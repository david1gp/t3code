// @effect-diagnostics nodeBuiltinImport:off - isolated pinned-SDK fake-provider fixture.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { AgentSession } from "@earendil-works/pi-coding-agent";
import { assert, it } from "@effect/vitest";
import { afterAll, beforeAll, vi } from "vite-plus/test";
import { ProviderDriverKind, ThreadId, type ProviderRuntimeEvent } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ServerConfig } from "../../config.ts";
import { makePiAdapter } from "./PiAdapter.ts";

type Assistant = Extract<AgentSession["state"]["messages"][number], { role: "assistant" }>;
type Block = Assistant["content"][number];
const text = (value: string): Block => ({ type: "text", text: value });
const thinking = (value: string): Block => ({ type: "thinking", thinking: value });
const historyItemsDecode = Schema.decodeUnknownEffect(
  Schema.Array(Schema.Struct({ role: Schema.String, content: Schema.Unknown })),
);
const agentDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-pi-finalization-"));
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
const controlKey = Symbol.for("t3.pi.finalization.test");
const testLayer = ServerConfig.layerTest(process.cwd(), { prefix: "pi-finalization-test-" }).pipe(
  Layer.provideMerge(NodeServices.layer),
);

beforeAll(() => {
  process.env.PI_CODING_AGENT_DIR = agentDir;
  NodeFS.mkdirSync(NodePath.join(agentDir, "extensions"));
  // Resolve the pinned SDK's own pi-ai, not another version or an installed extension edit.
  const sdk = NodeFS.realpathSync("node_modules/@earendil-works/pi-coding-agent");
  NodeFS.symlinkSync(
    NodePath.dirname(NodePath.dirname(sdk)),
    NodePath.join(agentDir, "node_modules"),
  );
  NodeFS.writeFileSync(
    NodePath.join(agentDir, "settings.json"),
    '{"retry":{"enabled":false},"compaction":{"enabled":false},"cacheWarming":{"enabled":false}}',
  );
  NodeFS.writeFileSync(
    NodePath.join(agentDir, "extensions", "finalization.js"),
    `import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
     export default function (pi) {
       const control = globalThis[Symbol.for("t3.pi.finalization.test")];
       pi.registerProvider("finalization-fixture", {
         api: "finalization-fixture", apiKey: "isolated-fake-provider", baseUrl: "https://fixture.invalid",
         models: [{ id: "fixture", name: "Fixture", reasoning: true, input: ["text"],
           cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
           contextWindow: 100000, maxTokens: 1000 }],
         streamSimple: (model) => {
           const stream = createAssistantMessageEventStream();
           const round = control.rounds[control.calls++];
           const message = { role: "assistant", api: model.api, provider: model.provider, model: model.id,
             content: round.streamed ?? round.final,
             usage: { input: 2, output: 3, cacheRead: 0, cacheWrite: 0, totalTokens: 5,
               cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.125 } },
             stopReason: round.stopReason ?? "stop", timestamp: control.calls,
             ...(round.stopReason === "error" ? { errorMessage: "fixture failed" } : {}) };
           if (round.streamed) {
             stream.push({ type: "start", partial: message });
             round.streamed.forEach((block, contentIndex) => {
               if (block.type === "text" || block.type === "thinking") {
                 stream.push({ type: block.type === "text" ? "text_delta" : "thinking_delta",
                   contentIndex, delta: block.type === "text" ? block.text : block.thinking, partial: message });
               }
             });
           }
           if (message.stopReason === "error" || message.stopReason === "aborted")
             stream.push({ type: "error", reason: message.stopReason, error: message });
           else stream.push({ type: "done", reason: message.stopReason, message });
           return stream;
         }
       });
       pi.on("session_start", async (_event, ctx) => {
         await pi.setModel(ctx.modelRegistry.find("finalization-fixture", "fixture"));
       });
       pi.on("message_end", (event) => {
         if (event.message.role !== "assistant") return;
         const round = control.rounds[control.calls - 1];
         return { message: { ...event.message, content: round.final } };
       });
       pi.on("agent_settled", async () => {
         control.settling.resolve();
         await control.settleRelease.promise;
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

const cases: ReadonlyArray<{
  name: string;
  streamed?: Block[];
  final: Block[];
  stopReason?: "error" | "aborted";
}> = [
  { name: "Draft → Final", streamed: [text("Draft")], final: [text("Final")] },
  { name: "Draft → Dra", streamed: [text("Draft")], final: [text("Dra")] },
  { name: "Draft → empty", streamed: [text("Draft")], final: [text("")] },
  {
    name: "prefix extension without suffix duplication",
    streamed: [text("Draft")],
    final: [text("Draft extended")],
  },
  {
    name: "ordinary unchanged stream",
    streamed: [thinking("Reason"), text("Draft")],
    final: [thinking("Reason"), text("Draft")],
  },
  {
    name: "final-only text and reasoning without deltas",
    final: [thinking("Reason"), text("Final")],
  },
  { name: "final-only empty text", final: [text("")] },
  {
    name: "reasoning rewritten shorter and empty",
    streamed: [thinking("Draft"), thinking("Stale")],
    final: [thinking("Dra"), thinking("")],
  },
  {
    name: "new final-only blocks appended to streamed content",
    streamed: [text("Draft")],
    final: [text("Final"), thinking("Final reason"), text("Final tail")],
  },
  {
    name: "multiple indexed blocks rewritten and removed",
    streamed: [thinking("Draft reason"), text("Draft"), text("Stale"), thinking("Stale reason")],
    final: [thinking("Final reason"), text("Final")],
  },
  {
    name: "indexed block kind replacement",
    streamed: [thinking("Reason"), text("Draft")],
    final: [text("Final"), thinking("Final reason")],
  },
  { name: "all streamed blocks removed", streamed: [thinking("Reason"), text("Draft")], final: [] },
  {
    name: "failure retains final partial text and reasoning",
    streamed: [thinking("Reason"), text("Partial")],
    final: [thinking("Reason"), text("Partial")],
    stopReason: "error",
  },
  {
    name: "aborted response retains partial text and reasoning",
    streamed: [thinking("Reason"), text("Partial")],
    final: [thinking("Reason"), text("Partial")],
    stopReason: "aborted",
  },
];

for (const fixture of cases) {
  it.effect(`finalizes real SDK ${fixture.name} before persistence and agent_settled`, () =>
    Effect.gen(function* () {
      const control = {
        rounds: [fixture],
        calls: 0,
        settling: Promise.withResolvers<void>(),
        settleRelease: Promise.withResolvers<void>(),
      };
      Reflect.set(globalThis, controlKey, control);
      const adapter = yield* makePiAdapter();
      const events: ProviderRuntimeEvent[] = [];
      const finalDrained = yield* Deferred.make<void>();
      const completed = yield* Deferred.make<void>();
      const expectedKeys = new Map<string, string>();
      for (const [index, block] of fixture.streamed?.entries() ?? []) {
        if (block.type === "text" || block.type === "thinking")
          expectedKeys.set(`${index}:${block.type}`, "");
      }
      for (const [index, block] of fixture.final.entries()) {
        if (block.type === "text" || block.type === "thinking")
          expectedKeys.set(
            `${index}:${block.type}`,
            block.type === "text" ? block.text : block.thinking,
          );
      }
      yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.gen(function* () {
          events.push(event);
          if (
            events.filter((entry) => entry.type === "item.completed").length === expectedKeys.size
          )
            yield* Deferred.succeed(finalDrained, undefined);
          if (event.type === "turn.completed") yield* Deferred.succeed(completed, undefined);
        }),
      ).pipe(Effect.forkScoped({ startImmediately: true }));
      let sdk: AgentSession | undefined;
      let publicFinalBeforePersistence = false;
      let observedFinal: Assistant | undefined;
      const bind = AgentSession.prototype.bindExtensions;
      const bindSpy = vi
        .spyOn(AgentSession.prototype, "bindExtensions")
        .mockImplementation(async function (this: AgentSession, bindings) {
          // eslint-disable-next-line typescript/no-this-alias -- Capture the pinned SDK fixture receiver.
          sdk = this;
          this.subscribe((event) => {
            if (event.type !== "message_end" || event.message.role !== "assistant") return;
            observedFinal = event.message;
            publicFinalBeforePersistence = !this.sessionManager
              .getBranch()
              .some((entry) => entry.type === "message" && entry.message.role === "assistant");
          });
          await bind.call(this, bindings);
        });
      const threadId = ThreadId.make(`finalization-${fixture.name}`);
      try {
        yield* adapter.startSession({
          threadId,
          provider: ProviderDriverKind.make("pi"),
          cwd: agentDir,
          runtimeMode: "full-access",
        });
        const sending = yield* adapter
          .sendTurn({ threadId, input: "fixture" })
          .pipe(Effect.forkScoped({ startImmediately: true }));
        yield* Effect.promise(() => control.settling.promise);
        yield* Deferred.await(finalDrained);
        assert.isTrue(publicFinalBeforePersistence);
        assert.deepEqual(observedFinal?.content, fixture.final);
        assert.equal(events.filter((event) => event.type === "turn.completed").length, 0);
        const finals = events.filter((event) => event.type === "item.completed");
        const starts = events.filter((event) => event.type === "item.started");
        assert.equal(starts.length, expectedKeys.size);
        assert.equal(new Set(starts.map((event) => event.itemId)).size, starts.length);
        assert.deepEqual(
          finals.map((event) => event.payload.finalText),
          [...expectedKeys.values()],
        );
        assert.deepEqual(
          finals.map((event) => event.itemId),
          starts.map((event) => event.itemId),
        );
        assert.deepEqual(
          finals.map((event) => event.payload.status),
          finals.map(() => (fixture.stopReason ? "failed" : "completed")),
        );
        const deltas = events.filter((event) => event.type === "content.delta");
        assert.deepEqual(
          deltas.map((event) => event.payload.contentIndex),
          fixture.streamed?.map((_block, index) => index) ?? [],
        );
        assert.deepEqual(
          deltas.map((event) => event.itemId),
          starts.slice(0, deltas.length).map((event) => event.itemId),
        );
        assert.deepEqual(
          sdk!.sessionManager
            .getBranch()
            .flatMap((entry) =>
              entry.type === "message" && entry.message.role === "assistant"
                ? [entry.message.content]
                : [],
            ),
          [fixture.final],
        );
        control.settleRelease.resolve();
        yield* Fiber.join(sending);
        yield* Deferred.await(completed);
        assert.equal(control.calls, 1);
        assert.deepEqual(
          events
            .filter((event) => event.type === "turn.completed")
            .map((event) => ({ state: event.payload.state, cost: event.payload.totalCostUsd })),
          [
            {
              state:
                fixture.stopReason === "error"
                  ? "failed"
                  : fixture.stopReason === "aborted"
                    ? "cancelled"
                    : "completed",
              cost: 0.125,
            },
          ],
        );
        const history = yield* adapter.readThread(threadId);
        assert.equal(history.turns.length, 1);
        assert.deepEqual(
          (yield* historyItemsDecode(history.turns[0]!.items))
            .filter((item) => item.role === "assistant")
            .map((item) => item.content),
          [fixture.final],
        );
        assert.equal(
          events.filter((event) => event.type === "item.completed").length,
          expectedKeys.size,
        );
      } finally {
        control.settleRelease.resolve();
        yield* adapter.stopSession(threadId);
        bindSpy.mockRestore();
      }
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );
}

it.effect(
  "finalizes real SDK indexed blocks before tools and resets indexes for the next assistant",
  () =>
    Effect.gen(function* () {
      const toolCall: Block = {
        type: "toolCall",
        id: "fixture-tool",
        name: "bash",
        arguments: { command: "fixture" },
      };
      const control = {
        calls: 0,
        rounds: [
          {
            streamed: [text("Draft"), toolCall, thinking("Draft reason"), text("Draft tail")],
            final: [text("Final"), toolCall, thinking("Final reason"), text("Final tail")],
            stopReason: "toolUse",
          },
          {
            streamed: [thinking("Next draft"), text("Next draft")],
            final: [thinking("Next reason"), text("Next final")],
          },
        ],
        settling: Promise.withResolvers<void>(),
        settleRelease: Promise.withResolvers<void>(),
      };
      Reflect.set(globalThis, controlKey, control);
      const adapter = yield* makePiAdapter();
      const events: ProviderRuntimeEvent[] = [];
      const finalsDrained = yield* Deferred.make<void>();
      yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.gen(function* () {
          events.push(event);
          if (event.type === "item.completed" && event.payload.finalText === "Next final")
            yield* Deferred.succeed(finalsDrained, undefined);
        }),
      ).pipe(Effect.forkScoped({ startImmediately: true }));
      const bind = AgentSession.prototype.bindExtensions;
      const bindSpy = vi
        .spyOn(AgentSession.prototype, "bindExtensions")
        .mockImplementation(async function (this: AgentSession, bindings) {
          const tool = this.agent.state.tools.find((entry) => entry.name === "bash")!;
          tool.execute = async () => ({
            content: [{ type: "text", text: "fixture tool result" }],
            details: {},
          });
          await bind.call(this, bindings);
        });
      const threadId = ThreadId.make("finalization-tool-ordering");
      try {
        yield* adapter.startSession({
          threadId,
          provider: ProviderDriverKind.make("pi"),
          cwd: agentDir,
          runtimeMode: "full-access",
        });
        const sending = yield* adapter
          .sendTurn({ threadId, input: "fixture" })
          .pipe(Effect.forkScoped({ startImmediately: true }));
        yield* Effect.promise(() => control.settling.promise);
        yield* Deferred.await(finalsDrained);
        const finals = events
          .filter((event) => event.type === "item.completed")
          .filter((event) => event.payload.finalText !== undefined);
        assert.deepEqual(
          finals.map((event) => event.payload.finalText),
          ["Final", "Final reason", "Final tail", "Next reason", "Next final"],
        );
        const deltas = events.filter((event) => event.type === "content.delta");
        assert.deepEqual(
          deltas.map((event) => event.payload.contentIndex),
          [0, 2, 3, 0, 1],
        );
        assert.deepEqual(
          deltas.map((event) => event.itemId),
          finals.map((event) => event.itemId),
        );
        assert.equal(new Set(finals.map((event) => event.itemId)).size, 5);
        const toolStart = events.findIndex(
          (event) => event.type === "item.started" && event.itemId === "fixture-tool",
        );
        const toolEnd = events.findIndex(
          (event) => event.type === "item.completed" && event.itemId === "fixture-tool",
        );
        assert.isTrue(events.indexOf(finals[2]!) < toolStart);
        assert.isTrue(toolStart < toolEnd && toolEnd < events.indexOf(deltas[3]!));
        assert.equal(events.filter((event) => event.type === "turn.completed").length, 0);
        control.settleRelease.resolve();
        yield* Fiber.join(sending);
        assert.equal(control.calls, 2);
        const history = yield* adapter.readThread(threadId);
        assert.equal(history.turns.length, 1);
        const items = yield* historyItemsDecode(history.turns[0]!.items);
        assert.deepEqual(
          items.filter((item) => item.role === "assistant").map((item) => item.content),
          control.rounds.map((round) => round.final),
        );
        assert.equal(items.filter((item) => item.role === "toolResult").length, 1);
      } finally {
        control.settleRelease.resolve();
        yield* adapter.stopSession(threadId);
        bindSpy.mockRestore();
      }
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
);
