// @effect-diagnostics nodeBuiltinImport:off - SDK sessions persist in isolated test state.
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  createAgentSession,
  createEventBus,
  ModelRuntime,
  type AgentSession,
  type AgentSessionEvent,
} from "@earendil-works/pi-coding-agent";
import { assert, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  RuntimeTaskId,
  ThreadId,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { ServerConfig } from "../../config.ts";
import { makePiAdapter } from "./PiAdapter.ts";

vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@earendil-works/pi-coding-agent")>();
  return {
    ...actual,
    createAgentSession: vi.fn(),
    createEventBus: vi.fn(actual.createEventBus),
  };
});

const testLayer = ServerConfig.layerTest(process.cwd(), { prefix: "pi-sdk-events-test-" }).pipe(
  Layer.provideMerge(NodeServices.layer),
);
const threadId = ThreadId.make("pi-sdk-events");
const start = {
  threadId,
  provider: ProviderDriverKind.make("pi"),
  cwd: process.cwd(),
  runtimeMode: "full-access" as const,
};

function sdkSession(
  prompt: (
    emit: (event: AgentSessionEvent) => void,
    preflight: (success: boolean) => void,
  ) => Promise<void>,
  sdkOptions: {
    readonly isStreaming?: () => boolean;
    readonly steer?: (text: string) => Promise<"queued" | "handled">;
    readonly abort?: () => Promise<void>;
    readonly clearQueue?: () => void;
    readonly availableLevels?: () => Array<Parameters<AgentSession["setThinkingLevel"]>[0]>;
    readonly setThinkingLevel?: (level: Parameters<AgentSession["setThinkingLevel"]>[0]) => void;
    readonly modelMetadata?: (
      provider: string,
      id: string,
    ) => {
      reasoning: boolean;
      thinkingLevelMap?: NonNullable<AgentSession["model"]>["thinkingLevelMap"];
    };
    readonly setModel?: () => void;
    readonly dispose?: () => void;
    readonly restoredModel?: AgentSession["model"];
    readonly listen?: (emit: (event: AgentSessionEvent) => void) => void;
    readonly contextUsage?: () => ReturnType<AgentSession["getContextUsage"]>;
  } = {},
) {
  vi.mocked(createAgentSession).mockImplementation(async (sessionOptions) => {
    let listener: (event: AgentSessionEvent) => void = () => {};
    let model = sdkOptions.restoredModel ?? sessionOptions?.model;
    let thinkingLevel = "high";
    return {
      session: {
        get model() {
          return model;
        },
        get thinkingLevel() {
          return thinkingLevel;
        },
        modelRuntime: {
          getModel: (provider: string, id: string) => ({
            provider,
            id,
            reasoning: id === "reasoning",
            ...sdkOptions.modelMetadata?.(provider, id),
          }),
        },
        setModel: async (selected: typeof model) => {
          sdkOptions.setModel?.();
          model = selected;
        },
        getAvailableThinkingLevels: () => sdkOptions.availableLevels?.() ?? ["off", "high"],
        setThinkingLevel: (level: Parameters<AgentSession["setThinkingLevel"]>[0]) => {
          thinkingLevel = level;
          sdkOptions.setThinkingLevel?.(level);
        },
        sessionManager: sessionOptions?.sessionManager,
        subscribe: (next: typeof listener) => {
          listener = next;
          sdkOptions.listen?.(next);
          return () => {};
        },
        bindExtensions: async () => {},
        extensionRunner: { hasHandlers: () => false, emit: async () => undefined },
        prompt: (_text: string, config: { preflightResult: (success: boolean) => void }) =>
          prompt(listener, config.preflightResult),
        get isStreaming() {
          return sdkOptions.isStreaming?.() ?? false;
        },
        steer: (text: string) => sdkOptions.steer?.(text) ?? Promise.resolve("queued"),
        abort: () => sdkOptions.abort?.() ?? Promise.resolve(),
        clearQueue: () => sdkOptions.clearQueue?.(),
        dispose: () => sdkOptions.dispose?.(),
        getContextUsage: () => sdkOptions.contextUsage?.(),
      },
    } as unknown as Awaited<ReturnType<typeof createAgentSession>>;
  });
}

it.effect("applies a selected thinking level to the new Pi session without changing defaults", () =>
  Effect.gen(function* () {
    const model = (yield* Effect.promise(() => ModelRuntime.create())).getAvailableSnapshot()[0]!;
    const applied: string[] = [];
    sdkSession(async () => {}, { setThinkingLevel: (level) => applied.push(level) });
    const adapter = yield* makePiAdapter();
    yield* adapter.startSession({
      ...start,
      modelSelection: {
        instanceId: ProviderInstanceId.make("pi"),
        model: `${model.provider}/${model.id}`,
        options: [{ id: "thinkingLevel", value: "high" }],
      },
    });
    assert.deepEqual(applied, ["high"]);
    assert.isUndefined(vi.mocked(createAgentSession).mock.lastCall?.[0]?.thinkingLevel);
    yield* adapter.stopSession(threadId);
  }).pipe(Effect.scoped, Effect.provide(testLayer)),
);

it.effect("uses the advertised medium default instead of SDK high when no level is sent", () =>
  Effect.gen(function* () {
    const model = (yield* Effect.promise(() => ModelRuntime.create()))
      .getModels()
      .find(
        (candidate) =>
          candidate.reasoning &&
          candidate.thinkingLevelMap?.medium !== null &&
          candidate.thinkingLevelMap?.high !== null,
      )!;
    let currentLevel = "high"; // The SDK restored/configured level.
    const applied: string[] = [];
    const prompts: string[] = [];
    sdkSession(
      async (emit, preflight) => {
        prompts.push(currentLevel);
        preflight(true);
        emit({ type: "agent_settled" });
      },
      {
        availableLevels: () => ["off", "minimal", "low", "medium", "high"],
        setThinkingLevel: (level) => {
          currentLevel = level;
          applied.push(level);
        },
      },
    );
    const adapter = yield* makePiAdapter();
    const events: ProviderRuntimeEvent[] = [];
    yield* adapter.streamEvents.pipe(
      Stream.runForEach((event) =>
        Effect.sync(() => {
          events.push(event);
        }),
      ),
      Effect.forkScoped({ startImmediately: true }),
    );
    const modelSelection = {
      instanceId: ProviderInstanceId.make("pi"),
      model: `${model.provider}/${model.id}`,
    };
    yield* adapter.startSession({ ...start, modelSelection });
    assert.deepEqual(applied, ["medium"]);
    assert.isUndefined(vi.mocked(createAgentSession).mock.lastCall?.[0]?.thinkingLevel);
    yield* adapter.sendTurn({ threadId, input: "first", modelSelection });
    yield* adapter.sendTurn({
      threadId,
      input: "explicit high",
      modelSelection: { ...modelSelection, options: [{ id: "thinkingLevel", value: "high" }] },
    });
    yield* adapter.sendTurn({ threadId, input: "default again" });
    assert.deepEqual(prompts, ["medium", "high", "medium"]);
    assert.deepEqual(applied, ["medium", "medium", "high", "medium"]);
    assert.deepEqual(
      events.filter((event) => event.type === "turn.started").map((event) => event.payload.effort),
      ["medium", "high", "medium"],
    );
    yield* adapter.stopSession(threadId);
  }).pipe(Effect.scoped, Effect.provide(testLayer)),
);

it.effect("keeps restored off-only models off with no thinking option", () =>
  Effect.gen(function* () {
    const model = (yield* Effect.promise(() => ModelRuntime.create()))
      .getAvailableSnapshot()
      .find((candidate) => candidate.reasoning)!;
    for (const reasoning of [true, false]) {
      const applied: string[] = [];
      let currentLevel = "high";
      const prompts: string[] = [];
      sdkSession(
        async (emit, preflight) => {
          prompts.push(currentLevel);
          preflight(true);
          emit({ type: "agent_settled" });
        },
        {
          restoredModel: {
            ...model,
            reasoning,
            thinkingLevelMap: {
              minimal: null,
              low: null,
              medium: null,
              high: null,
              xhigh: null,
              max: null,
            },
          },
          availableLevels: () => ["off"],
          setThinkingLevel: (level) => {
            currentLevel = level;
            applied.push(level);
          },
        },
      );
      const adapter = yield* makePiAdapter();
      yield* adapter.startSession(start);
      yield* adapter.sendTurn({ threadId, input: "off-only" });
      assert.deepEqual(applied, ["off", "off"]);
      assert.deepEqual(prompts, ["off"]);
      yield* adapter.stopSession(threadId);
    }
  }).pipe(Effect.scoped, Effect.provide(testLayer)),
);

it.effect("rejects an unsupported explicit start level before opening or stopping a session", () =>
  Effect.gen(function* () {
    const model = (yield* Effect.promise(() => ModelRuntime.create()))
      .getModels()
      .find((candidate) => !candidate.reasoning)!;
    let stopped = 0;
    sdkSession(async () => {}, { dispose: () => stopped++ });
    const adapter = yield* makePiAdapter();
    const previous = yield* adapter.startSession(start);
    const opens = vi.mocked(createAgentSession).mock.calls.length;
    const error = yield* adapter
      .startSession({
        ...start,
        modelSelection: {
          instanceId: ProviderInstanceId.make("pi"),
          model: `${model.provider}/${model.id}`,
          options: [{ id: "thinkingLevel", value: "high" }],
        },
      })
      .pipe(Effect.flip);
    assert.equal(error._tag, "ProviderAdapterValidationError");
    assert.equal(vi.mocked(createAgentSession).mock.calls.length, opens);
    assert.equal(stopped, 0);
    assert.deepEqual((yield* adapter.listSessions())[0], previous);
    yield* adapter.stopSession(threadId);
  }).pipe(Effect.scoped, Effect.provide(testLayer)),
);

it.effect(
  "sets explicit thinking after switching models and restores the default for an absent option",
  () =>
    Effect.gen(function* () {
      const calls: string[] = [];
      sdkSession(
        async (emit, preflight) => {
          calls.push("prompt");
          preflight(true);
          emit({ type: "agent_settled" });
        },
        {
          setModel: () => calls.push("model"),
          setThinkingLevel: (level) => calls.push(`thinking:${level}`),
        },
      );
      const adapter = yield* makePiAdapter();
      yield* adapter.startSession(start);
      yield* adapter.sendTurn({
        threadId,
        input: "first",
        modelSelection: {
          instanceId: ProviderInstanceId.make("pi"),
          model: "test/reasoning",
          options: [{ id: "thinkingLevel", value: "off" }],
        },
      });
      yield* adapter.sendTurn({ threadId, input: "second" });
      assert.deepEqual(calls, ["model", "thinking:off", "prompt", "thinking:medium", "prompt"]);
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
);

it.effect("clamps absent thinking levels using the selected model's SDK mapping", () =>
  Effect.gen(function* () {
    const calls: string[] = [];
    let currentLevel = "high";
    sdkSession(
      async (emit, preflight) => {
        calls.push(`prompt:${currentLevel}`);
        preflight(true);
        emit({ type: "agent_settled" });
      },
      {
        setModel: () => calls.push("model"),
        setThinkingLevel: (level) => {
          currentLevel = level;
          calls.push(`thinking:${level}`);
        },
        modelMetadata: (_provider, id) => ({
          reasoning: true,
          thinkingLevelMap:
            id === "upward"
              ? { medium: null, high: "native-high" }
              : id === "downward"
                ? { medium: null, high: null, xhigh: null, max: null }
                : id === "extra-high"
                  ? { medium: null, high: null, xhigh: "native-extra", max: null }
                  : { minimal: null, low: null, medium: null, high: null, xhigh: null, max: null },
        }),
      },
    );
    const adapter = yield* makePiAdapter();
    yield* adapter.startSession(start);
    for (const [model, expected] of [
      ["upward", "high"],
      ["downward", "low"],
      ["extra-high", "xhigh"],
      ["off-only", "off"],
    ] as const) {
      calls.length = 0;
      yield* adapter.sendTurn({
        threadId,
        input: model,
        modelSelection: { instanceId: ProviderInstanceId.make("pi"), model: `test/${model}` },
      });
      assert.deepEqual(calls, ["model", `thinking:${expected}`, `prompt:${expected}`]);
    }
    yield* adapter.stopSession(threadId);
  }).pipe(Effect.scoped, Effect.provide(testLayer)),
);

it.effect(
  "rejects a level unsupported by the candidate model without switching the active model",
  () =>
    Effect.gen(function* () {
      const model = (yield* Effect.promise(() => ModelRuntime.create()))
        .getAvailableSnapshot()
        .find((candidate) => candidate.reasoning)!;
      const calls: string[] = [];
      sdkSession(
        async () => {
          calls.push("prompt");
        },
        {
          availableLevels: () => ["off", "high"],
          setModel: () => calls.push("model"),
          setThinkingLevel: () => calls.push("thinking"),
        },
      );
      const adapter = yield* makePiAdapter();
      const previous = yield* adapter.startSession({
        ...start,
        modelSelection: {
          instanceId: ProviderInstanceId.make("pi"),
          model: `${model.provider}/${model.id}`,
        },
      });
      calls.length = 0;
      const error = yield* adapter
        .sendTurn({
          threadId,
          input: "hello",
          modelSelection: {
            instanceId: ProviderInstanceId.make("pi"),
            model: "test/plain",
            options: [{ id: "thinkingLevel", value: "high" }],
          },
        })
        .pipe(Effect.flip);
      assert.equal(error._tag, "ProviderAdapterValidationError");
      assert.deepEqual(calls, []);
      assert.deepEqual((yield* adapter.listSessions())[0], previous);
      assert.deepEqual(yield* adapter.readThread(threadId), { threadId, turns: [] });
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
);

it.effect(
  "completes a Pi turn only after the SDK agent_settled event and closes streamed items",
  () =>
    Effect.gen(function* () {
      sdkSession(async (emit, preflight) => {
        preflight(true);
        emit({
          type: "message_update",
          assistantMessageEvent: { type: "text_delta", delta: "done", contentIndex: 0 },
        } as AgentSessionEvent);
        emit({
          type: "message_end",
          message: { role: "assistant", stopReason: "stop" },
        } as AgentSessionEvent);
        emit({ type: "agent_settled" });
      });
      const adapter = yield* makePiAdapter();
      const events: ProviderRuntimeEvent[] = [];
      yield* adapter.streamEvents.pipe(
        Stream.runForEach((event) =>
          Effect.sync(() => {
            events.push(event);
          }),
        ),
        Effect.forkScoped({ startImmediately: true }),
      );
      yield* adapter.startSession(start);
      yield* adapter.sendTurn({ threadId, input: "hello" });
      assert.deepEqual(
        events
          .filter(
            (event) =>
              event.type === "turn.started" ||
              event.type === "item.started" ||
              event.type === "content.delta" ||
              event.type === "item.completed" ||
              event.type === "turn.completed",
          )
          .map((event) => event.type),
        ["turn.started", "item.started", "content.delta", "item.completed", "turn.completed"],
      );
      assert.equal((yield* adapter.listSessions())[0]?.status, "ready");
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
);

it.effect("terminates a rejected SDK preflight instead of leaving a running turn", () =>
  Effect.gen(function* () {
    sdkSession(async (_emit, _preflight) => {
      throw new Error("No API key for model");
    });
    const adapter = yield* makePiAdapter();
    const events: ProviderRuntimeEvent[] = [];
    yield* adapter.streamEvents.pipe(
      Stream.runForEach((event) =>
        Effect.sync(() => {
          events.push(event);
        }),
      ),
      Effect.forkScoped({ startImmediately: true }),
    );
    yield* adapter.startSession(start);
    const error = yield* adapter.sendTurn({ threadId, input: "hello" }).pipe(Effect.flip);
    assert.equal(error._tag, "ProviderAdapterRequestError");
    assert.equal((yield* adapter.listSessions())[0]?.status, "ready");
    assert.equal((yield* adapter.listSessions())[0]?.activeTurnId, undefined);
    assert.deepEqual(
      events.filter((event) => event.type === "turn.completed").map((event) => event.payload.state),
      ["failed"],
    );
    assert.include(
      events.find((event) => event.type === "turn.completed")?.payload.errorMessage,
      "No API key",
    );
  }).pipe(Effect.scoped, Effect.provide(testLayer)),
);

it.effect("rejects a Pi preflight that reports false without starting an agent run", () =>
  Effect.gen(function* () {
    sdkSession(async (_emit, preflight) => {
      preflight(false);
    });
    const adapter = yield* makePiAdapter();
    yield* adapter.startSession(start);
    const error = yield* adapter.sendTurn({ threadId, input: "hello" }).pipe(Effect.flip);
    assert.equal(error._tag, "ProviderAdapterRequestError");
    assert.equal((yield* adapter.listSessions())[0]?.status, "ready");
    assert.equal((yield* adapter.listSessions())[0]?.activeTurnId, undefined);
  }).pipe(Effect.scoped, Effect.provide(testLayer)),
);

it.effect("marks a failed assistant item and turn from the final SDK message", () =>
  Effect.gen(function* () {
    sdkSession(async (emit, preflight) => {
      preflight(true);
      emit({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: "partial", contentIndex: 0 },
      } as AgentSessionEvent);
      emit({
        type: "message_end",
        message: { role: "assistant", stopReason: "error", errorMessage: "model failed" },
      } as AgentSessionEvent);
      emit({ type: "agent_settled" });
    });
    const adapter = yield* makePiAdapter();
    const events: ProviderRuntimeEvent[] = [];
    yield* adapter.streamEvents.pipe(
      Stream.runForEach((event) =>
        Effect.sync(() => {
          events.push(event);
        }),
      ),
      Effect.forkScoped({ startImmediately: true }),
    );
    yield* adapter.startSession(start);
    yield* adapter.sendTurn({ threadId, input: "hello" });
    assert.deepEqual(
      events
        .filter((event) => event.type === "item.completed")
        .map((event) => event.payload.status),
      ["failed"],
    );
    assert.deepEqual(
      events.filter((event) => event.type === "turn.completed").map((event) => event.payload.state),
      ["failed"],
    );
  }).pipe(Effect.scoped, Effect.provide(testLayer)),
);

it.effect("rejects a concurrent send during Pi preflight without starting a second run", () =>
  Effect.gen(function* () {
    let entered!: () => void;
    const promptEntered = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let finish!: () => void;
    const finishPrompt = new Promise<void>((resolve) => {
      finish = resolve;
    });
    let prompts = 0;
    sdkSession(async (emit, preflight) => {
      prompts++;
      entered();
      await finishPrompt;
      preflight(true);
      emit({ type: "agent_settled" });
    });
    const adapter = yield* makePiAdapter();
    const events: ProviderRuntimeEvent[] = [];
    yield* adapter.streamEvents.pipe(
      Stream.runForEach((event) =>
        Effect.sync(() => {
          events.push(event);
        }),
      ),
      Effect.forkScoped({ startImmediately: true }),
    );
    yield* adapter.startSession(start);
    const first = yield* Effect.forkChild(adapter.sendTurn({ threadId, input: "first" }), {
      startImmediately: true,
    });
    yield* Effect.promise(() => promptEntered);
    const rejected = yield* adapter.sendTurn({ threadId, input: "second" }).pipe(Effect.flip);
    assert.equal(rejected._tag, "ProviderAdapterRequestError");
    assert.equal(prompts, 1);
    assert.equal((yield* adapter.listSessions())[0]?.status, "running");
    finish();
    yield* Fiber.join(first);
    assert.deepEqual(
      events.filter((event) => event.type === "turn.completed").map((event) => event.payload.state),
      ["completed"],
    );
    assert.equal(events.filter((event) => event.type === "turn.started").length, 1);
  }).pipe(Effect.scoped, Effect.provide(testLayer)),
);

it.effect("rejects a failed steer but keeps the original Pi turn active until it settles", () =>
  Effect.gen(function* () {
    let finish!: () => void;
    const finishPrompt = new Promise<void>((resolve) => {
      finish = resolve;
    });
    let started!: () => void;
    const promptStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    let streaming = false;
    let steers = 0;
    sdkSession(
      async (emit, preflight) => {
        streaming = true;
        preflight(true);
        started();
        await finishPrompt;
        streaming = false;
        emit({ type: "agent_settled" });
      },
      {
        isStreaming: () => streaming,
        steer: async () => {
          steers++;
          throw new Error("steer rejected by Pi");
        },
      },
    );
    const adapter = yield* makePiAdapter();
    const events: ProviderRuntimeEvent[] = [];
    yield* adapter.streamEvents.pipe(
      Stream.runForEach((event) =>
        Effect.sync(() => {
          events.push(event);
        }),
      ),
      Effect.forkScoped({ startImmediately: true }),
    );
    yield* adapter.startSession(start);
    const first = yield* Effect.forkChild(adapter.sendTurn({ threadId, input: "first" }), {
      startImmediately: true,
    });
    yield* Effect.promise(() => promptStarted);
    const activeTurnId = (yield* adapter.listSessions())[0]?.activeTurnId;
    const rejected = yield* adapter.sendTurn({ threadId, input: "second" }).pipe(Effect.flip);
    assert.equal(rejected._tag, "ProviderAdapterRequestError");
    assert.equal(steers, 1);
    assert.equal((yield* adapter.listSessions())[0]?.activeTurnId, activeTurnId);
    assert.equal(events.filter((event) => event.type === "turn.completed").length, 0);
    finish();
    yield* Fiber.join(first);
    assert.deepEqual(
      events.filter((event) => event.type === "turn.completed").map((event) => event.payload.state),
      ["completed"],
    );
  }).pipe(Effect.scoped, Effect.provide(testLayer)),
);

it.effect("queues a Pi steer into the existing running turn without another prompt", () =>
  Effect.gen(function* () {
    let started!: () => void;
    const promptStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    let finish!: () => void;
    const finishPrompt = new Promise<void>((resolve) => {
      finish = resolve;
    });
    let prompts = 0;
    const steers: string[] = [];
    let streaming = false;
    sdkSession(
      async (emit, preflight) => {
        prompts++;
        streaming = true;
        preflight(true);
        started();
        await finishPrompt;
        streaming = false;
        emit({ type: "agent_settled" });
      },
      {
        isStreaming: () => streaming,
        steer: async (text) => {
          steers.push(text);
          return "queued";
        },
      },
    );
    const adapter = yield* makePiAdapter();
    const events: ProviderRuntimeEvent[] = [];
    yield* adapter.streamEvents.pipe(
      Stream.runForEach((event) =>
        Effect.sync(() => {
          events.push(event);
        }),
      ),
      Effect.forkScoped({ startImmediately: true }),
    );
    yield* adapter.startSession(start);
    const first = yield* Effect.forkChild(adapter.sendTurn({ threadId, input: "first" }), {
      startImmediately: true,
    });
    yield* Effect.promise(() => promptStarted);
    const steered = yield* adapter.sendTurn({ threadId, input: "second" });
    assert.equal(steered.turnId, (yield* adapter.listSessions())[0]?.activeTurnId);
    assert.equal(prompts, 1);
    assert.deepEqual(steers, ["second"]);
    finish();
    assert.equal((yield* Fiber.join(first)).turnId, steered.turnId);
    assert.equal(events.filter((event) => event.type === "turn.started").length, 1);
    assert.equal(events.filter((event) => event.type === "turn.completed").length, 1);
  }).pipe(Effect.scoped, Effect.provide(testLayer)),
);

it.effect("settles an interrupted prompt rejected during preflight as cancelled", () =>
  Effect.gen(function* () {
    let entered!: () => void;
    const promptEntered = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let finish!: () => void;
    const finishPrompt = new Promise<void>((resolve) => {
      finish = resolve;
    });
    sdkSession(async () => {
      entered();
      await finishPrompt;
      throw new Error("preflight aborted");
    });
    const adapter = yield* makePiAdapter();
    const events: ProviderRuntimeEvent[] = [];
    yield* adapter.streamEvents.pipe(
      Stream.runForEach((event) =>
        Effect.sync(() => {
          events.push(event);
        }),
      ),
      Effect.forkScoped({ startImmediately: true }),
    );
    yield* adapter.startSession(start);
    const first = yield* Effect.forkChild(adapter.sendTurn({ threadId, input: "first" }), {
      startImmediately: true,
    });
    yield* Effect.promise(() => promptEntered);
    yield* adapter.interruptTurn(threadId);
    finish();
    yield* Fiber.join(first);
    assert.equal((yield* adapter.listSessions())[0]?.status, "ready");
    assert.deepEqual(
      events.filter((event) => event.type === "turn.completed").map((event) => event.payload.state),
      ["cancelled"],
    );
  }).pipe(Effect.scoped, Effect.provide(testLayer)),
);

it.effect("interrupts a streaming Pi run and restores a ready session", () =>
  Effect.gen(function* () {
    let started!: () => void;
    const promptStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    let finish!: () => void;
    const finishPrompt = new Promise<void>((resolve) => {
      finish = resolve;
    });
    let emitEvent!: (event: AgentSessionEvent) => void;
    let aborts = 0;
    sdkSession(
      async (emit, preflight) => {
        emitEvent = emit;
        preflight(true);
        emit({ type: "agent_start" });
        started();
        await finishPrompt;
        emit({ type: "agent_settled" });
      },
      {
        abort: async () => {
          aborts++;
          emitEvent({
            type: "message_end",
            message: { role: "assistant", stopReason: "aborted" },
          } as AgentSessionEvent);
          finish();
        },
      },
    );
    const adapter = yield* makePiAdapter();
    const events: ProviderRuntimeEvent[] = [];
    yield* adapter.streamEvents.pipe(
      Stream.runForEach((event) =>
        Effect.sync(() => {
          events.push(event);
        }),
      ),
      Effect.forkScoped({ startImmediately: true }),
    );
    yield* adapter.startSession(start);
    const first = yield* Effect.forkChild(adapter.sendTurn({ threadId, input: "first" }), {
      startImmediately: true,
    });
    yield* Effect.promise(() => promptStarted);
    yield* adapter.interruptTurn(threadId);
    yield* Fiber.join(first);
    assert.isAbove(aborts, 0);
    assert.equal((yield* adapter.listSessions())[0]?.status, "ready");
    assert.deepEqual(
      events.filter((event) => event.type === "turn.completed").map((event) => event.payload.state),
      ["cancelled"],
    );
  }).pipe(Effect.scoped, Effect.provide(testLayer)),
);

it.effect("reports an extension-triggered Pi run after the user turn as its own turn", () =>
  Effect.gen(function* () {
    let emitSdk: (event: AgentSessionEvent) => void = () => {};
    sdkSession(
      async (emit, preflight) => {
        preflight(true);
        emit({ type: "agent_settled" });
      },
      { listen: (emit) => (emitSdk = emit) },
    );
    const adapter = yield* makePiAdapter();
    const events: ProviderRuntimeEvent[] = [];
    const followUpSettled = yield* Deferred.make<void>();
    yield* adapter.streamEvents.pipe(
      Stream.runForEach((event) =>
        Effect.gen(function* () {
          events.push(event);
          if (events.filter((entry) => entry.type === "turn.completed").length === 2)
            yield* Deferred.succeed(followUpSettled, undefined);
        }),
      ),
      Effect.forkScoped({ startImmediately: true }),
    );
    yield* adapter.startSession(start);
    const user = yield* adapter.sendTurn({ threadId, input: "spawn a background subagent" });
    // A background subagent finishes; pi-subagents calls sendMessage({ triggerTurn: true }).
    emitSdk({ type: "agent_start" });
    emitSdk({
      type: "tool_execution_start",
      toolCallId: "call-result",
      toolName: "get_subagent_result",
      args: {},
    });
    emitSdk({ type: "agent_settled" });
    yield* Deferred.await(followUpSettled);
    const turns = events.filter(
      (event) => event.type === "turn.started" || event.type === "turn.completed",
    );
    assert.equal(turns.length, 4);
    const followUp = turns[2]!.turnId;
    assert.notEqual(followUp, user.turnId);
    assert.deepEqual(
      turns.map((event) => [event.type, event.turnId === followUp]),
      [
        ["turn.started", false],
        ["turn.completed", false],
        ["turn.started", true],
        ["turn.completed", true],
      ],
    );
    assert.equal(events.find((event) => event.type === "item.started")?.turnId, followUp);
    assert.equal((yield* adapter.listSessions())[0]?.status, "ready");
    yield* adapter.stopSession(threadId);
  }).pipe(Effect.scoped, Effect.provide(testLayer)),
);

it.effect("maps the Pi Agent tool to a subagent tool call", () =>
  Effect.gen(function* () {
    sdkSession(async (emit, preflight) => {
      preflight(true);
      emit({ type: "agent_start" });
      emit({
        type: "tool_execution_start",
        toolCallId: "call-agent",
        toolName: "Agent",
        args: { subagent_type: "explore", prompt: "look" },
      });
      emit({ type: "agent_settled" });
    });
    const adapter = yield* makePiAdapter();
    const events: ProviderRuntimeEvent[] = [];
    yield* adapter.streamEvents.pipe(
      Stream.runForEach((event) =>
        Effect.sync(() => {
          events.push(event);
        }),
      ),
      Effect.forkScoped({ startImmediately: true }),
    );
    yield* adapter.startSession(start);
    yield* adapter.sendTurn({ threadId, input: "delegate" });
    const started = events.find((event) => event.type === "item.started");
    assert.equal(
      started?.type === "item.started" ? started.payload.itemType : undefined,
      "collab_agent_tool_call",
    );
    yield* adapter.stopSession(threadId);
  }).pipe(Effect.scoped, Effect.provide(testLayer)),
);

it.effect(
  "reports Pi context size, API-equivalent turn cost and pi-subagents lifecycle as tasks",
  () =>
    Effect.gen(function* () {
      sdkSession(
        async (emit, preflight) => {
          preflight(true);
          // The extension bus the adapter handed to Pi's resource loader.
          const bus = vi.mocked(createEventBus).mock.results.at(-1)?.value as ReturnType<
            typeof createEventBus
          >;
          // A pi-subagents Agent tool call launches a child during the turn.
          bus.emit("subagents:started", { id: "agent-1", type: "explore", description: "Scan" });
          emit({
            type: "message_end",
            message: {
              role: "assistant",
              stopReason: "stop",
              usage: {
                input: 100,
                output: 20,
                cacheRead: 400,
                cacheWrite: 10,
                reasoning: 5,
                totalTokens: 530,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.0125 },
              },
            },
          } as AgentSessionEvent);
          bus.emit("subagents:completed", {
            id: "agent-1",
            type: "explore",
            description: "Scan",
            result: "found it",
            toolUses: 3,
            durationMs: 900,
            usage: {
              input: 50,
              output: 10,
              cacheRead: 40,
              cacheWrite: 0,
              totalTokens: 100,
              cost: { total: 0.002 },
            },
          });
          emit({ type: "agent_settled" });
        },
        { contextUsage: () => ({ tokens: 530, contextWindow: 200_000, percent: 0.265 }) },
      );
      const adapter = yield* makePiAdapter();
      const events: ProviderRuntimeEvent[] = [];
      const settled = yield* Deferred.make<void>();
      yield* adapter.streamEvents.pipe(
        Stream.runForEach((event) =>
          Effect.gen(function* () {
            events.push(event);
            if (event.type === "turn.completed") yield* Deferred.succeed(settled, undefined);
          }),
        ),
        Effect.forkScoped({ startImmediately: true }),
      );
      yield* adapter.startSession(start);
      const turn = yield* adapter.sendTurn({ threadId, input: "hello" });
      yield* Deferred.await(settled);

      const context = events.find((event) => event.type === "thread.token-usage.updated");
      assert.deepEqual(context?.type === "thread.token-usage.updated" && context.payload.usage, {
        usedTokens: 530,
        lastUsedTokens: 530,
        maxTokens: 200_000,
        inputTokens: 510,
        cachedInputTokens: 400,
        outputTokens: 20,
        reasoningOutputTokens: 5,
        lastInputTokens: 510,
        lastCachedInputTokens: 400,
        lastOutputTokens: 20,
        compactsAutomatically: true,
      });
      const completed = events.find((event) => event.type === "turn.completed");
      assert.equal(completed?.type === "turn.completed" && completed.payload.totalCostUsd, 0.0125);
      assert.deepEqual(
        events
          .filter((event) => event.type === "task.started" || event.type === "task.completed")
          .map((event) => ({ type: event.type, turnId: event.turnId, payload: event.payload })),
        [
          {
            type: "task.started",
            turnId: turn.turnId,
            payload: {
              taskId: RuntimeTaskId.make("pi:agent-1"),
              description: "Scan",
              taskType: "subagent",
              agentKind: "agent",
              title: "Scan",
              role: "explore",
            },
          },
          {
            type: "task.completed",
            turnId: turn.turnId,
            payload: {
              taskId: RuntimeTaskId.make("pi:agent-1"),
              status: "completed",
              summary: "found it",
              // Child spend stays on the task, not the parent turn's cost.
              typedUsage: {
                totalTokens: 100,
                inputTokens: 90,
                cachedInputTokens: 40,
                outputTokens: 10,
                toolUses: 3,
                durationMs: 900,
                costUsd: 0.002,
              },
              taskType: "subagent",
              agentKind: "agent",
              title: "Scan",
              role: "explore",
            },
          },
        ],
      );
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
);
