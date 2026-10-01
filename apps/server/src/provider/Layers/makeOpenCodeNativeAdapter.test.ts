import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  ApprovalRequestId,
  ProviderInstanceId,
  ProviderRuntimeEvent,
  RuntimeTaskId,
  ThreadId,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Option from "effect/Option";
import * as Scope from "effect/Scope";
import * as Exit from "effect/Exit";
import * as TestClock from "effect/testing/TestClock";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { ServerConfig } from "../../config.ts";
import { OpenCodeRuntimeError } from "../opencodeRuntime.ts";
import type { openCodeNativeSessionEngineCreate } from "../openCodeNativeSessionEngineCreate.ts";
import { makeOpenCodeNativeAdapter } from "./makeOpenCodeNativeAdapter.ts";

const threadId = ThreadId.make("native-v2-adapter-thread");
const decodeRuntimeEvent = Schema.decodeUnknownEffect(ProviderRuntimeEvent);
const start = { threadId, cwd: "/tmp/native-v2", runtimeMode: "full-access" as const };
const testLayer = ServerConfig.layerTest(process.cwd(), { prefix: "native-adapter-test-" }).pipe(
  Layer.provideMerge(NodeServices.layer),
);

function fakeEngine() {
  let receive!: Parameters<typeof openCodeNativeSessionEngineCreate>[0]["onEvent"];
  const calls: string[] = [];
  const stoppedDirectories: string[] = [];
  const starts: Array<
    Parameters<ReturnType<typeof openCodeNativeSessionEngineCreate>["start"]>[0]
  > = [];
  let broken = false;
  let rejected = false;
  let terminalBeforeReceipt = false;
  let rejectResume = false;
  let rejectStop = false;
  let rejectInterrupt = false;
  let rejectNextStopDirectory: string | undefined;
  let rejectSwitch = false;
  let uncertainSwitch = false;
  let running: string | undefined;
  let sends = 0;
  const create = ((input: Parameters<typeof openCodeNativeSessionEngineCreate>[0]) => {
    receive = input.onEvent;
    const receiveEvent = input.onEvent;
    let directory = "";
    return {
      start: async (
        options: Parameters<ReturnType<typeof openCodeNativeSessionEngineCreate>["start"]>[0],
      ) => {
        directory = options.directory;
        starts.push(options);
        calls.push(`start:${options.directory}`);
        if (rejectResume && options.resumeSessionId)
          return { success: false as const, error: { detail: "No verified durable boundary." } };
        return {
          success: true as const,
          data: { id: "ses_native", location: { directory: options.directory } },
        };
      },
      switchSelection: async (selection: {
        readonly model?: {
          readonly id: string;
          readonly providerID: string;
          readonly variant?: string;
        };
        readonly agent?: string;
      }) => {
        calls.push(
          `switch:${selection.model ? `${selection.model.providerID}/${selection.model.id}@${selection.model.variant ?? ""}` : ""}:${selection.agent ?? ""}`,
        );
        if (uncertainSwitch)
          return { success: false as const, error: { detail: "Interrupt outcome uncertain." } };
        if (rejectSwitch)
          return {
            success: false as const,
            rejected: true as const,
            error: { detail: "Switch failed." },
          };
        // The real engine interrupts a running turn and waits for its terminal.
        if (running)
          receive({
            type: "turn.failed",
            turnID: running,
            reason: "interrupted",
            interruptionReason: "user",
          });
        return { success: true as const, data: undefined };
      },
      send: async (text: string) => {
        calls.push(`send:${text}`);
        if (rejected)
          return {
            success: false as const,
            rejected: true as const,
            error: { detail: "Session already has pending work." },
          };
        const turnID = `msg_user_${++sends}`;
        if (terminalBeforeReceipt && !broken) {
          receiveEvent({ type: "turn.started", turnID });
          receiveEvent({ type: "turn.completed", turnID });
        }
        return broken
          ? { success: false as const, error: { detail: "Admission uncertain" } }
          : { success: true as const, data: { turnID } };
      },
      interrupt: async () => {
        calls.push("interrupt");
        return rejectInterrupt
          ? { success: false as const, error: { detail: "Interrupt outcome uncertain." } }
          : { success: true as const, data: true };
      },
      stop: async () => {
        calls.push("stop");
        stoppedDirectories.push(directory);
        const failThisStop = rejectStop || rejectNextStopDirectory === directory;
        if (rejectNextStopDirectory === directory) rejectNextStopDirectory = undefined;
        return failThisStop
          ? { success: false as const, error: { detail: "Interrupt outcome uncertain." } }
          : { success: true as const, data: undefined };
      },
      recover: async () => ({ success: false as const, error: { detail: "Not supported" } }),
      contextLimit: async (_model: { readonly id: string; readonly providerID: string }) =>
        200_000 as number | undefined,
      reconcilePending: async () => ({ success: true as const, data: undefined }),
      replyPermission: async (id: string, decision: string) => {
        calls.push(`permission:${id}:${decision}`);
        return { success: true as const, data: undefined };
      },
      replyForm: async (id: string, answer: unknown) => {
        calls.push(`form:${id}:${JSON.stringify(answer)}`);
        return { success: true as const, data: undefined };
      },
    };
  }) as typeof openCodeNativeSessionEngineCreate;
  return {
    create,
    calls,
    stoppedDirectories,
    starts,
    emit: (event: Parameters<typeof receive>[0]) => receive(event),
    completeBeforeReceipt: () => {
      terminalBeforeReceipt = true;
    },
    failResume: () => {
      rejectResume = true;
    },
    breakAdmission: () => {
      broken = true;
    },
    rejectDuplicate: () => {
      rejected = true;
    },
    allowSend: () => {
      rejected = false;
    },
    failStop: () => {
      rejectStop = true;
    },
    failSwitch: () => {
      rejectSwitch = true;
    },
    failSwitchUncertain: () => {
      uncertainSwitch = true;
    },
    setRunning: (turnID: string | undefined) => {
      running = turnID;
    },
    failInterrupt: () => {
      rejectInterrupt = true;
    },
    failNextStopFor: (directory: string) => {
      rejectNextStopDirectory = directory;
    },
  };
}

it.effect("reports a failed native stop as lost while still stopping other sessions", () =>
  Effect.gen(function* () {
    const fake = fakeEngine();
    const adapter = yield* makeOpenCodeNativeAdapter({
      url: "https://native.example",
      engineCreate: fake.create,
    });
    const events: ProviderRuntimeEvent[] = [];
    const exited = yield* Deferred.make<void>();
    let exitCount = 0;
    yield* Stream.runForEach(adapter.streamEvents, (event) =>
      Effect.gen(function* () {
        events.push(event);
        if (event.type === "session.exited" && ++exitCount === 2)
          yield* Deferred.succeed(exited, undefined);
      }),
    ).pipe(Effect.forkChild);
    const otherThread = ThreadId.make("native-v2-second-thread");
    yield* adapter.startSession(start);
    const turn = yield* adapter.sendTurn({ threadId, input: "in flight" });
    fake.emit({ type: "turn.started", turnID: turn.turnId });
    yield* adapter.startSession({ ...start, threadId: otherThread, cwd: "/tmp/native-v2-second" });
    fake.failNextStopFor(start.cwd);
    const error = yield* adapter.stopAll().pipe(Effect.flip);
    yield* Deferred.await(exited);
    assert.equal(error._tag, "ProviderAdapterRequestError");
    if (error._tag === "ProviderAdapterRequestError")
      assert.equal(error.detail, "Interrupt outcome uncertain.");
    assert.deepStrictEqual(fake.stoppedDirectories, [start.cwd, "/tmp/native-v2-second"]);
    assert.deepStrictEqual(yield* adapter.listSessions(), []);
    yield* Effect.forEach(events, (event) => decodeRuntimeEvent(event), { discard: true });
    assert.deepStrictEqual(
      events
        .filter((event) => event.type === "session.exited")
        .map((event) => ({
          threadId: event.threadId,
          payload: event.payload,
        })),
      [
        {
          threadId,
          payload: {
            reason: "Native session stopped locally; remote interrupt outcome is uncertain.",
            recoverable: false,
            exitKind: "error",
          },
        },
        {
          threadId: otherThread,
          payload: { exitKind: "graceful" },
        },
      ],
    );
    assert.deepStrictEqual(
      events.filter((event) => event.type === "turn.completed"),
      [],
    );
  }).pipe(Effect.provide(testLayer)),
);

it.effect("emits graceful exits for every successful stopAll session", () =>
  Effect.gen(function* () {
    const fake = fakeEngine();
    const adapter = yield* makeOpenCodeNativeAdapter({
      url: "https://native.example",
      engineCreate: fake.create,
    });
    const events: ProviderRuntimeEvent[] = [];
    const exited = yield* Deferred.make<void>();
    let exitCount = 0;
    yield* Stream.runForEach(adapter.streamEvents, (event) =>
      Effect.gen(function* () {
        events.push(event);
        if (event.type === "session.exited" && ++exitCount === 2)
          yield* Deferred.succeed(exited, undefined);
      }),
    ).pipe(Effect.forkChild);
    const otherThread = ThreadId.make("native-v2-all-success-thread");
    yield* adapter.startSession(start);
    yield* adapter.startSession({
      ...start,
      threadId: otherThread,
      cwd: "/tmp/native-v2-all-success",
    });

    yield* adapter.stopAll();
    yield* Deferred.await(exited);
    yield* Effect.forEach(events, (event) => decodeRuntimeEvent(event), { discard: true });
    assert.deepStrictEqual(
      events
        .filter((event) => event.type === "session.exited")
        .map((event) => ({ threadId: event.threadId, payload: event.payload })),
      [
        { threadId, payload: { exitKind: "graceful" } },
        { threadId: otherThread, payload: { exitKind: "graceful" } },
      ],
    );
    assert.deepStrictEqual(yield* adapter.listSessions(), []);
  }).pipe(Effect.provide(testLayer)),
);

it.effect("removes a stopped session locally and reports uncertain remote interruption", () =>
  Effect.gen(function* () {
    const fake = fakeEngine();
    const adapter = yield* makeOpenCodeNativeAdapter({
      url: "https://native.example",
      engineCreate: fake.create,
    });
    yield* adapter.startSession(start);
    const turn = yield* adapter.sendTurn({ threadId, input: "in flight" });
    fake.emit({ type: "turn.started", turnID: turn.turnId });
    fake.failStop();
    assert.equal(
      (yield* adapter.stopSession(threadId).pipe(Effect.flip))._tag,
      "ProviderAdapterRequestError",
    );
    assert.equal(yield* adapter.hasSession(threadId), false);
    assert.deepStrictEqual(yield* adapter.listSessions(), []);
  }).pipe(Effect.provide(testLayer)),
);

it.effect("switches model and agent inside the existing native session", () =>
  Effect.gen(function* () {
    const fake = fakeEngine();
    const adapter = yield* makeOpenCodeNativeAdapter({
      url: "https://native.example",
      engineCreate: fake.create,
    });
    const instanceId = ProviderInstanceId.make("opencode");
    yield* adapter.startSession({
      ...start,
      modelSelection: {
        instanceId,
        model: "openai/gpt-5",
        options: [
          { id: "variant", value: "high" },
          { id: "agent", value: "build" },
        ],
      },
    });
    // Same selection, options reordered: no switch.
    const first = yield* adapter.sendTurn({
      threadId,
      input: "same",
      modelSelection: {
        instanceId,
        model: "openai/gpt-5",
        options: [
          { id: "agent", value: "build" },
          { id: "variant", value: "high" },
        ],
      },
    });
    fake.emit({ type: "turn.started", turnID: first.turnId });
    fake.emit({ type: "turn.completed", turnID: first.turnId });
    // Agent only.
    const second = yield* adapter.sendTurn({
      threadId,
      input: "plan it",
      modelSelection: {
        instanceId,
        model: "openai/gpt-5",
        options: [
          { id: "variant", value: "high" },
          { id: "agent", value: "plan" },
        ],
      },
    });
    fake.emit({ type: "turn.started", turnID: second.turnId });
    fake.emit({ type: "turn.completed", turnID: second.turnId });
    // Model only.
    yield* adapter.sendTurn({
      threadId,
      input: "build it",
      modelSelection: {
        instanceId,
        model: "anthropic/claude-sonnet",
        options: [
          { id: "variant", value: "high" },
          { id: "agent", value: "plan" },
        ],
      },
    });
    assert.deepStrictEqual(fake.calls, [
      "start:/tmp/native-v2",
      "send:same",
      "switch::plan",
      "send:plan it",
      "switch:anthropic/claude-sonnet@high:",
      "send:build it",
    ]);
    const [session] = yield* adapter.listSessions();
    assert.equal(session?.model, "anthropic/claude-sonnet");
    assert.deepStrictEqual(session?.resumeCursor, { schemaVersion: 1, sessionId: "ses_native" });
    yield* adapter.stopSession(threadId);
  }).pipe(Effect.provide(testLayer)),
);

it.effect("interrupts the running turn and starts a new one when switching mid-turn", () =>
  Effect.gen(function* () {
    const fake = fakeEngine();
    const adapter = yield* makeOpenCodeNativeAdapter({
      url: "https://native.example",
      engineCreate: fake.create,
    });
    const events: Array<ProviderRuntimeEvent> = [];
    yield* Stream.runForEach(adapter.streamEvents, (event) =>
      Effect.sync(() => void events.push(event)),
    ).pipe(Effect.forkChild);
    const instanceId = ProviderInstanceId.make("opencode");
    yield* adapter.startSession({
      ...start,
      modelSelection: { instanceId, model: "openai/gpt-5" },
    });
    const first = yield* adapter.sendTurn({ threadId, input: "long job" });
    fake.emit({ type: "turn.started", turnID: first.turnId });
    fake.setRunning(first.turnId);
    const next = yield* adapter.sendTurn({
      threadId,
      input: "do this instead",
      modelSelection: { instanceId, model: "anthropic/claude-sonnet" },
    });
    assert.notEqual(next.turnId, first.turnId);
    yield* Effect.yieldNow;
    assert.deepStrictEqual(
      events
        .filter((event) => event.type === "turn.completed" && event.turnId === first.turnId)
        .map((event) => event.type === "turn.completed" && event.payload.state),
      ["interrupted"],
    );
    assert.deepStrictEqual(fake.calls, [
      "start:/tmp/native-v2",
      "send:long job",
      "switch:anthropic/claude-sonnet@:",
      "send:do this instead",
    ]);
    yield* adapter.stopSession(threadId);
  }).pipe(Effect.provide(testLayer)),
);

it.effect("takes the session offline when a mid-turn switch cannot confirm the interrupt", () =>
  Effect.gen(function* () {
    const fake = fakeEngine();
    const adapter = yield* makeOpenCodeNativeAdapter({
      url: "https://native.example",
      engineCreate: fake.create,
    });
    const instanceId = ProviderInstanceId.make("opencode");
    yield* adapter.startSession({
      ...start,
      modelSelection: { instanceId, model: "openai/gpt-5" },
    });
    fake.failSwitchUncertain();
    const error = yield* adapter
      .sendTurn({
        threadId,
        input: "switch",
        modelSelection: { instanceId, model: "anthropic/claude-sonnet" },
      })
      .pipe(Effect.flip);
    assert.equal(error._tag, "ProviderAdapterRequestError");
    assert.equal(yield* adapter.hasSession(threadId), false);
    assert.deepStrictEqual(fake.calls, [
      "start:/tmp/native-v2",
      "switch:anthropic/claude-sonnet@:",
    ]);
  }).pipe(Effect.provide(testLayer)),
);

it.effect("does not send the prompt when the native switch is rejected", () =>
  Effect.gen(function* () {
    const fake = fakeEngine();
    const adapter = yield* makeOpenCodeNativeAdapter({
      url: "https://native.example",
      engineCreate: fake.create,
    });
    const instanceId = ProviderInstanceId.make("opencode");
    yield* adapter.startSession({
      ...start,
      modelSelection: { instanceId, model: "openai/gpt-5" },
    });
    fake.failSwitch();
    const error = yield* adapter
      .sendTurn({
        threadId,
        input: "switch",
        modelSelection: {
          instanceId,
          model: "openai/gpt-5",
          options: [{ id: "agent", value: "plan" }],
        },
      })
      .pipe(Effect.flip);
    assert.equal(error._tag, "ProviderAdapterRequestError");
    assert.equal(yield* adapter.hasSession(threadId), true);
    assert.equal((yield* adapter.listSessions())[0]?.model, "openai/gpt-5");
    assert.deepStrictEqual(fake.calls, ["start:/tmp/native-v2", "switch::plan"]);
    yield* adapter.stopSession(threadId);
  }).pipe(Effect.provide(testLayer)),
);

it.effect("keeps the session usable after a deterministic pre-admission duplicate rejection", () =>
  Effect.gen(function* () {
    const fake = fakeEngine();
    const adapter = yield* makeOpenCodeNativeAdapter({
      url: "https://native.example",
      engineCreate: fake.create,
    });
    yield* adapter.startSession(start);
    const first = yield* adapter.sendTurn({ threadId, input: "first" });
    fake.rejectDuplicate();
    assert.equal(
      (yield* adapter.sendTurn({ threadId, input: "duplicate" }).pipe(Effect.flip))._tag,
      "ProviderAdapterRequestError",
    );
    assert.equal(yield* adapter.hasSession(threadId), true);
    fake.emit({ type: "turn.started", turnID: first.turnId });
    fake.emit({ type: "turn.completed", turnID: first.turnId });
    fake.allowSend();
    const next = yield* adapter.sendTurn({ threadId, input: "next" });
    assert.equal(next.turnId, "msg_user_2");
    assert.deepStrictEqual(fake.calls, [
      "start:/tmp/native-v2",
      "send:first",
      "send:duplicate",
      "send:next",
    ]);
    yield* adapter.stopSession(threadId);
  }).pipe(Effect.provide(testLayer)),
);

it.effect(
  "adapts fresh native text, reasoning, tools, step usage and terminal events into valid canonical events",
  () =>
    Effect.gen(function* () {
      const fake = fakeEngine();
      const adapter = yield* makeOpenCodeNativeAdapter({
        url: "https://native.example",
        engineCreate: fake.create,
      });
      const events: Array<ProviderRuntimeEvent> = [];
      const completed = yield* Deferred.make<void>();
      yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.gen(function* () {
          events.push(event);
          if (event.type === "turn.completed")
            yield* Deferred.succeed(completed, undefined).pipe(Effect.ignore);
        }),
      ).pipe(Effect.forkChild);
      const session = yield* adapter.startSession(start);
      assert.equal(session.status, "ready");
      assert.deepStrictEqual(session.resumeCursor, { schemaVersion: 1, sessionId: "ses_native" });
      const turn = yield* adapter.sendTurn({ threadId, input: "hello" });
      const scope = {
        sessionID: "ses_native",
        turnID: turn.turnId,
        key: "ses_native:msg_a:text:0",
        assistantMessageID: "msg_a",
        ordinal: 0,
      };
      const reason = { ...scope, key: "ses_native:msg_a:reasoning:0" };
      fake.emit({ type: "turn.started", turnID: turn.turnId });
      fake.emit({ type: "text.started", ...scope });
      fake.emit({ type: "text.delta", ...scope, delta: "Hello" });
      fake.emit({ type: "text.completed", ...scope, text: "Hello world" });
      fake.emit({ type: "reasoning.started", ...reason });
      fake.emit({ type: "reasoning.delta", ...reason, delta: "Think" });
      fake.emit({ type: "reasoning.completed", ...reason, text: "Think" });
      const tool = {
        id: "call_a",
        assistantMessageID: "msg_a",
        name: "bash",
        inputText: "",
        input: { command: "pwd" },
        executed: false,
      };
      const toolScope = {
        sessionID: "ses_native",
        turnID: turn.turnId,
        key: "ses_native:msg_a:tool:call_a",
      };
      fake.emit({ type: "tool.started", ...toolScope, tool });
      fake.emit({ type: "tool.called", ...toolScope, tool });
      fake.emit({
        type: "tool.completed",
        ...toolScope,
        tool: { ...tool, content: [{ type: "text", text: "/tmp" }] },
      });
      fake.emit({
        type: "step.completed",
        sessionID: "ses_native",
        turnID: turn.turnId,
        step: {
          sessionID: "ses_native",
          assistantMessageID: "msg_a",
          finish: "stop",
          cost: 0.25,
          tokens: { input: 10, output: 5, reasoning: 2, cache: { read: 3, write: 1 } },
        },
      });
      fake.emit({
        type: "usage.updated",
        sessionID: "ses_native",
        scope: "session",
        cost: 999,
        tokens: { input: 999, output: 999, reasoning: 0, cache: { read: 0, write: 0 } },
      });
      fake.emit({ type: "turn.completed", turnID: turn.turnId });
      yield* Deferred.await(completed);
      yield* Effect.forEach(events, (event) => decodeRuntimeEvent(event), { discard: true });
      assert.equal(turn.turnId, "msg_user_1");
      assert.deepStrictEqual(
        events.map((event) => event.type),
        [
          "session.started",
          "session.state.changed",
          "thread.started",
          "turn.started",
          "item.started",
          "content.delta",
          "content.delta",
          "item.completed",
          "item.started",
          "content.delta",
          "item.completed",
          "item.started",
          "item.updated",
          "item.completed",
          "turn.cost.updated",
          "thread.token-usage.updated",
          "turn.completed",
        ],
      );
      const context = events.find((event) => event.type === "thread.token-usage.updated");
      assert.deepStrictEqual(
        context?.type === "thread.token-usage.updated" && {
          usedTokens: context.payload.usage.usedTokens,
          inputTokens: context.payload.usage.inputTokens,
          turnId: context.turnId,
        },
        // The step's prompt (input + cache) plus its output is the live context size.
        { usedTokens: 19, inputTokens: 14, turnId: turn.turnId },
      );
      assert.deepStrictEqual(
        events.filter((event) => event.type === "content.delta").map((event) => event.payload),
        [
          { streamKind: "assistant_text", delta: "Hello" },
          { streamKind: "assistant_text", delta: " world" },
          { streamKind: "reasoning_text", delta: "Think" },
        ],
      );
      const terminal = events.find((event) => event.type === "turn.completed");
      assert.equal(terminal?.type === "turn.completed" && terminal.payload.state, "completed");
      if (terminal?.type === "turn.completed") {
        assert.deepStrictEqual(terminal.payload.tokenUsage, {
          usageScope: "main_agent",
          usageStatus: "complete",
          hasSubagents: false,
          inputTokens: 14,
          outputTokens: 7,
          cachedInputTokens: 3,
          cacheCreationTokens: 1,
          reasoningTokens: 2,
        });
        assert.equal(terminal.payload.totalCostUsd, 0.25);
      }
      yield* adapter.stopSession(threadId);
      assert.deepStrictEqual(fake.calls, ["start:/tmp/native-v2", "send:hello", "stop"]);
    }).pipe(Effect.provide(testLayer)),
);

it.effect(
  "reports main and nested child step costs during a turn and includes them at completion",
  () =>
    Effect.gen(function* () {
      const fake = fakeEngine();
      const adapter = yield* makeOpenCodeNativeAdapter({
        url: "https://native.example",
        engineCreate: fake.create,
      });
      const events: ProviderRuntimeEvent[] = [];
      const firstCost = yield* Deferred.make<void>();
      const done = yield* Deferred.make<void>();
      yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.gen(function* () {
          events.push(event);
          if (event.type === "turn.cost.updated")
            yield* Deferred.succeed(firstCost, undefined).pipe(Effect.ignore);
          if (event.type === "turn.completed")
            yield* Deferred.succeed(done, undefined).pipe(Effect.ignore);
        }),
      ).pipe(Effect.forkChild);
      yield* adapter.startSession({
        ...start,
        modelSelection: { instanceId: ProviderInstanceId.make("opencode"), model: "openai/gpt" },
      });
      const turn = yield* adapter.sendTurn({ threadId, input: "launch nested work" });
      fake.emit({ type: "turn.started", turnID: turn.turnId });
      const step = (sessionID: string, assistantMessageID: string, cost: number) => ({
        type: "step.completed" as const,
        sessionID,
        turnID: turn.turnId,
        step: {
          sessionID,
          assistantMessageID,
          finish: "stop" as const,
          cost,
          tokens: { input: 2, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
        },
      });
      fake.emit(step("ses_native", "msg_main", 0.125));
      yield* Deferred.await(firstCost);
      assert.deepStrictEqual(
        events.filter((event) => event.type === "turn.cost.updated").map((event) => event.payload),
        [{ totalCostUsd: 0.125, costSessionId: "ses_native", costModel: "openai/gpt" }],
      );
      const child = { sessionID: "ses_child", parentSessionID: "ses_native", turnID: turn.turnId };
      const nested = { sessionID: "ses_nested", parentSessionID: "ses_child", turnID: turn.turnId };
      fake.emit({ type: "child.attached", ...child, info: {} });
      fake.emit({ type: "child.attached", ...nested, info: {} });
      fake.emit(step("ses_child", "msg_child", 0.25));
      fake.emit(step("ses_child", "msg_child", 0.25));
      fake.emit(step("ses_child", "msg_child", 0.375));
      fake.emit(step("ses_nested", "msg_nested", 0.5));
      fake.emit({ type: "child.completed", ...nested });
      fake.emit({ type: "child.completed", ...child });
      fake.emit({ type: "turn.completed", turnID: turn.turnId });
      yield* Deferred.await(done);
      yield* Effect.forEach(events, (event) => decodeRuntimeEvent(event), { discard: true });
      assert.deepStrictEqual(
        events
          .filter((event) => event.type === "turn.cost.updated")
          .map((event) => event.payload.totalCostUsd),
        [0.125, 0.375, 0.5, 1],
      );
      const terminal = events.find((event) => event.type === "turn.completed");
      assert.equal(terminal?.type === "turn.completed" && terminal.payload.totalCostUsd, 1);
      assert.equal(
        terminal?.type === "turn.completed" && terminal.payload.tokenUsage?.usageScope,
        "main_agent",
      );
      assert.equal(
        terminal?.type === "turn.completed" && terminal.payload.tokenUsage?.inputTokens,
        2,
      );
      yield* adapter.stopSession(threadId);
    }).pipe(Effect.provide(testLayer)),
);

it.effect("finalizes child-only cost when the child finishes after the parent turn", () =>
  Effect.gen(function* () {
    const fake = fakeEngine();
    const adapter = yield* makeOpenCodeNativeAdapter({
      url: "https://native.example",
      engineCreate: fake.create,
    });
    const events: ProviderRuntimeEvent[] = [];
    const finished = yield* Deferred.make<void>();
    yield* Stream.runForEach(adapter.streamEvents, (event) =>
      Effect.gen(function* () {
        events.push(event);
        if (event.type === "turn.cost.updated" && event.payload.status === "final")
          yield* Deferred.succeed(finished, undefined).pipe(Effect.ignore);
      }),
    ).pipe(Effect.forkChild);
    yield* adapter.startSession({
      ...start,
      modelSelection: { instanceId: ProviderInstanceId.make("opencode"), model: "openai/gpt" },
    });
    const turn = yield* adapter.sendTurn({ threadId, input: "delegate the whole turn" });
    fake.emit({ type: "turn.started", turnID: turn.turnId });
    const child = { sessionID: "ses_child", parentSessionID: "ses_native", turnID: turn.turnId };
    fake.emit({ type: "child.attached", ...child, info: {} });
    fake.emit({ type: "turn.completed", turnID: turn.turnId });
    fake.emit({
      type: "step.completed",
      sessionID: child.sessionID,
      turnID: turn.turnId,
      step: {
        sessionID: child.sessionID,
        assistantMessageID: "child-step",
        finish: "stop",
        cost: 0.25,
        tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
      },
    });
    fake.emit({ type: "child.completed", ...child });
    yield* Deferred.await(finished);
    yield* Effect.forEach(events, (event) => decodeRuntimeEvent(event), { discard: true });
    const terminal = events.find((event) => event.type === "turn.completed");
    assert.equal(terminal?.type === "turn.completed" && terminal.payload.totalCostUsd, undefined);
    assert.deepStrictEqual(
      events.filter((event) => event.type === "turn.cost.updated").map((event) => event.payload),
      [
        { totalCostUsd: 0.25, costSessionId: "ses_native", costModel: "openai/gpt" },
        {
          totalCostUsd: 0.25,
          status: "final",
          costSessionId: "ses_native",
          costModel: "openai/gpt",
        },
      ],
    );
    const finalCost = events.findIndex(
      (event) => event.type === "turn.cost.updated" && event.payload.status === "final",
    );
    const parentCompletion = events.findIndex((event) => event.type === "turn.completed");
    assert.ok(parentCompletion >= 0 && finalCost > parentCompletion);
    yield* adapter.stopSession(threadId);
  }).pipe(Effect.provide(testLayer)),
);

it.effect("does not finalize child cost when a parent step is unresolved or invalid", () =>
  Effect.gen(function* () {
    const fake = fakeEngine();
    const adapter = yield* makeOpenCodeNativeAdapter({
      url: "https://native.example",
      engineCreate: fake.create,
    });
    const events: ProviderRuntimeEvent[] = [];
    const barrier = yield* Deferred.make<void>();
    yield* Stream.runForEach(adapter.streamEvents, (event) =>
      Effect.gen(function* () {
        events.push(event);
        if (event.type === "turn.completed" && event.turnId === "msg_user_3")
          yield* Deferred.succeed(barrier, undefined).pipe(Effect.ignore);
      }),
    ).pipe(Effect.forkChild);
    yield* adapter.startSession(start);
    const tokens = { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } };
    for (const incomplete of ["unresolved", "invalid"] as const) {
      const turn = yield* adapter.sendTurn({ threadId, input: incomplete });
      fake.emit({ type: "turn.started", turnID: turn.turnId });
      const child = {
        sessionID: `ses_${incomplete}`,
        parentSessionID: "ses_native",
        turnID: turn.turnId,
      };
      fake.emit({ type: "child.attached", ...child, info: {} });
      if (incomplete === "unresolved") {
        fake.emit({
          type: "step.failed",
          sessionID: "ses_native",
          turnID: turn.turnId,
          step: {
            sessionID: "ses_native",
            assistantMessageID: "main-step",
            error: { type: "step.error", message: "No cost" },
          },
        });
      } else {
        fake.emit({
          type: "step.completed",
          sessionID: "ses_native",
          turnID: turn.turnId,
          step: {
            sessionID: "ses_native",
            assistantMessageID: "main-step",
            finish: "stop",
            cost: -1,
            tokens,
          },
        });
      }
      fake.emit({ type: "turn.completed", turnID: turn.turnId });
      fake.emit({
        type: "step.completed",
        sessionID: child.sessionID,
        turnID: turn.turnId,
        step: {
          sessionID: child.sessionID,
          assistantMessageID: "child-step",
          finish: "stop",
          cost: 0.25,
          tokens,
        },
      });
      fake.emit({ type: "child.completed", ...child });
    }
    const next = yield* adapter.sendTurn({ threadId, input: "barrier" });
    fake.emit({ type: "turn.started", turnID: next.turnId });
    fake.emit({ type: "turn.completed", turnID: next.turnId });
    yield* Deferred.await(barrier);
    yield* Effect.forEach(events, (event) => decodeRuntimeEvent(event), { discard: true });
    assert.deepStrictEqual(
      events.filter((event) => event.type === "turn.cost.updated").map((event) => event.payload),
      [
        { totalCostUsd: 0.25, costSessionId: "ses_native" },
        { totalCostUsd: 0.25, costSessionId: "ses_native" },
      ],
    );
    assert.deepStrictEqual(
      events
        .filter((event) => event.type === "turn.completed")
        .map((event) => event.payload.totalCostUsd),
      [undefined, undefined, undefined],
    );
    yield* adapter.stopSession(threadId);
  }).pipe(Effect.provide(testLayer)),
);

it.effect(
  "finalizes an old turn only after every background child settles, without charging the next turn",
  () =>
    Effect.gen(function* () {
      const fake = fakeEngine();
      const adapter = yield* makeOpenCodeNativeAdapter({
        url: "https://native.example",
        engineCreate: fake.create,
      });
      const events: ProviderRuntimeEvent[] = [];
      const finished = yield* Deferred.make<void>();
      yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.gen(function* () {
          events.push(event);
          if (event.type === "turn.cost.updated" && event.payload.status === "final")
            yield* Deferred.succeed(finished, undefined).pipe(Effect.ignore);
        }),
      ).pipe(Effect.forkChild);
      yield* adapter.startSession({
        ...start,
        modelSelection: { instanceId: ProviderInstanceId.make("opencode"), model: "openai/old" },
      });
      const first = yield* adapter.sendTurn({ threadId, input: "launch background work" });
      fake.emit({ type: "turn.started", turnID: first.turnId });
      const step = (sessionID: string, turnID: string, id: string, cost: number) => ({
        type: "step.completed" as const,
        sessionID,
        turnID,
        step: {
          sessionID,
          assistantMessageID: id,
          finish: "stop" as const,
          cost,
          tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
        },
      });
      fake.emit(step("ses_native", first.turnId, "main-old", 0.1));
      const child = { sessionID: "ses_child", parentSessionID: "ses_native", turnID: first.turnId };
      const nested = {
        sessionID: "ses_nested",
        parentSessionID: "ses_child",
        turnID: first.turnId,
      };
      fake.emit({ type: "child.attached", ...child, info: {} });
      fake.emit({ type: "child.attached", ...nested, info: {} });
      fake.emit({ type: "turn.completed", turnID: first.turnId });
      const second = yield* adapter.sendTurn({ threadId, input: "new turn" });
      fake.emit({ type: "turn.started", turnID: second.turnId });
      fake.emit(step("ses_native", second.turnId, "main-new", 0.2));
      fake.emit(step("ses_child", first.turnId, "child-old", 0.3));
      fake.emit(step("ses_child", first.turnId, "child-old", 0.3));
      fake.emit({ type: "child.completed", ...child });
      fake.emit(step("ses_nested", first.turnId, "nested-old", 0.4));
      fake.emit({ type: "turn.completed", turnID: second.turnId });
      fake.emit({ type: "child.completed", ...nested });
      yield* Deferred.await(finished);
      yield* Effect.forEach(events, (event) => decodeRuntimeEvent(event), { discard: true });
      const oldUpdates = events.filter(
        (event) => event.type === "turn.cost.updated" && event.turnId === first.turnId,
      );
      assert.deepStrictEqual(
        oldUpdates.map((event) => event.payload),
        [
          { totalCostUsd: 0.1, costSessionId: "ses_native", costModel: "openai/old" },
          { totalCostUsd: 0.4, costSessionId: "ses_native", costModel: "openai/old" },
          {
            totalCostUsd: 0.8,
            costSessionId: "ses_native",
            costModel: "openai/old",
          },
          {
            totalCostUsd: 0.8,
            status: "final",
            costSessionId: "ses_native",
            costModel: "openai/old",
          },
        ],
      );
      const terminals = events.filter(
        (event): event is Extract<ProviderRuntimeEvent, { type: "turn.completed" }> =>
          event.type === "turn.completed",
      );
      assert.deepStrictEqual(
        terminals.map((event) => event.payload.totalCostUsd),
        [undefined, 0.2],
      );
      assert.deepStrictEqual(
        events
          .filter(
            (event): event is Extract<ProviderRuntimeEvent, { type: "turn.cost.updated" }> =>
              event.type === "turn.cost.updated" && event.turnId === second.turnId,
          )
          .map((event) => event.payload.totalCostUsd),
        [0.2],
      );
      fake.emit(step("ses_nested", first.turnId, "late-duplicate", 9));
      assert.equal(events.filter((event) => event.type === "turn.cost.updated").length, 5);
      yield* adapter.stopSession(threadId);
    }).pipe(Effect.provide(testLayer)),
);

it.effect(
  "keeps late child cost provisional when a background child has incomplete accounting",
  () =>
    Effect.gen(function* () {
      const fake = fakeEngine();
      const adapter = yield* makeOpenCodeNativeAdapter({
        url: "https://native.example",
        engineCreate: fake.create,
      });
      const events: ProviderRuntimeEvent[] = [];
      const barrier = yield* Deferred.make<void>();
      yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.gen(function* () {
          events.push(event);
          if (event.type === "turn.completed" && event.turnId === "msg_user_2")
            yield* Deferred.succeed(barrier, undefined).pipe(Effect.ignore);
        }),
      ).pipe(Effect.forkChild);
      yield* adapter.startSession(start);
      const first = yield* adapter.sendTurn({ threadId, input: "background" });
      fake.emit({ type: "turn.started", turnID: first.turnId });
      const tokens = { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } };
      fake.emit({
        type: "step.completed",
        sessionID: "ses_native",
        turnID: first.turnId,
        step: {
          sessionID: "ses_native",
          assistantMessageID: "main-step",
          finish: "stop",
          cost: 0.1,
          tokens,
        },
      });
      const child = { sessionID: "ses_child", parentSessionID: "ses_native", turnID: first.turnId };
      fake.emit({ type: "child.attached", ...child, info: {} });
      fake.emit({ type: "turn.completed", turnID: first.turnId });
      fake.emit({
        type: "step.completed",
        sessionID: child.sessionID,
        turnID: first.turnId,
        step: {
          sessionID: child.sessionID,
          assistantMessageID: "child-step",
          finish: "stop",
          cost: 0.25,
          tokens,
        },
      });
      fake.emit({
        type: "step.failed",
        sessionID: child.sessionID,
        turnID: first.turnId,
        step: {
          sessionID: child.sessionID,
          assistantMessageID: "unpriced-child-step",
          error: { type: "step.error", message: "No cost" },
        },
      });
      fake.emit({ type: "child.completed", ...child });
      const second = yield* adapter.sendTurn({ threadId, input: "barrier" });
      fake.emit({ type: "turn.started", turnID: second.turnId });
      fake.emit({ type: "turn.completed", turnID: second.turnId });
      yield* Deferred.await(barrier);
      yield* Effect.forEach(events, (event) => decodeRuntimeEvent(event), { discard: true });
      assert.deepStrictEqual(
        events
          .filter((event) => event.type === "turn.cost.updated" && event.turnId === first.turnId)
          .map((event) => event.payload),
        [
          { totalCostUsd: 0.1, costSessionId: "ses_native" },
          { totalCostUsd: 0.35, costSessionId: "ses_native" },
        ],
      );
      assert.deepStrictEqual(
        events
          .filter((event) => event.type === "turn.completed")
          .map((event) => event.payload.totalCostUsd),
        [undefined, undefined],
      );
      yield* adapter.stopSession(threadId);
    }).pipe(Effect.provide(testLayer)),
);

it.effect("charges a priced failed parent attempt once alongside its retry", () =>
  Effect.gen(function* () {
    const fake = fakeEngine();
    const adapter = yield* makeOpenCodeNativeAdapter({
      url: "https://native.example",
      engineCreate: fake.create,
    });
    const events: ProviderRuntimeEvent[] = [];
    const done = yield* Deferred.make<void>();
    yield* Stream.runForEach(adapter.streamEvents, (event) =>
      Effect.gen(function* () {
        events.push(event);
        if (event.type === "turn.completed")
          yield* Deferred.succeed(done, undefined).pipe(Effect.ignore);
      }),
    ).pipe(Effect.forkChild);
    yield* adapter.startSession(start);
    const turn = yield* adapter.sendTurn({ threadId, input: "retry" });
    fake.emit({ type: "turn.started", turnID: turn.turnId });
    const failed = (cost: number) => ({
      type: "step.failed" as const,
      sessionID: "ses_native",
      turnID: turn.turnId,
      step: {
        sessionID: "ses_native",
        assistantMessageID: "msg_attempt",
        error: { type: "provider.rate-limit", message: "Retry" },
        cost,
      },
    });
    fake.emit(failed(0.2));
    fake.emit(failed(0.2));
    fake.emit(failed(0.3));
    fake.emit({
      type: "step.completed",
      sessionID: "ses_native",
      turnID: turn.turnId,
      step: {
        sessionID: "ses_native",
        assistantMessageID: "msg_retry",
        finish: "stop",
        cost: 0.4,
        tokens: { input: 2, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
      },
    });
    fake.emit(failed(0.3));
    fake.emit({ type: "turn.completed", turnID: turn.turnId });
    yield* Deferred.await(done);
    yield* Effect.forEach(events, (event) => decodeRuntimeEvent(event), { discard: true });
    assert.deepStrictEqual(
      events
        .filter((event) => event.type === "turn.cost.updated")
        .map((event) => event.payload.totalCostUsd),
      [0.2, 0.3, 0.7],
    );
    const terminal = events.find((event) => event.type === "turn.completed");
    assert.equal(terminal?.type === "turn.completed" && terminal.payload.totalCostUsd, 0.7);
    assert.equal(
      terminal?.type === "turn.completed" && terminal.payload.tokenUsage?.usageStatus,
      "partial",
    );
    yield* adapter.stopSession(threadId);
  }).pipe(Effect.provide(testLayer)),
);

it.effect(
  "finalizes a priced failed child step without charging duplicates or a later completion",
  () =>
    Effect.gen(function* () {
      const fake = fakeEngine();
      const adapter = yield* makeOpenCodeNativeAdapter({
        url: "https://native.example",
        engineCreate: fake.create,
      });
      const events: ProviderRuntimeEvent[] = [];
      const done = yield* Deferred.make<void>();
      yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.gen(function* () {
          events.push(event);
          if (event.type === "turn.cost.updated" && event.payload.status === "final")
            yield* Deferred.succeed(done, undefined).pipe(Effect.ignore);
        }),
      ).pipe(Effect.forkChild);
      yield* adapter.startSession(start);
      const turn = yield* adapter.sendTurn({ threadId, input: "child retry" });
      fake.emit({ type: "turn.started", turnID: turn.turnId });
      const child = { sessionID: "ses_child", parentSessionID: "ses_native", turnID: turn.turnId };
      fake.emit({ type: "child.attached", ...child, info: {} });
      fake.emit({ type: "turn.completed", turnID: turn.turnId });
      const failed = (cost: number) => ({
        type: "step.failed" as const,
        sessionID: child.sessionID,
        turnID: turn.turnId,
        step: {
          sessionID: child.sessionID,
          assistantMessageID: "child-attempt",
          error: { type: "step.error", message: "Retry" },
          cost,
        },
      });
      fake.emit(failed(0.1));
      fake.emit(failed(0.1));
      fake.emit(failed(0.25));
      fake.emit({
        type: "step.completed",
        sessionID: child.sessionID,
        turnID: turn.turnId,
        step: {
          sessionID: child.sessionID,
          assistantMessageID: "child-retry",
          finish: "stop",
          cost: 0.5,
          tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
        },
      });
      fake.emit({ type: "child.completed", ...child });
      yield* Deferred.await(done);
      yield* Effect.forEach(events, (event) => decodeRuntimeEvent(event), { discard: true });
      assert.deepStrictEqual(
        events
          .filter((event) => event.type === "turn.cost.updated")
          .map((event) => [event.payload.totalCostUsd, event.payload.status]),
        [
          [0.1, undefined],
          [0.25, undefined],
          [0.75, undefined],
          [0.75, "final"],
        ],
      );
      assert.equal(
        events.find((event) => event.type === "turn.completed")?.payload.totalCostUsd,
        undefined,
      );
      yield* adapter.stopSession(threadId);
    }).pipe(Effect.provide(testLayer)),
);

it.effect(
  "replaces a failed attempt when its completed cost arrives and rejects unpriced corrections",
  () =>
    Effect.gen(function* () {
      const fake = fakeEngine();
      const adapter = yield* makeOpenCodeNativeAdapter({
        url: "https://native.example",
        engineCreate: fake.create,
      });
      const events: ProviderRuntimeEvent[] = [];
      const done = yield* Deferred.make<void>();
      yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.gen(function* () {
          events.push(event);
          if (event.type === "turn.completed")
            yield* Deferred.succeed(done, undefined).pipe(Effect.ignore);
        }),
      ).pipe(Effect.forkChild);
      yield* adapter.startSession(start);
      const turn = yield* adapter.sendTurn({ threadId, input: "corrected failure" });
      fake.emit({ type: "turn.started", turnID: turn.turnId });
      const tokens = { input: 2, output: 1, reasoning: 0, cache: { read: 0, write: 0 } };
      const failed = (id: string, cost?: number) => ({
        type: "step.failed" as const,
        sessionID: "ses_native",
        turnID: turn.turnId,
        step: {
          sessionID: "ses_native",
          assistantMessageID: id,
          error: { type: "step.error", message: "Try again" },
          ...(cost === undefined ? {} : { cost }),
          tokens,
        },
      });
      fake.emit(failed("corrected", 0.3));
      fake.emit({
        type: "step.completed",
        sessionID: "ses_native",
        turnID: turn.turnId,
        step: {
          sessionID: "ses_native",
          assistantMessageID: "corrected",
          finish: "stop",
          cost: 0.4,
          tokens,
        },
      });
      fake.emit(failed("corrected", 0.3));
      fake.emit(failed("unpriced", 0.25));
      fake.emit(failed("unpriced", -1));
      fake.emit(failed("missing"));
      fake.emit({ type: "turn.completed", turnID: turn.turnId });
      yield* Deferred.await(done);
      yield* Effect.forEach(events, (event) => decodeRuntimeEvent(event), { discard: true });
      assert.deepStrictEqual(
        events
          .filter((event) => event.type === "turn.cost.updated")
          .map((event) => event.payload.totalCostUsd),
        [0.3, 0.4, 0.65, 0.4],
      );
      const terminal = events.find((event) => event.type === "turn.completed");
      assert.equal(terminal?.type === "turn.completed" && terminal.payload.totalCostUsd, undefined);
      assert.equal(
        terminal?.type === "turn.completed" && terminal.payload.tokenUsage?.inputTokens,
        2,
      );
      yield* adapter.stopSession(threadId);
    }).pipe(Effect.provide(testLayer)),
);

it.effect("deduplicates corrected costs and excludes steps from older turns", () =>
  Effect.gen(function* () {
    const fake = fakeEngine();
    const adapter = yield* makeOpenCodeNativeAdapter({
      url: "https://native.example",
      engineCreate: fake.create,
    });
    const events: ProviderRuntimeEvent[] = [];
    const done = yield* Deferred.make<void>();
    yield* Stream.runForEach(adapter.streamEvents, (event) =>
      Effect.gen(function* () {
        events.push(event);
        if (event.type === "turn.completed" && event.turnId === "msg_user_2")
          yield* Deferred.succeed(done, undefined).pipe(Effect.ignore);
      }),
    ).pipe(Effect.forkChild);
    yield* adapter.startSession(start);
    const first = yield* adapter.sendTurn({ threadId, input: "old" });
    fake.emit({ type: "turn.started", turnID: first.turnId });
    const step = (turnID: string, cost: number) => ({
      type: "step.completed" as const,
      sessionID: "ses_native",
      turnID,
      step: {
        sessionID: "ses_native",
        assistantMessageID: "msg_step",
        finish: "stop" as const,
        cost,
        tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
      },
    });
    fake.emit(step(first.turnId, 0.9));
    fake.emit({ type: "turn.completed", turnID: first.turnId });
    const second = yield* adapter.sendTurn({ threadId, input: "new" });
    fake.emit({ type: "turn.started", turnID: second.turnId });
    fake.emit(step(first.turnId, 0.9));
    fake.emit(step(second.turnId, 0.2));
    fake.emit(step(second.turnId, 0.2));
    fake.emit(step(second.turnId, 0.4));
    fake.emit({ type: "turn.completed", turnID: second.turnId });
    yield* Deferred.await(done);
    assert.deepStrictEqual(
      events
        .filter(
          (event): event is Extract<ProviderRuntimeEvent, { type: "turn.cost.updated" }> =>
            event.type === "turn.cost.updated" && event.turnId === second.turnId,
        )
        .map((event) => event.payload.totalCostUsd),
      [0.2, 0.4],
    );
    const terminal = events.find(
      (event) => event.type === "turn.completed" && event.turnId === second.turnId,
    );
    assert.equal(terminal?.type === "turn.completed" && terminal.payload.totalCostUsd, 0.4);
    yield* adapter.stopSession(threadId);
  }).pipe(Effect.provide(testLayer)),
);

it.effect("omits terminal cost when a step is unresolved or a child is still running", () =>
  Effect.gen(function* () {
    const fake = fakeEngine();
    const adapter = yield* makeOpenCodeNativeAdapter({
      url: "https://native.example",
      engineCreate: fake.create,
    });
    const events: ProviderRuntimeEvent[] = [];
    const done = yield* Deferred.make<void>();
    let completed = 0;
    yield* Stream.runForEach(adapter.streamEvents, (event) =>
      Effect.gen(function* () {
        events.push(event);
        if (event.type === "turn.completed" && ++completed === 6)
          yield* Deferred.succeed(done, undefined).pipe(Effect.ignore);
      }),
    ).pipe(Effect.forkChild);
    yield* adapter.startSession(start);
    const first = yield* adapter.sendTurn({ threadId, input: "no accounting" });
    fake.emit({ type: "turn.started", turnID: first.turnId });
    fake.emit({ type: "turn.completed", turnID: first.turnId });
    const second = yield* adapter.sendTurn({ threadId, input: "partial accounting" });
    fake.emit({ type: "turn.started", turnID: second.turnId });
    const tokens = { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } };
    fake.emit({
      type: "step.completed",
      sessionID: "ses_native",
      turnID: second.turnId,
      step: {
        sessionID: "ses_native",
        assistantMessageID: "msg_good",
        finish: "stop",
        cost: 0.2,
        tokens,
      },
    });
    fake.emit({
      type: "step.failed",
      sessionID: "ses_native",
      turnID: second.turnId,
      step: {
        sessionID: "ses_native",
        assistantMessageID: "msg_missing",
        error: { type: "step.error", message: "No cost" },
      },
    });
    fake.emit({ type: "turn.completed", turnID: second.turnId });
    const third = yield* adapter.sendTurn({ threadId, input: "background child" });
    fake.emit({ type: "turn.started", turnID: third.turnId });
    fake.emit({
      type: "step.completed",
      sessionID: "ses_native",
      turnID: third.turnId,
      step: {
        sessionID: "ses_native",
        assistantMessageID: "msg_other",
        finish: "stop",
        cost: 0.3,
        tokens,
      },
    });
    fake.emit({
      type: "child.attached",
      sessionID: "ses_running",
      parentSessionID: "ses_native",
      turnID: third.turnId,
      info: {},
    });
    fake.emit({ type: "turn.completed", turnID: third.turnId });
    const fourth = yield* adapter.sendTurn({ threadId, input: "unpriced child" });
    fake.emit({ type: "turn.started", turnID: fourth.turnId });
    fake.emit({
      type: "step.completed",
      sessionID: "ses_native",
      turnID: fourth.turnId,
      step: {
        sessionID: "ses_native",
        assistantMessageID: "msg_fourth",
        finish: "stop",
        cost: 0.4,
        tokens,
      },
    });
    const unpriced = {
      sessionID: "ses_unpriced",
      parentSessionID: "ses_native",
      turnID: fourth.turnId,
    };
    fake.emit({ type: "child.attached", ...unpriced, info: {} });
    fake.emit({ type: "child.completed", ...unpriced });
    fake.emit({ type: "turn.completed", turnID: fourth.turnId });
    const fifth = yield* adapter.sendTurn({ threadId, input: "invalid accounting" });
    fake.emit({ type: "turn.started", turnID: fifth.turnId });
    fake.emit({
      type: "step.completed",
      sessionID: "ses_native",
      turnID: fifth.turnId,
      step: {
        sessionID: "ses_native",
        assistantMessageID: "msg_fifth",
        finish: "stop",
        cost: -1,
        tokens,
      },
    });
    fake.emit({ type: "turn.completed", turnID: fifth.turnId });
    const sixth = yield* adapter.sendTurn({ threadId, input: "reported free step" });
    fake.emit({ type: "turn.started", turnID: sixth.turnId });
    fake.emit({
      type: "step.completed",
      sessionID: "ses_native",
      turnID: sixth.turnId,
      step: {
        sessionID: "ses_native",
        assistantMessageID: "msg_sixth",
        finish: "stop",
        cost: 0,
        tokens,
      },
    });
    fake.emit({ type: "turn.completed", turnID: sixth.turnId });
    yield* Deferred.await(done);
    yield* Effect.forEach(events, (event) => decodeRuntimeEvent(event), { discard: true });
    assert.deepStrictEqual(
      events
        .filter((event) => event.type === "turn.completed")
        .map((event) => event.payload.totalCostUsd),
      [undefined, undefined, undefined, undefined, undefined, 0],
    );
    assert.deepStrictEqual(
      events
        .filter((event) => event.type === "turn.cost.updated")
        .map((event) => event.payload.totalCostUsd),
      [0.2, 0.3, 0.4, 0],
    );
    yield* adapter.stopSession(threadId);
  }).pipe(Effect.provide(testLayer)),
);

it.effect(
  "rejects malformed resume, modes and responses, and fails closed on uncertain admission or lost stream",
  () =>
    Effect.gen(function* () {
      const fake = fakeEngine();
      const adapter = yield* makeOpenCodeNativeAdapter({
        url: "https://native.example",
        engineCreate: fake.create,
      });
      assert.equal(
        (yield* adapter
          .startSession({ ...start, resumeCursor: { sessionId: "ses_old" } })
          .pipe(Effect.flip))._tag,
        "ProviderAdapterValidationError",
      );
      assert.equal(
        (yield* adapter
          .startSession({ ...start, runtimeMode: "approval-required" })
          .pipe(Effect.flip))._tag,
        "ProviderAdapterValidationError",
      );
      assert.equal(
        (yield* adapter
          .startSession({
            ...start,
            modelSelection: {
              instanceId: ProviderInstanceId.make("other"),
              model: "openai/gpt",
            },
          })
          .pipe(Effect.flip))._tag,
        "ProviderAdapterValidationError",
      );
      assert.deepStrictEqual(fake.calls, []);
      yield* adapter.startSession(start);
      const received: Array<ProviderRuntimeEvent> = [];
      const exited = yield* Deferred.make<void>();
      yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.gen(function* () {
          received.push(event);
          if (event.type === "session.exited")
            yield* Deferred.succeed(exited, undefined).pipe(Effect.ignore);
        }),
      ).pipe(Effect.forkChild);
      assert.equal(
        (yield* adapter
          .respondToRequest(threadId, ApprovalRequestId.make("request"), "accept")
          .pipe(Effect.flip))._tag,
        "ProviderAdapterRequestError",
      );
      assert.equal(
        (yield* adapter
          .respondToUserInput(threadId, ApprovalRequestId.make("request"), {})
          .pipe(Effect.flip))._tag,
        "ProviderAdapterRequestError",
      );
      assert.equal(
        (yield* adapter.readThread(threadId).pipe(Effect.flip))._tag,
        "ProviderAdapterRequestError",
      );
      assert.equal(
        (yield* adapter.rollbackThread(threadId, 1).pipe(Effect.flip))._tag,
        "ProviderAdapterRequestError",
      );
      assert.equal(
        (yield* adapter.sendTurn({ threadId, input: "", attachments: [] }).pipe(Effect.flip))._tag,
        "ProviderAdapterValidationError",
      );
      assert.equal(
        (yield* adapter
          .sendTurn({
            threadId,
            input: "hello",
            modelSelection: {
              instanceId: ProviderInstanceId.make("other"),
              model: "openai/gpt",
            },
          })
          .pipe(Effect.flip))._tag,
        "ProviderAdapterValidationError",
      );
      fake.breakAdmission();
      assert.equal(
        (yield* adapter.sendTurn({ threadId, input: "uncertain" }).pipe(Effect.flip))._tag,
        "ProviderAdapterRequestError",
      );
      yield* Deferred.await(exited);
      assert.equal(yield* adapter.hasSession(threadId), false);
      assert.equal((yield* adapter.listSessions())[0]?.status, "error");
      assert.equal(
        (yield* adapter.sendTurn({ threadId, input: "do not retry" }).pipe(Effect.flip))._tag,
        "ProviderAdapterSessionNotFoundError",
      );
      fake.emit({ type: "stream.lost", sessionID: "ses_native" });
      fake.emit({ type: "turn.started", turnID: "msg_user_1" });
      assert.deepStrictEqual(
        received.filter(
          (event) => event.type === "turn.completed" || event.type === "turn.aborted",
        ),
        [],
      );
      assert.equal(
        received.find((event) => event.type === "session.exited")?.type,
        "session.exited",
      );
      assert.equal(received.filter((event) => event.type === "session.exited").length, 1);
      assert.equal(yield* adapter.hasSession(threadId), false);
      assert.equal(
        (yield* adapter.sendTurn({ threadId, input: "do not retry" }).pipe(Effect.flip))._tag,
        "ProviderAdapterSessionNotFoundError",
      );
      yield* adapter.stopSession(threadId);
      assert.deepStrictEqual(fake.calls, ["start:/tmp/native-v2", "send:uncertain", "stop"]);
    }).pipe(Effect.provide(testLayer)),
);

it.effect(
  "passes the versioned native cursor through restart and rejects unverifiable adoption without replacing it",
  () =>
    Effect.gen(function* () {
      const first = fakeEngine();
      const initial = yield* makeOpenCodeNativeAdapter({
        url: "https://native.example",
        engineCreate: first.create,
      });
      const prior = yield* initial.startSession(start);
      yield* initial.stopSession(threadId);
      const next = fakeEngine();
      next.failResume();
      const resumed = yield* makeOpenCodeNativeAdapter({
        url: "https://native.example",
        engineCreate: next.create,
      });
      const error = yield* resumed
        .startSession({ ...start, resumeCursor: prior.resumeCursor })
        .pipe(Effect.flip);
      assert.equal(error._tag, "ProviderAdapterRequestError");
      assert.deepStrictEqual(next.starts, [
        { directory: start.cwd, resumeSessionId: "ses_native" },
      ]);
      assert.deepStrictEqual(next.calls, ["start:/tmp/native-v2", "stop"]);
      assert.deepStrictEqual(yield* resumed.listSessions(), []);
      assert.equal(yield* resumed.hasSession(threadId), false);
    }).pipe(Effect.provide(testLayer)),
);

it.effect(
  "interrupts an admitted turn before its start event without inventing a terminal, and preserves provider failures",
  () =>
    Effect.gen(function* () {
      const fake = fakeEngine();
      const adapter = yield* makeOpenCodeNativeAdapter({
        url: "https://native.example",
        engineCreate: fake.create,
      });
      yield* adapter.startSession(start);
      const turn = yield* adapter.sendTurn({ threadId, input: "run" });
      yield* adapter.interruptTurn(threadId, turn.turnId);
      assert.deepStrictEqual(fake.calls, ["start:/tmp/native-v2", "send:run", "interrupt"]);
      const events: Array<ProviderRuntimeEvent> = [];
      const terminal = yield* Deferred.make<void>();
      yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.gen(function* () {
          events.push(event);
          if (event.type === "turn.completed")
            yield* Deferred.succeed(terminal, undefined).pipe(Effect.ignore);
        }),
      ).pipe(Effect.forkChild);
      fake.emit({ type: "turn.started", turnID: turn.turnId });
      fake.emit({
        type: "turn.failed",
        turnID: turn.turnId,
        reason: "failed",
        error: { type: "provider.error", message: "No capacity" },
      });
      yield* Deferred.await(terminal);
      assert.deepStrictEqual(
        events.filter((event) => event.type === "turn.completed").map((event) => event.payload),
        [{ state: "failed", errorMessage: "No capacity" }],
      );
      yield* adapter.stopSession(threadId);
    }).pipe(Effect.provide(testLayer)),
);

it.effect("reports a failed interrupt as session loss without completing the turn", () =>
  Effect.gen(function* () {
    const fake = fakeEngine();
    const adapter = yield* makeOpenCodeNativeAdapter({
      url: "https://native.example",
      engineCreate: fake.create,
    });
    const events: ProviderRuntimeEvent[] = [];
    const exited = yield* Deferred.make<void>();
    yield* Stream.runForEach(adapter.streamEvents, (event) =>
      Effect.gen(function* () {
        events.push(event);
        if (event.type === "session.exited") yield* Deferred.succeed(exited, undefined);
      }),
    ).pipe(Effect.forkChild);
    yield* adapter.startSession(start);
    const turn = yield* adapter.sendTurn({ threadId, input: "in flight" });
    fake.emit({ type: "turn.started", turnID: turn.turnId });
    fake.failInterrupt();
    const error = yield* adapter.interruptTurn(threadId, turn.turnId).pipe(Effect.flip);
    assert.equal(error._tag, "ProviderAdapterRequestError");
    if (error._tag === "ProviderAdapterRequestError")
      assert.equal(error.detail, "Interrupt outcome uncertain.");
    assert.equal(yield* adapter.hasSession(threadId), false);
    yield* Deferred.await(exited);
    fake.emit({ type: "turn.completed", turnID: turn.turnId });
    yield* Effect.forEach(events, (event) => decodeRuntimeEvent(event), { discard: true });
    assert.deepStrictEqual(
      events.filter((event) => event.type === "session.exited").map((event) => event.payload),
      [
        {
          reason: "Native interrupt outcome is uncertain; do not retry in this session.",
          recoverable: true,
          exitKind: "error",
        },
      ],
    );
    assert.deepStrictEqual(
      events.filter((event) => event.type === "turn.completed"),
      [],
    );
    assert.equal((yield* adapter.listSessions())[0]?.status, "error");
    assert.equal(
      (yield* adapter.sendTurn({ threadId, input: "do not retry" }).pipe(Effect.flip))._tag,
      "ProviderAdapterSessionNotFoundError",
    );
    yield* adapter.stopSession(threadId);
    assert.deepStrictEqual(fake.calls, [
      "start:/tmp/native-v2",
      "send:in flight",
      "interrupt",
      "stop",
    ]);
    assert.equal(events.filter((event) => event.type === "session.exited").length, 1);
  }).pipe(Effect.provide(testLayer)),
);

it.effect(
  "starts the reactor's first-turn model selection on the native session and switches variants in place",
  () =>
    Effect.gen(function* () {
      const fake = fakeEngine();
      const adapter = yield* makeOpenCodeNativeAdapter({
        url: "https://native.example",
        engineCreate: fake.create,
      });
      const selection = {
        instanceId: ProviderInstanceId.make("opencode"),
        model: "openai/gpt-5.2/codex",
        options: [
          { id: "variant", value: "high" },
          { id: "agent", value: "build" },
        ],
      };
      assert.equal(
        (yield* adapter
          .startSession({
            ...start,
            modelSelection: { ...selection, options: [{ id: "unsupported", value: true }] },
          })
          .pipe(Effect.flip))._tag,
        "ProviderAdapterValidationError",
      );
      assert.deepStrictEqual(fake.calls, []);
      // ProviderCommandReactor supplies the selected model at both startSession and sendTurn.
      const session = yield* adapter.startSession({
        ...start,
        title: "Selected thread",
        modelSelection: selection,
      });
      assert.equal(session.model, selection.model);
      assert.deepStrictEqual(fake.starts, [
        {
          directory: start.cwd,
          title: "Selected thread",
          model: { providerID: "openai", id: "gpt-5.2/codex", variant: "high" },
          agent: "build",
        },
      ]);
      const turn = yield* adapter.sendTurn({ threadId, input: "hello", modelSelection: selection });
      assert.equal(turn.turnId, "msg_user_1");
      fake.emit({ type: "turn.started", turnID: turn.turnId });
      fake.emit({ type: "turn.completed", turnID: turn.turnId });
      yield* adapter.sendTurn({
        threadId,
        input: "switch",
        modelSelection: {
          ...selection,
          options: [
            { id: "variant", value: "low" },
            { id: "agent", value: "build" },
          ],
        },
      });
      assert.deepStrictEqual(fake.calls, [
        "start:/tmp/native-v2",
        "send:hello",
        "switch:openai/gpt-5.2/codex@low:",
        "send:switch",
      ]);
      yield* adapter.stopSession(threadId);
    }).pipe(Effect.provide(testLayer)),
);

it.effect.each([undefined, "Transport: fixture event read failed"])(
  "exposes a lost active session without inventing a turn terminal or retrying its prompt (detail: %s)",
  (detail) =>
    Effect.gen(function* () {
      const fake = fakeEngine();
      const adapter = yield* makeOpenCodeNativeAdapter({
        url: "https://native.example",
        engineCreate: fake.create,
      });
      const events: ProviderRuntimeEvent[] = [];
      const exited = yield* Deferred.make<void>();
      yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.gen(function* () {
          events.push(event);
          if (event.type === "session.exited") yield* Deferred.succeed(exited, undefined);
        }),
      ).pipe(Effect.forkChild);
      yield* adapter.startSession(start);
      const turn = yield* adapter.sendTurn({ threadId, input: "running" });
      fake.emit({ type: "turn.started", turnID: turn.turnId });
      fake.emit({
        type: "child.attached",
        sessionID: "ses_background",
        parentSessionID: "ses_native",
        turnID: turn.turnId,
        info: { title: "Background task" },
      });
      fake.emit({
        type: "child.attached",
        sessionID: "ses_foreign_child",
        parentSessionID: "ses_other",
        turnID: turn.turnId,
        info: { title: "Unrelated task" },
      });
      fake.emit({ type: "stream.lost", sessionID: "ses_other", detail: "Unrelated stream error." });
      fake.emit({
        type: "stream.lost",
        sessionID: "ses_native",
        ...(detail === undefined ? {} : { detail }),
      });
      fake.emit({ type: "stream.lost", sessionID: "ses_native", detail: "Later stream closure." });
      yield* Deferred.await(exited);
      yield* Effect.forEach(events, (event) => decodeRuntimeEvent(event), { discard: true });
      const reason = detail
        ? `Native event stream lost; turn outcome is uncertain. ${detail}`
        : "Native event stream lost; turn outcome is uncertain.";
      const lostSession = (yield* adapter.listSessions())[0];
      assert.equal(lostSession?.status, "error");
      assert.equal(lostSession?.lastError, reason);
      assert.deepStrictEqual(
        events.filter((event) => event.type === "session.exited").map((event) => event.payload),
        [{ reason, recoverable: true, exitKind: "error" }],
      );
      assert.equal(yield* adapter.hasSession(threadId), false);
      assert.deepStrictEqual(
        events.filter((event) => event.type === "turn.completed"),
        [],
      );
      assert.deepStrictEqual(
        events
          .filter((event) => event.type === "runtime.warning")
          .map((event) => event.type === "runtime.warning" && event.payload.message),
        [
          `The outcome of related OpenCode child session ses_background is unknown because the parent session was lost: ${reason}`,
        ],
      );
      assert.deepStrictEqual(
        events.filter((event) => event.type === "task.completed"),
        [],
      );
      assert.equal(
        (yield* adapter.sendTurn({ threadId, input: "never retry" }).pipe(Effect.flip))._tag,
        "ProviderAdapterSessionNotFoundError",
      );
      yield* adapter.stopSession(threadId);
      assert.deepStrictEqual(fake.calls, ["start:/tmp/native-v2", "send:running", "stop"]);
    }).pipe(Effect.provide(testLayer)),
);

it.effect(
  "does not interrupt or leave a pending turn when completion precedes the send receipt",
  () =>
    Effect.gen(function* () {
      const fake = fakeEngine();
      fake.completeBeforeReceipt();
      const adapter = yield* makeOpenCodeNativeAdapter({
        url: "https://native.example",
        engineCreate: fake.create,
      });
      const events: ProviderRuntimeEvent[] = [];
      const terminal = yield* Deferred.make<void>();
      yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.gen(function* () {
          events.push(event);
          if (event.type === "turn.completed") yield* Deferred.succeed(terminal, undefined);
        }),
      ).pipe(Effect.forkChild);
      yield* adapter.startSession(start);
      const turn = yield* adapter.sendTurn({ threadId, input: "fast" });
      yield* Deferred.await(terminal);
      yield* Effect.forEach(events, (event) => decodeRuntimeEvent(event), { discard: true });
      yield* adapter.interruptTurn(threadId, turn.turnId);
      assert.deepStrictEqual(
        events.filter((event) => event.type.startsWith("turn.")).map((event) => event.type),
        ["turn.started", "turn.completed"],
      );
      assert.deepStrictEqual(fake.calls, ["start:/tmp/native-v2", "send:fast"]);
      yield* adapter.stopSession(threadId);
    }).pipe(Effect.provide(testLayer)),
);

it.effect("warns when stopping an idle parent with a confirmed running child", () =>
  Effect.gen(function* () {
    const fake = fakeEngine();
    const adapter = yield* makeOpenCodeNativeAdapter({
      url: "https://native.example",
      engineCreate: fake.create,
    });
    const events: ProviderRuntimeEvent[] = [];
    const exited = yield* Deferred.make<void>();
    yield* Stream.runForEach(adapter.streamEvents, (event) =>
      Effect.gen(function* () {
        events.push(event);
        if (event.type === "session.exited") yield* Deferred.succeed(exited, undefined);
      }),
    ).pipe(Effect.forkChild);
    yield* adapter.startSession(start);
    const turn = yield* adapter.sendTurn({ threadId, input: "launch background work" });
    fake.emit({ type: "turn.started", turnID: turn.turnId });
    fake.emit({
      type: "child.attached",
      sessionID: "ses_background",
      parentSessionID: "ses_native",
      turnID: turn.turnId,
      info: { title: "Background task" },
    });
    fake.emit({ type: "turn.completed", turnID: turn.turnId });
    yield* adapter.stopSession(threadId);
    yield* Deferred.await(exited);
    yield* Effect.forEach(events, (event) => decodeRuntimeEvent(event), { discard: true });
    assert.deepStrictEqual(
      events
        .filter((event) => event.type === "runtime.warning")
        .map((event) => event.type === "runtime.warning" && event.payload.message),
      [
        "The outcome of related OpenCode child session ses_background is unknown because the idle parent session was stopped.",
      ],
    );
    assert.deepStrictEqual(
      events.filter((event) => event.type === "task.completed"),
      [],
    );
  }).pipe(Effect.provide(testLayer)),
);

it.effect("does not warn when a related background child completed before parent stop", () =>
  Effect.gen(function* () {
    const fake = fakeEngine();
    const adapter = yield* makeOpenCodeNativeAdapter({
      url: "https://native.example",
      engineCreate: fake.create,
    });
    const events: ProviderRuntimeEvent[] = [];
    const exited = yield* Deferred.make<void>();
    yield* Stream.runForEach(adapter.streamEvents, (event) =>
      Effect.gen(function* () {
        events.push(event);
        if (event.type === "session.exited") yield* Deferred.succeed(exited, undefined);
      }),
    ).pipe(Effect.forkChild);
    yield* adapter.startSession(start);
    const turn = yield* adapter.sendTurn({ threadId, input: "launch background work" });
    fake.emit({ type: "turn.started", turnID: turn.turnId });
    const child = {
      sessionID: "ses_background",
      parentSessionID: "ses_native",
      turnID: turn.turnId,
    };
    fake.emit({ type: "child.attached", ...child, info: { title: "Background task" } });
    fake.emit({ type: "turn.completed", turnID: turn.turnId });
    fake.emit({ type: "child.completed", ...child, summary: "Done" });
    yield* adapter.stopSession(threadId);
    yield* Deferred.await(exited);
    yield* Effect.forEach(events, (event) => decodeRuntimeEvent(event), { discard: true });
    assert.deepStrictEqual(
      events.filter((event) => event.type === "runtime.warning"),
      [],
    );
    assert.equal(events.filter((event) => event.type === "task.completed").length, 1);
  }).pipe(Effect.provide(testLayer)),
);

it.effect(
  "maps nested and background native children to stable tasks across parent turns without admitting foreign ancestry",
  () =>
    Effect.gen(function* () {
      const fake = fakeEngine();
      const adapter = yield* makeOpenCodeNativeAdapter({
        url: "https://native.example/api",
        engineCreate: fake.create,
      });
      const events: ProviderRuntimeEvent[] = [];
      const done = yield* Deferred.make<void>();
      yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.gen(function* () {
          events.push(event);
          if (event.type === "task.completed" && event.payload.taskId === "ses_grandchild")
            yield* Deferred.succeed(done, undefined).pipe(Effect.ignore);
        }),
      ).pipe(Effect.forkChild);
      yield* adapter.startSession(start);
      const first = yield* adapter.sendTurn({ threadId, input: "launch background work" });
      fake.emit({ type: "turn.started", turnID: first.turnId });
      const child = {
        sessionID: "ses_child",
        parentSessionID: "ses_native",
        parentToolKey: "ses_native:msg_a:tool:call_1",
        turnID: first.turnId,
      };
      const nested = {
        sessionID: "ses_grandchild",
        parentSessionID: "ses_child",
        parentToolKey: "ses_child:msg_b:tool:call_2",
        turnID: first.turnId,
      };
      fake.emit({
        type: "child.attached",
        ...child,
        info: { agent: "explore", directory: "/tmp/child" },
      });
      fake.emit({ type: "child.started", ...child });
      fake.emit({
        type: "child.updated",
        ...child,
        info: { title: "Explore code", model: { providerID: "openai", id: "gpt" } },
      });
      fake.emit({
        type: "child.attached",
        ...nested,
        info: { title: "Inspect tests", agent: "build" },
      });
      fake.emit({ type: "child.started", ...nested });
      fake.emit({
        type: "step.completed",
        sessionID: "ses_grandchild",
        turnID: first.turnId,
        parentSessionID: "ses_child",
        step: {
          sessionID: "ses_grandchild",
          assistantMessageID: "msg_b",
          finish: "stop",
          cost: 0.4,
          tokens: { input: 9, output: 6, reasoning: 2, cache: { read: 3, write: 1 } },
        },
      });
      fake.emit({
        type: "child.attached",
        sessionID: "ses_foreign",
        parentSessionID: "ses_other",
        turnID: first.turnId,
        info: {},
      });
      fake.emit({
        type: "child.completed",
        sessionID: "ses_foreign",
        parentSessionID: "ses_other",
        turnID: first.turnId,
      });
      fake.emit({ type: "turn.completed", turnID: first.turnId });
      const second = yield* adapter.sendTurn({ threadId, input: "continue" });
      fake.emit({ type: "turn.started", turnID: second.turnId });
      fake.emit({
        type: "child.failed",
        ...child,
        error: { type: "subagent.error", message: "Background failed" },
      });
      fake.emit({ type: "child.completed", ...child, summary: "late duplicate" });
      fake.emit({ type: "child.completed", ...nested, summary: "Tests inspected" });
      yield* Deferred.await(done);
      yield* Effect.forEach(events, (event) => decodeRuntimeEvent(event), { discard: true });
      const tasks = events.filter(
        (event): event is Extract<ProviderRuntimeEvent, { type: `task.${string}` }> =>
          event.type.startsWith("task."),
      );
      assert.deepStrictEqual(
        tasks.map((event) => event.type),
        [
          "task.started",
          "task.progress",
          "task.started",
          "task.progress",
          "task.completed",
          "task.completed",
        ],
      );
      assert.deepStrictEqual(
        tasks.map((event) => event.turnId),
        Array(6).fill(first.turnId),
      );
      assert.deepStrictEqual(
        tasks.map((event) => event.payload.taskId),
        [
          "ses_child",
          "ses_child",
          "ses_grandchild",
          "ses_grandchild",
          "ses_child",
          "ses_grandchild",
        ],
      );
      assert.equal(tasks[0]?.type === "task.started" && tasks[0].payload.role, "explore");
      assert.equal(tasks[1]?.type === "task.progress" && tasks[1].payload.model, "openai/gpt");
      assert.equal(
        tasks[2]?.type === "task.started" && tasks[2].payload.parentAgentId,
        "ses_child",
      );
      assert.equal(
        tasks[3]?.type === "task.progress" && tasks[3].payload.typedUsage?.totalTokens,
        21,
      );
      assert.equal(
        tasks[4]?.type === "task.completed" && tasks[4].payload.summary,
        "Background failed",
      );
      assert.equal(tasks[4]?.type === "task.completed" && tasks[4].payload.status, "failed");
      assert.equal(
        tasks[5]?.type === "task.completed" && tasks[5].payload.summary,
        "Tests inspected",
      );
      assert.equal(
        tasks[5]?.type === "task.completed" && tasks[5].payload.typedUsage?.costUsd,
        0.4,
      );
      assert.equal(events.filter((event) => event.type === "runtime.warning").length, 0);
      yield* adapter.stopSession(threadId);
    }).pipe(Effect.provide(testLayer)),
);

it.effect("settles an interrupted native child once without ending the parent turn", () =>
  Effect.gen(function* () {
    const fake = fakeEngine();
    const adapter = yield* makeOpenCodeNativeAdapter({
      url: "https://native.example",
      engineCreate: fake.create,
    });
    const events: ProviderRuntimeEvent[] = [];
    const terminal = yield* Deferred.make<void>();
    yield* Stream.runForEach(adapter.streamEvents, (event) =>
      Effect.gen(function* () {
        events.push(event);
        if (event.type === "task.completed") yield* Deferred.succeed(terminal, undefined);
      }),
    ).pipe(Effect.forkChild);
    yield* adapter.startSession(start);
    const turn = yield* adapter.sendTurn({ threadId, input: "launch" });
    fake.emit({ type: "turn.started", turnID: turn.turnId });
    const scope = {
      sessionID: "ses_cancelled",
      parentSessionID: "ses_native",
      turnID: turn.turnId,
    };
    fake.emit({ type: "child.attached", ...scope, info: {} });
    fake.emit({ type: "child.interrupted", ...scope, reason: "cancelled" });
    fake.emit({ type: "child.completed", ...scope });
    yield* Deferred.await(terminal);
    yield* Effect.forEach(events, (event) => decodeRuntimeEvent(event), { discard: true });
    assert.deepStrictEqual(
      events.filter((event) => event.type === "task.completed").map((event) => event.payload),
      [
        {
          taskId: RuntimeTaskId.make("ses_cancelled"),
          status: "stopped",
          summary: "Execution interrupted: cancelled.",
          taskType: "subagent",
          agentKind: "agent",
          runHandles: {
            sessionUrl: "https://native.example/L3RtcC9uYXRpdmUtdjI/session/ses_cancelled",
          },
        },
      ],
    );
    assert.equal(events.filter((event) => event.type === "turn.completed").length, 0);
    yield* adapter.stopSession(threadId);
  }).pipe(Effect.provide(testLayer)),
);

it.effect(
  "correlates native permission replies, external decisions and duplicates without auto-approval",
  () =>
    Effect.gen(function* () {
      const fake = fakeEngine();
      const adapter = yield* makeOpenCodeNativeAdapter({
        url: "https://native.example",
        engineCreate: fake.create,
      });
      const events: ProviderRuntimeEvent[] = [];
      const opened = yield* Deferred.make<void>();
      const resolved = yield* Deferred.make<void>();
      yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.gen(function* () {
          events.push(event);
          if (event.type === "request.opened")
            yield* Deferred.succeed(opened, undefined).pipe(Effect.ignore);
          if (event.type === "request.resolved")
            yield* Deferred.succeed(resolved, undefined).pipe(Effect.ignore);
        }),
      ).pipe(Effect.forkChild);
      yield* adapter.startSession(start);
      const turn = yield* adapter.sendTurn({ threadId, input: "edit" });
      fake.emit({ type: "turn.started", turnID: turn.turnId });
      const request = {
        id: "per_edit",
        sessionID: "ses_native",
        action: "edit",
        resources: ["src/main.ts"],
      };
      fake.emit({ type: "permission.asked", turnID: turn.turnId, request });
      fake.emit({ type: "permission.asked", turnID: turn.turnId, request });
      fake.emit({
        type: "permission.asked",
        turnID: turn.turnId,
        request: { ...request, sessionID: "ses_foreign", id: "per_other" },
      });
      yield* Deferred.await(opened);
      assert.deepStrictEqual(fake.calls, ["start:/tmp/native-v2", "send:edit"]);
      assert.equal(
        (yield* adapter
          .respondToRequest(threadId, ApprovalRequestId.make("per_other"), "accept")
          .pipe(Effect.flip))._tag,
        "ProviderAdapterRequestError",
      );
      yield* adapter.respondToRequest(threadId, ApprovalRequestId.make(request.id), "decline");
      fake.emit({
        type: "permission.replied",
        turnID: turn.turnId,
        sessionID: "ses_native",
        requestID: request.id,
        decision: "reject",
      });
      fake.emit({
        type: "permission.replied",
        turnID: turn.turnId,
        sessionID: "ses_native",
        requestID: request.id,
        decision: "reject",
      });
      yield* Deferred.await(resolved);
      yield* adapter.respondToRequest(threadId, ApprovalRequestId.make(request.id), "accept");
      assert.deepStrictEqual(fake.calls, [
        "start:/tmp/native-v2",
        "send:edit",
        "permission:per_edit:reject",
      ]);
      assert.equal(events.filter((event) => event.type === "request.opened").length, 1);
      assert.deepStrictEqual(
        events.filter((event) => event.type === "request.resolved").map((event) => event.payload),
        [{ requestType: "file_change_approval", decision: "decline" }],
      );
      yield* adapter.stopSession(threadId);
    }).pipe(Effect.provide(testLayer)),
);

it.effect("maps native form fields, validates answers and cancels explicitly", () =>
  Effect.gen(function* () {
    const fake = fakeEngine();
    const adapter = yield* makeOpenCodeNativeAdapter({
      url: "https://native.example",
      engineCreate: fake.create,
    });
    const events: ProviderRuntimeEvent[] = [];
    const requested = yield* Deferred.make<void>();
    const unsupportedRequested = yield* Deferred.make<void>();
    const resolved = yield* Deferred.make<void>();
    yield* Stream.runForEach(adapter.streamEvents, (event) =>
      Effect.gen(function* () {
        events.push(event);
        if (event.type === "user-input.requested")
          yield* Deferred.succeed(requested, undefined).pipe(Effect.ignore);
        if (event.type === "user-input.requested" && event.requestId === "frm_unsupported")
          yield* Deferred.succeed(unsupportedRequested, undefined).pipe(Effect.ignore);
        if (event.type === "user-input.resolved" && event.requestId === "frm_cancel")
          yield* Deferred.succeed(resolved, undefined).pipe(Effect.ignore);
      }),
    ).pipe(Effect.forkChild);
    yield* adapter.startSession(start);
    const turn = yield* adapter.sendTurn({ threadId, input: "ask" });
    const form = {
      id: "frm_config",
      sessionID: "ses_native",
      title: "Configure",
      fields: [
        { key: "name", type: "string" as const, required: true },
        { key: "count", type: "integer" as const, minimum: 1 },
        { key: "enabled", type: "boolean" as const },
        { key: "tags", type: "multiselect" as const, options: [{ label: "One", value: "one" }] },
      ] as [
        { key: string; type: "string"; required: boolean },
        { key: string; type: "integer"; minimum: number },
        { key: string; type: "boolean" },
        { key: string; type: "multiselect"; options: { label: string; value: string }[] },
      ],
    };
    fake.emit({ type: "form.created", turnID: turn.turnId, form });
    fake.emit({ type: "form.created", turnID: turn.turnId, form });
    fake.emit({
      type: "form.created",
      turnID: turn.turnId,
      form: { ...form, id: "frm_foreign", sessionID: "ses_other" },
    });
    fake.emit({
      type: "form.created",
      turnID: turn.turnId,
      form: {
        ...form,
        id: "frm_unsupported",
        fields: [{ key: "link", type: "external" as const, url: "https://example.org" }],
      },
    });
    yield* Deferred.await(requested);
    yield* Deferred.await(unsupportedRequested);
    const fallback = events.find(
      (event) => event.type === "user-input.requested" && event.requestId === "frm_unsupported",
    );
    assert.equal(fallback?.type, "user-input.requested");
    if (fallback?.type === "user-input.requested") {
      assert.deepStrictEqual(fallback.payload.questions, [
        {
          id: "native-form-action",
          header: "Unsupported form",
          question:
            "Configure contains fields T3 cannot safely answer. Cancel this form or answer it in the native OpenCode client.",
          options: [{ label: "Cancel form", description: "", value: "cancel" }],
          allowCustomAnswer: false,
          multiSelect: false,
        },
      ]);
    }
    assert.equal(
      (yield* adapter
        .respondToUserInput(threadId, ApprovalRequestId.make("frm_unsupported"), {
          link: "https://example.org",
        })
        .pipe(Effect.flip))._tag,
      "ProviderAdapterValidationError",
    );
    assert.deepStrictEqual(fake.calls, ["start:/tmp/native-v2", "send:ask"]);
    yield* adapter.respondToUserInput(threadId, ApprovalRequestId.make("frm_unsupported"), {
      "native-form-action": "cancel",
    });
    fake.emit({
      type: "form.resolved",
      turnID: turn.turnId,
      sessionID: "ses_native",
      formID: "frm_unsupported",
      answer: {},
    });
    assert.equal(
      (yield* adapter
        .respondToUserInput(threadId, ApprovalRequestId.make(form.id), { name: "Ada", count: "0" })
        .pipe(Effect.flip))._tag,
      "ProviderAdapterValidationError",
    );
    yield* adapter.respondToUserInput(threadId, ApprovalRequestId.make(form.id), {
      name: "Ada",
      count: "2",
      enabled: "false",
      tags: ["one"],
    });
    fake.emit({
      type: "form.resolved",
      turnID: turn.turnId,
      sessionID: "ses_native",
      formID: form.id,
      answer: { name: "Ada", count: 2, enabled: false, tags: ["one"] },
    });
    yield* adapter.respondToUserInput(threadId, ApprovalRequestId.make(form.id), {});
    fake.emit({ type: "form.created", turnID: turn.turnId, form: { ...form, id: "frm_cancel" } });
    yield* adapter.respondToUserInput(threadId, ApprovalRequestId.make("frm_cancel"), {});
    fake.emit({
      type: "form.resolved",
      turnID: turn.turnId,
      sessionID: "ses_native",
      formID: "frm_cancel",
      answer: {},
    });
    yield* Deferred.await(resolved);
    assert.deepStrictEqual(fake.calls, [
      "start:/tmp/native-v2",
      "send:ask",
      "form:frm_unsupported:undefined",
      'form:frm_config:{"name":"Ada","count":2,"enabled":false,"tags":["one"]}',
      "form:frm_cancel:undefined",
    ]);
    assert.equal(events.filter((event) => event.type === "user-input.requested").length, 3);
    assert.equal(events.filter((event) => event.type === "user-input.resolved").length, 3);
    assert.equal(events.filter((event) => event.type === "runtime.warning").length, 1);
    yield* Effect.forEach(events, (event) => decodeRuntimeEvent(event), { discard: true });
    yield* adapter.stopSession(threadId);
  }).pipe(Effect.provide(testLayer)),
);

const recoveryFixture = Effect.fnUntraced(function* () {
  type Engine = ReturnType<typeof openCodeNativeSessionEngineCreate>;
  type StartReceipt = { index: number; options: Parameters<Engine["start"]>[0] };
  const starts = yield* Queue.unbounded<StartReceipt>();
  const stops = yield* Queue.unbounded<{ index: number; options: Parameters<Engine["stop"]>[0] }>();
  const switches = yield* Queue.unbounded<number>();
  const liveSubscriptions = new Set<number>();
  const promptSelections: Array<Parameters<Engine["switchSelection"]>[0]> = [];
  const prompts: Array<[string, object]> = [];
  let nativeSelection: Parameters<Engine["switchSelection"]>[0] = { agent: "build" };
  let heldStop:
    | { index: number; release: ReturnType<typeof Promise.withResolvers<void>> }
    | undefined;
  let heldSwitch:
    | ReturnType<typeof Promise.withResolvers<Awaited<ReturnType<Engine["switchSelection"]>>>>
    | undefined;
  const callbacks: Array<Parameters<typeof openCodeNativeSessionEngineCreate>[0]["onEvent"]> = [];
  const fake = fakeEngine();
  let refuse = false;
  let loseDuringStart = false;
  let hold:
    | ReturnType<typeof Promise.withResolvers<Awaited<ReturnType<Engine["start"]>>>>
    | undefined;
  const create: typeof openCodeNativeSessionEngineCreate = (input) => {
    const index = callbacks.push(input.onEvent) - 1;
    const engine = fake.create(input);
    return {
      ...engine,
      start: async (options) => {
        const started = await engine.start(options);
        if (started.success) liveSubscriptions.add(index);
        if (!options.resumeSessionId)
          nativeSelection = {
            agent: options.agent ?? "build",
            ...(options.model ? { model: options.model } : {}),
          };
        Queue.offerUnsafe(starts, { index, options });
        if (index > 0 && refuse)
          return {
            success: false,
            error: new OpenCodeRuntimeError({
              operation: "session.resume",
              detail: "Native session still active or awaiting input.",
            }),
          };
        if (index > 0 && loseDuringStart)
          input.onEvent({
            type: "stream.lost",
            sessionID: "ses_native",
            detail: "candidate disconnected before adoption",
          });
        if (index > 0 && hold) {
          const pending = hold;
          hold = undefined;
          const receipt = await pending.promise;
          if (receipt.success) liveSubscriptions.add(index);
          return receipt;
        }
        return started;
      },
      switchSelection: async (selection) => {
        // Apply native state first; only the HTTP response is held, not the setter.
        const switched = await engine.switchSelection(selection);
        if (switched.success) nativeSelection = { ...nativeSelection, ...selection };
        Queue.offerUnsafe(switches, index);
        if (heldSwitch) {
          const pending = heldSwitch;
          heldSwitch = undefined;
          return pending.promise;
        }
        return switched;
      },
      send: async (...args) => {
        promptSelections.push(nativeSelection);
        prompts.push([args[0], args[1] ?? {}]);
        return engine.send(...args);
      },
      stop: async (options) => {
        Queue.offerUnsafe(stops, { index, options });
        if (heldStop?.index === index) {
          const pending = heldStop;
          heldStop = undefined;
          await pending.release.promise;
        }
        liveSubscriptions.delete(index);
        return options?.interrupt === false ? { success: true, data: undefined } : engine.stop();
      },
    };
  };
  return {
    fake,
    starts,
    stops,
    switches,
    liveSubscriptions,
    promptSelections,
    prompts,
    nativeSelection: () => nativeSelection,
    holdStop: (index: number) => {
      const release = Promise.withResolvers<void>();
      heldStop = { index, release };
      return release;
    },
    holdSwitch: () => {
      heldSwitch = Promise.withResolvers<Awaited<ReturnType<Engine["switchSelection"]>>>();
      return heldSwitch;
    },
    callbacks,
    create,
    refuse: (value: boolean) => {
      refuse = value;
    },
    loseDuringStart: (value: boolean) => {
      loseDuringStart = value;
    },
    hold: () => {
      hold = Promise.withResolvers<Awaited<ReturnType<Engine["start"]>>>();
      return hold;
    },
    loss: (index: number) =>
      callbacks[index]!({ type: "stream.lost", sessionID: "ses_native", detail: "transport gap" }),
  };
});

it.effect(
  "recovers idle on the same native ID with a fresh context, one original prompt, and fenced old callbacks",
  () =>
    Effect.gen(function* () {
      const f = yield* recoveryFixture();
      const adapter = yield* makeOpenCodeNativeAdapter({
        url: "https://native.example",
        engineCreate: f.create,
      });
      const events = yield* Queue.unbounded<ProviderRuntimeEvent>();
      yield* Stream.runForEach(adapter.streamEvents, (event) => Queue.offer(events, event)).pipe(
        Effect.forkChild,
      );
      yield* adapter.startSession(start);
      yield* Queue.take(f.starts);
      const turn = yield* adapter.sendTurn({ threadId, input: "original once" });
      f.callbacks[0]!({ type: "turn.started", turnID: turn.turnId });
      f.loss(0);
      f.loss(0);
      assert.equal(yield* adapter.hasSession(threadId), false);
      yield* TestClock.adjust("250 millis");
      const retry = yield* Queue.take(f.starts);
      assert.equal(retry.index, 1);
      assert.equal(retry.options.resumeSessionId, "ses_native");
      const cleanup = yield* Queue.take(f.stops);
      assert.deepStrictEqual(cleanup, { index: 0, options: { interrupt: false } });
      assert.equal(yield* adapter.hasSession(threadId), true);
      const recovered = (yield* adapter.listSessions())[0]!;
      assert.equal(recovered.status, "ready");
      assert.equal(recovered.activeTurnId, undefined);
      assert.equal(recovered.lastError, undefined);
      f.callbacks[0]!({ type: "turn.completed", turnID: turn.turnId });
      f.callbacks[0]!({ type: "turn.started", turnID: "stale-late-response" });
      f.loss(0);
      assert.deepStrictEqual((yield* adapter.listSessions())[0], recovered);
      assert.deepStrictEqual(f.prompts, [["original once", {}]]);
      // Readiness is an observable receipt that drains earlier queued lifecycle events.
      const observed: ProviderRuntimeEvent[] = [];
      let ready = 0;
      while (ready < 2) {
        const event = yield* Queue.take(events);
        observed.push(event);
        if (event.type === "session.state.changed" && event.payload.state === "ready") ready++;
      }
      assert.equal(observed.filter((e) => e.type === "session.exited").length, 1);
      assert.equal(
        observed.filter((e) => e.type === "turn.completed" || e.type === "task.completed").length,
        0,
      );
      yield* adapter.stopSession(threadId);
    }).pipe(Effect.provide(testLayer)),
);

it.effect(
  "refuses busy candidates with capped exponential backoff, expires old requests only on quiescent readiness, and repeats recovery",
  () =>
    Effect.gen(function* () {
      const f = yield* recoveryFixture();
      const adapter = yield* makeOpenCodeNativeAdapter({
        url: "https://native.example",
        engineCreate: f.create,
      });
      const events = yield* Queue.unbounded<ProviderRuntimeEvent>();
      yield* Stream.runForEach(adapter.streamEvents, (event) => Queue.offer(events, event)).pipe(
        Effect.forkChild,
      );
      yield* adapter.startSession(start);
      yield* Queue.take(f.starts);
      const turn = yield* adapter.sendTurn({ threadId, input: "ask once" });
      f.callbacks[0]!({ type: "turn.started", turnID: turn.turnId });
      f.callbacks[0]!({
        type: "permission.asked",
        turnID: turn.turnId,
        request: {
          id: "per_old",
          sessionID: "ses_native",
          action: "read",
          resources: ["/tmp/a"],
          metadata: {},
        },
      });
      f.callbacks[0]!({
        type: "form.created",
        turnID: turn.turnId,
        form: {
          id: "form_old",
          sessionID: "ses_native",
          title: "Question",
          fields: [{ type: "string", key: "reply", options: [] }],
        },
      });
      f.refuse(true);
      f.loss(0);
      for (const [index, delay] of [250, 500, 1000, 2000, 4000, 5000, 5000].entries()) {
        yield* TestClock.adjust(`${delay} millis`);
        assert.equal((yield* Queue.take(f.starts)).index, index + 1);
        assert.deepStrictEqual(yield* Queue.take(f.stops), {
          index: index + 1,
          options: { interrupt: false },
        });
        assert.equal(yield* adapter.hasSession(threadId), false);
        const collected = yield* Queue.takeN(events, yield* Queue.size(events));
        assert.equal(collected.filter((e) => e.type === "request.expired").length, 0);
      }
      f.refuse(false);
      yield* TestClock.adjust("5000 millis");
      assert.equal((yield* Queue.take(f.starts)).index, 8);
      assert.deepStrictEqual(yield* Queue.take(f.stops), {
        index: 0,
        options: { interrupt: false },
      });
      const expired: ProviderRuntimeEvent[] = [];
      while (true) {
        const event = yield* Queue.take(events);
        expired.push(event);
        if (event.type === "session.state.changed" && event.payload.state === "ready") break;
      }
      assert.deepStrictEqual(
        expired.filter((e) => e.type === "request.expired").map((e) => e.requestId),
        ["per_old", "form_old"],
      );
      assert.equal(
        expired.some(
          (e) =>
            e.type === "request.resolved" ||
            e.type === "user-input.resolved" ||
            e.type === "turn.completed",
        ),
        false,
      );
      f.loss(8);
      yield* TestClock.adjust("250 millis");
      assert.equal((yield* Queue.take(f.starts)).index, 9);
      assert.deepStrictEqual(yield* Queue.take(f.stops), {
        index: 8,
        options: { interrupt: false },
      });
      assert.equal(yield* adapter.hasSession(threadId), true);
      assert.deepStrictEqual(f.prompts, [["ask once", {}]]);
      assert.equal(
        f.fake.calls.some(
          (call) =>
            call === "interrupt" || call.startsWith("permission:") || call.startsWith("form:"),
        ),
        false,
      );
      yield* adapter.stopSession(threadId);
    }).pipe(Effect.provide(testLayer)),
);

it.effect(
  "discards a candidate disconnected before adoption without false ready and retries later",
  () =>
    Effect.gen(function* () {
      const f = yield* recoveryFixture();
      const adapter = yield* makeOpenCodeNativeAdapter({
        url: "https://native.example",
        engineCreate: f.create,
      });
      yield* adapter.startSession(start);
      yield* Queue.take(f.starts);
      f.loseDuringStart(true);
      f.loss(0);
      yield* TestClock.adjust("250 millis");
      yield* Queue.take(f.starts);
      assert.deepStrictEqual(yield* Queue.take(f.stops), {
        index: 1,
        options: { interrupt: false },
      });
      assert.equal(yield* adapter.hasSession(threadId), false);
      f.loseDuringStart(false);
      yield* TestClock.adjust("500 millis");
      yield* Queue.take(f.starts);
      yield* Queue.take(f.stops);
      assert.equal(yield* adapter.hasSession(threadId), true);
      yield* adapter.stopSession(threadId);
    }).pipe(Effect.provide(testLayer)),
);

it.effect(
  "explicit stop cancels an in-flight candidate locally, interrupts only the original engine, and fences replacement",
  () =>
    Effect.gen(function* () {
      const f = yield* recoveryFixture();
      const adapter = yield* makeOpenCodeNativeAdapter({
        url: "https://native.example",
        engineCreate: f.create,
      });
      yield* adapter.startSession(start);
      yield* Queue.take(f.starts);
      f.loss(0);
      const held = f.hold();
      yield* TestClock.adjust("250 millis");
      yield* Queue.take(f.starts);
      yield* adapter.stopSession(threadId);
      assert.deepStrictEqual(yield* Queue.take(f.stops), {
        index: 1,
        options: { interrupt: false },
      });
      assert.deepStrictEqual(yield* Queue.take(f.stops), { index: 0, options: undefined });
      yield* adapter.startSession(start);
      yield* Queue.take(f.starts);
      held.resolve({
        success: true,
        data: { id: "ses_native", location: { directory: start.cwd } },
      });
      f.loss(1);
      f.callbacks[0]!({ type: "turn.started", turnID: "obsolete" });
      yield* TestClock.adjust("30 seconds");
      assert.equal((yield* adapter.listSessions())[0]?.status, "ready");
      assert.equal(Option.isNone(yield* Queue.poll(f.starts)), true);
      yield* adapter.stopSession(threadId);
    }).pipe(Effect.provide(testLayer)),
);

it.effect("scope/provider replacement cancels delayed retries and disposes retained contexts", () =>
  Effect.gen(function* () {
    const f = yield* recoveryFixture();
    const scope = yield* Scope.make();
    const adapter = yield* makeOpenCodeNativeAdapter({
      url: "https://native.example",
      engineCreate: f.create,
    }).pipe(Effect.provideService(Scope.Scope, scope));
    yield* adapter.startSession(start);
    yield* Queue.take(f.starts);
    f.loss(0);
    yield* Scope.close(scope, Exit.void);
    assert.deepStrictEqual(yield* Queue.take(f.stops), { index: 0, options: undefined });
    yield* TestClock.adjust("30 seconds");
    assert.equal(Option.isNone(yield* Queue.poll(f.starts)), true);
    assert.deepStrictEqual(yield* adapter.listSessions(), []);
  }).pipe(Effect.provide(testLayer)),
);

it.effect(
  "uncertain admission automatically recovers readiness but never replays the prompt or fabricates its terminal",
  () =>
    Effect.gen(function* () {
      const f = yield* recoveryFixture();
      const adapter = yield* makeOpenCodeNativeAdapter({
        url: "https://native.example",
        engineCreate: f.create,
      });
      yield* adapter.startSession(start);
      yield* Queue.take(f.starts);
      f.fake.breakAdmission();
      yield* adapter.sendTurn({ threadId, input: "uncertain once" }).pipe(Effect.flip);
      assert.equal(yield* adapter.hasSession(threadId), false);
      yield* TestClock.adjust("250 millis");
      assert.equal((yield* Queue.take(f.starts)).options.resumeSessionId, "ses_native");
      assert.deepStrictEqual(yield* Queue.take(f.stops), {
        index: 0,
        options: { interrupt: false },
      });
      assert.equal(yield* adapter.hasSession(threadId), true);
      assert.deepStrictEqual(f.prompts, [["uncertain once", {}]]);
      assert.equal((yield* adapter.listSessions())[0]?.activeTurnId, undefined);
      yield* adapter.stopSession(threadId);
    }).pipe(Effect.provide(testLayer)),
);

it.effect(
  "reasserts unverified native agent and model before new input after an applied switch response is lost",
  () =>
    Effect.gen(function* () {
      for (const explicit of [false, true]) {
        const f = yield* recoveryFixture();
        const adapter = yield* makeOpenCodeNativeAdapter({
          url: "https://native.example",
          engineCreate: f.create,
        });
        const modelSelection = {
          instanceId: ProviderInstanceId.make("opencode"),
          model: "openai/original",
          options: [{ id: "variant", value: "high" }],
        };
        yield* adapter.startSession({ ...start, modelSelection });
        yield* Queue.take(f.starts);
        const switched = f.holdSwitch();
        const send = yield* adapter
          .sendTurn({
            threadId,
            input: "stale waiting prompt",
            modelSelection: {
              ...modelSelection,
              model: "openai/uncertain",
              options: [
                { id: "variant", value: "low" },
                { id: "agent", value: "plan" },
              ],
            },
          })
          .pipe(Effect.exit, Effect.forkChild);
        assert.equal(yield* Queue.take(f.switches), 0);
        assert.deepStrictEqual(f.nativeSelection(), {
          agent: "plan",
          model: { providerID: "openai", id: "uncertain", variant: "low" },
        });
        f.loss(0);
        yield* TestClock.adjust("250 millis");
        yield* Queue.take(f.starts);
        yield* Queue.take(f.stops);
        assert.deepStrictEqual(f.prompts, []);
        assert.equal(yield* Queue.size(f.switches), 0);
        // Recovery must not change native selection or interrupt/replay work.
        assert.equal(f.nativeSelection().agent, "plan");
        assert.equal(f.fake.calls.includes("interrupt"), false);
        // If new remote work starts after adoption, reconciliation must wait for idle.
        f.callbacks[1]!({ type: "turn.started", turnID: "remote-work" });
        const busy = yield* adapter
          .sendTurn({ threadId, input: "not while busy" })
          .pipe(Effect.flip);
        assert.equal(busy._tag, "ProviderAdapterRequestError");
        assert.equal(yield* Queue.size(f.switches), 0);
        assert.deepStrictEqual(f.prompts, []);
        assert.equal(f.nativeSelection().agent, "plan");
        f.callbacks[1]!({ type: "turn.completed", turnID: "remote-work" });
        const choice = explicit
          ? {
              ...modelSelection,
              model: "openai/chosen",
              options: [
                { id: "variant", value: "medium" },
                { id: "agent", value: "review" },
              ],
            }
          : undefined;
        const turn = yield* adapter.sendTurn({
          threadId,
          input: "new prompt",
          interactionMode: "default",
          ...(choice ? { modelSelection: choice } : {}),
        });
        assert.equal(yield* Queue.take(f.switches), 1);
        assert.deepStrictEqual(f.promptSelections, [
          {
            agent: explicit ? "review" : "build",
            model: {
              providerID: "openai",
              id: explicit ? "chosen" : "original",
              variant: explicit ? "medium" : "high",
            },
          },
        ]);
        const ready = (yield* adapter.listSessions())[0];
        switched.resolve({ success: true, data: undefined });
        assert.equal(Exit.isFailure(yield* Fiber.join(send)), true);
        f.callbacks[0]!({ type: "turn.started", turnID: "obsolete" });
        assert.deepStrictEqual((yield* adapter.listSessions())[0], ready);
        f.callbacks[1]!({ type: "turn.started", turnID: turn.turnId });
        f.callbacks[1]!({ type: "turn.completed", turnID: turn.turnId });
        yield* adapter.sendTurn({ threadId, input: "verified prompt", interactionMode: "default" });
        assert.equal(yield* Queue.size(f.switches), 0);
        assert.deepStrictEqual(f.prompts, [
          ["new prompt", {}],
          ["verified prompt", {}],
        ]);
        assert.deepStrictEqual(f.promptSelections[1], f.promptSelections[0]);
        yield* adapter.stopSession(threadId);
      }
    }).pipe(Effect.provide(testLayer)),
);

it.effect(
  "scope closure fences starts during held cleanup and locally closes a late in-flight startup",
  () =>
    Effect.gen(function* () {
      const f = yield* recoveryFixture();
      const scope = yield* Scope.make();
      const adapter = yield* makeOpenCodeNativeAdapter({
        url: "https://native.example",
        engineCreate: f.create,
      }).pipe(Effect.provideService(Scope.Scope, scope));
      yield* adapter.startSession(start);
      yield* Queue.take(f.starts);
      const startup = f.hold();
      const inflightId = ThreadId.make("inflight-at-close");
      const inflight = yield* adapter
        .startSession({ ...start, threadId: inflightId })
        .pipe(Effect.exit, Effect.forkChild);
      assert.equal((yield* Queue.take(f.starts)).index, 1);
      const stop = f.holdStop(0);
      const closing = yield* Scope.close(scope, Exit.void).pipe(Effect.forkChild);
      assert.deepStrictEqual(yield* Queue.take(f.stops), {
        index: 1,
        options: { interrupt: false },
      });
      assert.deepStrictEqual(yield* Queue.take(f.stops), { index: 0, options: undefined });
      const other = { ...start, threadId: ThreadId.make("start-during-close") };
      assert.equal(Exit.isFailure(yield* adapter.startSession(other).pipe(Effect.exit)), true);
      assert.deepStrictEqual(yield* adapter.listSessions(), []);
      startup.resolve({
        success: true,
        data: { id: "ses_native", location: { directory: start.cwd } },
      });
      assert.equal(Exit.isFailure(yield* Fiber.join(inflight)), true);
      assert.deepStrictEqual(yield* Queue.take(f.stops), {
        index: 1,
        options: { interrupt: false },
      });
      stop.resolve();
      yield* Fiber.join(closing);
      assert.equal(Exit.isFailure(yield* adapter.startSession(other).pipe(Effect.exit)), true);
      f.loss(0);
      f.loss(1);
      yield* TestClock.adjust("30 seconds");
      assert.equal(yield* Queue.size(f.starts), 0);
      assert.equal(yield* Queue.size(f.switches), 0);
      assert.equal(f.callbacks.length, 2);
      assert.equal(f.liveSubscriptions.size, 0);
      assert.deepStrictEqual(yield* adapter.listSessions(), []);
      assert.deepStrictEqual(f.prompts, []);
    }).pipe(Effect.provide(testLayer)),
);

it.effect(
  "public stopAll remains reusable and does not orphan a new session during held cleanup",
  () =>
    Effect.gen(function* () {
      const f = yield* recoveryFixture();
      const adapter = yield* makeOpenCodeNativeAdapter({
        url: "https://native.example",
        engineCreate: f.create,
      });
      yield* adapter.startSession(start);
      yield* Queue.take(f.starts);
      const stop = f.holdStop(0);
      const stopping = yield* adapter.stopAll().pipe(Effect.forkChild);
      yield* Queue.take(f.stops);
      const otherId = ThreadId.make("start-during-public-stop");
      yield* adapter.startSession({ ...start, threadId: otherId });
      assert.equal((yield* Queue.take(f.starts)).index, 1);
      stop.resolve();
      yield* Fiber.join(stopping);
      assert.equal(yield* adapter.hasSession(otherId), true);
      assert.deepStrictEqual([...f.liveSubscriptions], [1]);
      yield* adapter.stopAll();
      assert.equal((yield* Queue.take(f.stops)).index, 1);
      assert.equal(f.liveSubscriptions.size, 0);
      yield* adapter.startSession(start);
      assert.equal((yield* Queue.take(f.starts)).index, 2);
      yield* adapter.stopAll();
      assert.equal((yield* Queue.take(f.stops)).index, 2);
      assert.equal(f.liveSubscriptions.size, 0);
      assert.deepStrictEqual(yield* adapter.listSessions(), []);
    }).pipe(Effect.provide(testLayer)),
);
