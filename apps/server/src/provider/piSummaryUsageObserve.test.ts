// @effect-diagnostics nodeBuiltinImport:off - isolated pinned-SDK fake-I/O fixture.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import {
  type AgentSession,
  type AgentSessionEvent,
  type BranchSummaryEntry,
  type CompactionResult,
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  VERSION,
} from "@earendil-works/pi-coding-agent";
import { afterEach, expect, it } from "vite-plus/test";
import { piSummaryUsageObserve } from "./piSummaryUsageObserve.ts";

type Usage = NonNullable<CompactionResult["usage"]>;
type Observation = Parameters<Parameters<typeof piSummaryUsageObserve>[1]>[0];
const charge = (input = 100, output = 20, total = 0.02): Usage => ({
  input,
  output,
  cacheRead: 3,
  cacheWrite: 2,
  totalTokens: input + output + 5,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total },
});
const roots: string[] = [];
const sessions: AgentSession[] = [];
const controlKey = Symbol.for("t3.pi.summary-usage.test");
afterEach(() => {
  for (const session of sessions.splice(0)) session.dispose();
  for (const root of roots.splice(0)) NodeFS.rmSync(root, { recursive: true, force: true });
  Reflect.deleteProperty(globalThis, controlKey);
});

async function sdkFixture(auto = false) {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-pi-summary-usage-"));
  roots.push(root);
  const agentDir = NodePath.join(root, "agent");
  NodeFS.mkdirSync(agentDir);
  const sdk = NodeFS.realpathSync("node_modules/@earendil-works/pi-coding-agent");
  NodeFS.symlinkSync(
    NodePath.dirname(NodePath.dirname(sdk)),
    NodePath.join(agentDir, "node_modules"),
  );
  const control = {
    rounds: [] as { text: string; usage: Usage; stopReason?: "error" }[],
    calls: 0,
  };
  Reflect.set(globalThis, controlKey, control);
  const extension = NodePath.join(agentDir, "fixture.js");
  NodeFS.writeFileSync(
    extension,
    `
    import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
    export default function(pi) {
      const control = globalThis[Symbol.for("t3.pi.summary-usage.test")];
      pi.registerProvider("summary-fixture", {
        api: "summary-fixture", apiKey: "fake", baseUrl: "https://fixture.invalid",
        models: [{ id: "main", name: "Main", reasoning: false, input: ["text"],
          contextWindow: 5000, maxTokens: 1000,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
        streamSimple: model => {
          const stream = createAssistantMessageEventStream();
          const round = control.rounds.shift();
          if (!round) throw new Error("No scripted response");
          control.calls++;
          const message = { role: "assistant", content: [{ type: "text", text: round.text }],
            api: model.api, provider: model.provider, model: model.id, usage: round.usage,
            timestamp: Date.now(), stopReason: round.stopReason ?? "stop",
            ...(round.stopReason === "error" ? { errorMessage: "summary failed" } : {}) };
          queueMicrotask(() => {
            stream.push(message.stopReason === "error"
              ? { type: "error", reason: "error", error: message }
              : { type: "done", reason: "stop", message });
            stream.end(message);
          });
          return stream;
        }
      });
    }`,
  );
  const settingsManager = SettingsManager.inMemory({
    compaction: { enabled: auto, reserveTokens: 4500, keepRecentTokens: 0 },
    branchSummary: { reserveTokens: 1000 },
    retry: { enabled: false },
    cacheWarming: "off",
  });
  const resourceLoader = new DefaultResourceLoader({
    cwd: root,
    agentDir,
    settingsManager,
    additionalExtensionPaths: [extension],
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPrompt: "fixture",
  });
  await resourceLoader.reload();
  const modelRuntime = await ModelRuntime.create({
    authPath: NodePath.join(agentDir, "auth.json"),
    modelsPath: null,
    modelsStorePath: NodePath.join(agentDir, "models"),
    refreshOnCreate: false,
    allowModelNetwork: false,
  });
  const { session } = await createAgentSession({
    cwd: root,
    agentDir,
    settingsManager,
    resourceLoader,
    modelRuntime,
    sessionManager: SessionManager.inMemory(root),
    noTools: "all",
  });
  sessions.push(session);
  const model = modelRuntime.getModel("summary-fixture", "main");
  expect(model).toBeDefined();
  await session.setModel(model!);
  const observed: AgentSessionEvent[] = [];
  session.subscribe((event) => observed.push(event));
  const usage: Observation[] = [];
  const observer = piSummaryUsageObserve(session, (value) => usage.push(value));
  return { session, control, observed, usage, observer };
}

it("observes real 0.87.1 automatic and combined split-turn manual compaction once", async () => {
  expect(VERSION).toBe("0.87.1");
  const f = await sdkFixture(true);
  f.control.rounds.push(
    { text: "first", usage: charge(1000, 10, 0.01) },
    { text: "summary", usage: charge() },
  );
  await f.session.prompt("first");
  await f.session.waitForIdle();
  expect(f.usage).toHaveLength(1);
  expect(f.usage[0]).toMatchObject({
    kind: "compaction",
    reason: "threshold",
    usage: charge(),
    usageSource: "compaction-result",
    modelIdentity: {
      provider: "summary-fixture",
      model: "main",
      source: "session-model-at-compaction-start",
    },
  });
  expect(f.session.sessionManager.getEntry(f.usage[0]!.entryId)?.type).toBe("compaction");
  f.session.settingsManager.applyOverrides({ compaction: { enabled: false } });
  f.control.rounds.push(
    { text: "second", usage: charge(70, 7, 0.01) },
    { text: "history", usage: charge(50, 5, 0.04) },
    { text: "prefix", usage: charge(25, 3, 0.02) },
  );
  await f.session.prompt("second");
  const result = await f.session.compact();
  expect(f.control.calls).toBe(5);
  expect(result.summary).toContain("Turn Context (split turn)");
  expect(f.usage).toHaveLength(2);
  expect(f.usage[1]).toMatchObject({
    reason: "manual",
    usage: {
      input: 75,
      output: 8,
      cacheRead: 6,
      cacheWrite: 4,
      totalTokens: 93,
      cost: { total: expect.closeTo(0.06) },
    },
  });
  expect(new Set(f.usage.map((entry) => entry.entryId)).size).toBe(2);
  expect(Object.isFrozen(f.usage[1])).toBe(true);
  expect(Object.isFrozen(f.usage[1]!.usage)).toBe(true);
  expect(Object.isFrozen(f.usage[1]!.usage.cost)).toBe(true);
});

it("uses the actual public navigateTree summaryEntry, not an invented branch event", async () => {
  const f = await sdkFixture();
  f.control.rounds.push(
    { text: "first", usage: charge(10) },
    { text: "second", usage: charge(20) },
  );
  await f.session.prompt("first");
  const target = f.session.sessionManager.getLeafId()!;
  await f.session.prompt("second");
  f.control.rounds.push({ text: "paid branch", usage: charge(31, 4, 0.03) });
  const navigation = await f.session.navigateTree(target, { summarize: true });
  expect(navigation.cancelled).toBe(false);
  expect(navigation.summaryEntry?.type).toBe("branch_summary");
  expect(f.usage).toHaveLength(0);
  expect(
    f.observed.some(
      (event) => event.type === "entry_appended" && event.entry.type === "branch_summary",
    ),
  ).toBe(false);
  const entry = navigation.summaryEntry as BranchSummaryEntry;
  f.observer.observeBranchSummary(entry);
  f.observer.observeBranchSummary(structuredClone(entry));
  expect(f.usage).toEqual([
    {
      entryId: entry.id,
      kind: "branch_summary",
      usageSource: "persisted-entry",
      usage: charge(31, 4, 0.03),
    },
  ]);
  f.observer.unsubscribe();
  const resumed: Observation[] = [];
  const observer = piSummaryUsageObserve(f.session, (value) => resumed.push(value));
  observer.observeBranchSummary(entry);
  expect(resumed).toEqual([]);
  observer.unsubscribe();
});

it.each(["failure", "abort"])(
  "does not fabricate usage from a real %s compaction",
  async (mode) => {
    const f = await sdkFixture();
    f.control.rounds.push({ text: "answer", usage: charge() });
    await f.session.prompt("hello");
    if (mode === "failure")
      f.control.rounds.push({ text: "", usage: charge(99, 0, 0.5), stopReason: "error" });
    else
      f.session.subscribe((event) => {
        if (event.type === "compaction_start") f.session.abortCompaction();
      });
    await expect(f.session.compact()).rejects.toThrow();
    expect(f.observed.findLast((event) => event.type === "compaction_end")).toMatchObject({
      result: undefined,
      aborted: mode === "abort",
    });
    expect(f.usage).toEqual([]);
  },
);

function eventFixture() {
  const sessionManager = SessionManager.inMemory("/tmp/opencode");
  const listeners = new Set<(event: AgentSessionEvent) => void>();
  const session = {
    sessionManager,
    model: undefined,
    subscribe: (listener: (event: AgentSessionEvent) => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
  const emit = (
    result: CompactionResult | undefined,
    reason: "manual" | "threshold" | "overflow" = "manual",
  ) => {
    for (const listener of listeners)
      listener({ type: "compaction_end", reason, result, aborted: false, willRetry: false });
  };
  const persist = (result: CompactionResult) =>
    sessionManager.appendCompaction(
      result.summary,
      result.firstKeptEntryId,
      result.tokensBefore,
      undefined,
      false,
      result.usage,
    );
  const result = (usage: Usage | undefined = charge()): CompactionResult => ({
    summary: "identical",
    firstKeptEntryId: "kept",
    tokensBefore: 500,
    ...(usage ? { usage } : {}),
  });
  return { session, sessionManager, emit, persist, result };
}

it.each(["zero", "missing"])(
  "preserves %s cost in a real SDK summary without pricing fallback",
  async (cost) => {
    const f = await sdkFixture();
    const summaryUsage = charge(42, 6, 0);
    if (cost === "missing") Reflect.deleteProperty(summaryUsage, "cost");
    f.control.rounds.push(
      { text: "answer", usage: charge(1000, 10, 0.25) },
      { text: "summary", usage: summaryUsage },
    );
    await f.session.prompt("hello");
    const result = await f.session.compact();
    expect(f.usage).toHaveLength(1);
    expect(f.usage[0]!.usage).toEqual(result.usage);
    expect(f.usage[0]!.usage.input).toBe(42);
    expect(f.usage[0]!.usage.cost?.total).toBe(cost === "zero" ? 0 : undefined);
    expect(f.control.calls).toBe(2);
  },
);

it("deduplicates real manager entry IDs, repeated events, branch changes and resumed history", () => {
  const f = eventFixture();
  const old = f.result();
  f.persist(old);
  const usage: Observation[] = [];
  const observer = piSummaryUsageObserve(f.session, (value) => usage.push(value));
  f.emit(old);
  const first = f.result();
  const id = f.persist(first);
  f.emit(first);
  f.emit(structuredClone(first), "threshold");
  const second = f.result();
  const secondId = f.persist(second);
  f.emit(second, "overflow");
  f.emit(first); // same result object remains deduplicated even after a newer identical entry
  f.sessionManager.branch(id);
  f.emit(structuredClone(first));
  expect(usage.map((entry) => entry.entryId)).toEqual([id, secondId]);
  observer.unsubscribe();
  const resumed: Observation[] = [];
  const again = piSummaryUsageObserve(f.session, (value) => resumed.push(value));
  f.emit(structuredClone(first));
  f.sessionManager.branch(secondId);
  f.emit(structuredClone(second));
  expect(resumed).toEqual([]);
  again.unsubscribe();
});

it("retains zero-cost tokens and missing cost, takes authoritative result usage, and ignores unpersisted successes", () => {
  const f = eventFixture();
  const usage: Observation[] = [];
  const observer = piSummaryUsageObserve(f.session, (value) => usage.push(value));
  const zero = f.result(charge(10, 2, 0));
  f.persist(zero);
  f.emit(zero);
  const missing = f.result(charge(30));
  // Public Usage requires cost, but real provider payloads can omit it at runtime.
  Reflect.deleteProperty(missing.usage!, "cost");
  f.persist(missing);
  f.emit(missing);
  const fallback = f.result(charge(40));
  f.persist(fallback);
  const noUsage = { ...fallback };
  delete noUsage.usage;
  f.emit(noUsage);
  const authoritative = f.result(charge(50));
  f.persist(authoritative);
  f.emit({ ...authoritative, usage: charge(60) });
  f.emit({ ...f.result(), summary: "not persisted" });
  f.emit(undefined);
  const absent = { ...f.result(), summary: "persisted without usage" };
  delete absent.usage;
  f.persist(absent);
  f.emit(absent);
  expect(usage.map((entry) => [entry.usage.input, entry.usage.cost?.total])).toEqual([
    [10, 0],
    [30, undefined],
    [40, 0.02],
    [60, 0.02],
  ]);
  expect(usage[2]!.usageSource).toBe("persisted-entry");
  zero.usage!.cost.total = 123;
  expect(usage[0]!.usage.cost?.total).toBe(0);
  observer.unsubscribe();
  const late = f.result();
  f.persist(late);
  f.emit(late);
  expect(usage).toHaveLength(4);
});
