// @effect-diagnostics nodeBuiltinImport:off - isolated pinned-SDK fake-provider fixture.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  createAgentSession,
  AgentSession,
  type AgentSessionEvent,
  type CompactionResult,
  VERSION,
} from "@earendil-works/pi-coding-agent";
import { assert, it } from "@effect/vitest";
import { afterEach, vi } from "vite-plus/test";
import {
  ProviderDriverKind,
  ThreadId,
  UsageDay,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";
import { HostProcessEnvironment } from "@t3tools/shared/hostProcess";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import { ServerConfig } from "../../config.ts";
import * as ServerSettings from "../../serverSettings.ts";
import { runtimeEventToActivities } from "../../orchestration/Layers/ProviderRuntimeIngestion.ts";
import { ProjectionThreadActivityRepository } from "../../persistence/Services/ProjectionThreadActivities.ts";
import { ProjectionThreadActivityRepositoryLive } from "../../persistence/Layers/ProjectionThreadActivities.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import * as UsageService from "../../usage/UsageService.ts";
import { foldSubagentActivities } from "../../../../../packages/client-runtime/src/state/subagentRuntime.ts";
import { makePiAdapter } from "./PiAdapter.ts";

vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@earendil-works/pi-coding-agent")>();
  return { ...actual, createAgentSession: vi.fn(actual.createAgentSession) };
});

type Usage = NonNullable<CompactionResult["usage"]>;
const charge = (input = 100, output = 20, total = 0.02): Usage => ({
  input,
  output,
  cacheRead: 3,
  cacheWrite: 2,
  totalTokens: input + output + 5,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total },
});
const controlKey = Symbol.for("t3.pi.adapter.accounting.test");
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
const roots: string[] = [];
const accountingFixtureDecode = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      sdkVersion: Schema.String,
      independentlyKnownUsage: Schema.Array(
        Schema.Struct({ cost: Schema.Struct({ total: Schema.Finite }) }),
      ),
      records: Schema.Array(
        Schema.Struct({
          name: Schema.String,
          payload: Schema.Record(Schema.String, Schema.Unknown),
        }),
      ),
    }),
  ),
);
const accountingOutputEncode = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
afterEach(() => {
  vi.restoreAllMocks();
  Reflect.deleteProperty(globalThis, controlKey);
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  for (const root of roots.splice(0)) NodeFS.rmSync(root, { recursive: true, force: true });
});

const testLayer = ServerConfig.layerTest(process.cwd(), { prefix: "pi-accounting-test-" }).pipe(
  Layer.provideMerge(NodeServices.layer),
);

function fixture(
  auto = false,
  startup = false,
  records?: ReturnType<typeof accountingFixtureDecode>["records"],
) {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "pi-adapter-accounting-"));
  roots.push(root);
  const agentDir = NodePath.join(root, "agent");
  NodeFS.mkdirSync(NodePath.join(agentDir, "extensions"), { recursive: true });
  const sdk = NodeFS.realpathSync("node_modules/@earendil-works/pi-coding-agent");
  NodeFS.symlinkSync(
    NodePath.dirname(NodePath.dirname(sdk)),
    NodePath.join(agentDir, "node_modules"),
  );
  NodeFS.writeFileSync(
    NodePath.join(agentDir, "settings.json"),
    JSON.stringify({
      compaction: { enabled: auto, reserveTokens: 4500, keepRecentTokens: 0 },
      retry: { enabled: false },
      cacheWarming: "off",
    }),
  );
  const control = {
    rounds: [] as {
      text: string;
      usage: Usage;
      stopReason?: "error";
      tool?: boolean;
      hold?: boolean;
      resume?: string;
    }[],
    calls: 0,
    startup,
    child: false,
    records,
    phase: 0,
    startupSettled: Promise.withResolvers<void>(),
    summaryEntered: Promise.withResolvers<void>(),
  };
  Reflect.set(globalThis, controlKey, control);
  NodeFS.writeFileSync(
    NodePath.join(agentDir, "extensions", "fixture.js"),
    `
    import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
    import { Type } from "typebox";
    export default function(pi) {
      const control = globalThis[Symbol.for("t3.pi.adapter.accounting.test")];
      pi.registerProvider("accounting-fixture", {
        api: "accounting-fixture", apiKey: "fake", baseUrl: "https://fixture.invalid",
        models: [{ id: "main", name: "Main", reasoning: false, input: ["text"],
          contextWindow: 5000, maxTokens: 1000,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
        streamSimple: (model, _context, options) => {
          const stream = createAssistantMessageEventStream();
          const round = control.rounds.shift();
          if (!round) throw new Error("No scripted response");
          control.calls++;
          const message = { role: "assistant", content: round.tool
             ? [{ type: "toolCall", id: "child-result-" + control.calls, name: control.records ? "Agent" : "ChildReport", arguments: round.resume ? { resume: round.resume } : {} }]
            : [{ type: "text", text: round.text }],
            api: model.api, provider: model.provider, model: model.id, usage: round.usage,
            timestamp: Date.now(), stopReason: round.tool ? "toolUse" : round.stopReason ?? "stop",
            ...(round.stopReason === "error" ? { errorMessage: "summary failed" } : {}) };
          const finish = () => {
            stream.push(message.stopReason === "error"
              ? { type: "error", reason: "error", error: message }
              : { type: "done", reason: message.stopReason, message });
            stream.end(message);
          };
          if (round.hold) {
            control.summaryEntered.resolve();
            const abort = () => {
              message.stopReason = "aborted";
              stream.push({ type: "error", reason: "aborted", error: message });
              stream.end(message);
            };
            if (options.signal?.aborted) abort();
            else options.signal?.addEventListener("abort", abort, { once: true });
          } else queueMicrotask(finish);
          return stream;
        }
      });
      pi.registerTool({ name: "ChildReport", label: "Child report", description: "Fixture child report",
          parameters: Type.Object({}), execute: async () => ({
            content: [{ type: "text", text: "Child output" }],
            details: { usage: { input: 9000, output: 1000, totalTokens: 10000, cost: { total: 99 } } }
           }) });
      if (control.records) pi.registerTool({ name: "Agent", label: "Agent", description: "Replay captured actual Agent result",
        parameters: Type.Object({ resume: Type.Optional(Type.String()) }), execute: async () => {
          const phases = [];
          for (const record of control.records) {
            if (record.name === "phase") phases.push([]);
            else phases.at(-1)?.push(record);
          }
          const phase = phases[control.phase++];
          for (const record of phase) if (record.name.startsWith("subagents:")) pi.events.emit(record.name, record.payload);
          // Exactly the emitted terminal can be replayed; cumulative usage is not a delta.
          const terminal = phase.find(record => record.name === "subagents:completed");
          pi.events.emit(terminal.name, terminal.payload);
          return phase.find(record => record.name === "tool_execution_end").payload.result;
        } });
      pi.on("session_start", async (_event, ctx) => {
        await pi.setModel(ctx.modelRegistry.find("accounting-fixture", "main"));
        if (control.startup) {
          pi.sendMessage({ customType: "startup", content: "startup", display: false }, { triggerTurn: true });
          await control.startupSettled.promise;
        }
      });
      pi.on("agent_settled", () => control.startupSettled.resolve());
      pi.on("agent_start", () => {
        if (!control.child) return;
        pi.events.emit("subagents:started", { id: "child", description: "Child" });
        pi.events.emit("subagents:completed", { id: "child", usage: {
          input: 9000, output: 1000, totalTokens: 10000, cost: { total: 99 }
        } });
      });
      pi.registerCommand("manual-summary", { handler: async (_args, ctx) => {
        await new Promise((resolve, reject) => ctx.compact({ onComplete: resolve, onError: reject }));
      } });
    }
  `,
  );
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const threadId = ThreadId.make("pi-accounting");
  const start = {
    threadId,
    provider: ProviderDriverKind.make("pi"),
    cwd: root,
    runtimeMode: "full-access" as const,
  };
  const sdkSession = async (): Promise<AgentSession> => {
    const result: Awaited<ReturnType<typeof createAgentSession>> = await vi
      .mocked(createAgentSession)
      .mock.results.at(-1)!.value;
    return result.session;
  };
  return { root, control, start, threadId, sdkSession };
}

const collect = (adapter: Effect.Success<ReturnType<typeof makePiAdapter>>) =>
  Effect.gen(function* () {
    const events: ProviderRuntimeEvent[] = [];
    const waiters = new Map<number, Deferred.Deferred<void>>();
    yield* Stream.runForEach(adapter.streamEvents, (event) =>
      Effect.gen(function* () {
        events.push(event);
        const count = events.filter((value) => value.type === "turn.completed").length;
        const waiter = waiters.get(count);
        if (waiter) yield* Deferred.succeed(waiter, undefined);
      }),
    ).pipe(Effect.forkScoped({ startImmediately: true }));
    const completed = (count: number) =>
      Effect.gen(function* () {
        if (events.filter((event) => event.type === "turn.completed").length >= count) return;
        const done = yield* Deferred.make<void>();
        waiters.set(count, done);
        yield* Deferred.await(done);
      });
    return { events, completed };
  });

for (const mode of ["complete", "partial"] as const)
  it.effect.skipIf(!process.env.PI_SUBAGENTS_ACCOUNTING_FIXTURE)(
    `preserves actual corrected child compaction and repeated lifetime usage separately from ${mode} parent cost through SQL and Usage`,
    () =>
      Effect.gen(function* () {
        const captured = accountingFixtureDecode(
          yield* Effect.promise(() =>
            NodeFS.promises.readFile(process.env.PI_SUBAGENTS_ACCOUNTING_FIXTURE!, "utf8"),
          ),
        );
        assert.equal(captured.sdkVersion, "0.87.1");
        const knownChildCost = captured.independentlyKnownUsage.reduce(
          (sum, usage) => sum + usage.cost.total,
          0,
        );
        assert.approximately(knownChildCost, 0.1, 1e-12);
        const id = captured.records.find((record) => record.name === "subagents:started")!.payload
          .id as string;
        const f = fixture(true, false, captured.records);
        const secondSummary = charge(100, 20, 0.023);
        const secondAnswer = charge(1000, 10, 0.022);
        f.control.rounds.push(
          { text: "", tool: true, usage: charge(20, 5, 0.011) },
          { text: "first parent", usage: charge(1000, 10, 0.012) },
          { text: "parent summary", usage: charge(100, 20, 0.013) },
          { text: "", tool: true, resume: id, usage: charge(20, 5, 0.021) },
          { text: "second parent", usage: secondAnswer },
          {
            text: "parent summary",
            usage: secondSummary,
            ...(mode === "partial" ? { stopReason: "error" as const } : {}),
          },
        );
        if (mode === "complete")
          f.control.rounds.push({ text: "parent prefix summary", usage: charge(25, 3, 0.024) });
        const adapter = yield* makePiAdapter();
        const c = yield* collect(adapter);
        yield* adapter.startSession(f.start);
        const sdk = yield* Effect.promise(f.sdkSession);
        const stats = vi.spyOn(sdk, "getSessionStats");
        const turns = [];
        turns.push(
          (yield* adapter.sendTurn({ threadId: f.threadId, input: "fresh child" })).turnId,
        );
        yield* c.completed(1);
        turns.push(
          (yield* adapter.sendTurn({ threadId: f.threadId, input: "resume child" })).turnId,
        );
        yield* c.completed(2);
        assert.equal(stats.mock.calls.length, 0);
        const toolResults = sdk.sessionManager
          .getEntries()
          .flatMap((entry) =>
            entry.type === "message" && entry.message.role === "toolResult" ? [entry.message] : [],
          );
        assert.equal(toolResults.length, 2);
        assert.approximately(toolResults[0]!.usage!.cost.total, 0.03, 1e-12);
        assert.approximately(toolResults[1]!.usage!.cost.total, 0.07, 1e-12);
        yield* adapter.stopSession(f.threadId);
        const tasks = c.events.filter((event) => event.type === "task.completed");
        assert.equal(tasks.length, 2);
        assert.deepEqual(
          tasks.map((event) => event.turnId),
          turns,
        );
        assert.deepEqual(
          tasks.map((event) => event.payload.typedUsage?.totalTokens),
          [1140, 1315],
        );
        assert.approximately(tasks[0]!.payload.typedUsage!.costUsd!, 0.03, 1e-12);
        assert.approximately(tasks[1]!.payload.typedUsage!.costUsd!, knownChildCost, 1e-12);
        const parent = c.events.filter((event) => event.type === "turn.completed");
        assert.approximately(parent[0]!.payload.totalCostUsd!, 0.036, 1e-12);
        assert.equal(parent[1]!.payload.tokenUsage?.usageStatus, mode);
        assert.equal(parent[1]!.payload.tokenUsage?.inputTokens, mode === "complete" ? 1165 : 1030);
        if (mode === "complete")
          assert.approximately(parent[1]!.payload.totalCostUsd!, 0.09, 1e-12);
        else assert.isUndefined(parent[1]!.payload.totalCostUsd);
        assert.equal(f.control.calls, mode === "complete" ? 7 : 6);
        const repository = yield* ProjectionThreadActivityRepository;
        const taskActivities = c.events
          .flatMap((event) => runtimeEventToActivities(event))
          .filter((activity) => activity.kind.startsWith("task."));
        const folded = foldSubagentActivities(taskActivities);
        assert.equal(folded.length, 1);
        assert.equal(folded[0]!.activationCount, 2);
        assert.approximately(folded[0]!.usage!.costUsd!, knownChildCost, 1e-12);
        assert.equal(folded[0]!.usage!.totalTokens, 1315);
        for (const event of c.events) {
          for (const activity of runtimeEventToActivities(event)) {
            yield* repository.upsert({
              activityId: activity.id,
              threadId: event.threadId,
              turnId: activity.turnId ?? null,
              tone: activity.tone,
              kind: activity.kind,
              summary: activity.summary,
              payload: activity.payload ?? {},
              createdAt: activity.createdAt,
            });
          }
        }
        const stored = yield* repository.listByThreadId({ threadId: f.threadId });
        const storedTasks = stored.filter((activity) => activity.kind === "task.completed");
        assert.equal(storedTasks.length, 2);
        assert.deepEqual(
          storedTasks.map((activity) => Reflect.get(activity.payload!, "typedUsage")),
          tasks.map((event) => event.payload.typedUsage),
        );
        const day = UsageDay.make(parent[0]!.createdAt.slice(0, 10));
        const costs = yield* repository.listUsageCostActivities({
          since: `${day}T00:00:00.000Z`,
          until: `${day}T23:59:59.999Z`,
        });
        assert.equal(costs.length, 2);
        assert.isTrue(costs.every((cost) => cost.providerName === "pi"));
        assert.deepEqual(
          costs.map((cost) => cost.status),
          ["final", mode === "complete" ? "final" : "provisional"],
        );
        assert.approximately(costs[1]!.totalCostUsd, mode === "complete" ? 0.09 : 0.043, 1e-12);
        const service = yield* UsageService.make;
        const summary = yield* service.readSummary({
          timeZone: "UTC",
          sinceDay: day,
          untilDay: day,
        });
        const bucket = summary.buckets.find((bucket) => bucket.provider === "pi")!;
        assert.approximately(bucket.costUsd, mode === "complete" ? 0.126 : 0.079, 1e-12);
        assert.equal(bucket.records, 2);
        assert.equal(bucket.costSource, "providerReported");
        assert.equal(bucket.totals.outputTokens, 0);
        const source = summary.sources.find((source) => source.fingerprint.provider === "pi")!;
        assert.equal(source.status, mode === "complete" ? "ok" : "partial");
        assert.include(
          source.description!,
          mode === "complete" ? "2 final and 0 provisional" : "1 final and 1 provisional",
        );
        yield* Effect.logInfo({
          mode,
          independentlyKnownChildCost: knownChildCost,
          childPendingDeltas: toolResults.map((message) => message.usage!.cost.total),
          mainTurnCosts: costs.map((cost) => ({ costUsd: cost.totalCostUsd, status: cost.status })),
          usageProvider: bucket.provider,
          usageCostUsd: bucket.costUsd,
        });
        if (process.env.PI_SUBAGENTS_ACCOUNTING_OUTPUT)
          yield* Effect.promise(() =>
            NodeFS.promises.writeFile(
              `${process.env.PI_SUBAGENTS_ACCOUNTING_OUTPUT}.${mode}.json`,
              accountingOutputEncode({ knownChildCost, events: c.events, costs, summary }),
            ),
          );
      }).pipe(
        Effect.scoped,
        Effect.provide(
          ProjectionThreadActivityRepositoryLive.pipe(
            Layer.provideMerge(SqlitePersistenceMemory),
            Layer.provideMerge(
              ServerSettings.layerTest({
                providers: {
                  claudeAgent: { homePath: "/tmp/opencode/pi-accounting-no-transcripts/claude" },
                  codex: { homePath: "/tmp/opencode/pi-accounting-no-transcripts/codex" },
                },
              }),
            ),
            Layer.provideMerge(
              Layer.succeed(HostProcessEnvironment, {
                HOME: "/tmp/opencode/pi-accounting-no-transcripts",
                GROK_HOME: "/tmp/opencode/pi-accounting-no-transcripts/grok",
              }),
            ),
            Layer.provideMerge(
              Layer.succeed(
                HttpClient.HttpClient,
                HttpClient.make((request) =>
                  Effect.succeed(HttpClientResponse.fromWeb(request, Response.json({}))),
                ),
              ),
            ),
            Layer.provideMerge(testLayer),
          ),
        ),
      ),
  );

it.effect(
  "charges real pinned automatic compaction once to its parent and keeps child reporting separate",
  () =>
    Effect.gen(function* () {
      assert.equal(VERSION, "0.87.1");
      const f = fixture(true);
      f.control.child = true;
      f.control.rounds.push(
        { text: "answer", usage: charge(1000, 10, 0.01) },
        { text: "summary", usage: charge() },
      );
      const adapter = yield* makePiAdapter();
      const c = yield* collect(adapter);
      yield* adapter.startSession(f.start);
      const turn = yield* adapter.sendTurn({ threadId: f.threadId, input: "hello" });
      yield* c.completed(1);
      const end = c.events.find((event) => event.type === "turn.completed")!;
      assert.equal(end.turnId, turn.turnId);
      assert.equal(end.type === "turn.completed" && end.payload.totalCostUsd, 0.03);
      assert.deepInclude(end.payload, {
        tokenUsage: {
          usageScope: "main_agent",
          usageStatus: "complete",
          hasSubagents: true,
          reasoningTokensAvailable: false,
          inputTokens: 1110,
          outputTokens: 30,
          cachedInputTokens: 6,
          cacheCreationTokens: 4,
        },
      });
      const child = c.events.find((event) => event.type === "task.completed");
      assert.equal(child?.type === "task.completed" && child.payload.typedUsage?.costUsd, 99);
      assert.equal(f.control.calls, 2);
      yield* adapter.stopSession(f.threadId);
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
);

it.effect(
  "charges real idle manual compaction in a distinct activation and excludes historical summaries on resume",
  () =>
    Effect.gen(function* () {
      const f = fixture();
      f.control.rounds.push(
        { text: "first", usage: charge(70, 7, 0.01) },
        { text: "summary", usage: charge() },
      );
      const adapter = yield* makePiAdapter();
      const c = yield* collect(adapter);
      const started = yield* adapter.startSession(f.start);
      const first = yield* adapter.sendTurn({ threadId: f.threadId, input: "hello" });
      const sdk = yield* Effect.promise(f.sdkSession);
      const result = yield* Effect.promise(() => sdk.compact());
      yield* c.completed(2);
      const ends = c.events.filter((event) => event.type === "turn.completed");
      assert.notEqual(ends[1]!.turnId, first.turnId);
      assert.equal(ends[0]!.payload.totalCostUsd, 0.01);
      assert.equal(ends[1]!.payload.totalCostUsd, result.usage!.cost.total);
      assert.equal(ends[1]!.payload.costModel, "accounting-fixture/main");
      yield* adapter.stopSession(f.threadId);
      yield* adapter.startSession({ ...f.start, resumeCursor: started.resumeCursor });
      f.control.rounds.push({ text: "next", usage: charge(10, 2, 0.005) });
      yield* adapter.sendTurn({ threadId: f.threadId, input: "next" });
      yield* c.completed(3);
      assert.equal(
        c.events.filter((event) => event.type === "turn.completed")[2]!.payload.totalCostUsd,
        0.005,
      );
      yield* adapter.stopSession(f.threadId);
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
);

it.effect(
  "deduplicates replayed real SDK compaction receipts with identical summary text and unsubscribes on stop",
  () =>
    Effect.gen(function* () {
      const originalSubscribe = AgentSession.prototype.subscribe;
      const listeners = new Set<(event: AgentSessionEvent) => void>();
      const receipts: AgentSessionEvent[] = [];
      vi.spyOn(AgentSession.prototype, "subscribe").mockImplementation(function (
        this: AgentSession,
        listener,
      ) {
        listeners.add(listener);
        const off = originalSubscribe.call(this, (event) => {
          if (event.type === "compaction_end" && !receipts.includes(event)) receipts.push(event);
          listener(event);
        });
        return () => {
          listeners.delete(listener);
          off();
        };
      });
      const f = fixture();
      const adapter = yield* makePiAdapter();
      const c = yield* collect(adapter);
      yield* adapter.startSession(f.start);
      f.control.rounds.push(
        { text: "first", usage: charge(70, 7, 0.01) },
        { text: "identical", usage: charge() },
      );
      yield* adapter.sendTurn({ threadId: f.threadId, input: "hello" });
      const sdk = yield* Effect.promise(f.sdkSession);
      yield* Effect.promise(() => sdk.compact());
      yield* c.completed(2);
      // Replay the SDK's exact public receipt, never a fabricated summary event.
      for (const listener of listeners) listener(receipts[0]!);
      f.control.rounds.push(
        { text: "second", usage: charge(70, 7, 0.01) },
        { text: "identical", usage: charge(50, 5, 0.04) },
        { text: "prefix", usage: charge(25, 3, 0.02) },
      );
      yield* adapter.sendTurn({ threadId: f.threadId, input: "second" });
      yield* Effect.promise(() => sdk.compact());
      yield* c.completed(4);
      for (const listener of listeners) for (const receipt of receipts) listener(receipt);
      yield* adapter.stopSession(f.threadId); // drains duplicates before unsubscribing
      const ends = c.events.filter((event) => event.type === "turn.completed");
      assert.equal(ends.length, 4);
      assert.deepEqual(
        ends.map((event) => event.payload.totalCostUsd),
        [0.01, 0.02, 0.01, 0.06],
      );
      assert.equal(listeners.size, 0);
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
);

it.effect("owns registered-command manual compaction on the command turn without inference", () =>
  Effect.gen(function* () {
    const f = fixture();
    f.control.rounds.push(
      { text: "first", usage: charge(70, 7, 0.01) },
      { text: "summary", usage: charge() },
    );
    const adapter = yield* makePiAdapter();
    const c = yield* collect(adapter);
    yield* adapter.startSession(f.start);
    yield* adapter.sendTurn({ threadId: f.threadId, input: "hello" });
    const command = yield* adapter.sendTurn({ threadId: f.threadId, input: "/manual-summary" });
    yield* c.completed(2);
    const end = c.events.filter((event) => event.type === "turn.completed")[1]!;
    assert.equal(end.turnId, command.turnId);
    assert.equal(end.payload.totalCostUsd, 0.02);
    assert.equal(end.payload.tokenUsage?.inputTokens, 105);
    assert.equal(f.control.calls, 2);
    yield* adapter.stopSession(f.threadId);
  }).pipe(Effect.scoped, Effect.provide(testLayer)),
);

it.effect(
  "removes summary subscription and discards buffered usage after failed real SDK binding",
  () =>
    Effect.gen(function* () {
      const originalSubscribe = AgentSession.prototype.subscribe;
      const originalBind = AgentSession.prototype.bindExtensions;
      const listeners = new Set<(event: AgentSessionEvent) => void>();
      vi.spyOn(AgentSession.prototype, "subscribe").mockImplementation(function (
        this: AgentSession,
        listener,
      ) {
        listeners.add(listener);
        const off = originalSubscribe.call(this, listener);
        return () => {
          listeners.delete(listener);
          off();
        };
      });
      vi.spyOn(AgentSession.prototype, "bindExtensions").mockImplementation(async function (
        this: AgentSession,
        options,
      ) {
        await originalBind.call(this, options);
        throw new Error("fixture binding failure");
      });
      const f = fixture(true, true);
      f.control.rounds.push(
        { text: "first", usage: charge(1000, 10, 0.01) },
        { text: "summary", usage: charge() },
      );
      const adapter = yield* makePiAdapter();
      const c = yield* collect(adapter);
      const error = yield* adapter.startSession(f.start).pipe(Effect.flip);
      assert.equal(error._tag, "ProviderAdapterProcessError");
      assert.equal(listeners.size, 0);
      assert.deepEqual(c.events, []);
      assert.deepEqual(yield* adapter.listSessions(), []);
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
);

it.effect("does not charge real SDK child tool-result usage or cumulative session statistics", () =>
  Effect.gen(function* () {
    const f = fixture();
    f.control.rounds.push(
      { text: "", tool: true, usage: charge(20, 5, 0.01) },
      { text: "answer", usage: charge(30, 7, 0.02) },
    );
    const adapter = yield* makePiAdapter();
    const c = yield* collect(adapter);
    yield* adapter.startSession(f.start);
    const sdk = yield* Effect.promise(f.sdkSession);
    const stats = vi.spyOn(sdk, "getSessionStats");
    yield* adapter.sendTurn({ threadId: f.threadId, input: "child report" });
    yield* c.completed(1);
    const result = c.events.find(
      (event) => event.type === "item.completed" && event.payload.title === "ChildReport",
    );
    assert.isDefined(result);
    assert.equal(stats.mock.calls.length, 0);
    const end = c.events.find((event) => event.type === "turn.completed")!;
    assert.equal(end.type === "turn.completed" && end.payload.totalCostUsd, 0.03);
    assert.equal(end.type === "turn.completed" && end.payload.tokenUsage?.inputTokens, 60);
    yield* adapter.stopSession(f.threadId);
  }).pipe(Effect.scoped, Effect.provide(testLayer)),
);

it.effect(
  "stopping during real automatic compaction fences the attempt without losing known parent tokens",
  () =>
    Effect.gen(function* () {
      const f = fixture(true);
      f.control.rounds.push(
        { text: "answer", usage: charge(1000, 10, 0.01) },
        { text: "summary", usage: charge(99, 0, 0.5), hold: true },
      );
      const adapter = yield* makePiAdapter();
      const c = yield* collect(adapter);
      yield* adapter.startSession(f.start);
      const sending = yield* adapter
        .sendTurn({ threadId: f.threadId, input: "hello" })
        .pipe(Effect.forkScoped);
      yield* Effect.promise(() => f.control.summaryEntered.promise);
      yield* adapter.stopSession(f.threadId);
      yield* Fiber.join(sending);
      yield* c.completed(1);
      const end = c.events.find((event) => event.type === "turn.completed")!;
      assert.equal(end.type === "turn.completed" && end.payload.state, "cancelled");
      assert.equal(end.type === "turn.completed" && end.payload.tokenUsage?.inputTokens, 1005);
      assert.equal(end.type === "turn.completed" && end.payload.tokenUsage?.usageStatus, "partial");
      assert.isUndefined(end.type === "turn.completed" && end.payload.totalCostUsd);
      const cost = c.events.find((event) => event.type === "turn.cost.updated");
      assert.equal(cost?.type === "turn.cost.updated" && cost.payload.totalCostUsd, 0.01);
      assert.equal(cost?.type === "turn.cost.updated" && cost.payload.status, "provisional");
      assert.equal(c.events.filter((event) => event.type === "turn.completed").length, 1);
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
);

it.effect.each(["zero", "missing"] as const)(
  "retains known summary tokens with %s reported cost",
  (mode) =>
    Effect.gen(function* () {
      const f = fixture(true);
      const usage = charge(42, 6, 0);
      if (mode === "missing") Reflect.deleteProperty(usage, "cost");
      f.control.rounds.push(
        { text: "first", usage: charge(1000, 10, 0) },
        { text: "summary", usage },
      );
      const adapter = yield* makePiAdapter();
      const c = yield* collect(adapter);
      yield* adapter.startSession(f.start);
      yield* adapter.sendTurn({ threadId: f.threadId, input: "hello" });
      yield* c.completed(1);
      const end = c.events.find((event) => event.type === "turn.completed")!;
      assert.equal(end.type === "turn.completed" && end.payload.tokenUsage?.inputTokens, 1052);
      assert.equal(
        end.type === "turn.completed" && end.payload.totalCostUsd,
        mode === "zero" ? 0 : undefined,
      );
      assert.equal(
        c.events.filter((event) => event.type === "turn.cost.updated").length,
        mode === "zero" ? 0 : 1,
      );
      yield* adapter.stopSession(f.threadId);
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
);

it.effect("observes real compaction during binding before startup events are consumed", () =>
  Effect.gen(function* () {
    const f = fixture(true, true);
    f.control.rounds.push(
      { text: "first", usage: charge(1000, 10, 0.01) },
      { text: "summary", usage: charge() },
    );
    const adapter = yield* makePiAdapter();
    const c = yield* collect(adapter);
    yield* adapter.startSession(f.start);
    yield* c.completed(1);
    const end = c.events.find((event) => event.type === "turn.completed")!;
    assert.equal(end.type === "turn.completed" && end.payload.totalCostUsd, 0.03);
    assert.equal(c.events[0]!.type, "session.started");
    assert.equal(c.events.filter((event) => event.type === "turn.started").length, 1);
    yield* adapter.stopSession(f.threadId);
  }).pipe(Effect.scoped, Effect.provide(testLayer)),
);

it.effect.each(["failure", "abort"] as const)(
  "does not fabricate spend for real %s idle compaction",
  (mode) =>
    Effect.gen(function* () {
      const f = fixture();
      f.control.rounds.push({ text: "first", usage: charge(100, 10, 0.01) });
      const adapter = yield* makePiAdapter();
      const c = yield* collect(adapter);
      yield* adapter.startSession(f.start);
      yield* adapter.sendTurn({ threadId: f.threadId, input: "hello" });
      const sdk = yield* Effect.promise(f.sdkSession);
      if (mode === "failure")
        f.control.rounds.push({ text: "", usage: charge(99, 0, 0.5), stopReason: "error" });
      else
        sdk.subscribe((event) => {
          if (event.type === "compaction_start") sdk.abortCompaction();
        });
      const failed = yield* Effect.promise(async () => {
        try {
          await sdk.compact();
          return false;
        } catch {
          return true;
        }
      });
      assert.isTrue(failed);
      yield* c.completed(2);
      const end = c.events.filter((event) => event.type === "turn.completed")[1]!;
      assert.isUndefined(end.payload.totalCostUsd);
      assert.equal(end.payload.tokenUsage?.usageStatus, "partial");
      yield* adapter.stopSession(f.threadId);
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
);
