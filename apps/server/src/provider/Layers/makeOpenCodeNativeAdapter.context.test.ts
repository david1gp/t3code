import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { Session } from "@opencode/client/effect";
import { ProviderInstanceId, ThreadId, ProviderRuntimeEvent } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { ServerConfig } from "../../config.ts";
import type { openCodeNativeSessionEngineCreate } from "../openCodeNativeSessionEngineCreate.ts";
import { makeOpenCodeNativeAdapter } from "./makeOpenCodeNativeAdapter.ts";

type NativeEvent = Parameters<
  Parameters<typeof openCodeNativeSessionEngineCreate>[0]["onEvent"]
>[0];
const threadId = ThreadId.make("native-context");
const instanceId = ProviderInstanceId.make("opencode");
const layer = ServerConfig.layerTest(process.cwd(), { prefix: "native-context-" }).pipe(
  Layer.provideMerge(NodeServices.layer),
);
const tokens = { input: 10, output: 5, reasoning: 2, cache: { read: 3, write: 1 } };
const stepStartedDecode = Schema.decodeSync(Schema.toEncoded(Session.Event.Step.Started.data));
const stepEndedDecode = Schema.decodeSync(Schema.toEncoded(Session.Event.Step.Ended.data));
const stepEndedDecodeEffect = Schema.decodeEffect(Schema.toEncoded(Session.Event.Step.Ended.data));
const stepFailedDecode = Schema.decodeEffect(Schema.toEncoded(Session.Event.Step.Failed.data));
const compactionStartedDecode = Schema.decodeEffect(
  Schema.toEncoded(Session.Event.Compaction.Started.data),
);
const compactionEndedDecode = Schema.decodeEffect(
  Schema.toEncoded(Session.Event.Compaction.Ended.data),
);
const runtimeDecode = Schema.decodeEffect(ProviderRuntimeEvent);
const lookupCreate = Effect.fnUntraced(function* () {
  const value = yield* Deferred.make<number>();
  let resolve!: (value: number) => void;
  const promise = new Promise<number>((complete) => (resolve = complete));
  yield* Deferred.await(value).pipe(
    Effect.tap((limit) => Effect.sync(() => resolve(limit))),
    Effect.forkChild,
  );
  return { promise, complete: (limit: number) => Deferred.succeed(value, limit) };
});
const scope = { sessionID: "ses_native", turnID: "msg_user" };
const model = (id: string) => ({ providerID: "native", id });
const started = (id: string, modelId: string): NativeEvent => ({
  type: "step.started",
  ...scope,
  step: stepStartedDecode({
    sessionID: scope.sessionID,
    assistantMessageID: id,
    agent: "build",
    model: model(modelId),
    started: 1,
  }),
});
const ended = (id: string, input = 10): NativeEvent => ({
  type: "step.completed",
  ...scope,
  step: stepEndedDecode({
    sessionID: scope.sessionID,
    assistantMessageID: id,
    finish: "stop",
    cost: 0.25,
    tokens: { ...tokens, input },
  }),
});
const fixture = Effect.fnUntraced(function* (
  lookup: (model: {
    readonly id: string;
    readonly providerID: string;
  }) => Promise<number | undefined>,
) {
  let receive!: (event: NativeEvent) => void;
  const engineCreate = ((input: Parameters<typeof openCodeNativeSessionEngineCreate>[0]) => {
    receive = input.onEvent;
    return {
      start: async () => ({
        success: true,
        data: { id: "ses_native", location: { directory: "/tmp/native-context" } },
      }),
      send: async () => ({ success: true, data: { turnID: scope.turnID } }),
      switchSelection: async () => ({ success: true, data: undefined }),
      stop: async () => ({ success: true, data: undefined }),
      reconcilePending: async () => ({ success: true, data: undefined }),
      replyPermission: async () => ({ success: true, data: undefined }),
      replyForm: async () => ({ success: true, data: undefined }),
      recover: async () => ({ success: true, data: undefined }),
      interrupt: async () => ({ success: true, data: false }),
      contextLimit: lookup,
      compact: async () => ({
        success: true as const,
        data: { turnID: scope.turnID, inputID: "msg_compact" },
      }),
    };
  }) as typeof openCodeNativeSessionEngineCreate;
  const adapter = yield* makeOpenCodeNativeAdapter({ url: "https://native.example", engineCreate });
  const queue = yield* Queue.unbounded<ProviderRuntimeEvent>();
  yield* Stream.runForEach(adapter.streamEvents, (event) => Queue.offer(queue, event)).pipe(
    Effect.forkChild,
  );
  yield* adapter.startSession({
    threadId,
    cwd: "/tmp/native-context",
    runtimeMode: "full-access",
    modelSelection: { instanceId, model: "native/selected" },
  });
  yield* adapter.sendTurn({ threadId, input: "hello" });
  receive({ type: "turn.started", turnID: scope.turnID });
  const through = Effect.fnUntraced(function* (
    predicate: (event: ProviderRuntimeEvent) => boolean,
  ) {
    const events: ProviderRuntimeEvent[] = [];
    while (true) {
      const event = yield* Queue.take(queue);
      yield* runtimeDecode(event);
      events.push(event);
      if (predicate(event)) return events;
    }
  });
  const finish = Effect.fnUntraced(function* () {
    receive({ type: "turn.completed", turnID: scope.turnID });
    return yield* through((event) => event.type === "turn.completed");
  });
  return { adapter, emit: receive, through, finish };
});
const usages = (events: ProviderRuntimeEvent[]) =>
  events.flatMap((event) =>
    event.type === "thread.token-usage.updated" ? [event.payload.usage] : [],
  );

it.effect(
  "native effective response model drives limits and reasoning-inclusive occupancy without double charging output",
  () =>
    Effect.gen(function* () {
      const limit = yield* lookupCreate();
      const calls: string[] = [];
      const test = yield* fixture((ref) => {
        calls.push(`${ref.providerID}/${ref.id}`);
        return limit.promise;
      });
      test.emit(started("msg_answer", "actual"));
      test.emit(ended("msg_answer"));
      yield* limit.complete(100_000);
      const events = yield* test.through(
        (event) =>
          event.type === "thread.token-usage.updated" && event.payload.usage.maxTokens === 100_000,
      );
      assert.deepStrictEqual(calls, ["native/actual"]);
      assert.deepStrictEqual(usages(events).at(-1), {
        contextUsageStatus: "estimated",
        usedTokens: 21,
        lastUsedTokens: 21,
        maxTokens: 100_000,
        inputTokens: 14,
        cachedInputTokens: 3,
        outputTokens: 5,
        reasoningOutputTokens: 2,
        lastInputTokens: 14,
        lastCachedInputTokens: 3,
        lastOutputTokens: 5,
        lastReasoningOutputTokens: 2,
      });
      assert.equal((yield* test.adapter.listSessions())[0]?.model, "native/actual");
      const terminal = (yield* test.finish()).at(-1);
      assert.equal(terminal?.type, "turn.completed");
      if (terminal?.type === "turn.completed") {
        assert.equal(terminal.payload.costModel, "native/actual");
        assert.equal(terminal.payload.tokenUsage?.outputTokens, 7);
        assert.equal(terminal.payload.tokenUsage?.reasoningTokens, 2);
      }
    }).pipe(Effect.provide(layer)),
);

it.effect(
  "latest usage fences pending same-model lookups, including a zero-occupancy snapshot",
  () =>
    Effect.gen(function* () {
      const limit = yield* lookupCreate();
      let lookup!: Promise<number | undefined>;
      const test = yield* fixture(() => (lookup = limit.promise));
      test.emit(started("msg_one", "selected"));
      test.emit(ended("msg_one", 100));
      test.emit(started("msg_two", "selected"));
      test.emit({
        type: "step.completed",
        ...scope,
        step: yield* stepEndedDecodeEffect({
          sessionID: scope.sessionID,
          assistantMessageID: "msg_two",
          finish: "stop",
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        }),
      });
      yield* limit.complete(50_000);
      yield* Effect.promise(() => lookup);
      const events = yield* test.finish();
      const withLimit = usages(events).filter((usage) => usage.maxTokens !== undefined);
      assert.equal(withLimit.length, 1);
      assert.equal(withLimit[0]?.usedTokens, 0);
    }).pipe(Effect.provide(layer)),
);

it.effect(
  "model generation fences old limits across selection and mixed responses have no cached single-model label",
  () =>
    Effect.gen(function* () {
      const oldLimit = yield* lookupCreate();
      const newLimit = yield* lookupCreate();
      let oldLookup!: Promise<number | undefined>;
      const calls: string[] = [];
      const test = yield* fixture((ref) => {
        calls.push(ref.id);
        const lookup = (ref.id === "first" ? oldLimit : newLimit).promise;
        if (ref.id === "first") oldLookup = lookup;
        return lookup;
      });
      test.emit(started("msg_one", "first"));
      test.emit(ended("msg_one", 100));
      test.emit({ type: "model.selected", sessionID: scope.sessionID, model: model("second") });
      test.emit(started("msg_two", "second"));
      test.emit(ended("msg_two", 20));
      yield* newLimit.complete(200_000);
      const events = yield* test.through(
        (event) =>
          event.type === "thread.token-usage.updated" && event.payload.usage.maxTokens === 200_000,
      );
      yield* oldLimit.complete(1_000);
      yield* Effect.promise(() => oldLookup);
      const tail = yield* test.finish();
      assert.deepStrictEqual(calls, ["first", "second"]);
      assert.equal(usages(tail).length, 0);
      assert.equal(usages(events).at(-1)?.usedTokens, 31);
      const terminal = tail.at(-1);
      if (terminal?.type === "turn.completed") assert.notProperty(terminal.payload, "costModel");
    }).pipe(Effect.provide(layer)),
);

it.effect(
  "returning to the same model starts a fresh lookup generation instead of reusing an older pending limit",
  () =>
    Effect.gen(function* () {
      const first = yield* lookupCreate();
      const second = yield* lookupCreate();
      const current = yield* lookupCreate();
      const calls: string[] = [];
      const test = yield* fixture((ref) => {
        calls.push(ref.id);
        return calls.length === 1
          ? first.promise
          : calls.length === 2
            ? second.promise
            : current.promise;
      });
      test.emit(started("msg_first", "a"));
      test.emit(ended("msg_first", 100));
      test.emit({ type: "model.selected", sessionID: scope.sessionID, model: model("b") });
      test.emit({ type: "model.selected", sessionID: scope.sessionID, model: model("a") });
      test.emit(started("msg_current", "a"));
      test.emit(ended("msg_current", 20));
      yield* current.complete(200_000);
      yield* test.through(
        (event) =>
          event.type === "thread.token-usage.updated" && event.payload.usage.maxTokens === 200_000,
      );
      yield* first.complete(1_000);
      yield* second.complete(2_000);
      yield* Effect.promise(() => Promise.all([first.promise, second.promise]));
      assert.deepStrictEqual(calls, ["a", "b", "a"]);
      assert.equal(usages(yield* test.finish()).length, 0);
    }).pipe(Effect.provide(layer)),
);

it.effect(
  "compaction immediately invalidates occupancy and summary or provider replacement tokens never become context",
  () =>
    Effect.gen(function* () {
      const limit = yield* lookupCreate();
      let lookup!: Promise<number | undefined>;
      const test = yield* fixture(() => (lookup = limit.promise));
      test.emit(started("msg_before", "selected"));
      test.emit(ended("msg_before", 100));
      const base = {
        ...scope,
        key: "compact",
        durable: { aggregateID: scope.sessionID, seq: 1, version: 1 },
      };
      test.emit({
        ...base,
        type: "compaction.started",
        eventID: "start",
        compaction: yield* compactionStartedDecode({
          sessionID: scope.sessionID,
          reason: "auto",
          recent: "",
        }),
      });
      const startEvents = yield* test.through(
        (event) =>
          event.type === "thread.token-usage.updated" &&
          event.payload.usage.contextUsageStatus === "unknown",
      );
      assert.notProperty(usages(startEvents).at(-1), "usedTokens");
      test.emit({
        ...base,
        type: "compaction.completed",
        eventID: "end",
        compaction: yield* compactionEndedDecode({
          sessionID: scope.sessionID,
          reason: "auto",
          model: model("selected"),
          text: "",
          recent: "",
          cost: 0.5,
          tokens: { ...tokens, input: 9_000 },
          providerContext: {
            version: 1,
            provenance: {
              providerID: "native",
              provider: "test",
              modelID: "selected",
              route: "test",
              protocol: "test",
              endpoint: "digest",
            },
            messages: [],
          },
        }),
      });
      yield* limit.complete(200_000);
      yield* Effect.promise(() => lookup);
      const events = yield* test.finish();
      for (const usage of usages(events)) {
        assert.equal(usage.contextUsageStatus, "unknown");
        assert.notProperty(usage, "usedTokens");
        assert.notProperty(usage, "compactsAutomatically");
      }
      const terminal = events.at(-1);
      if (terminal?.type === "turn.completed") {
        assert.equal(terminal.payload.totalCostUsd, 0.75);
        assert.equal(terminal.payload.tokenUsage?.inputTokens, 9_108);
      }
      // A subsequent real request restores occupancy, never the summary request.
      test.emit({ type: "turn.started", turnID: scope.turnID });
      test.emit(started("msg_after", "selected"));
      test.emit(ended("msg_after", 20));
      const after = yield* test.through(
        (event) =>
          event.type === "thread.token-usage.updated" && event.payload.usage.usedTokens === 31,
      );
      assert.equal(usages(after).at(-1)?.contextUsageStatus, "estimated");
    }).pipe(Effect.provide(layer)),
);

it.effect(
  "failed limit lookup preserves the latest estimated usage without inventing limits or auto-compaction settings",
  () =>
    Effect.gen(function* () {
      const value = yield* Deferred.make<void>();
      let reject!: (error: Error) => void;
      const lookup = new Promise<number | undefined>((_resolve, fail) => (reject = fail));
      yield* Deferred.await(value).pipe(
        Effect.tap(() => Effect.sync(() => reject(new Error("model list unavailable")))),
        Effect.forkChild,
      );
      const test = yield* fixture(() => lookup);
      test.emit(started("msg_answer", "selected"));
      test.emit(ended("msg_answer"));
      yield* Deferred.succeed(value, undefined);
      yield* Effect.promise(() => lookup.catch(() => undefined));
      const events = yield* test.finish();
      const usage = usages(events).at(-1);
      assert.equal(usage?.usedTokens, 21);
      assert.equal(usage?.contextUsageStatus, "estimated");
      assert.notProperty(usage, "maxTokens");
      assert.notProperty(usage, "compactsAutomatically");
    }).pipe(Effect.provide(layer)),
);

it.effect(
  "failed native usage keeps known tokens with partial cost and unknown failures clear context",
  () =>
    Effect.gen(function* () {
      const test = yield* fixture(async () => undefined);
      test.emit(started("msg_paid", "actual"));
      test.emit({
        type: "step.failed",
        ...scope,
        step: yield* stepFailedDecode({
          sessionID: scope.sessionID,
          assistantMessageID: "msg_paid",
          error: { type: "error", message: "failed" },
          tokens,
        }),
      });
      const events = yield* test.through(
        (event) =>
          event.type === "thread.token-usage.updated" && event.payload.usage.usedTokens === 21,
      );
      assert.equal(usages(events).at(-1)?.contextUsageStatus, "estimated");
      test.emit(started("msg_unknown", "actual"));
      test.emit({
        type: "step.failed",
        ...scope,
        step: yield* stepFailedDecode({
          sessionID: scope.sessionID,
          assistantMessageID: "msg_unknown",
          error: { type: "error", message: "no usage" },
        }),
      });
      const terminalEvents = yield* test.finish();
      assert.equal(usages(terminalEvents).at(-1)?.contextUsageStatus, "unknown");
      const terminal = terminalEvents.at(-1);
      if (terminal?.type === "turn.completed") {
        assert.equal(terminal.payload.tokenUsage?.inputTokens, 14);
        assert.equal(terminal.payload.tokenUsage?.outputTokens, 7);
        assert.equal(terminal.payload.tokenUsage?.usageStatus, "partial");
        assert.notProperty(terminal.payload, "totalCostUsd");
      }
    }).pipe(Effect.provide(layer)),
);
