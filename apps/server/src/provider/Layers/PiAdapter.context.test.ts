// @effect-diagnostics nodeBuiltinImport:off - isolated pinned-SDK fake I/O.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { AgentSession, VERSION } from "@earendil-works/pi-coding-agent";
import { assert, it } from "@effect/vitest";
import { afterEach, vi } from "vite-plus/test";
import { ProviderDriverKind, ThreadId, type ProviderRuntimeEvent } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { ServerConfig } from "../../config.ts";
import { makePiAdapter } from "./PiAdapter.ts";

type Assistant = Extract<AgentSession["state"]["messages"][number], { role: "assistant" }>;
type Round = {
  usage: Assistant["usage"];
  model?: Assistant["model"];
  provider?: Assistant["provider"];
  responseModel?: Assistant["responseModel"];
  tool?: boolean;
};
const usage = (reasoning?: number): Assistant["usage"] => ({
  input: 1000,
  output: 10,
  cacheRead: 3,
  cacheWrite: 2,
  totalTokens: 1015,
  ...(reasoning !== undefined ? { reasoning } : {}),
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.01 },
});
const key = Symbol.for("t3.pi.context.test");
const roots: string[] = [];
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
afterEach(() => {
  vi.restoreAllMocks();
  Reflect.deleteProperty(globalThis, key);
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  for (const root of roots.splice(0)) NodeFS.rmSync(root, { recursive: true, force: true });
});
const layer = ServerConfig.layerTest(process.cwd(), { prefix: "pi-context-test-" }).pipe(
  Layer.provideMerge(NodeServices.layer),
);
function fixture(auto = false, reserveTokens = 4500) {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "pi-context-"));
  roots.push(root);
  const agentDir = NodePath.join(root, "agent");
  NodeFS.mkdirSync(NodePath.join(agentDir, "extensions"), { recursive: true });
  const sdkPath = NodeFS.realpathSync("node_modules/@earendil-works/pi-coding-agent");
  NodeFS.symlinkSync(
    NodePath.dirname(NodePath.dirname(sdkPath)),
    NodePath.join(agentDir, "node_modules"),
  );
  NodeFS.writeFileSync(
    NodePath.join(agentDir, "settings.json"),
    JSON.stringify({
      compaction: {
        enabled: auto,
        reserveTokens,
        keepRecentTokens: 0,
        modelOverrides: { "context-fixture/alternate": { reserveTokens: 700 } },
      },
      retry: { enabled: false },
      cacheWarming: "off",
    }),
  );
  const control = { rounds: [] as Round[], child: "none" as "none" | "created" | "started" };
  Reflect.set(globalThis, key, control);
  NodeFS.writeFileSync(
    NodePath.join(agentDir, "extensions", "fixture.js"),
    `
    import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
    import { Type } from "typebox";
    export default function(pi) {
      const control = globalThis[Symbol.for("t3.pi.context.test")];
      pi.registerProvider("context-fixture", {
        api: "context-fixture", apiKey: "fake", baseUrl: "https://fixture.invalid",
        models: [ ["main", 5000], ["alternate", 9000] ].map(([id, contextWindow]) => ({
          id, name: id, contextWindow, maxTokens: 1000, reasoning: true, input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } })),
        streamSimple: (model) => {
          const round = control.rounds.shift();
          if (!round) throw new Error("Missing scripted response");
          const stream = createAssistantMessageEventStream();
          const message = { role: "assistant", api: model.api,
            provider: round.provider ?? model.provider, model: round.model ?? model.id,
            ...(round.responseModel !== undefined ? { responseModel: round.responseModel } : {}),
            usage: round.usage, timestamp: Date.now(), stopReason: round.tool ? "toolUse" : "stop",
            content: round.tool ? [{ type: "toolCall", id: "work", name: "ExtensionWork", arguments: {} }]
              : [{ type: "text", text: "fixture answer" }] };
          queueMicrotask(() => { stream.push({ type: "done", reason: message.stopReason, message }); stream.end(message); });
          return stream;
        }
      });
      pi.registerTool({ name: "ExtensionWork", label: "Extension work", description: "Non-Agent child work",
        parameters: Type.Object({}), execute: async () => {
          if (control.child !== "none") {
            pi.events.emit("subagents:" + control.child, { id: "observed-child", description: "Child" });
            if (control.child === "started") pi.events.emit("subagents:completed", {
              id: "observed-child", usage: { input: 9000, output: 1000, cacheRead: 400,
                totalTokens: 10400, cost: { total: 99 } } });
          }
          return { content: [{ type: "text", text: "tool output" }], details: { usage: {
            input: 9000, output: 1000, totalTokens: 10000, cost: { total: 99 } } } };
        } });
      pi.registerCommand("queued-child", { handler: async () => {
        pi.events.emit("subagents:created", { id: "queued-only", description: "Queued only" });
      } });
      pi.on("session_start", async (_event, ctx) => {
        await pi.setModel(ctx.modelRegistry.find("context-fixture", "main"));
      });
    }
  `,
  );
  process.env.PI_CODING_AGENT_DIR = agentDir;
  let sdk: AgentSession | undefined;
  const bind = AgentSession.prototype.bindExtensions;
  vi.spyOn(AgentSession.prototype, "bindExtensions").mockImplementation(async function (
    this: AgentSession,
    options,
  ) {
    // eslint-disable-next-line typescript/no-this-alias -- Capture the real pinned SDK fixture.
    sdk = this;
    await bind.call(this, options);
  });
  const threadId = ThreadId.make("pi-context");
  return {
    control,
    threadId,
    sdk: () => sdk!,
    start: {
      threadId,
      cwd: root,
      provider: ProviderDriverKind.make("pi"),
      runtimeMode: "full-access" as const,
    },
  };
}
const collect = (adapter: Effect.Success<ReturnType<typeof makePiAdapter>>) =>
  Effect.gen(function* () {
    const events: ProviderRuntimeEvent[] = [];
    const waiters = new Map<number, Deferred.Deferred<void>>();
    yield* Stream.runForEach(adapter.streamEvents, (event) =>
      Effect.gen(function* () {
        events.push(event);
        const count = events.filter((e) => e.type === "turn.completed").length;
        const waiter = waiters.get(count);
        if (waiter) yield* Deferred.succeed(waiter, undefined);
      }),
    ).pipe(Effect.forkScoped({ startImmediately: true }));
    const completed = (count: number) =>
      Effect.gen(function* () {
        if (events.filter((e) => e.type === "turn.completed").length >= count) return;
        const done = yield* Deferred.make<void>();
        waiters.set(count, done);
        yield* Deferred.await(done);
      });
    return { events, completed };
  });
const snapshots = (events: ProviderRuntimeEvent[]) =>
  events.flatMap((event) =>
    event.type === "thread.token-usage.updated" ? [event.payload.usage] : [],
  );
const ends = (events: ProviderRuntimeEvent[]) => events.filter((e) => e.type === "turn.completed");

it.effect(
  "preserves SDK zero estimates and child-only command availability without fabricating main tokens",
  () =>
    Effect.gen(function* () {
      const f = fixture();
      f.control.rounds.push({ usage: usage(0) });
      const adapter = yield* makePiAdapter();
      const c = yield* collect(adapter);
      yield* adapter.startSession(f.start);
      vi.spyOn(f.sdk(), "getContextUsage").mockReturnValue({
        tokens: 0,
        contextWindow: 5000,
        percent: 0,
      });
      yield* adapter.sendTurn({ threadId: f.threadId, input: "zero estimate" });
      yield* c.completed(1);
      assert.equal(snapshots(c.events)[0]!.contextUsageStatus, "estimated");
      assert.equal(snapshots(c.events)[0]!.usedTokens, 0);
      yield* adapter.sendTurn({ threadId: f.threadId, input: "/queued-child" });
      yield* c.completed(2);
      const tokens = ends(c.events)[1]!.payload.tokenUsage!;
      assert.isTrue(tokens.hasSubagents);
      assert.equal(tokens.usageStatus, "unavailable");
      assert.isUndefined(tokens.inputTokens);
      assert.isUndefined(tokens.outputTokens);
      assert.isFalse(tokens.reasoningTokensAvailable);
      yield* adapter.stopSession(f.threadId);
    }).pipe(Effect.scoped, Effect.provide(layer)),
);

it.effect("does not turn partially observed reasoning into a fabricated complete zero", () =>
  Effect.gen(function* () {
    const f = fixture();
    f.control.rounds.push({ usage: usage(5), tool: true }, { usage: usage() });
    const adapter = yield* makePiAdapter();
    const c = yield* collect(adapter);
    yield* adapter.startSession(f.start);
    yield* adapter.sendTurn({ threadId: f.threadId, input: "mixed reasoning" });
    yield* c.completed(1);
    assert.isFalse(ends(c.events)[0]!.payload.tokenUsage!.reasoningTokensAvailable);
    assert.isUndefined(ends(c.events)[0]!.payload.tokenUsage!.reasoningTokens);
    assert.equal(ends(c.events)[0]!.payload.tokenUsage!.outputTokens, 20);
    yield* adapter.stopSession(f.threadId);
  }).pipe(Effect.scoped, Effect.provide(layer)),
);

it.effect(
  "reports actual disabled auto-compaction and numeric SDK estimates without a threshold",
  () =>
    Effect.gen(function* () {
      assert.equal(VERSION, "0.87.1");
      const f = fixture();
      f.control.rounds.push({ usage: usage() });
      const adapter = yield* makePiAdapter();
      const c = yield* collect(adapter);
      yield* adapter.startSession(f.start);
      assert.isFalse(f.sdk().autoCompactionEnabled);
      const observed: ReturnType<AgentSession["getContextUsage"]>[] = [];
      const original = f.sdk().getContextUsage.bind(f.sdk());
      vi.spyOn(f.sdk(), "getContextUsage").mockImplementation(() => {
        const value = original();
        observed.push(value);
        return value;
      });
      yield* adapter.sendTurn({ threadId: f.threadId, input: "first" });
      yield* c.completed(1);
      const snapshot = snapshots(c.events)[0]!;
      assert.equal(snapshot.contextUsageStatus, "estimated");
      assert.equal(snapshot.usedTokens, observed[0]!.tokens);
      assert.equal(snapshot.maxTokens, 5000);
      assert.isFalse(snapshot.compactsAutomatically);
      assert.isUndefined(snapshot.autoCompactThreshold);
      yield* adapter.stopSession(f.threadId);
    }).pipe(Effect.scoped, Effect.provide(layer)),
);

for (const auto of [true, false])
  it.effect(
    `invalidates real ${auto ? "automatic" : "idle manual"} compaction immediately and restores only the next SDK estimate`,
    () =>
      Effect.gen(function* () {
        const f = fixture(auto);
        f.control.rounds.push({ usage: usage() }, { usage: usage(0) });
        const adapter = yield* makePiAdapter();
        const c = yield* collect(adapter);
        yield* adapter.startSession(f.start);
        yield* adapter.sendTurn({ threadId: f.threadId, input: "first" });
        if (!auto) yield* Effect.promise(() => f.sdk().compact());
        yield* c.completed(auto ? 1 : 2);
        assert.isNull(f.sdk().getContextUsage()!.tokens);
        const unknown = snapshots(c.events).at(-1)!;
        assert.equal(unknown.contextUsageStatus, "unknown");
        assert.isUndefined(unknown.usedTokens);
        assert.isUndefined(unknown.lastUsedTokens);
        assert.equal(unknown.maxTokens, 5000);
        assert.equal(unknown.compactsAutomatically, auto);
        assert.equal(unknown.autoCompactThreshold, auto ? 500 : undefined);
        assert.equal(c.events.at(-1)!.type, "turn.completed");
        f.sdk().setAutoCompactionEnabled(false);
        f.control.rounds.push({ usage: usage(0) });
        yield* adapter.sendTurn({ threadId: f.threadId, input: "next" });
        yield* c.completed(auto ? 2 : 3);
        assert.equal(snapshots(c.events).at(-1)!.contextUsageStatus, "estimated");
        assert.isFalse(snapshots(c.events).at(-1)!.compactsAutomatically);
        yield* adapter.stopSession(f.threadId);
      }).pipe(Effect.scoped, Effect.provide(layer)),
  );

it.effect(
  "undefined SDK context clears stale occupancy and retains only the factually supported response limit",
  () =>
    Effect.gen(function* () {
      const f = fixture(false, 0);
      f.control.rounds.push(
        { usage: { ...usage(), input: 10 } },
        { usage: usage(), responseModel: "alternate" },
        { usage: usage(), responseModel: "missing" },
      );
      const adapter = yield* makePiAdapter();
      const c = yield* collect(adapter);
      yield* adapter.startSession(f.start);
      yield* adapter.sendTurn({ threadId: f.threadId, input: "known" });
      vi.spyOn(f.sdk(), "getContextUsage").mockReturnValue(undefined);
      f.sdk().setAutoCompactionEnabled(true);
      // Keep real automatic compaction below its selected-model trigger in this case.
      for (const round of f.control.rounds) round.usage.input = 10;
      yield* adapter.sendTurn({ threadId: f.threadId, input: "alternate" });
      yield* c.completed(2);
      const alternate = snapshots(c.events).at(-1)!;
      assert.equal(alternate.contextUsageStatus, "unknown");
      assert.isUndefined(alternate.usedTokens);
      assert.equal(alternate.maxTokens, 9000);
      assert.equal(alternate.autoCompactThreshold, 8300);
      assert.equal(ends(c.events)[1]!.payload.costModel, "context-fixture/alternate");
      yield* adapter.sendTurn({ threadId: f.threadId, input: "missing" });
      yield* c.completed(3);
      const missing = snapshots(c.events).at(-1)!;
      assert.equal(missing.contextUsageStatus, "unknown");
      assert.isUndefined(missing.maxTokens);
      assert.isUndefined(missing.autoCompactThreshold);
      yield* adapter.stopSession(f.threadId);
    }).pipe(Effect.scoped, Effect.provide(layer)),
);

it.effect(
  "uses response provider identity without borrowing a same-named selected model limit",
  () =>
    Effect.gen(function* () {
      const f = fixture();
      f.control.rounds.push({
        usage: usage(),
        provider: "unregistered-provider",
        responseModel: "main",
      });
      const adapter = yield* makePiAdapter();
      const c = yield* collect(adapter);
      yield* adapter.startSession(f.start);
      yield* adapter.sendTurn({ threadId: f.threadId, input: "response override" });
      yield* c.completed(1);
      assert.equal(ends(c.events)[0]!.payload.costModel, "unregistered-provider/main");
      assert.isUndefined(snapshots(c.events)[0]!.maxTokens);
      assert.isUndefined(snapshots(c.events)[0]!.autoCompactThreshold);
      yield* adapter.stopSession(f.threadId);
    }).pipe(Effect.scoped, Effect.provide(layer)),
);

for (const child of ["created", "started"] as const)
  it.effect(
    `attributes mixed response models and ${child} non-Agent children to their own turn without charging child usage`,
    () =>
      Effect.gen(function* () {
        const f = fixture();
        f.control.child = child;
        f.control.rounds.push(
          { usage: usage(0), tool: true, model: "alias", responseModel: "alternate" },
          { usage: usage(5) },
          { usage: usage(0) },
        );
        const adapter = yield* makePiAdapter();
        const c = yield* collect(adapter);
        yield* adapter.startSession(f.start);
        yield* adapter.sendTurn({ threadId: f.threadId, input: "work" });
        yield* c.completed(1);
        const first = ends(c.events)[0]!.payload;
        assert.isUndefined(first.costModel);
        assert.equal(first.totalCostUsd, 0.02);
        assert.equal(first.tokenUsage?.hasSubagents, true);
        assert.equal(first.tokenUsage?.inputTokens, 2010);
        assert.equal(first.tokenUsage?.cachedInputTokens, 6);
        assert.equal(first.tokenUsage?.outputTokens, 20);
        assert.equal(first.tokenUsage?.reasoningTokens, 5);
        assert.equal(first.tokenUsage?.reasoningTokensAvailable, true);
        assert.equal(snapshots(c.events)[0]!.maxTokens, 9000);
        yield* adapter.sendTurn({ threadId: f.threadId, input: "no child" });
        yield* c.completed(2);
        assert.isFalse(ends(c.events)[1]!.payload.tokenUsage!.hasSubagents);
        assert.equal(ends(c.events)[1]!.payload.costModel, "context-fixture/main");
        yield* adapter.stopSession(f.threadId);
      }).pipe(Effect.scoped, Effect.provide(layer)),
  );

for (const reasoning of [undefined, 0, 99])
  it.effect(
    `preserves ${reasoning === undefined ? "absent" : reasoning} reasoning availability and inclusive output subset`,
    () =>
      Effect.gen(function* () {
        const f = fixture();
        f.control.rounds.push({ usage: usage(reasoning) });
        const adapter = yield* makePiAdapter();
        const c = yield* collect(adapter);
        yield* adapter.startSession(f.start);
        yield* adapter.sendTurn({ threadId: f.threadId, input: "reasoning" });
        yield* c.completed(1);
        const tokens = ends(c.events)[0]!.payload.tokenUsage!;
        assert.equal(tokens.reasoningTokensAvailable, reasoning !== undefined);
        assert.equal(
          tokens.reasoningTokens,
          reasoning === undefined ? undefined : Math.min(10, reasoning),
        );
        assert.equal(tokens.outputTokens, 10);
        yield* adapter.stopSession(f.threadId);
      }).pipe(Effect.scoped, Effect.provide(layer)),
  );
