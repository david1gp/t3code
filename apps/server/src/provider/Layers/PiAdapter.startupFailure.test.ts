// @effect-diagnostics nodeBuiltinImport:off - isolated pinned-SDK lifecycle fixture.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  AgentSession,
  createEventBus,
  DefaultResourceLoader,
  ExtensionRunner,
  ModelRuntime,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { assert, it } from "@effect/vitest";
import { afterAll, beforeAll, vi } from "vite-plus/test";
import { ProviderDriverKind, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Cause from "effect/Cause";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import { ServerConfig } from "../../config.ts";
import { makePiAdapter } from "./PiAdapter.ts";

vi.mock("effect/Scope", { spy: true });
vi.mock("effect/Queue", { spy: true });
vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => {
  const sdk = await importOriginal<typeof import("@earendil-works/pi-coding-agent")>();
  return { ...sdk, createEventBus: vi.fn(sdk.createEventBus) };
});

const testLayer = ServerConfig.layerTest(process.cwd(), { prefix: "pi-startup-failure-" }).pipe(
  Layer.provideMerge(NodeServices.layer),
);
const agentDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-pi-startup-failure-"));
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
const controlKey = Symbol.for("t3.pi.startup.failure.test");
const stages = [
  "bind",
  "bind-shutdown-error",
  "active-bind",
  "resources_discover",
  "model-before-preset",
  "model-after-preset",
  "preset",
  "thinking-validation",
  "thinking-set",
] as const;

beforeAll(() => {
  NodeFS.mkdirSync(NodePath.join(agentDir, "extensions"));
  NodeFS.writeFileSync(NodePath.join(agentDir, "presets.json"), '{"startup":{}}');
  NodeFS.writeFileSync(
    NodePath.join(agentDir, "extensions", "owned-resource.js"),
    `import fs from "node:fs";
     export default function (pi) {
       const control = globalThis[Symbol.for("t3.pi.startup.failure.test")];
       let off;
       pi.on("session_start", () => {
         control.order.push("session_start");
         fs.writeFileSync(control.resource, "extension-owned");
         off = pi.events.on("fixture:probe", () => control.probes++);
         control.emit = () => {
           pi.events.emit("fixture:probe", {});
           pi.events.emit("subagents:started", { id: "late-child" });
         };
         if (control.stage === "active-bind")
           pi.sendMessage({ customType: "startup", content: "start tool", display: false }, { triggerTurn: true });
       });
       pi.on("resources_discover", () => {
         control.order.push("resources_discover");
         return control.stage === "resources_discover" ? { promptPaths: ["unused.md"] } : {};
       });
       pi.on("input", () => ({ action: control.stage === "active-bind" ? "continue" : "handled" }));
       pi.on("agent_start", () => control.order.push("agent-start"));
       pi.registerCommand("preset", { handler: () => {
         control.order.push("preset");
         if (control.stage === "preset") throw new Error("fixture preset failure");
       }});
       pi.on("session_shutdown", async () => {
         control.order.push("shutdown-enter");
         control.shutdownEntered.resolve();
         await control.shutdownRelease.promise;
         off?.();
         fs.rmSync(control.resource);
         control.order.push("shutdown-exit");
         if (control.stage === "bind-shutdown-error") throw new Error("fixture shutdown failure");
       });
     }`,
  );
});

afterAll(() => {
  Reflect.deleteProperty(globalThis, controlKey);
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  NodeFS.rmSync(agentDir, { recursive: true, force: true });
});

for (const stage of stages) {
  it.effect(`cleans real SDK ${stage} startup failure through awaited shutdown exactly once`, () =>
    Effect.gen(function* () {
      process.env.PI_CODING_AGENT_DIR = agentDir;
      const control = {
        stage,
        order: [] as string[],
        probes: 0,
        emit: () => {},
        resource: NodePath.join(agentDir, `${stage}.resource`),
        shutdownEntered: Promise.withResolvers<void>(),
        shutdownRelease: Promise.withResolvers<void>(),
        toolEntered: Promise.withResolvers<void>(),
        toolAborted: Promise.withResolvers<void>(),
        toolRelease: Promise.withResolvers<void>(),
        settling: Promise.withResolvers<void>(),
        settleRelease: Promise.withResolvers<void>(),
      };
      Reflect.set(globalThis, controlKey, control);
      const adapter = yield* makePiAdapter();
      const models = (yield* Effect.promise(() => ModelRuntime.create())).getModels();
      const selected = models.find((model) =>
        stage === "active-bind" ? !model.reasoning : model.reasoning,
      )!;
      const other = models.find((model) => !model.reasoning)!;
      let sdk: AgentSession | undefined;
      let observerOffs = 0;
      let errorOffs = 0;
      const originalSubscribe = AgentSession.prototype.subscribe;
      const subscribe = vi.spyOn(AgentSession.prototype, "subscribe").mockImplementation(function (
        this: AgentSession,
        listener,
      ) {
        const off = originalSubscribe.call(this, listener);
        return () => {
          observerOffs++;
          off();
        };
      });
      const originalError = ExtensionRunner.prototype.onError;
      const onError = vi.spyOn(ExtensionRunner.prototype, "onError").mockImplementation(function (
        this: ExtensionRunner,
        listener,
      ) {
        const off = originalError.call(this, listener);
        return () => {
          errorOffs++;
          off();
        };
      });
      const originalBind = AgentSession.prototype.bindExtensions;
      const bind = vi
        .spyOn(AgentSession.prototype, "bindExtensions")
        .mockImplementation(async function (this: AgentSession, bindings) {
          // eslint-disable-next-line typescript/no-this-alias -- public SDK receiver retained for assertions.
          sdk = this;
          if (stage === "active-bind") {
            let calls = 0;
            this.agent.streamFunction = (model) => {
              const tool = this.agent.state.tools.find((entry) => entry.name === "bash")!;
              tool.execute = async (_id, _args, signal) => {
                signal?.addEventListener("abort", () => control.toolAborted.resolve(), {
                  once: true,
                });
                control.toolEntered.resolve();
                await control.toolRelease.promise;
                return { content: [{ type: "text", text: "startup aborted result" }], details: {} };
              };
              calls++;
              const message = {
                role: "assistant" as const,
                api: model.api,
                provider: model.provider,
                model: model.id,
                content:
                  calls === 1
                    ? [
                        {
                          type: "toolCall" as const,
                          id: "startup-tool",
                          name: "bash",
                          arguments: { command: "fixture" },
                        },
                      ]
                    : [],
                usage: {
                  input: 1,
                  output: 1,
                  cacheRead: 0,
                  cacheWrite: 0,
                  totalTokens: 2,
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
                },
                stopReason: calls === 1 ? ("toolUse" as const) : ("stop" as const),
                timestamp: 1,
              };
              return {
                async *[Symbol.asyncIterator]() {
                  yield { type: "done", reason: "toolUse", message };
                },
                result: async () => message,
              } as unknown as ReturnType<AgentSession["agent"]["streamFunction"]>;
            };
          }
          await originalBind.call(this, bindings);
          if (stage === "active-bind") {
            await control.toolEntered.promise;
            throw new Error("fixture active bind failure");
          }
          if (stage === "bind" || stage === "bind-shutdown-error")
            throw new Error("fixture bind failure");
          if (stage === "model-before-preset" || stage === "thinking-validation")
            this.state.model = other;
        });
      const extend = vi.spyOn(DefaultResourceLoader.prototype, "extendResources");
      if (stage === "resources_discover")
        extend.mockImplementation(() => {
          throw new Error("fixture resource installation failure");
        });
      const auth = vi.spyOn(ModelRuntime.prototype, "checkAuth").mockResolvedValue(undefined);
      const getAuth = vi
        .spyOn(ModelRuntime.prototype, "getAuth")
        .mockResolvedValue({ auth: { apiKey: "fake" } });
      const originalEmit = ExtensionRunner.prototype.emit;
      const emit = vi.spyOn(ExtensionRunner.prototype, "emit").mockImplementation(async function (
        this: ExtensionRunner,
        event,
      ) {
        if (stage === "active-bind" && event.type === "agent_settled") {
          control.settling.resolve();
          await control.settleRelease.promise;
          control.order.push("settled");
        }
        return originalEmit.call(this, event);
      });
      const originalPrompt = AgentSession.prototype.prompt;
      const prompt = vi.spyOn(AgentSession.prototype, "prompt").mockImplementation(async function (
        this: AgentSession,
        input,
        options,
      ) {
        await originalPrompt.call(this, input, options);
        if (stage === "model-after-preset") this.state.model = other;
      });
      const originalThinking = AgentSession.prototype.setThinkingLevel;
      const thinking = vi
        .spyOn(AgentSession.prototype, "setThinkingLevel")
        .mockImplementation(function (this: AgentSession, level, options) {
          originalThinking.call(this, level, options);
          if (stage === "thinking-set" && sdk === this && level === "off")
            throw new Error("fixture thinking persistence failure");
        });
      const originalDispose = AgentSession.prototype.dispose;
      const dispose = vi.spyOn(AgentSession.prototype, "dispose").mockImplementation(function (
        this: AgentSession,
      ) {
        control.order.push("dispose");
        originalDispose.call(this);
      });
      const abort = vi.spyOn(AgentSession.prototype, "abort");
      const close = vi.spyOn(Scope, "close");
      const queueShutdown = vi.spyOn(Queue, "shutdown");
      const offer = vi.spyOn(Queue, "offer");
      try {
        const startup = yield* adapter
          .startSession({
            threadId: ThreadId.make(`failed-${stage}`),
            provider: ProviderDriverKind.make("pi"),
            cwd: agentDir,
            runtimeMode: "full-access",
            modelSelection: {
              instanceId: ProviderInstanceId.make("pi"),
              model: `${selected.provider}/${selected.id}`,
              options: [
                ...(stage.startsWith("model-") || stage === "active-bind"
                  ? [{ id: "modelOverride", value: true }]
                  : []),
                ...(stage === "preset" || stage === "model-after-preset"
                  ? [{ id: "preset", value: "startup" }]
                  : []),
                ...(stage === "thinking-validation"
                  ? [{ id: "thinkingLevel", value: "high" }]
                  : []),
                ...(stage === "thinking-set" ? [{ id: "thinkingLevel", value: "off" }] : []),
              ],
            },
          })
          .pipe(Effect.exit, Effect.forkScoped({ startImmediately: true }));
        if (stage === "active-bind") {
          yield* Effect.promise(() => control.toolAborted.promise);
          assert.equal(dispose.mock.calls.length, 0);
          assert.notInclude(control.order, "shutdown-enter");
          control.toolRelease.resolve();
          yield* Effect.promise(() => control.settling.promise);
          assert.notInclude(
            control.order,
            "shutdown-enter",
            "abort awaits asynchronous SDK settlement",
          );
          control.settleRelease.resolve();
        }
        yield* Effect.promise(() => control.shutdownEntered.promise);
        if (stage === "active-bind") {
          assert.isTrue(
            sdk!.sessionManager
              .getBranch()
              .some((entry) => entry.type === "message" && entry.message.role === "toolResult"),
          );
          assert.include(control.order, "settled");
        }
        assert.isTrue(NodeFS.existsSync(control.resource));
        assert.equal(dispose.mock.calls.length, 0, "shutdown must finish before dispose");
        assert.equal(observerOffs, 0, "abort/shutdown retain observers until settlement");
        assert.equal(abort.mock.calls.length, 1);
        assert.isTrue(sdk!.isIdle);
        assert.isUndefined(startup.pollUnsafe(), "startup waits for extension shutdown");
        control.emit();
        assert.equal(control.probes, 1);
        control.shutdownRelease.resolve();
        const result = yield* Fiber.join(startup);
        assert.isTrue(Exit.isFailure(result));
        if (Exit.isFailure(result)) {
          const failure = Cause.squash(result.cause);
          assert.isTrue(failure instanceof Error);
          if (failure instanceof Error) {
            assert.equal(
              failure.name,
              stage === "thinking-validation"
                ? "ProviderAdapterValidationError"
                : stage === "preset" || stage.startsWith("model-") || stage === "thinking-set"
                  ? "ProviderAdapterRequestError"
                  : "ProviderAdapterProcessError",
            );
          }
        }
        assert.deepEqual(yield* adapter.listSessions(), []);
        assert.isFalse(NodeFS.existsSync(control.resource));
        assert.equal(dispose.mock.calls.length, 1);
        // Both the adapter event listener and summary-usage observer subscribe to
        // the SDK session; startup failure must dispose both listeners.
        assert.equal(observerOffs, 2);
        assert.equal(errorOffs, onError.mock.calls.length);
        assert.equal(close.mock.calls.length, 1);
        assert.equal(queueShutdown.mock.calls.length, 1);
        assert.deepEqual(control.order.slice(-3), ["shutdown-enter", "shutdown-exit", "dispose"]);
        assert.equal(control.order.filter((event) => event === "shutdown-enter").length, 1);
        const offers = offer.mock.calls.length;
        const bus = vi.mocked(createEventBus).mock.results.at(-1)!.value;
        bus.emit("fixture:probe", {});
        bus.emit("subagents:started", { id: "late-child" });
        assert.throws(control.emit, /stale/);
        assert.equal(control.probes, 1, "extension removes its own listener");
        assert.equal(offer.mock.calls.length, offers, "T3 bus observers are unsubscribed");
        yield* adapter.stopAll();
        assert.equal(dispose.mock.calls.length, 1, "failed starts never transfer into stopAll");
      } finally {
        control.shutdownRelease.resolve();
        control.toolRelease.resolve();
        control.settleRelease.resolve();
        subscribe.mockRestore();
        onError.mockRestore();
        bind.mockRestore();
        extend.mockRestore();
        auth.mockRestore();
        getAuth.mockRestore();
        emit.mockRestore();
        prompt.mockRestore();
        thinking.mockRestore();
        dispose.mockRestore();
        abort.mockRestore();
        close.mockRestore();
        queueShutdown.mockRestore();
        offer.mockRestore();
      }
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );
}

it.effect(
  "keeps an independent old session usable after real SDK replacement startup failure",
  () =>
    Effect.gen(function* () {
      process.env.PI_CODING_AGENT_DIR = agentDir;
      const adapter = yield* makePiAdapter();
      const controlCreate = (name: string) => ({
        stage: "idle",
        order: [] as string[],
        probes: 0,
        emit: () => {},
        resource: NodePath.join(agentDir, name),
        shutdownEntered: Promise.withResolvers<void>(),
        shutdownRelease: Promise.withResolvers<void>(),
      });
      const previousControl = controlCreate("previous.resource");
      Reflect.set(globalThis, controlKey, previousControl);
      const threadId = ThreadId.make("independent-replacement");
      const input = {
        threadId,
        provider: ProviderDriverKind.make("pi"),
        cwd: agentDir,
        runtimeMode: "full-access" as const,
      };
      const previous = yield* adapter.startSession(input);
      const failedControl = controlCreate("replacement.resource");
      Reflect.set(globalThis, controlKey, failedControl);
      failedControl.shutdownRelease.resolve();
      const originalBind = AgentSession.prototype.bindExtensions;
      const bind = vi
        .spyOn(AgentSession.prototype, "bindExtensions")
        .mockImplementation(async function (this: AgentSession, bindings) {
          await originalBind.call(this, bindings);
          throw new Error("replacement bind failure");
        });
      const open = vi.spyOn(SessionManager, "open");
      try {
        yield* adapter.startSession(input).pipe(Effect.flip);
        assert.deepEqual(yield* adapter.listSessions(), [previous]);
        assert.isTrue(NodeFS.existsSync(previousControl.resource));
        assert.isFalse(NodeFS.existsSync(failedControl.resource));
        assert.equal(open.mock.calls.length, 0);
        yield* adapter.sendTurn({ threadId, input: "handled still usable" });
        yield* adapter.readThread(threadId);
        previousControl.shutdownRelease.resolve();
        yield* adapter.stopSession(threadId);
        assert.isFalse(NodeFS.existsSync(previousControl.resource));
      } finally {
        previousControl.shutdownRelease.resolve();
        failedControl.shutdownRelease.resolve();
        bind.mockRestore();
        open.mockRestore();
      }
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
);
