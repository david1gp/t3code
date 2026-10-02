// @effect-diagnostics nodeBuiltinImport:off - SDK resource-loader fixture uses temporary Node paths.
import { afterEach, beforeEach, describe, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import {
  CONFIG_DIR_NAME,
  DefaultResourceLoader,
  ModelRuntime,
  VERSION,
} from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { PiSettings, ProviderInstanceId } from "@t3tools/contracts";
import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { BUILT_IN_DRIVERS } from "../builtInDrivers.ts";
import { PiDriver, piResourcesForCwd } from "./PiDriver.ts";
import type { PiAdapterFactoryOptions } from "../PiAdapterFactoryOptions.ts";
import * as PiAdapterModule from "../Layers/PiAdapter.ts";

const adapterFactory = { options: new Map<string, PiAdapterFactoryOptions>() };

vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@earendil-works/pi-coding-agent")>();
  // Bundling relocates Pi's package-relative VERSION lookup to the server package.
  // Keep native SDK discovery and resource loading; only simulate that version mismatch.
  return { ...actual, VERSION: "0.0.42" };
});

const decodePiSettings = Schema.decodeSync(PiSettings);
const decodeLegacyPiSettings = Schema.decodeUnknownSync(PiSettings);

function skillWrite(directory: string, name: string, description: string, extra = "") {
  const path = NodePath.join(directory, name, "SKILL.md");
  NodeFS.mkdirSync(NodePath.dirname(path), { recursive: true });
  NodeFS.writeFileSync(
    path,
    `---\nname: ${name}\ndescription: ${description}\n${extra}---\nSkill body`,
  );
  return path;
}

function settingsWrite(directory: string, settings: { skills?: string[]; prompts?: string[] }) {
  NodeFS.mkdirSync(directory, { recursive: true });
  NodeFS.writeFileSync(NodePath.join(directory, "settings.json"), JSON.stringify(settings));
}

describe("Pi built-in driver", () => {
  let root: string;
  let home: string;
  let agentDir: string;
  let cwd: string;

  beforeEach(() => {
    const originalFactory = PiAdapterModule.makePiAdapter;
    vi.spyOn(PiAdapterModule, "makePiAdapter").mockImplementation(
      (options: PiAdapterFactoryOptions = {}) => {
        if (options.instanceId) adapterFactory.options.set(options.instanceId, options);
        return originalFactory(options);
      },
    );
    root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-pi-resource-catalog-"));
    home = NodePath.join(root, "home");
    agentDir = NodePath.join(home, CONFIG_DIR_NAME, "agent");
    cwd = NodePath.join(root, "workspace");
    NodeFS.mkdirSync(agentDir, { recursive: true });
    // Bound ancestor .agents discovery to the isolated workspace.
    NodeFS.mkdirSync(NodePath.join(cwd, ".git"), { recursive: true });
    vi.stubEnv("HOME", home);
    vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
  });

  afterEach(() => {
    adapterFactory.options.clear();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    NodeFS.rmSync(root, { recursive: true, force: true });
  });

  const instanceCreate = (id: string) =>
    PiDriver.create({
      instanceId: ProviderInstanceId.make(id),
      displayName: id,
      environment: [],
      enabled: false,
      config: decodePiSettings({ enabled: false, customModels: ["fixture/custom"] }),
    });
  const testLayer = () =>
    ServerConfig.layerTest(root, { prefix: "t3-pi-initialized-resources-" }).pipe(
      Layer.provideMerge(NodeServices.layer),
      Layer.provideMerge(ServerSettingsService.layerTest()),
      Layer.provideMerge(
        Layer.mock(BackgroundPolicy.BackgroundPolicy)({
          shouldRunScopeWork: () => Effect.succeed(false),
        }),
      ),
    );
  const catalog = (directory: string, name = "dynamic") => ({
    cwd: directory,
    checkedAt: "2026-10-01T20:00:00.000Z",
    slashCommands: [{ name, description: "Initialized extension command" }],
    skills: [{ name, path: NodePath.join(directory, "SKILL.md"), enabled: true }],
  });
  const publisher = (id: string) => adapterFactory.options.get(id)!.publishInitializedResources!;

  it.effect(
    "publishes initialized catalogs on the instance stream and prefers them to static discovery",
    () =>
      Effect.gen(function* () {
        const instance = yield* instanceCreate("initialized");
        const machine = yield* instance.snapshot.getSnapshot;
        const pull = yield* Stream.toPull(instance.streamWorkspaceSnapshotChanges!);
        const notification = yield* pull.pipe(Effect.forkChild({ startImmediately: true }));
        const resources = catalog(cwd);
        yield* publisher("initialized")({ ...resources, cwd: ` ${cwd}/nested/.. ` });
        expect(yield* Fiber.join(notification)).toEqual([resources]);
        const reload = vi.spyOn(DefaultResourceLoader.prototype, "reload");
        const scoped = yield* instance.snapshotForCwd!(`${cwd}/.`);
        expect(scoped).toEqual({
          ...machine,
          checkedAt: resources.checkedAt,
          slashCommands: resources.slashCommands,
          skills: resources.skills,
        });
        expect(reload).not.toHaveBeenCalled();
        yield* instance.snapshot.refresh;
        expect((yield* instance.snapshotForCwd!(cwd)).slashCommands).toEqual(
          resources.slashCommands,
        );
        expect(reload).not.toHaveBeenCalled();
      }).pipe(Effect.scoped, Effect.provide(testLayer())),
  );

  it.effect(
    "retains machine SDK models, metadata, provider identity and preset preferences on publication",
    () =>
      Effect.gen(function* () {
        const runtime = yield* Effect.promise(() =>
          ModelRuntime.create({
            refreshOnCreate: false,
            allowModelNetwork: false,
          }),
        );
        vi.spyOn(runtime, "getModels").mockReturnValue([
          {
            provider: "fixture",
            id: "reasoner",
            name: "Fixture reasoner",
            reasoning: true,
            api: "openai-responses",
            baseUrl: "https://example.invalid",
            input: ["text"],
            contextWindow: 16000,
            maxTokens: 2000,
            cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.2 },
          },
        ]);
        vi.spyOn(ModelRuntime, "create").mockResolvedValue(runtime);
        NodeFS.writeFileSync(NodePath.join(agentDir, "presets.json"), '{"fast":{}}');
        const instance = yield* PiDriver.create({
          instanceId: ProviderInstanceId.make("metadata"),
          displayName: "Metadata",
          environment: [],
          enabled: true,
          config: decodePiSettings({}),
        });
        const machine = yield* instance.snapshot.refresh;
        expect(machine.models[0]).toMatchObject({
          slug: "fixture/reasoner",
          metadata: { limits: { context: 16000, output: 2000 } },
          capabilities: {
            optionDescriptors: [
              { id: "thinkingLevel", currentValue: "medium" },
              { id: "preset", options: [{ id: "none" }, { id: "fast" }] },
            ],
          },
        });
        const resources = catalog(cwd);
        yield* publisher("metadata")(resources);
        expect(yield* instance.snapshotForCwd!(cwd)).toEqual({
          ...machine,
          checkedAt: resources.checkedAt,
          slashCommands: resources.slashCommands,
          skills: resources.skills,
        });
        expect(yield* instance.snapshot.getSnapshot).toEqual(machine);
      }).pipe(Effect.scoped, Effect.provide(testLayer())),
  );

  it.effect("initialized publication wins over an in-flight unbound catalog refresh", () =>
    Effect.gen(function* () {
      const instance = yield* instanceCreate("race");
      const { promise: started, resolve: markStarted } = Promise.withResolvers<void>();
      const { promise: release, resolve: releaseDiscovery } = Promise.withResolvers<void>();
      const original = DefaultResourceLoader.prototype.reload;
      vi.spyOn(DefaultResourceLoader.prototype, "reload").mockImplementationOnce(async function (
        this: DefaultResourceLoader,
      ) {
        markStarted();
        await release;
        return original.call(this);
      });
      const discovery = yield* instance.snapshotForCwd!(cwd).pipe(Effect.forkChild);
      yield* Effect.promise(() => started);
      const resources = catalog(cwd);
      yield* publisher("race")(resources);
      releaseDiscovery();
      const scoped = yield* Fiber.join(discovery);
      expect(scoped).toMatchObject({
        checkedAt: resources.checkedAt,
        slashCommands: resources.slashCommands,
        skills: resources.skills,
      });
      expect((yield* instance.snapshotForCwd!(cwd)).slashCommands).toEqual(resources.slashCommands);
    }).pipe(Effect.scoped, Effect.provide(testLayer())),
  );

  it.effect("initialized publication survives a concurrent static discovery failure", () =>
    Effect.gen(function* () {
      const instance = yield* instanceCreate("failed-race");
      const { promise: started, resolve: markStarted } = Promise.withResolvers<void>();
      const { promise: release, resolve: releaseDiscovery } = Promise.withResolvers<void>();
      vi.spyOn(DefaultResourceLoader.prototype, "reload").mockImplementationOnce(async () => {
        markStarted();
        await release;
        throw new Error("Unbound discovery failed after successful binding");
      });
      const discovery = yield* instance.snapshotForCwd!(cwd).pipe(Effect.forkChild);
      yield* Effect.promise(() => started);
      const resources = catalog(cwd);
      yield* publisher("failed-race")(resources);
      releaseDiscovery();
      expect(yield* Fiber.join(discovery)).toMatchObject({
        checkedAt: resources.checkedAt,
        slashCommands: resources.slashCommands,
        skills: resources.skills,
      });
    }).pipe(Effect.scoped, Effect.provide(testLayer())),
  );

  it.effect("bounds initialized workspaces to 16 and refreshes an existing cwd's recency", () =>
    Effect.gen(function* () {
      const instance = yield* instanceCreate("bounded");
      for (let index = 0; index < 16; index++) {
        yield* publisher("bounded")(
          catalog(NodePath.join(root, `cwd-${index}`), `dynamic-${index}`),
        );
      }
      const first = NodePath.join(root, "cwd-0");
      yield* publisher("bounded")(catalog(first, "updated-first"));
      yield* publisher("bounded")(catalog(NodePath.join(root, "cwd-16"), "dynamic-16"));
      const reload = vi.spyOn(DefaultResourceLoader.prototype, "reload");
      expect((yield* instance.snapshotForCwd!(first)).slashCommands).toEqual(
        catalog(first, "updated-first").slashCommands,
      );
      expect(reload).not.toHaveBeenCalled();
      const evicted = yield* instance.snapshotForCwd!(NodePath.join(root, "cwd-1"));
      expect(evicted.slashCommands).toEqual([]);
      expect(reload).toHaveBeenCalledTimes(1);
    }).pipe(Effect.scoped, Effect.provide(testLayer())),
  );

  it.effect(
    "fences disposed publishers and isolates replacement and parallel instance caches/streams",
    () =>
      Effect.gen(function* () {
        const oldScope = yield* Scope.make();
        const old = yield* instanceCreate("replaced").pipe(Scope.provide(oldScope));
        const oldPublish = publisher("replaced");
        const oldPull = yield* Stream.toPull(old.streamWorkspaceSnapshotChanges!);
        const oldNotification = yield* oldPull.pipe(Effect.forkChild({ startImmediately: true }));
        yield* oldPublish(catalog(cwd, "old"));
        expect(yield* Fiber.join(oldNotification)).toEqual([catalog(cwd, "old")]);
        yield* Scope.close(oldScope, Exit.void);
        yield* oldPublish(catalog(cwd, "late-old"));
        expect(Exit.isFailure(yield* oldPull.pipe(Effect.exit))).toBe(true);
        const replacement = yield* instanceCreate("replaced");
        const other = yield* instanceCreate("parallel");
        const replacementPull = yield* Stream.toPull(replacement.streamWorkspaceSnapshotChanges!);
        const otherPull = yield* Stream.toPull(other.streamWorkspaceSnapshotChanges!);
        const replacementNotification = yield* replacementPull.pipe(
          Effect.forkChild({ startImmediately: true }),
        );
        const otherNotification = yield* otherPull.pipe(
          Effect.forkChild({ startImmediately: true }),
        );
        yield* publisher("replaced")(catalog(cwd, "replacement"));
        yield* publisher("parallel")(catalog(cwd, "other"));
        yield* oldPublish(catalog(cwd, "late-again"));
        expect(yield* Fiber.join(replacementNotification)).toEqual([catalog(cwd, "replacement")]);
        expect(yield* Fiber.join(otherNotification)).toEqual([catalog(cwd, "other")]);
        expect((yield* replacement.snapshotForCwd!(cwd)).slashCommands).toEqual(
          catalog(cwd, "replacement").slashCommands,
        );
        expect((yield* other.snapshotForCwd!(cwd)).slashCommands).toEqual(
          catalog(cwd, "other").slashCommands,
        );
      }).pipe(Effect.scoped, Effect.provide(testLayer())),
  );

  it("registers Pi with SDK-only settings", () => {
    expect(BUILT_IN_DRIVERS.some((driver) => driver.driverKind === "pi")).toBe(true);
    expect(decodePiSettings({})).toMatchObject({
      enabled: true,
      customModels: [],
    });
    expect(PiSettings.fields).not.toHaveProperty("binaryPath");
    expect(decodeLegacyPiSettings({ binaryPath: "/old/pi", enabled: true })).toEqual({
      enabled: true,
      customModels: [],
    });
  });

  it("discovers global and cwd project prompt templates through Pi's resource loader", async () => {
    const globalPrompts = NodePath.join(agentDir, "prompts");
    const projectPrompts = NodePath.join(cwd, CONFIG_DIR_NAME, "prompts");
    NodeFS.mkdirSync(globalPrompts, { recursive: true });
    NodeFS.mkdirSync(projectPrompts, { recursive: true });
    NodeFS.writeFileSync(
      NodePath.join(globalPrompts, "review.md"),
      '---\ndescription: Global review\nargument-hint: "<file>"\n---\nReview $1',
    );
    NodeFS.writeFileSync(NodePath.join(globalPrompts, "shared.md"), "Global collision");
    NodeFS.writeFileSync(
      NodePath.join(projectPrompts, "deploy.md"),
      '---\ndescription: Project deploy\nargument-hint: "[target]"\n---\nDeploy $1',
    );
    NodeFS.writeFileSync(NodePath.join(projectPrompts, "shared.md"), "Project collision");
    const resources = await piResourcesForCwd(cwd);
    expect(resources.slashCommands).toEqual([
      { name: "deploy", description: "Project deploy", input: { hint: "[target]" } },
      { name: "shared", description: "Project collision" },
      { name: "review", description: "Global review", input: { hint: "<file>" } },
    ]);
    expect(resources.skills).toEqual([]);
  });

  it("publishes native extension invocation names and lets extension commands win over templates", async () => {
    const extensions = NodePath.join(agentDir, "extensions");
    const prompts = NodePath.join(agentDir, "prompts");
    NodeFS.mkdirSync(extensions, { recursive: true });
    NodeFS.mkdirSync(prompts, { recursive: true });
    NodeFS.writeFileSync(NodePath.join(prompts, "review.md"), "Template review");
    NodeFS.writeFileSync(NodePath.join(prompts, "deploy.md"), "Deploy template");
    const startupMarker = NodePath.join(root, "session-start");
    NodeFS.writeFileSync(
      NodePath.join(extensions, "first.js"),
      `import { writeFileSync } from "node:fs";
      export default function (pi) {
        pi.registerCommand("review", { description: "Extension review", handler: async () => {} });
        pi.registerCommand("inspect", { description: "First inspect", handler: async () => {} });
        pi.on("session_start", () => {
          writeFileSync(${JSON.stringify(startupMarker)}, "started");
          throw new Error("Discovery must not start a session");
        });
      }`,
    );
    NodeFS.writeFileSync(
      NodePath.join(extensions, "second.js"),
      `export default function (pi) {
        pi.registerCommand("inspect", { description: "Second inspect", handler: async () => {} });
      }`,
    );

    const resources = await piResourcesForCwd(cwd);
    expect(resources.slashCommands).toEqual([
      { name: "review", description: "Extension review" },
      { name: "inspect:1", description: "First inspect" },
      { name: "inspect:2", description: "Second inspect" },
      { name: "deploy", description: "Deploy template" },
    ]);
    expect(resources.skills).toEqual([]);
    expect(await piResourcesForCwd(cwd)).toEqual(resources);
    expect(NodeFS.existsSync(startupMarker)).toBe(false);
  });

  it("discovers global and project Pi and .agents skills, preserving collisions and same-name prompts", async () => {
    const globalSkills = NodePath.join(agentDir, "skills");
    const projectSkills = NodePath.join(cwd, CONFIG_DIR_NAME, "skills");
    skillWrite(globalSkills, "assets", "Global assets");
    const assets = skillWrite(projectSkills, "assets", "Project assets");
    const codeStyle = skillWrite(globalSkills, "code-style", "Global code style");
    const commits = skillWrite(
      NodePath.join(cwd, ".agents", "skills"),
      "commits",
      "Project commits",
    );
    const agentBrowser = skillWrite(
      NodePath.join(home, ".agents", "skills"),
      "agent-browser",
      "Global browser",
    );
    const prompts = NodePath.join(agentDir, "prompts");
    NodeFS.mkdirSync(prompts, { recursive: true });
    NodeFS.writeFileSync(NodePath.join(prompts, "assets.md"), "Assets prompt");

    const resources = await piResourcesForCwd(cwd);
    expect(resources.slashCommands).toEqual([{ name: "assets", description: "Assets prompt" }]);
    expect(resources.skills).toEqual([
      {
        name: "assets",
        path: assets,
        description: "Project assets",
        enabled: true,
        scope: "project",
      },
      {
        name: "commits",
        path: commits,
        description: "Project commits",
        enabled: true,
        scope: "project",
      },
      {
        name: "code-style",
        path: codeStyle,
        description: "Global code style",
        enabled: true,
        scope: "user",
      },
      {
        name: "agent-browser",
        path: agentBrowser,
        description: "Global browser",
        enabled: true,
        scope: "user",
      },
    ]);
  });

  it("deduplicates symlinks to the same skill without replacing native paths and ignores broken links", async () => {
    const canonicalSkills = NodePath.join(root, "shared-skills");
    const canonicalPath = skillWrite(canonicalSkills, "assets", "Shared assets");
    // Different directory-derived names prove real-path dedup, not just name collisions.
    NodeFS.writeFileSync(canonicalPath, "---\ndescription: Shared assets\n---\nSkill body");
    const globalSkills = NodePath.join(agentDir, "skills");
    const agentsSkills = NodePath.join(home, ".agents", "skills");
    const projectSkills = NodePath.join(cwd, CONFIG_DIR_NAME, "skills");
    for (const [directory, alias] of [
      [globalSkills, "global-assets"],
      [agentsSkills, "agent-assets"],
      [projectSkills, "project-assets"],
    ] as const) {
      NodeFS.mkdirSync(directory, { recursive: true });
      NodeFS.symlinkSync(NodePath.dirname(canonicalPath), NodePath.join(directory, alias), "dir");
    }
    NodeFS.symlinkSync(
      NodePath.join(root, "missing"),
      NodePath.join(globalSkills, "broken"),
      "dir",
    );
    settingsWrite(agentDir, { skills: [canonicalPath] });

    const resources = await piResourcesForCwd(cwd);
    const nativePath = NodePath.join(projectSkills, "project-assets", "SKILL.md");
    expect(NodeFS.realpathSync(nativePath)).toBe(canonicalPath);
    expect(resources.skills).toEqual([
      {
        name: "project-assets",
        path: nativePath,
        description: "Shared assets",
        enabled: true,
        scope: "project",
      },
    ]);
  });

  it("honors global and project resource settings without treating model-invocation-disabled skills as unloaded", async () => {
    const globalSkills = NodePath.join(agentDir, "skills");
    const projectConfig = NodePath.join(cwd, CONFIG_DIR_NAME);
    const projectSkills = NodePath.join(projectConfig, "skills");
    skillWrite(globalSkills, "disabled-global", "Excluded global");
    skillWrite(projectSkills, "disabled-project", "Excluded project");
    const manual = skillWrite(
      globalSkills,
      "manual",
      "Explicit-only skill",
      "disable-model-invocation: true\n",
    );
    const configured = skillWrite(
      NodePath.join(root, "configured"),
      "configured",
      "Configured project skill",
    );
    settingsWrite(agentDir, { skills: ["-skills/disabled-global"] });
    settingsWrite(projectConfig, {
      skills: ["-skills/disabled-project", configured],
      prompts: ["-prompts/disabled.md"],
    });
    const prompts = NodePath.join(projectConfig, "prompts");
    NodeFS.mkdirSync(prompts, { recursive: true });
    NodeFS.writeFileSync(NodePath.join(prompts, "disabled.md"), "Excluded prompt");

    expect(await piResourcesForCwd(cwd)).toEqual({
      slashCommands: [],
      skills: [
        {
          name: "configured",
          path: configured,
          description: "Configured project skill",
          enabled: true,
          scope: "project",
        },
        {
          name: "manual",
          path: manual,
          description: "Explicit-only skill",
          enabled: true,
          scope: "user",
        },
      ],
    });
  });

  it.effect("uses the embedded SDK pin, not relocated VERSION, when discovery fails", () =>
    Effect.gen(function* () {
      expect(VERSION).toBe("0.0.42");
      vi.spyOn(ModelRuntime, "create").mockRejectedValue(new Error("Model catalog unavailable"));
      const instance = yield* PiDriver.create({
        instanceId: ProviderInstanceId.make("pi-version-test"),
        displayName: "Pi version test",
        environment: [],
        enabled: true,
        config: decodePiSettings({ enabled: true }),
      });
      const snapshot = yield* instance.snapshot.refresh;
      expect(snapshot).toMatchObject({
        instanceId: "pi-version-test",
        installed: true,
        version: "0.87.1",
        message: "The embedded Pi SDK model catalog could not be read.",
      });
    }).pipe(
      Effect.scoped,
      Effect.provide(
        ServerConfig.layerTest(cwd, { prefix: "t3-pi-version-snapshot-" }).pipe(
          Layer.provideMerge(NodeServices.layer),
          Layer.provideMerge(ServerSettingsService.layerTest()),
          Layer.provideMerge(
            Layer.mock(BackgroundPolicy.BackgroundPolicy)({
              shouldRunScopeWork: () => Effect.succeed(false),
            }),
          ),
        ),
      ),
    ),
  );

  it.effect(
    "publishes loaded skills and prompt commands together in the cwd provider snapshot",
    () =>
      Effect.gen(function* () {
        skillWrite(NodePath.join(agentDir, "skills"), "assets", "Global assets skill");
        const path = skillWrite(
          NodePath.join(cwd, CONFIG_DIR_NAME, "skills"),
          "assets",
          "Project assets skill",
        );
        const prompts = NodePath.join(agentDir, "prompts");
        const projectPrompts = NodePath.join(cwd, CONFIG_DIR_NAME, "prompts");
        NodeFS.mkdirSync(prompts, { recursive: true });
        NodeFS.mkdirSync(projectPrompts, { recursive: true });
        NodeFS.writeFileSync(
          NodePath.join(prompts, "assets.md"),
          "---\ndescription: Global assets prompt\n---\nGlobal assets body",
        );
        NodeFS.writeFileSync(
          NodePath.join(projectPrompts, "assets.md"),
          "---\ndescription: Project assets prompt\n---\nProject assets body",
        );
        // A disabled provider skips model/auth discovery, keeping this a resource-only test.
        const instance = yield* PiDriver.create({
          instanceId: ProviderInstanceId.make("pi-resource-test"),
          displayName: "Pi resource test",
          environment: [],
          enabled: false,
          config: decodePiSettings({ enabled: false }),
        });
        const snapshot = yield* instance.snapshotForCwd!(cwd);
        expect(snapshot).toMatchObject({
          instanceId: "pi-resource-test",
          enabled: false,
          slashCommands: [{ name: "assets", description: "Project assets prompt" }],
          skills: [
            {
              name: "assets",
              path,
              description: "Project assets skill",
              enabled: true,
              scope: "project",
            },
          ],
        });
      }).pipe(
        Effect.scoped,
        Effect.provide(
          // The requested workspace differs from the server cwd.
          ServerConfig.layerTest(root, { prefix: "t3-pi-resource-snapshot-" }).pipe(
            Layer.provideMerge(NodeServices.layer),
            Layer.provideMerge(ServerSettingsService.layerTest()),
            Layer.provideMerge(
              Layer.mock(BackgroundPolicy.BackgroundPolicy)({
                shouldRunScopeWork: () => Effect.succeed(false),
              }),
            ),
          ),
        ),
      ),
  );
});
