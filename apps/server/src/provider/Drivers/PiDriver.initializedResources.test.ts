// @effect-diagnostics nodeBuiltinImport:off - isolated pinned-SDK resource fixture.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { AgentSession, DefaultResourceLoader, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { assert, it } from "@effect/vitest";
import { afterEach, beforeEach, vi } from "vite-plus/test";
import {
  PiSettings,
  ProviderInstanceId,
  ThreadId,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import * as ModelManifest from "../ModelManifest.ts";
import { makePiAdapter } from "../Layers/PiAdapter.ts";
import { ProviderRegistryLive } from "../Layers/ProviderRegistry.ts";
import { ProviderInstanceRegistry } from "../Services/ProviderInstanceRegistry.ts";
import { ProviderRegistry } from "../Services/ProviderRegistry.ts";
import { PiDriver } from "./PiDriver.ts";

const controlKey = Symbol.for("t3.pi.initialized.resources.test");
const decodePiSettings = Schema.decodeSync(PiSettings);
let root: string;
let cwd: string;
let agentDir: string;
let skillPath: string;
let promptPath: string;
let control: { order: string[]; commands: string[]; expanded: string[] };

beforeEach(async () => {
  root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-pi-bound-resources-"));
  cwd = NodePath.join(root, "workspace");
  agentDir = NodePath.join(root, "home", "agent");
  NodeFS.mkdirSync(NodePath.join(cwd, ".git"), { recursive: true });
  NodeFS.mkdirSync(NodePath.join(agentDir, "extensions"), { recursive: true });
  NodeFS.mkdirSync(NodePath.join(agentDir, "prompts"), { recursive: true });
  vi.stubEnv("HOME", NodePath.join(root, "home"));
  vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
  skillPath = NodePath.join(root, "discovered", "dynamic-skill", "SKILL.md");
  promptPath = NodePath.join(root, "discovered", "dynamic-template.md");
  NodeFS.mkdirSync(NodePath.dirname(skillPath), { recursive: true });
  NodeFS.writeFileSync(
    skillPath,
    "---\nname: dynamic-skill\ndescription: Bound skill\n---\nDynamic skill instruction.",
  );
  NodeFS.writeFileSync(
    promptPath,
    "---\ndescription: Bound template\nargument-hint: <target>\n---\nDynamic template $1",
  );
  NodeFS.writeFileSync(NodePath.join(agentDir, "prompts", "review.md"), "Shadowed review template");
  NodeFS.writeFileSync(NodePath.join(agentDir, "prompts", "inspect.md"), "Unaliased inspect $1");
  NodeFS.writeFileSync(NodePath.join(agentDir, "presets.json"), '{"startup":{}}');
  control = { order: [], commands: [], expanded: [] };
  Reflect.set(globalThis, controlKey, control);
  NodeFS.writeFileSync(
    NodePath.join(agentDir, "extensions", "first.js"),
    `
    export default function (pi) {
      const c = globalThis[Symbol.for("t3.pi.initialized.resources.test")];
      pi.registerCommand("static-command", { description: "Static native command", handler: () => c.commands.push("static") });
      pi.on("session_start", () => {
        c.order.push("session_start");
        pi.registerCommand("review", { description: "Bound review", handler: () => c.commands.push("review") });
        pi.registerCommand("inspect", { description: "Bound first inspect", handler: () => c.commands.push("inspect:1") });
      });
      pi.on("resources_discover", () => {
        c.order.push("resources_discover");
        pi.registerCommand("discovered", { description: "Discover command", handler: () => c.commands.push("discovered") });
        return { skillPaths: [${JSON.stringify(skillPath)}], promptPaths: [${JSON.stringify(promptPath)}] };
      });
      pi.registerCommand("preset", { handler: (_args, ctx) => {
        c.order.push("preset");
        if (ctx.sessionManager.getSessionId()) pi.registerCommand("from-preset", {
          description: "Preset command", handler: () => c.commands.push("from-preset")
        });
      }});
      pi.on("before_agent_start", (event) => { c.expanded.push(event.prompt); });
    }
  `,
  );
  NodeFS.writeFileSync(
    NodePath.join(agentDir, "extensions", "second.js"),
    `
    export default function (pi) {
      const c = globalThis[Symbol.for("t3.pi.initialized.resources.test")];
      pi.on("session_start", () => pi.registerCommand("inspect", {
        description: "Bound second inspect", handler: () => c.commands.push("inspect:2")
      }));
    }
  `,
  );
  const runtime = await ModelRuntime.create({ refreshOnCreate: false, allowModelNetwork: false });
  vi.spyOn(ModelRuntime, "create").mockResolvedValue(runtime);
});

afterEach(() => {
  Reflect.deleteProperty(globalThis, controlKey);
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  NodeFS.rmSync(root, { recursive: true, force: true });
});

const testLayer = () =>
  ServerConfig.layerTest(root, { prefix: "pi-bound-resources-state-" }).pipe(
    Layer.provideMerge(NodeServices.layer),
    Layer.provideMerge(ServerSettingsService.layerTest()),
    Layer.provideMerge(ModelManifest.layerTest),
    Layer.provideMerge(
      Layer.mock(BackgroundPolicy.BackgroundPolicy)({
        shouldRunScopeWork: () => Effect.succeed(false),
      }),
    ),
  );

it.live(
  "publishes real bound Pi resources through the driver factory and Registry change stream before start returns",
  () =>
    Effect.gen(function* () {
      const instanceId = ProviderInstanceId.make("pi-initialized-fixture");
      const instance = yield* PiDriver.create({
        instanceId,
        displayName: "Bound Pi",
        environment: [],
        enabled: false,
        config: decodePiSettings({ enabled: false, customModels: ["fixture/machine"] }),
      });
      const other = yield* PiDriver.create({
        instanceId: ProviderInstanceId.make("pi-other"),
        displayName: "Other Pi",
        environment: [],
        enabled: false,
        config: decodePiSettings({ enabled: false }),
      });
      const machine = yield* instance.snapshot.getSnapshot;
      // Exercise existing static snapshot commands without fabricating an SDK command:
      // the actual extension still owns the invokable static-command/preset names.
      Object.defineProperty(instance.snapshot, "getSnapshot", {
        value: Effect.succeed({
          ...machine,
          enabled: true,
          slashCommands: [
            { name: "static-command", description: "Stale static descriptor" },
            { name: "preset" },
            { name: "retained-static", description: "Existing machine command" },
            { name: "retained-static", description: "Duplicate static descriptor" },
          ],
        }),
      });
      const subscribed = yield* Deferred.make<void>();
      const wrapped = {
        ...instance,
        streamWorkspaceSnapshotChanges: Stream.unwrap(
          Effect.gen(function* () {
            const pull = yield* Stream.toPull(instance.streamWorkspaceSnapshotChanges!);
            yield* Deferred.succeed(subscribed, undefined);
            return Stream.fromPull(Effect.succeed(pull));
          }),
        ),
      };
      const changes = yield* PubSub.unbounded<void>();
      const registryContext = yield* Layer.build(
        ProviderRegistryLive.pipe(
          Layer.provide(
            Layer.succeed(ProviderInstanceRegistry, {
              getInstance: (id) => Effect.succeed(id === instanceId ? wrapped : other),
              listInstances: Effect.succeed([wrapped, other]),
              listUnavailable: Effect.succeed([]),
              streamChanges: Stream.fromPubSub(changes),
              subscribeChanges: PubSub.subscribe(changes),
            }),
          ),
        ),
      );
      const registry = yield* ProviderRegistry.pipe(Effect.provide(registryContext));
      yield* Deferred.await(subscribed);
      const before = yield* registry.getProviders;
      const scopedBefore = yield* instance.snapshotForCwd!(cwd);
      assert.deepEqual(control.order, [], "ordinary discovery must not bind/start hooks");
      assert.isFalse(scopedBefore.skills.some((skill) => skill.name === "dynamic-skill"));
      const pull = yield* Stream.toPull(registry.streamChanges);
      const notification = yield* pull.pipe(Effect.forkChild({ startImmediately: true }));
      const runtimeEvents: ProviderRuntimeEvent[] = [];
      const lifecycle = yield* Deferred.make<void>();
      yield* Stream.runForEach(instance.adapter.streamEvents, (event) =>
        Effect.gen(function* () {
          runtimeEvents.push(event);
          if (event.type === "thread.started") yield* Deferred.succeed(lifecycle, undefined);
        }),
      ).pipe(Effect.forkScoped({ startImmediately: true }));
      const originalBind = AgentSession.prototype.bindExtensions;
      const bind = vi
        .spyOn(AgentSession.prototype, "bindExtensions")
        .mockImplementation(async function (this: AgentSession, bindings) {
          this.agent.streamFunction = (selected) => {
            const message = {
              role: "assistant" as const,
              api: selected.api,
              provider: selected.provider,
              model: selected.id,
              content: [{ type: "text" as const, text: "fixture answer" }],
              usage: {
                input: 1,
                output: 1,
                cacheRead: 0,
                cacheWrite: 0,
                totalTokens: 2,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
              },
              stopReason: "stop" as const,
              timestamp: 1,
            };
            return {
              async *[Symbol.asyncIterator]() {
                yield { type: "done" as const, reason: "stop" as const, message };
              },
              result: async () => message,
            } as unknown as ReturnType<AgentSession["agent"]["streamFunction"]>;
          };
          await originalBind.call(this, bindings);
        });
      vi.spyOn(ModelRuntime.prototype, "getAuth").mockResolvedValue({
        auth: { apiKey: "fake-fixture-key" },
      });
      vi.spyOn(ModelRuntime.prototype, "hasConfiguredAuth").mockReturnValue(true);
      const beforeTime = yield* Clock.currentTimeMillis;
      const session = yield* instance.adapter.startSession({
        threadId: ThreadId.make("initialized-thread"),
        cwd: ` ${cwd}/nested/.. `,
        runtimeMode: "full-access",
        modelSelection: {
          instanceId,
          model: "fixture/machine",
          options: [{ id: "preset", value: "startup" }],
        },
      });
      const afterTime = yield* Clock.currentTimeMillis;
      yield* Deferred.await(lifecycle);
      assert.equal(session.cwd, cwd);
      assert.equal(session.status, "ready");
      assert.equal(
        bind.mock.calls.length,
        1,
        "publication must not construct/bind a second SDK session",
      );
      assert.deepEqual(control.order, ["session_start", "resources_discover", "preset"]);
      assert.deepEqual(
        runtimeEvents.map((event) => event.type),
        ["session.started", "session.state.changed", "thread.started"],
      );
      const [published] = yield* Fiber.join(notification);
      const provider = published!.find((entry) => entry.instanceId === instanceId)!;
      const workspace = provider.workspaceSnapshots![0]!;
      assert.equal(workspace.cwd, cwd);
      assert.isAtLeast(Date.parse(workspace.checkedAt), beforeTime);
      assert.isAtMost(Date.parse(workspace.checkedAt), afterTime);
      assert.deepEqual(workspace.skills, [
        {
          name: "dynamic-skill",
          description: "Bound skill",
          path: skillPath,
          enabled: true,
          scope: "temporary",
        },
      ]);
      const commands = workspace.slashCommands;
      assert.deepEqual(
        commands.map((command) => command.name),
        [
          "static-command",
          "preset",
          "review",
          "inspect:1",
          "discovered",
          "from-preset",
          "inspect:2",
          "inspect",
          "dynamic-template",
          "retained-static",
        ],
      );
      assert.deepEqual(
        commands.find((command) => command.name === "review"),
        { name: "review", description: "Bound review" },
      );
      assert.deepEqual(
        commands.find((command) => command.name === "static-command"),
        { name: "static-command", description: "Static native command" },
      );
      assert.deepEqual(
        commands.find((command) => command.name === "dynamic-template"),
        { name: "dynamic-template", description: "Bound template", input: { hint: "<target>" } },
      );
      assert.deepEqual(
        commands.find((command) => command.name === "retained-static"),
        { name: "retained-static", description: "Existing machine command" },
      );
      assert.deepEqual(
        provider.models,
        before.find((entry) => entry.instanceId === instanceId)!.models,
      );
      assert.deepEqual(
        provider.slashCommands,
        before.find((entry) => entry.instanceId === instanceId)!.slashCommands,
      );
      assert.deepEqual(
        published!.find((entry) => entry.instanceId === other.instanceId),
        before.find((entry) => entry.instanceId === other.instanceId),
      );
      const reload = vi.spyOn(DefaultResourceLoader.prototype, "reload");
      assert.deepEqual((yield* instance.snapshotForCwd!(cwd)).skills, workspace.skills);
      assert.equal(
        reload.mock.calls.length,
        0,
        "cached bound resources must not enumerate hooks again",
      );
      for (const name of [
        "static-command",
        "review",
        "inspect:1",
        "inspect:2",
        "discovered",
        "from-preset",
      ]) {
        yield* instance.adapter.sendTurn({ threadId: session.threadId, input: `/${name}` });
      }
      assert.deepEqual(control.commands, [
        "static",
        "review",
        "inspect:1",
        "inspect:2",
        "discovered",
        "from-preset",
      ]);
      for (const input of [
        "/dynamic-template target",
        "/skill:dynamic-skill",
        "/inspect target",
        "ordinary prompt",
      ]) {
        const completed = yield* Stream.toPull(
          instance.adapter.streamEvents.pipe(
            Stream.filter((event) => event.type === "turn.completed"),
          ),
        );
        const receipt = yield* completed.pipe(Effect.forkChild({ startImmediately: true }));
        yield* instance.adapter.sendTurn({ threadId: session.threadId, input });
        yield* Fiber.join(receipt);
      }
      assert.equal(control.expanded[0], "Dynamic template target");
      assert.include(control.expanded[1], "Dynamic skill instruction.");
      assert.equal(control.expanded[2], "Unaliased inspect target");
      assert.equal(control.expanded[3], "ordinary prompt");
      assert.deepEqual(control.order, ["session_start", "resources_discover", "preset"]);
      yield* instance.adapter.stopSession(session.threadId);
    }).pipe(Effect.scoped, Effect.provide(testLayer())),
);

it.effect("does not publish resources from a failed real Pi bind", () =>
  Effect.gen(function* () {
    const publish = vi.fn(() => Effect.void);
    const adapter = yield* makePiAdapter({ publishInitializedResources: publish });
    const original = AgentSession.prototype.bindExtensions;
    vi.spyOn(AgentSession.prototype, "bindExtensions").mockImplementation(async function (
      this: AgentSession,
      bindings,
    ) {
      await original.call(this, bindings);
      throw new Error("fixture bind failed after dynamic discovery");
    });
    yield* adapter
      .startSession({ threadId: ThreadId.make("failed-bind"), cwd, runtimeMode: "full-access" })
      .pipe(Effect.flip);
    assert.equal(publish.mock.calls.length, 0);
    assert.deepEqual(yield* adapter.listSessions(), []);
    assert.deepEqual(control.order, ["session_start", "resources_discover"]);
  }).pipe(Effect.scoped, Effect.provide(testLayer())),
);
