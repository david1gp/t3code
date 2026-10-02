// @effect-diagnostics nodeBuiltinImport:off - isolated pinned-SDK extension fixture.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { AgentSession, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { assert, it } from "@effect/vitest";
import { afterAll, beforeAll, vi } from "vite-plus/test";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Predicate from "effect/Predicate";
import * as Stream from "effect/Stream";
import { ServerConfig } from "../../config.ts";
import { makePiAdapter } from "./PiAdapter.ts";

const testLayer = ServerConfig.layerTest(process.cwd(), { prefix: "pi-startup-test-" }).pipe(
  Layer.provideMerge(NodeServices.layer),
);
const agentDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-pi-startup-"));
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
const controlKey = Symbol.for("t3.pi.startup.test");

beforeAll(() => {
  NodeFS.mkdirSync(NodePath.join(agentDir, "extensions"));
  NodeFS.writeFileSync(NodePath.join(agentDir, "presets.json"), '{"startup":{}}');
  NodeFS.writeFileSync(
    NodePath.join(agentDir, "extensions", "startup.js"),
    `export default function (pi) {
      const control = globalThis[Symbol.for("t3.pi.startup.test")];
      const run = async (stage) => {
        control.order.push(stage);
        if (stage !== control.stage) return;
        pi.events.emit("subagents:started", { id: "startup-child", description: stage });
        pi.sendMessage({ customType: "startup", content: stage, display: false }, { triggerTurn: true });
        await control.providerEntered.promise;
        await control.bindRelease.promise;
      };
      pi.on("session_start", () => run("session_start"));
      pi.on("resources_discover", async () => {
        await run("resources_discover");
        return {};
      });
      pi.registerCommand("preset", { handler: () => run("preset") });
      pi.on("agent_settled", () => {
        pi.events.emit("subagents:completed", { id: "startup-child", result: "startup child answer" });
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

it.effect(
  "publishes an idle initial lifecycle after real SDK bind and state-only preset dispatch",
  () =>
    Effect.gen(function* () {
      process.env.PI_CODING_AGENT_DIR = agentDir;
      const control = { stage: "idle", order: [] as string[] };
      Reflect.set(globalThis, controlKey, control);
      const adapter = yield* makePiAdapter();
      const events: ProviderRuntimeEvent[] = [];
      const initialized = yield* Deferred.make<void>();
      yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.gen(function* () {
          events.push(event);
          if (event.type === "thread.started") yield* Deferred.succeed(initialized, undefined);
        }),
      ).pipe(Effect.forkScoped({ startImmediately: true }));
      const threadId = ThreadId.make("startup-idle");
      const model = (yield* Effect.promise(() => ModelRuntime.create())).getModels()[0]!;
      const session = yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("pi"),
        cwd: agentDir,
        runtimeMode: "full-access",
        modelSelection: {
          instanceId: ProviderInstanceId.make("pi"),
          model: `${model.provider}/${model.id}`,
          options: [{ id: "preset", value: "startup" }],
        },
      });
      yield* Deferred.await(initialized);
      assert.equal(session.status, "ready");
      assert.isUndefined(session.activeTurnId);
      assert.deepEqual(control.order, ["session_start", "resources_discover", "preset"]);
      assert.deepEqual(
        events.map((event) => event.type),
        ["session.started", "session.state.changed", "thread.started"],
      );
      assert.deepEqual(
        events
          .filter((event) => event.type === "session.state.changed")
          .map((event) => event.payload.state),
        ["ready"],
      );
      assert.deepEqual((yield* adapter.readThread(threadId)).turns, []);
      yield* adapter.stopSession(threadId);
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
);

for (const stage of ["session_start", "resources_discover", "preset"] as const) {
  for (const active of [false, true]) {
    it.effect(
      `buffers real SDK ${stage} startup outputs before initial lifecycle with ${active ? "active" : "settled"} inference`,
      () =>
        Effect.gen(function* () {
          process.env.PI_CODING_AGENT_DIR = agentDir;
          const control = {
            stage,
            order: [] as string[],
            providerEntered: Promise.withResolvers<void>(),
            inferenceRelease: Promise.withResolvers<void>(),
            bindRelease: Promise.withResolvers<void>(),
            nativeSettled: Promise.withResolvers<void>(),
          };
          Reflect.set(globalThis, controlKey, control);
          const adapter = yield* makePiAdapter();
          const events: ProviderRuntimeEvent[] = [];
          const completed = yield* Deferred.make<void>();
          const started = yield* Deferred.make<void>();
          yield* Stream.runForEach(adapter.streamEvents, (event) =>
            Effect.gen(function* () {
              events.push(event);
              if (event.type === "turn.started") yield* Deferred.succeed(started, undefined);
              if (event.type === "turn.completed") yield* Deferred.succeed(completed, undefined);
            }),
          ).pipe(Effect.forkScoped({ startImmediately: true }));
          const model = (yield* Effect.promise(() => ModelRuntime.create()))
            .getModels()
            .find((candidate) => !candidate.reasoning)!;
          const authSpy = vi.spyOn(ModelRuntime.prototype, "getAuth").mockResolvedValue({
            auth: { apiKey: "isolated-fake-provider" },
          });
          const originalBind = AgentSession.prototype.bindExtensions;
          let sdk: AgentSession | undefined;
          const bindSpy = vi
            .spyOn(AgentSession.prototype, "bindExtensions")
            .mockImplementation(async function (this: AgentSession, bindings) {
              // eslint-disable-next-line typescript/no-this-alias -- SDK prototype fixture captures its receiver.
              sdk = this;
              this.subscribe((event) => {
                if (event.type === "agent_settled") control.nativeSettled.resolve();
              });
              this.agent.streamFunction = (selected) => {
                const message = {
                  role: "assistant" as const,
                  api: selected.api,
                  provider: selected.provider,
                  model: selected.id,
                  content: [{ type: "text" as const, text: "startup answer" }],
                  usage: {
                    input: 2,
                    output: 1,
                    cacheRead: 0,
                    cacheWrite: 0,
                    totalTokens: 3,
                    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
                  },
                  stopReason: "stop" as const,
                  timestamp: 1,
                };
                return {
                  async *[Symbol.asyncIterator]() {
                    yield { type: "start", partial: message };
                    yield {
                      type: "text_delta",
                      contentIndex: 0,
                      delta: "startup answer",
                      partial: message,
                    };
                    control.providerEntered.resolve();
                    await control.inferenceRelease.promise;
                    yield { type: "done", reason: "stop", message };
                  },
                  result: async () => message,
                } as unknown as ReturnType<AgentSession["agent"]["streamFunction"]>;
              };
              await originalBind.call(this, bindings);
            });
          const threadId = ThreadId.make(`startup-${stage}-${active}`);
          try {
            const startup = yield* adapter
              .startSession({
                threadId,
                provider: ProviderDriverKind.make("pi"),
                cwd: agentDir,
                runtimeMode: "full-access",
                modelSelection: {
                  instanceId: ProviderInstanceId.make("pi"),
                  model: `${model.provider}/${model.id}`,
                  options: [
                    { id: "modelOverride", value: true },
                    ...(stage === "preset" ? [{ id: "preset", value: "startup" }] : []),
                  ],
                },
              })
              .pipe(Effect.forkScoped({ startImmediately: true }));
            yield* Effect.promise(() => control.providerEntered.promise);
            assert.deepEqual(events, [], "bind/preset work must remain buffered");
            // The native SDK has started, but the runtime consumer is still gated.
            // The durable marker must already precede SDK assistant persistence.
            assert.equal(
              sdk!.sessionManager
                .getBranch()
                .filter((entry) => entry.type === "custom" && entry.customType === "t3.turn")
                .length,
              1,
            );
            if (!active) {
              control.inferenceRelease.resolve();
              yield* Effect.promise(() => control.nativeSettled.promise);
            }
            control.bindRelease.resolve();
            const session = yield* Fiber.join(startup);
            yield* Deferred.await(started);
            assert.equal(session.status, active ? "running" : "ready");
            assert.equal(session.activeTurnId !== undefined, active);
            assert.deepEqual(control.order, [
              "session_start",
              "resources_discover",
              ...(stage === "preset" ? ["preset"] : []),
            ]);
            assert.deepEqual(
              events.slice(0, 5).map((event) => event.type),
              [
                "session.started",
                "session.state.changed",
                "thread.started",
                "task.started",
                "turn.started",
              ],
            );
            assert.deepEqual(
              events
                .filter((event) => event.type === "session.state.changed")
                .map((event) => event.payload.state),
              ["running"],
              "initial lifecycle cannot claim idle readiness after startup inference began",
            );
            control.inferenceRelease.resolve();
            yield* Deferred.await(completed);
            assert.equal(events.filter((event) => event.type === "turn.started").length, 1);
            assert.equal(events.filter((event) => event.type === "turn.completed").length, 1);
            assert.deepEqual(
              events
                .filter((event) => event.type === "content.delta")
                .map((event) => event.payload.delta),
              ["startup answer"],
            );
            assert.deepEqual(
              events
                .filter((event) => event.type === "task.started" || event.type === "task.completed")
                .map((event) => event.type),
              ["task.started", "task.completed"],
            );
            const turn = events.find((event) => event.type === "turn.started")!;
            assert.deepEqual(
              events
                .filter((event) => event.type === "task.started" || event.type === "task.completed")
                .map((event) => event.turnId),
              [undefined, undefined],
              "startup-only child has no origin before the SDK activation and cannot adopt it later",
            );
            const history = yield* adapter.readThread(threadId);
            assert.deepEqual(
              history.turns.map((entry) => entry.id),
              [turn.turnId],
            );
            assert.include(
              history.turns[0]!.items.flatMap((item) =>
                Predicate.isObject(item) ? [Reflect.get(item, "role")] : [],
              ),
              "assistant",
            );
            assert.equal((yield* adapter.listSessions())[0]!.status, "ready");
            yield* adapter.stopSession(threadId);
          } finally {
            control.bindRelease.resolve();
            control.inferenceRelease.resolve();
            bindSpy.mockRestore();
            authSpy.mockRestore();
          }
        }).pipe(Effect.scoped, Effect.provide(testLayer)),
    );
  }
}
