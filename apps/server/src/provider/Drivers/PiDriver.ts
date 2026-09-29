// @effect-diagnostics nodeBuiltinImport:off - Pi SDK runtime resolves its standard credential directory.
import { getAgentDir, ModelRuntime, VERSION } from "@earendil-works/pi-coding-agent";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import { PiSettings, ProviderDriverKind } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
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

const DRIVER = ProviderDriverKind.make("pi");
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
      const adapter = yield* makePiAdapter({ instanceId });
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
            version: VERSION,
            message: "The embedded Pi SDK model catalog could not be read.",
          });
        }
        return yield* buildPiProviderSnapshot({
          settings,
          models: result.success.value.models,
          installed: true,
          version: VERSION,
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
      return {
        instanceId,
        driverKind: DRIVER,
        continuationIdentity,
        displayName,
        accentColor,
        enabled,
        snapshot,
        adapter,
        textGeneration,
      } satisfies ProviderInstance;
    }),
};
