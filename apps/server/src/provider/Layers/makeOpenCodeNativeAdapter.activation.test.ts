// @effect-diagnostics globalFetch:off - fake I/O drives the real pinned native client and engine.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ProviderRuntimeEvent, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { vi } from "vite-plus/test";

import { foldSubagentActivities } from "../../../../../packages/client-runtime/src/state/subagentRuntime.ts";
import { ServerConfig } from "../../config.ts";
import { openCodeNativeSessionEngineCreate } from "../openCodeNativeSessionEngineCreate.ts";
import { makeOpenCodeNativeAdapter } from "./makeOpenCodeNativeAdapter.ts";

const directory = "/native/activation-fixture";
const session = { id: "ses_activation_parent", location: { directory } };
const threadId = ThreadId.make("native-child-activations");
const decodeRuntimeEvent = Schema.decodeUnknownEffect(ProviderRuntimeEvent);
type NativeEvent = Parameters<
  Parameters<typeof openCodeNativeSessionEngineCreate>[0]["onEvent"]
>[0];
const testLayer = ServerConfig.layerTest(process.cwd(), { prefix: "native-activation-test-" }).pipe(
  Layer.provideMerge(NodeServices.layer),
);
const fixture = () => {
  let demand = Promise.withResolvers<void>();
  let stream!: ReadableStreamDefaultController<Uint8Array>;
  let serial = 0;
  let sequence = 0;
  const nativeEvents: NativeEvent[] = [];
  let replay!: (event: NativeEvent) => void;
  const encode = (type: string, data: Record<string, unknown>, seq = ++sequence, id?: string) =>
    new TextEncoder().encode(
      `data: ${JSON.stringify({
        id: id ?? `evt_activation_${++serial}`,
        created: 1,
        type,
        ...(["server.connected", "session.tool.progress", "session.usage.updated"].includes(type)
          ? {}
          : { durable: { aggregateID: data.sessionID, seq, version: 1 } }),
        data,
      })}\n\n`,
    );
  const create: typeof openCodeNativeSessionEngineCreate = (input) => {
    replay = input.onEvent;
    return openCodeNativeSessionEngineCreate({
      ...input,
      onEvent: (event) => {
        nativeEvents.push(event);
        input.onEvent(event);
      },
      fetch: async (request, options) => {
        const path = new URL(request instanceof Request ? request.url : String(request)).pathname;
        if (path === "/api/event")
          return new Response(
            new ReadableStream<Uint8Array>(
              {
                start(controller) {
                  stream = controller;
                  controller.enqueue(encode("server.connected", {}));
                  options?.signal?.addEventListener(
                    "abort",
                    () => {
                      controller.close();
                      demand.resolve();
                    },
                    { once: true },
                  );
                },
                pull() {
                  demand.resolve();
                },
              },
              { highWaterMark: 0 },
            ),
            { headers: { "content-type": "text/event-stream" } },
          );
        if (path === "/api/session") return Response.json({ data: session });
        if (["permission", "form"].some((kind) => path.endsWith(`/${kind}`)))
          return Response.json({ data: [] });
        if (path.endsWith("/interrupt")) return new Response(null, { status: 204 });
        return new Response(null, { status: 404 });
      },
    });
  };
  const observe = async (
    type: string,
    data: Record<string, unknown> = {},
    seq?: number,
    id?: string,
  ) => {
    await demand.promise;
    demand = Promise.withResolvers<void>();
    stream.enqueue(encode(type, { sessionID: session.id, ...data }, seq, id));
    await demand.promise;
  };
  return { create, nativeEvents, observe, replay: (event: NativeEvent) => replay(event) };
};

it.effect.each([false, true])(
  "real engine repeated child preserves two turn costs, cumulative task usage and late-start guards (background before start: %s)",
  (backgroundBeforeStart) =>
    Effect.gen(function* () {
      const f = fixture();
      const adapter = yield* makeOpenCodeNativeAdapter({
        url: "https://native.example",
        engineCreate: f.create,
      });
      const received = yield* Queue.unbounded<ProviderRuntimeEvent>();
      yield* Stream.runForEach(adapter.streamEvents, (event) => Queue.offer(received, event)).pipe(
        Effect.forkChild,
      );
      yield* adapter.startSession({ threadId, cwd: directory, runtimeMode: "full-access" });
      const observe = (type: string, data: Record<string, unknown> = {}, seq?: number) =>
        Effect.promise(() => f.observe(type, data, seq));
      const events: ProviderRuntimeEvent[] = [];
      const through = (predicate: (event: ProviderRuntimeEvent) => boolean) =>
        Effect.gen(function* () {
          while (true) {
            const event = yield* Queue.take(received);
            events.push(yield* decodeRuntimeEvent(event));
            if (predicate(event)) return;
          }
        });
      const wake = (id: string) =>
        Effect.gen(function* () {
          yield* observe("session.inbox.enqueued", {
            inboxID: id,
            item: { type: "synthetic", delivery: "steer", payload: { text: "continue" } },
          });
          yield* observe("session.execution.started");
          yield* observe("session.inbox.delivered", { inboxID: id });
        });
      const childID = "ses_reused_child";
      const launch = (message: string, id: string, reused: boolean) =>
        Effect.gen(function* () {
          const ref = { assistantMessageID: message, id };
          yield* observe("session.tool.input.started", { ...ref, name: "subagent" });
          yield* observe("session.tool.called", {
            ...ref,
            input: {
              agent: reused ? "review" : "explore",
              ...(reused ? { sessionID: childID } : {}),
            },
            executed: false,
          });
          yield* observe("session.tool.progress", {
            ...ref,
            metadata: { sessionID: childID, status: "running" },
          });
        });
      const tokens = { input: 10, output: 7, reasoning: 2, cache: { read: 3, write: 4 } };
      const step = (message: string, cost: number, seq: number) =>
        observe(
          "session.step.ended",
          {
            sessionID: childID,
            assistantMessageID: message,
            model: { providerID: "openai", id: "gpt" },
            agent: "explore",
            finish: "stop",
            cost,
            tokens,
          },
          seq,
        );
      yield* wake("msg_first");
      yield* launch("msg_parent_first", "call_first", false);
      yield* observe("session.execution.started", { sessionID: childID }, 10);
      yield* observe(
        "session.text.ended",
        {
          sessionID: childID,
          assistantMessageID: "msg_child_first",
          ordinal: 0,
          text: "First result",
        },
        11,
      );
      yield* step("msg_child_first", 0.25, 11);
      yield* observe("session.execution.succeeded", { sessionID: childID }, 12);
      yield* observe("session.execution.succeeded");
      yield* through((event) => event.type === "turn.completed" && event.turnId === "msg_first");
      const firstEvents = [...events];
      yield* wake("msg_second");
      yield* launch("msg_parent_second", "call_second", true);
      if (backgroundBeforeStart) yield* observe("session.execution.succeeded");
      yield* observe(
        "session.execution.failed",
        { sessionID: childID, error: { type: "old", message: "late" } },
        13,
      );
      yield* observe("session.execution.started", { sessionID: childID }, 20);
      yield* through((event) => event.type === "task.updated");
      const fold = (rows: readonly ProviderRuntimeEvent[]) =>
        foldSubagentActivities(
          rows.flatMap((event) =>
            event.type.startsWith("task.")
              ? [
                  {
                    id: event.eventId,
                    kind: event.type,
                    tone: "info" as const,
                    summary: event.type,
                    payload: event.payload,
                    turnId: event.turnId ?? null,
                    createdAt: event.createdAt,
                  },
                ]
              : [],
          ),
          { sessionLive: true },
        );
      assert.equal(fold(events)[0]?.activationCount, 2);
      assert.equal(fold(events)[0]?.status, "running");
      assert.equal(fold(events)[0]?.completedAt, null);
      assert.equal(fold(events)[0]?.result, null);
      yield* observe("session.execution.succeeded", { sessionID: childID }, 12);
      yield* step("msg_child_first", 999, 11);
      yield* observe("session.tool.progress", {
        assistantMessageID: "msg_parent_first",
        id: "call_first",
        metadata: { sessionID: childID, status: "completed" },
      });
      yield* observe("session.synthetic", {
        text: "unkeyed old notification",
        metadata: { source: "subagent", childID, state: "completed" },
      });
      yield* observe(
        "session.text.ended",
        {
          sessionID: childID,
          assistantMessageID: "msg_child_first",
          ordinal: 0,
          text: "Stale result",
        },
        11,
      );
      yield* observe(
        "session.text.ended",
        {
          sessionID: childID,
          assistantMessageID: "msg_child_second",
          ordinal: 0,
          text: "Current result",
        },
        21,
      );
      yield* step("msg_child_second", 0.75, 21);
      yield* step("msg_child_second", 0.75, 21);
      yield* observe("session.usage.updated", { sessionID: childID, cost: 1, tokens });
      yield* observe("session.usage.updated", { sessionID: childID, cost: 1, tokens });
      yield* observe("session.execution.succeeded", { sessionID: childID }, 22);
      if (!backgroundBeforeStart) yield* observe("session.execution.succeeded");
      yield* through((event) =>
        backgroundBeforeStart
          ? event.type === "turn.cost.updated" &&
            event.turnId === "msg_second" &&
            event.payload.status === "final"
          : event.type === "turn.completed" && event.turnId === "msg_second",
      );
      assert.deepStrictEqual(events.slice(0, firstEvents.length), firstEvents);
      assert.deepStrictEqual(
        events
          .filter((event) => event.type === "turn.completed")
          .map((event) => [event.turnId, event.payload.totalCostUsd]),
        [
          ["msg_first", 0.25],
          ["msg_second", backgroundBeforeStart ? undefined : 0.75],
        ],
      );
      assert.deepStrictEqual(
        events
          .filter((event) => event.type === "turn.cost.updated")
          .map((event) => [event.turnId, event.payload.totalCostUsd]),
        [
          ["msg_first", 0.25],
          ["msg_second", 0.75],
          ...(backgroundBeforeStart ? [["msg_second", 0.75]] : []),
        ],
      );
      assert.deepStrictEqual(
        events
          .filter((event) => event.type === "task.started" || event.type === "task.updated")
          .map((event) => [event.type, event.turnId, event.payload.toolUseId]),
        [
          ["task.started", "msg_first", `opencode:${session.id}:msg_parent_first:tool:call_first`],
          [
            "task.updated",
            "msg_second",
            `opencode:${session.id}:msg_parent_second:tool:call_second`,
          ],
        ],
      );
      assert.deepStrictEqual(
        f.nativeEvents
          .filter((event) => event.type === "child.started")
          .map((event) => event.reactivation),
        [undefined, { key: `${session.id}:msg_parent_second:tool:call_second` }],
      );
      assert.equal(fold(events)[0]?.status, "completed");
      assert.equal(fold(events)[0]?.activationCount, 2);
      assert.equal(fold(events)[0]?.usage?.costUsd, 1);
      assert.equal(fold(events)[0]?.usage?.totalTokens, 52);
      assert.equal(fold(events)[0]?.result, "Current result");
      assert.deepStrictEqual(
        events
          .filter((event) => event.type === "task.completed")
          .map((event) => event.payload.summary),
        ["First result", "Current result"],
      );
      yield* adapter.stopSession(threadId);
    }).pipe(Effect.provide(testLayer)),
);

it.effect(
  "200 real child activations retain linear billing archives, cumulative usage and immutable prior costs",
  () =>
    Effect.gen(function* () {
      const count = 200;
      const childID = "ses_stress_reused_child";
      // Observe the actual retained child graph, not allocations or mock call history.
      let retainedHistory: unknown[] = [];
      const mapSet = Map.prototype.set;
      const retention = vi.spyOn(Map.prototype, "set").mockImplementation(function (
        this: Map<unknown, unknown>,
        key: unknown,
        value: unknown,
      ) {
        if (
          key === childID &&
          typeof value === "object" &&
          value !== null &&
          "history" in value &&
          Array.isArray(value.history)
        )
          retainedHistory = value.history;
        return mapSet.call(this, key, value);
      });
      yield* Effect.addFinalizer(() => Effect.sync(() => retention.mockRestore()));
      const f = fixture();
      const adapter = yield* makeOpenCodeNativeAdapter({
        url: "https://native.example",
        engineCreate: f.create,
      });
      const received = yield* Queue.unbounded<ProviderRuntimeEvent>();
      yield* Stream.runForEach(adapter.streamEvents, (event) => Queue.offer(received, event)).pipe(
        Effect.forkChild,
      );
      yield* adapter.startSession({ threadId, cwd: directory, runtimeMode: "full-access" });
      const observe = (type: string, data: Record<string, unknown> = {}, seq?: number) =>
        Effect.promise(() => f.observe(type, data, seq));
      const events: ProviderRuntimeEvent[] = [];
      const through = Effect.fnUntraced(function* (turnID: string) {
        while (true) {
          const event = yield* Queue.take(received);
          events.push(yield* decodeRuntimeEvent(event));
          if (event.type === "turn.completed" && event.turnId === turnID) return;
        }
      });
      const tokens = { input: 10, output: 7, reasoning: 2, cache: { read: 3, write: 4 } };
      let firstCompaction: NativeEvent | undefined;
      for (let i = 0; i < count; i++) {
        const turnID = `msg_stress_turn_${i}`;
        const ref = { assistantMessageID: `msg_stress_parent_${i}`, id: `call_stress_${i}` };
        const seq = 1000 + i * 10;
        yield* observe("session.inbox.enqueued", {
          inboxID: turnID,
          item: { type: "synthetic", delivery: "steer", payload: { text: "continue" } },
        });
        yield* observe("session.execution.started");
        yield* observe("session.inbox.delivered", { inboxID: turnID });
        yield* observe("session.tool.input.started", { ...ref, name: "subagent" });
        yield* observe("session.tool.called", {
          ...ref,
          input: { agent: "explore", ...(i ? { sessionID: childID } : {}) },
          executed: false,
        });
        yield* observe("session.tool.progress", {
          ...ref,
          metadata: { sessionID: childID, status: "running" },
        });
        yield* observe("session.execution.started", { sessionID: childID }, seq);
        if (firstCompaction) f.replay(firstCompaction);
        yield* observe(
          "session.compaction.started",
          { sessionID: childID, reason: "auto", recent: "recent" },
          seq + 1,
        );
        const compacted = {
          sessionID: childID,
          reason: "auto",
          recent: "recent",
          text: "summary",
          model: { providerID: "openai", id: "gpt" },
          cost: 0.125,
          tokens,
        };
        yield* observe("session.compaction.ended", compacted, seq + 2);
        const compaction = f.nativeEvents.findLast(
          (event) => event.type === "compaction.completed",
        );
        assert.isDefined(compaction);
        firstCompaction ??= compaction;
        // Bypass feed-ID dedup with a real decoded canonical event: the attempt
        // record, not a growing second event-ID set, must prevent double charging.
        if (compaction) f.replay(compaction);
        if (i === 0 && compaction?.type === "compaction.completed") {
          // Both engine feed-ID caches retain 4096 IDs. A terminal replay after
          // eviction is re-keyed to its terminal ID; its billing record still
          // needs to suppress the charge without another unbounded set.
          for (let j = 0; j < 4100; j++)
            yield* observe("session.usage.updated", { sessionID: childID, cost: 999, tokens });
          const compactionsBeforeReplay = f.nativeEvents.filter(
            (event) => event.type === "compaction.completed",
          ).length;
          yield* Effect.promise(() =>
            f.observe("session.compaction.ended", compacted, seq + 2, compaction.eventID),
          );
          assert.equal(
            f.nativeEvents.filter((event) => event.type === "compaction.completed").length,
            compactionsBeforeReplay,
            "a terminal replay must be suppressed before emitting another engine compaction",
          );
        }
        yield* observe(
          "session.step.ended",
          {
            sessionID: childID,
            assistantMessageID: `msg_stress_child_${i}`,
            finish: "stop",
            cost: 0.25,
            tokens,
          },
          seq + 3,
        );
        yield* observe("session.execution.succeeded", { sessionID: childID }, seq + 4);
        yield* observe("session.execution.succeeded");
        yield* through(turnID);
      }
      const turns = events.filter((event) => event.type === "turn.completed");
      assert.equal(turns.length, count);
      assert.deepStrictEqual(
        turns.map((event) => [String(event.turnId), event.payload.totalCostUsd]),
        Array.from({ length: count }, (_, i) => [`msg_stress_turn_${i}`, 0.375]),
      );
      const terminals = events.filter((event) => event.type === "task.completed");
      assert.equal(terminals.length, count);
      for (let i = 0; i < count; i++) {
        assert.equal(terminals[i]?.payload.typedUsage?.costUsd, (i + 1) * 0.375);
        assert.equal(terminals[i]?.payload.typedUsage?.totalTokens, (i + 1) * 52);
      }
      assert.equal(events.filter((event) => event.type === "task.updated").length, count - 1);
      assert.equal(retainedHistory.length, count - 1);
      for (const activation of retainedHistory) {
        assert.isObject(activation);
        assert.notProperty(
          activation,
          "history",
          "archives must not retain earlier history arrays",
        );
      }
      yield* adapter.stopSession(threadId);
    }).pipe(Effect.provide(testLayer)),
);

it.effect.each(["complete", "missing-cost", "cost-only", "unresolved", "background"] as const)(
  "real pinned compaction parent/child success/failure replay retains activation ownership and known tokens (%s)",
  (mode) =>
    Effect.gen(function* () {
      const f = fixture();
      const adapter = yield* makeOpenCodeNativeAdapter({
        url: "https://native.example",
        engineCreate: f.create,
      });
      const received = yield* Queue.unbounded<ProviderRuntimeEvent>();
      yield* Stream.runForEach(adapter.streamEvents, (event) => Queue.offer(received, event)).pipe(
        Effect.forkChild,
      );
      yield* adapter.startSession({ threadId, cwd: directory, runtimeMode: "full-access" });
      const observe = (
        type: string,
        data: Record<string, unknown> = {},
        seq?: number,
        id?: string,
      ) => Effect.promise(() => f.observe(type, data, seq, id));
      const events: ProviderRuntimeEvent[] = [];
      const through = (predicate: (event: ProviderRuntimeEvent) => boolean) =>
        Effect.gen(function* () {
          while (true) {
            const event = yield* Queue.take(received);
            events.push(yield* decodeRuntimeEvent(event));
            if (predicate(event)) return;
          }
        });
      const wake = (id: string) =>
        Effect.gen(function* () {
          yield* observe("session.inbox.enqueued", {
            inboxID: id,
            item: { type: "synthetic", delivery: "steer", payload: { text: "continue" } },
          });
          yield* observe("session.execution.started");
          yield* observe("session.inbox.delivered", { inboxID: id });
        });
      const childID = "ses_compaction_child";
      const launch = (id: string, reused: boolean) =>
        Effect.gen(function* () {
          const ref = { assistantMessageID: `msg_parent_${id}`, id };
          yield* observe("session.tool.input.started", { ...ref, name: "subagent" });
          yield* observe("session.tool.called", {
            ...ref,
            input: { agent: "explore", ...(reused ? { sessionID: childID } : {}) },
            executed: false,
          });
          yield* observe("session.tool.progress", {
            ...ref,
            metadata: { sessionID: childID, status: "running" },
          });
        });
      const tokens = { input: 10, output: 7, reasoning: 2, cache: { read: 3, write: 4 } };
      const charge = (
        sessionID: string,
        prefix: string,
        success: boolean,
        cost: number,
        seq: number,
      ) =>
        Effect.gen(function* () {
          const reason = success ? "auto" : "manual";
          const inputID = `msg_${prefix}`;
          yield* observe(
            "session.compaction.started",
            { sessionID, reason, inputID, recent: "recent" },
            seq,
            `evt_${prefix}_start`,
          );
          const type = success ? "session.compaction.ended" : "session.compaction.failed";
          const data = {
            sessionID,
            reason,
            ...(mode === "cost-only" && prefix !== "child_second" ? {} : { tokens }),
            ...(mode === "missing-cost" && prefix !== "child_second" ? {} : { cost }),
            ...(success
              ? {
                  text: "summary",
                  recent: "recent",
                  model: { providerID: "openai", id: "gpt" },
                  providerState: { checkpoint: "kept" },
                }
              : { inputID, error: { type: "api", message: "charged failure" } }),
          };
          yield* observe(type, data, seq + 1, `evt_${prefix}_terminal`);
          yield* observe(type, data, seq + 1, `evt_${prefix}_terminal`);
        });
      yield* wake("msg_compaction_first");
      yield* launch("first", false);
      yield* observe("session.execution.started", { sessionID: childID }, 100);
      for (const [sessionID, prefix, cost, seq] of [
        [session.id, "parent", 0.1, 30],
        [childID, "child", 0.4, 101],
      ] as const) {
        yield* observe(
          "session.step.ended",
          { sessionID, assistantMessageID: `msg_${prefix}_step`, finish: "stop", cost, tokens },
          seq,
        );
        yield* charge(
          sessionID,
          `${prefix}_success`,
          true,
          prefix === "parent" ? 0.2 : 0.5,
          seq + 2,
        );
        yield* charge(
          sessionID,
          `${prefix}_failure`,
          false,
          prefix === "parent" ? 0.3 : 0.6,
          seq + 4,
        );
        if (mode === "unresolved")
          yield* observe(
            "session.compaction.started",
            { sessionID, reason: "auto", recent: "unresolved" },
            seq + 6,
          );
        yield* observe("session.usage.updated", { sessionID, cost: 999, tokens });
        if (mode === "background" && sessionID === session.id)
          yield* observe("session.execution.succeeded", {}, 45);
      }
      yield* observe("session.execution.succeeded", { sessionID: childID }, 120);
      if (mode !== "background") yield* observe("session.execution.succeeded", {}, 45);
      yield* through((event) =>
        mode === "background"
          ? event.type === "turn.cost.updated" && event.payload.status === "final"
          : event.type === "turn.completed",
      );
      const first = events.find((event) => event.type === "turn.completed");
      assert.equal(
        first?.type === "turn.completed" && first.payload.totalCostUsd,
        mode === "complete" || mode === "cost-only" ? 2.1 : undefined,
      );
      assert.deepStrictEqual(first?.type === "turn.completed" && first.payload.tokenUsage, {
        usageScope: "main_agent",
        usageStatus: mode === "complete" || mode === "background" ? "complete" : "partial",
        hasSubagents: true,
        inputTokens: mode === "cost-only" ? 17 : 51,
        outputTokens: mode === "cost-only" ? 9 : 27,
        cachedInputTokens: mode === "cost-only" ? 3 : 9,
        cacheCreationTokens: mode === "cost-only" ? 4 : 12,
        reasoningTokens: mode === "cost-only" ? 2 : 6,
      });
      const childTerminal = events.find((event) => event.type === "task.completed");
      if (mode === "background") {
        const finalCost = events.find(
          (event) => event.type === "turn.cost.updated" && event.payload.status === "final",
        );
        assert.equal(
          finalCost?.type === "turn.cost.updated" && finalCost.payload.totalCostUsd,
          2.1,
        );
      }
      assert.equal(
        childTerminal?.type === "task.completed" && childTerminal.payload.typedUsage?.totalTokens,
        mode === "cost-only" ? 26 : 78,
      );
      assert.equal(
        childTerminal?.type === "task.completed" && childTerminal.payload.typedUsage?.costUsd,
        mode === "missing-cost" ? 0.4 : 1.5,
      );
      const compact = f.nativeEvents.filter(
        (event) => event.type === "compaction.completed" || event.type === "compaction.failed",
      );
      assert.equal(compact.length, 4);
      assert.equal(
        compact[0]?.type === "compaction.completed" && compact[0].inputID,
        "msg_parent_success",
      );
      assert.equal(
        compact[0]?.type === "compaction.completed" && compact[0].key,
        "evt_parent_success_start",
      );
      const context = events.filter((event) => event.type === "thread.token-usage.updated");
      assert.equal(
        context.filter((event) => event.payload.usage.usedTokens !== undefined).length,
        1,
      );
      assert.equal(context.at(-1)?.payload.usage.contextUsageStatus, "unknown");
      assert.notProperty(context.at(-1)?.payload.usage, "usedTokens");
      const original = [...events];
      yield* wake("msg_compaction_second");
      yield* launch("second", true);
      yield* observe("session.execution.started", { sessionID: childID }, 200);
      yield* observe(
        "session.compaction.failed",
        {
          sessionID: childID,
          reason: "manual",
          inputID: "msg_child_failure",
          cost: 999,
          tokens,
          error: { type: "old", message: "replay" },
        },
        106,
        "evt_child_failure_terminal",
      );
      yield* charge(childID, "child_second", true, 0.7, 201);
      yield* observe("session.execution.succeeded", { sessionID: childID }, 210);
      yield* observe("session.execution.succeeded", {}, 60);
      yield* through(
        (event) => event.type === "turn.completed" && event.turnId === "msg_compaction_second",
      );
      assert.deepStrictEqual(events.slice(0, original.length), original);
      const second = events.find(
        (event) => event.type === "turn.completed" && event.turnId === "msg_compaction_second",
      );
      assert.equal(second?.type === "turn.completed" && second.payload.totalCostUsd, 0.7);
      const terminals = events.filter((event) => event.type === "task.completed");
      assert.equal(
        terminals[1]?.type === "task.completed" && terminals[1].payload.typedUsage?.totalTokens,
        mode === "cost-only" ? 52 : 104,
      );
      assert.equal(
        terminals[1]?.type === "task.completed" && terminals[1].payload.typedUsage?.costUsd,
        mode === "missing-cost" ? 1.1 : 2.2,
      );
      yield* adapter.stopSession(threadId);
    }).pipe(Effect.provide(testLayer)),
);
