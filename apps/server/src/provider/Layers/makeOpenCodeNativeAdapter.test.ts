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
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { ServerConfig } from "../../config.ts";
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
          receive({ type: "turn.started", turnID });
          receive({ type: "turn.completed", turnID });
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
      assert.deepStrictEqual(next.calls, ["start:/tmp/native-v2"]);
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
          recoverable: false,
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

it.effect(
  "exposes a lost active session without inventing a turn terminal or retrying its prompt",
  () =>
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
      fake.emit({ type: "stream.lost", sessionID: "ses_other" });
      fake.emit({ type: "stream.lost", sessionID: "ses_native" });
      yield* Deferred.await(exited);
      yield* Effect.forEach(events, (event) => decodeRuntimeEvent(event), { discard: true });
      assert.equal((yield* adapter.listSessions())[0]?.status, "error");
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
          "The outcome of related OpenCode child session ses_background is unknown because the parent session was lost: Native event stream lost; turn outcome is uncertain.",
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
