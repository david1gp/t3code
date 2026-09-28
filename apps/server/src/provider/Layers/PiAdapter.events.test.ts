// @effect-diagnostics nodeBuiltinImport:off - SDK sessions persist in isolated test state.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { createAgentSession, type AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { assert, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import { ProviderDriverKind, ThreadId, type ProviderRuntimeEvent } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { ServerConfig } from "../../config.ts";
import { makePiAdapter } from "./PiAdapter.ts";

vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@earendil-works/pi-coding-agent")>()),
  createAgentSession: vi.fn(),
}));

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
  } = {},
) {
  vi.mocked(createAgentSession).mockImplementation(async (sessionOptions) => {
    let listener: (event: AgentSessionEvent) => void = () => {};
    return {
      session: {
        model: undefined,
        sessionManager: sessionOptions?.sessionManager,
        subscribe: (next: typeof listener) => {
          listener = next;
          return () => {};
        },
        prompt: (_text: string, config: { preflightResult: (success: boolean) => void }) =>
          prompt(listener, config.preflightResult),
        get isStreaming() {
          return sdkOptions.isStreaming?.() ?? false;
        },
        steer: (text: string) => sdkOptions.steer?.(text) ?? Promise.resolve("queued"),
        abort: () => sdkOptions.abort?.() ?? Promise.resolve(),
        clearQueue: () => sdkOptions.clearQueue?.(),
        dispose: () => {},
      },
    } as unknown as Awaited<ReturnType<typeof createAgentSession>>;
  });
}

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
