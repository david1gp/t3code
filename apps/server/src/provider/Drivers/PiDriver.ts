// @effect-diagnostics nodeBuiltinImport:off - Pi SDK runtime resolves its standard credential directory.
import {
  DefaultResourceLoader,
  getAgentDir,
  ModelRuntime,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import {
  PiSettings,
  ProviderDriverKind,
  type ServerProviderWorkspaceSnapshot,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import serverPackage from "../../../package.json" with { type: "json" };
import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import type { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { makePiTextGeneration } from "../../textGeneration/PiTextGeneration.ts";
import { ProviderDriverError } from "../Errors.ts";
import { makePiAdapter } from "../Layers/PiAdapter.ts";
import {
  buildInitialPiProviderSnapshot,
  buildPiProviderSnapshot,
  piAuthFromSdk,
  piModelsFromSdk,
  piPresetNamesFromJson,
  piPromptTemplatesToSlashCommands,
} from "../Layers/PiProvider.ts";
import { makeManagedServerProvider } from "../makeManagedServerProvider.ts";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "../ProviderDriver.ts";
import { withInstanceIdentity } from "./instanceIdentity.ts";
import {
  haveProviderSnapshotSettingsChanged,
  makeProviderSnapshotSettingsSource,
  type ProviderSnapshotSettings,
} from "../providerUpdateSettings.ts";
import { makeManualOnlyProviderMaintenanceCapabilities } from "../providerMaintenance.ts";
import { piSkillsToServerProviderSkills } from "../piSkillsToServerProviderSkills.ts";
import { piExtensionCommandsForResources } from "../piExtensionCommandsForResources.ts";
import type { PiAdapterFactoryOptions } from "../PiAdapterFactoryOptions.ts";

const DRIVER = ProviderDriverKind.make("pi");
const MAX_INITIALIZED_WORKSPACES = 16;
// SDK VERSION resolves package.json relative to import.meta.url, which becomes T3's
// package directory in the server bundle. The exact dependency pin identifies the embedded SDK.
const SDK_VERSION = serverPackage.dependencies["@earendil-works/pi-coding-agent"];
const decodeSettings = Schema.decodeSync(PiSettings);
const maintenance = makeManualOnlyProviderMaintenanceCapabilities({
  provider: DRIVER,
  packageName: null,
});

async function readPiPresetNames(): Promise<ReadonlyArray<string>> {
  try {
    const source = await NodeFSP.readFile(NodePath.join(getAgentDir(), "presets.json"), "utf8");
    return piPresetNamesFromJson(JSON.parse(source));
  } catch {
    // A missing or malformed optional preset file must not block Pi discovery.
    return [];
  }
}

/** Discover the same cwd-aware global/project resources used by Pi sessions. */
export async function piResourcesForCwd(cwd: string) {
  const agentDir = getAgentDir();
  const settingsManager = SettingsManager.create(cwd, agentDir);
  const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager });
  await loader.reload();
  const extensionCommands = await piExtensionCommandsForResources(cwd, loader.getExtensions());
  const extensionNames = new Set(extensionCommands.map((command) => command.name));
  return {
    // Pi resolves registered extension commands before expanding prompt templates.
    slashCommands: [
      ...extensionCommands,
      ...piPromptTemplatesToSlashCommands(loader.getPrompts().prompts).filter(
        (command) => !extensionNames.has(command.name),
      ),
    ],
    skills: piSkillsToServerProviderSkills(loader.getSkills().skills),
  };
}

export type PiDriverEnv =
  | BackgroundPolicy.BackgroundPolicy
  | FileSystem.FileSystem
  | ServerConfig
  | ServerSettingsService;

export const PiDriver: ProviderDriver<PiSettings, PiDriverEnv> = {
  driverKind: DRIVER,
  metadata: { displayName: "Pi", supportsMultipleInstances: true },
  configSchema: PiSettings,
  defaultConfig: () => decodeSettings({}),
  create: ({ instanceId, displayName, accentColor, enabled, config }) =>
    Effect.gen(function* () {
      const settings = { ...config, enabled } satisfies PiSettings;
      const continuationIdentity = defaultProviderContinuationIdentity({
        driverKind: DRIVER,
        instanceId,
      });
      const stampIdentity = withInstanceIdentity({
        instanceId,
        driverKind: DRIVER,
        displayName,
        accentColor,
        continuationGroupKey: continuationIdentity.continuationKey,
      });
      const initializedResources = new Map<string, ServerProviderWorkspaceSnapshot>();
      const workspaceChanges = yield* Effect.acquireRelease(
        PubSub.unbounded<ServerProviderWorkspaceSnapshot>(),
        PubSub.shutdown,
      );
      let disposed = false;
      const adapterOptions: PiAdapterFactoryOptions = {
        instanceId,
        publishInitializedResources: Effect.fnUntraced(function* (resources) {
          if (disposed) return;
          const cwd = NodePath.resolve(resources.cwd.trim());
          const current = yield* snapshot.getSnapshot;
          const names = new Set(resources.slashCommands.map((command) => command.name));
          const initialized = {
            cwd,
            checkedAt: resources.checkedAt,
            slashCommands: [
              ...resources.slashCommands,
              ...current.slashCommands.filter((command) => {
                if (names.has(command.name)) return false;
                names.add(command.name);
                return true;
              }),
            ],
            skills: resources.skills,
          };
          initializedResources.delete(cwd);
          initializedResources.set(cwd, initialized);
          if (initializedResources.size > MAX_INITIALIZED_WORKSPACES) {
            const oldestCwd = initializedResources.keys().next().value;
            if (oldestCwd !== undefined) initializedResources.delete(oldestCwd);
          }
          yield* PubSub.publish(workspaceChanges, initialized);
        }),
      };
      const adapter = yield* makePiAdapter(adapterOptions);
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          disposed = true;
          initializedResources.clear();
        }),
      );
      const textGeneration = makePiTextGeneration();
      const checkProvider = Effect.gen(function* () {
        if (!settings.enabled)
          return yield* buildPiProviderSnapshot({
            settings,
            models: [],
            installed: false,
            message: "Pi is disabled in T3 Code settings.",
          });
        const result = yield* Effect.tryPromise({
          try: async () => {
            const runtime = await ModelRuntime.create({
              refreshOnCreate: false,
              allowModelNetwork: false,
            });
            const sdkModels = runtime.getModels();
            const presetNames = await readPiPresetNames();
            return {
              models: piModelsFromSdk(sdkModels, presetNames),
              auth: piAuthFromSdk(runtime, sdkModels),
            };
          },
          catch: (cause) =>
            new ProviderDriverError({
              driver: DRIVER,
              instanceId,
              detail: `Pi SDK model discovery failed: ${String(cause)}`,
              cause,
            }),
        }).pipe(Effect.timeoutOption("10 seconds"), Effect.result);
        if (result._tag === "Failure" || result.success._tag === "None") {
          return yield* buildPiProviderSnapshot({
            settings,
            models: [],
            installed: true,
            version: SDK_VERSION,
            message: "The embedded Pi SDK model catalog could not be read.",
          });
        }
        return yield* buildPiProviderSnapshot({
          settings,
          models: result.success.value.models,
          installed: true,
          version: SDK_VERSION,
          auth: result.success.value.auth,
        });
      }).pipe(Effect.map(stampIdentity));
      const snapshotSettings = makeProviderSnapshotSettingsSource(
        settings,
        yield* ServerSettingsService,
      );
      const snapshot = yield* makeManagedServerProvider<ProviderSnapshotSettings<PiSettings>>({
        resolveMaintenance: () => Effect.succeed(maintenance),
        getSettings: snapshotSettings.getSettings,
        streamSettings: snapshotSettings.streamSettings,
        haveSettingsChanged: haveProviderSnapshotSettingsChanged,
        initialSnapshot: (next) =>
          buildInitialPiProviderSnapshot(next.provider).pipe(Effect.map(stampIdentity)),
        checkProvider,
      }).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: DRIVER,
              instanceId,
              detail: "Failed to initialize Pi provider.",
              cause,
            }),
        ),
      );
      const snapshotForCwd: NonNullable<ProviderInstance["snapshotForCwd"]> = (directory) =>
        Effect.gen(function* () {
          const cwd = NodePath.resolve(directory.trim());
          const current = yield* snapshot.getSnapshot;
          const initialized = initializedResources.get(cwd);
          if (initialized) {
            const { cwd: _cwd, ...resources } = initialized;
            return { ...current, ...resources };
          }
          const discovered = yield* Effect.tryPromise(() => piResourcesForCwd(cwd)).pipe(
            // Binding can publish while unbound discovery is in flight, even if
            // that discovery fails. Its initialized resources remain authoritative.
            Effect.catch((cause) => {
              const initialized = initializedResources.get(cwd);
              return initialized ? Effect.succeed(initialized) : Effect.fail(cause);
            }),
          );
          const resources = initializedResources.get(cwd) ?? discovered;
          return {
            ...current,
            slashCommands: resources.slashCommands,
            skills: resources.skills,
            ...("checkedAt" in resources ? { checkedAt: resources.checkedAt } : {}),
          };
        }).pipe(
          Effect.mapError(
            (cause) =>
              new ProviderDriverError({
                driver: DRIVER,
                instanceId,
                detail: `Failed to discover Pi resources for '${directory}'.`,
                cause,
              }),
          ),
        );
      return {
        instanceId,
        driverKind: DRIVER,
        continuationIdentity,
        displayName,
        accentColor,
        enabled,
        snapshot,
        snapshotForCwd,
        streamWorkspaceSnapshotChanges: Stream.fromPubSub(workspaceChanges),
        adapter,
        textGeneration,
      } satisfies ProviderInstance;
    }),
};
