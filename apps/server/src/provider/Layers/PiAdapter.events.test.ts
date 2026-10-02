// @effect-diagnostics nodeBuiltinImport:off - SDK sessions persist in isolated test state.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  createAgentSession,
  createEventBus,
  CONFIG_DIR_NAME,
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
import * as Schema from "effect/Schema";
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
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const lifecycleFixtureDecode = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Array(
      Schema.Struct({
        name: Schema.String,
        payload: Schema.Record(Schema.String, Schema.Unknown),
      }),
    ),
  ),
);
const threadId = ThreadId.make("pi-sdk-events");
type AssistantMessage = Extract<AgentSession["state"]["messages"][number], { role: "assistant" }>;
const assistantMessage = (options: {
  readonly text: string;
  readonly stopReason: AssistantMessage["stopReason"];
  readonly errorMessage?: string;
}): AssistantMessage => ({
  role: "assistant",
  api: "openai-completions",
  provider: "test",
  model: "plain",
  content: [{ type: "text", text: options.text }],
  usage: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
  stopReason: options.stopReason,
  ...(options.errorMessage === undefined ? {} : { errorMessage: options.errorMessage }),
  timestamp: 0,
});
const start = {
  threadId,
  provider: ProviderDriverKind.make("pi"),
  cwd: process.cwd(),
  runtimeMode: "full-access" as const,
};

it.effect.skipIf(!process.env.PI_SUBAGENTS_LIFECYCLE_FIXTURE)(
  "translates corrected extension emitted lifecycle with queued origin and separate partial output/error",
  () =>
    Effect.gen(function* () {
      const records = yield* lifecycleFixtureDecode(
        yield* Effect.promise(() =>
          NodeFSP.readFile(process.env.PI_SUBAGENTS_LIFECYCLE_FIXTURE!, "utf8"),
        ),
      );
      const bus = () =>
        vi.mocked(createEventBus).mock.results.at(-1)!.value as ReturnType<typeof createEventBus>;
      let calls = 0;
      sdkSession(async (emit, preflight) => {
        preflight(true);
        const phase = calls++ === 0 ? records.slice(0, 4) : records.slice(4);
        for (const record of phase) bus().emit(record.name, record.payload);
        emit({ type: "agent_settled" });
      });
      const adapter = yield* makePiAdapter();
      const events: ProviderRuntimeEvent[] = [];
      const done = yield* Deferred.make<void>();
      yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.gen(function* () {
          events.push(event);
          if (events.filter((event) => event.type === "turn.completed").length === 2)
            yield* Deferred.succeed(done, undefined);
        }),
      ).pipe(Effect.forkScoped({ startImmediately: true }));
      yield* adapter.startSession(start);
      const first = yield* adapter.sendTurn({ threadId, input: "queue children" });
      const pending = events.filter((event) => event.type === "task.updated");
      assert.equal(pending.length, 2);
      assert.isTrue(
        pending.every(
          (event) => event.payload.status === "pending" && event.turnId === first.turnId,
        ),
      );
      const second = yield* adapter.sendTurn({ threadId, input: "later parent" });
      yield* Deferred.await(done);
      for (const description of ["queued", "stopped"]) {
        const id = `pi:${records.find((record) => record.payload.description === description)!.payload.id}`;
        const child = events.filter(
          (event) =>
            event.type.startsWith("task.") &&
            "taskId" in event.payload &&
            event.payload.taskId === id,
        );
        assert.isTrue(child.every((event) => event.turnId === first.turnId));
        assert.equal(child.at(-1)!.type, "task.completed");
        const terminal = child.at(-1)!;
        assert.equal(terminal.type === "task.completed" && terminal.payload.status, "stopped");
      }
      const failure = events.find(
        (event) => event.type === "task.completed" && event.payload.title === "error",
      );
      assert.equal(failure?.turnId, second.turnId);
      assert.equal(failure?.type === "task.completed" && failure.payload.status, "failed");
      assert.equal(
        failure?.type === "task.completed" && failure.payload.summary,
        "salvaged output",
      );
      assert.equal(failure?.type === "task.completed" && failure.payload.error, "provider failed");
      assert.isTrue(
        events
          .filter((event) => event.type.startsWith("task."))
          .every(
            (event) =>
              !("model" in event.payload) &&
              !("effort" in event.payload) &&
              !("runHandles" in event.payload) &&
              !("toolUseId" in event.payload),
          ),
      );
      yield* adapter.stopSession(threadId);
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
);

it.effect("rejects invalid Pi terminal statuses without losing a queued child's origin", () =>
  Effect.gen(function* () {
    const bus = () =>
      vi.mocked(createEventBus).mock.results.at(-1)!.value as ReturnType<typeof createEventBus>;
    sdkSession(async (emit, preflight) => {
      preflight(true);
      bus().emit("subagents:created", { id: "validated", description: "Queued" });
      for (const status of ["queued", "running", "toString", null, 1])
        bus().emit("subagents:failed", { id: "validated", status, error: "invalid terminal" });
      bus().emit("subagents:failed", {
        id: "validated",
        status: "aborted",
        result: "partial",
        error: "abort detail",
      });
      bus().emit("subagents:completed", {
        id: "steered",
        status: "steered",
        result: "steering result",
      });
      emit({ type: "agent_settled" });
    });
    const adapter = yield* makePiAdapter();
    const events: ProviderRuntimeEvent[] = [];
    const done = yield* Deferred.make<void>();
    yield* Stream.runForEach(adapter.streamEvents, (event) =>
      Effect.gen(function* () {
        events.push(event);
        if (event.type === "turn.completed") yield* Deferred.succeed(done, undefined);
      }),
    ).pipe(Effect.forkScoped({ startImmediately: true }));
    yield* adapter.startSession(start);
    const turn = yield* adapter.sendTurn({ threadId, input: "validate lifecycle" });
    yield* Deferred.await(done);
    const terminals = events.filter((event) => event.type === "task.completed");
    assert.equal(terminals.length, 2);
    assert.deepEqual(
      terminals.map((event) => [
        event.payload.status,
        event.payload.summary,
        event.payload.error,
        event.turnId,
      ]),
      [
        ["stopped", "partial", "abort detail", turn.turnId],
        ["completed", "steering result", undefined, turn.turnId],
      ],
    );
    yield* adapter.stopSession(threadId);
  }).pipe(Effect.scoped, Effect.provide(testLayer)),
);

it.effect.skipIf(!process.env.PI_SUBAGENTS_REACTIVATION_FIXTURE)(
  "reactivates real corrected Agent resumes once and fences duplicate lifecycle without moving history",
  () =>
    Effect.gen(function* () {
      const records = yield* lifecycleFixtureDecode(
        yield* Effect.promise(() =>
          NodeFSP.readFile(process.env.PI_SUBAGENTS_REACTIVATION_FIXTURE!, "utf8"),
        ),
      );
      const id = records.find((record) => record.name === "subagents:started")!.payload.id;
      const phases: Array<Array<(typeof records)[number]>> = [];
      for (const record of records) {
        if (record.name === "phase") phases.push([]);
        else phases.at(-1)!.push(record);
      }
      const bus = () =>
        vi.mocked(createEventBus).mock.results.at(-1)!.value as ReturnType<typeof createEventBus>;
      let call = 0;
      sdkSession(async (emit, preflight) => {
        preflight(true);
        // Replay duplicate old lifecycle before the successor's real tool
        // boundary. No callback payload contains a fabricated activation ID.
        if (call > 0 && call !== 4) {
          bus().emit("subagents:started", { id, description: "obsolete start" });
          bus().emit("subagents:created", { id, description: "obsolete creation" });
          bus().emit("subagents:completed", { id, result: "obsolete result" });
        }
        for (const record of phases[call++]!) {
          if (record.name.startsWith("tool_execution_"))
            emit({ type: record.name, ...record.payload } as AgentSessionEvent);
          else bus().emit(record.name, record.payload);
          if (record.name === "subagents:started")
            bus().emit(record.name, { ...record.payload, description: "duplicate start" });
        }
        emit({ type: "agent_settled" });
      });
      const adapter = yield* makePiAdapter();
      const events: ProviderRuntimeEvent[] = [];
      const done = yield* Deferred.make<void>();
      yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.gen(function* () {
          events.push(event);
          if (events.filter((event) => event.type === "turn.completed").length === 6)
            yield* Deferred.succeed(done, undefined);
        }),
      ).pipe(Effect.forkScoped({ startImmediately: true }));
      yield* adapter.startSession(start);
      const turns = [];
      for (const input of [
        "fresh",
        "foreground",
        "immediate-background",
        "queued",
        "stop",
        "successor",
      ])
        turns.push((yield* adapter.sendTurn({ threadId, input })).turnId);
      yield* Deferred.await(done);
      const child = events.filter(
        (event) =>
          (event.type === "task.started" ||
            event.type === "task.updated" ||
            event.type === "task.completed") &&
          event.payload.taskId === `pi:${id}`,
      );
      assert.deepEqual(
        child.map((event) => [
          event.type,
          "status" in event.payload ? event.payload.status : undefined,
          event.turnId,
        ]),
        [
          ["task.started", undefined, turns[0]],
          ["task.completed", "completed", turns[0]],
          ["task.updated", "running", turns[1]],
          ["task.started", undefined, turns[1]],
          ["task.completed", "completed", turns[1]],
          ["task.updated", "running", turns[2]],
          ["task.started", undefined, turns[2]],
          ["task.completed", "completed", turns[2]],
          ["task.updated", "running", turns[3]],
          ["task.started", undefined, turns[3]],
          ["task.completed", "stopped", turns[3]],
          ["task.updated", "running", turns[5]],
          ["task.started", undefined, turns[5]],
          ["task.completed", "completed", turns[5]],
        ],
      );
      assert.deepEqual(
        child
          .filter((event) => event.type === "task.completed")
          .map((event) => event.payload.summary),
        ["first answer", "second answer", "successor answer", "partial resume", "successor answer"],
      );
      yield* adapter.stopSession(threadId);
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
);

it.effect(
  "admits a Pi resume with retained task history and fences startup callbacks after settlement",
  () =>
    Effect.gen(function* () {
      const bus = () =>
        vi.mocked(createEventBus).mock.results.at(-1)!.value as ReturnType<typeof createEventBus>;
      sdkSession(
        async (emit, preflight) => {
          preflight(true);
          emit({
            type: "tool_execution_start",
            toolName: "Agent",
            toolCallId: "resume",
            args: { resume: "history" },
          });
          bus().emit("subagents:started", { id: "history", description: "Resume retained child" });
          bus().emit("subagents:completed", { id: "history", result: "new history answer" });
          bus().emit("subagents:started", { id: "startup", description: "late startup" });
          bus().emit("subagents:created", { id: "startup", description: "late startup creation" });
          bus().emit("subagents:failed", { id: "startup", error: "late startup failure" });
          emit({
            type: "tool_execution_start",
            toolName: "Agent",
            toolCallId: "startup-resume",
            args: { resume: "startup" },
          });
          bus().emit("subagents:started", { id: "startup", description: "Startup child resumed" });
          bus().emit("subagents:completed", { id: "startup", result: "resumed startup answer" });
          emit({
            type: "tool_execution_start",
            toolName: "Agent",
            toolCallId: "rejected-resume",
            args: { resume: "startup" },
          });
          emit({
            type: "tool_execution_end",
            toolName: "Agent",
            toolCallId: "rejected-resume",
            result: { content: [{ type: "text", text: "resume rejected" }] },
            isError: true,
          });
          bus().emit("subagents:created", {
            id: "startup",
            description: "late after rejected resume",
          });
          bus().emit("subagents:started", { id: "startup" });
          bus().emit("subagents:completed", { id: "startup", result: "obsolete" });
          emit({ type: "agent_settled" });
        },
        {
          bindExtensions: () => {
            bus().emit("subagents:created", { id: "startup", description: "Startup child" });
            bus().emit("subagents:started", { id: "startup" });
            bus().emit("subagents:completed", { id: "startup", result: "startup answer" });
          },
        },
      );
      const adapter = yield* makePiAdapter();
      const events: ProviderRuntimeEvent[] = [];
      const done = yield* Deferred.make<void>();
      yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.gen(function* () {
          events.push(event);
          if (event.type === "turn.completed") yield* Deferred.succeed(done, undefined);
        }),
      ).pipe(Effect.forkScoped({ startImmediately: true }));
      yield* adapter.startSession(start);
      const turn = yield* adapter.sendTurn({ threadId, input: "resume persisted child" });
      yield* Deferred.await(done);
      const tasks = events.filter(
        (event) =>
          event.type === "task.started" ||
          event.type === "task.updated" ||
          event.type === "task.completed",
      );
      assert.deepEqual(
        tasks.map((event) => [event.type, event.payload.taskId, event.turnId]),
        [
          ["task.updated", "pi:startup", undefined],
          ["task.started", "pi:startup", undefined],
          ["task.completed", "pi:startup", undefined],
          ["task.updated", "pi:history", turn.turnId],
          ["task.started", "pi:history", turn.turnId],
          ["task.completed", "pi:history", turn.turnId],
          ["task.updated", "pi:startup", turn.turnId],
          ["task.started", "pi:startup", turn.turnId],
          ["task.completed", "pi:startup", turn.turnId],
        ],
      );
      yield* adapter.stopSession(threadId);
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
);

function sdkSession(
  prompt: (
    emit: (event: AgentSessionEvent) => void,
    preflight: (success: boolean) => void,
  ) => Promise<void>,
  sdkOptions: {
    readonly isStreaming?: () => boolean;
    readonly steer?: (text: string) => Promise<void>;
    readonly isIdle?: () => boolean;
    readonly pendingMessageCount?: () => number;
    readonly abort?: () => Promise<void>;
    readonly clearQueue?: () => void;
    readonly availableLevels?: () => Array<Parameters<AgentSession["setThinkingLevel"]>[0]>;
    readonly setThinkingLevel?: (level: Parameters<AgentSession["setThinkingLevel"]>[0]) => void;
    readonly modelMetadata?: (
      provider: string,
      id: string,
    ) => {
      reasoning: boolean;
      contextWindow?: number;
      thinkingLevelMap?: NonNullable<AgentSession["model"]>["thinkingLevelMap"];
    };
    readonly setModel?: () => void;
    readonly dispose?: () => void;
    readonly restoredModel?: AgentSession["model"];
    readonly listen?: (emit: (event: AgentSessionEvent) => void) => void;
    readonly contextUsage?: () => ReturnType<AgentSession["getContextUsage"]>;
    readonly autoCompactionEnabled?: boolean;
    readonly presetCommand?: boolean;
    readonly onPrompt?: (text: string) => void;
    readonly bindExtensions?: (emit: (event: AgentSessionEvent) => void) => void;
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
        bindExtensions: async () => sdkOptions.bindExtensions?.(listener),
        extensionRunner: {
          hasHandlers: () => false,
          emit: async () => undefined,
          getCommand: () => (sdkOptions.presetCommand ? {} : undefined),
          onError: () => () => {},
        },
        prompt: async (
          text: string,
          config: { preflightResult: (success: boolean) => void; streamingBehavior?: "steer" },
        ) => {
          sdkOptions.onPrompt?.(text);
          if (text.startsWith("/preset ")) return;
          if (config.streamingBehavior === "steer") {
            await sdkOptions.steer?.(text);
            config.preflightResult(true);
            return;
          }
          return prompt(listener, config.preflightResult);
        },
        get isStreaming() {
          return sdkOptions.isStreaming?.() ?? false;
        },
        get isIdle() {
          return sdkOptions.isIdle?.() ?? !(sdkOptions.isStreaming?.() ?? false);
        },
        get pendingMessageCount() {
          return sdkOptions.pendingMessageCount?.() ?? 0;
        },
        steer: (text: string) => sdkOptions.steer?.(text) ?? Promise.resolve(),
        abort: () => sdkOptions.abort?.() ?? Promise.resolve(),
        clearQueue: () => sdkOptions.clearQueue?.(),
        dispose: () => sdkOptions.dispose?.(),
        getContextUsage: () => sdkOptions.contextUsage?.(),
        get autoCompactionEnabled() {
          return sdkOptions.autoCompactionEnabled ?? true;
        },
        settingsManager: sessionOptions?.settingsManager,
      },
    } as unknown as Awaited<ReturnType<typeof createAgentSession>>;
  });
}

it.effect(
  "snapshots Pi child bus origin during startup before queued SDK events are consumed",
  () =>
    Effect.gen(function* () {
      const bus = () =>
        vi.mocked(createEventBus).mock.results.at(-1)!.value as ReturnType<typeof createEventBus>;
      sdkSession(async () => {}, {
        bindExtensions: (emit) => {
          bus().emit("subagents:created", { id: "no-origin", description: "Startup only" });
          emit({ type: "agent_start" });
          bus().emit("subagents:created", { id: "sdk-origin", description: "Startup activation" });
          bus().emit("subagents:started", { id: "no-origin" });
          bus().emit("subagents:started", { id: "sdk-origin" });
          bus().emit("subagents:completed", {
            id: "no-origin",
            status: "completed",
            result: "early",
          });
          bus().emit("subagents:completed", {
            id: "sdk-origin",
            status: "completed",
            result: "bound",
          });
          emit({ type: "agent_settled" });
        },
      });
      const adapter = yield* makePiAdapter();
      const events: ProviderRuntimeEvent[] = [];
      const done = yield* Deferred.make<void>();
      yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.gen(function* () {
          events.push(event);
          if (event.type === "turn.completed") yield* Deferred.succeed(done, undefined);
        }),
      ).pipe(Effect.forkScoped({ startImmediately: true }));
      yield* adapter.startSession(start);
      yield* Deferred.await(done);
      const turnId = events.find((event) => event.type === "turn.started")!.turnId;
      assert.isDefined(turnId);
      for (const [id, origin] of [
        ["no-origin", undefined],
        ["sdk-origin", turnId],
      ] as const) {
        const child = events.filter(
          (event) =>
            event.type.startsWith("task.") &&
            "taskId" in event.payload &&
            event.payload.taskId === `pi:${id}`,
        );
        assert.deepEqual(
          child.map((event) => event.type),
          ["task.updated", "task.started", "task.completed"],
        );
        assert.deepEqual(
          child.map((event) => event.turnId),
          [origin, origin, origin],
        );
      }
      yield* adapter.stopSession(threadId);
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
);

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

it.effect(
  "uses model defaults for explicit model selections but preserves SDK thinking otherwise",
  () =>
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
        options: [{ id: "modelOverride", value: true }],
      };
      yield* adapter.startSession({ ...start, modelSelection });
      assert.deepEqual(applied, ["medium"]);
      assert.isUndefined(vi.mocked(createAgentSession).mock.lastCall?.[0]?.thinkingLevel);
      yield* adapter.sendTurn({ threadId, input: "first", modelSelection });
      yield* adapter.sendTurn({
        threadId,
        input: "explicit high",
        modelSelection: {
          ...modelSelection,
          options: [...modelSelection.options, { id: "thinkingLevel", value: "high" }],
        },
      });
      yield* adapter.sendTurn({ threadId, input: "default again" });
      assert.deepEqual(prompts, ["medium", "high", "high"]);
      assert.deepEqual(applied, ["medium", "medium", "high"]);
      assert.deepEqual(
        events
          .filter((event) => event.type === "turn.started")
          .map((event) => event.payload.effort),
        ["medium", "high", "high"],
      );
      yield* adapter.stopSession(threadId);
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
);

it.effect(
  "does not override the extension's thinking default on a fresh no-selection session",
  () =>
    Effect.gen(function* () {
      const applied: string[] = [];
      sdkSession(async () => {}, { setThinkingLevel: (level) => applied.push(level) });
      const adapter = yield* makePiAdapter();
      yield* adapter.startSession(start);
      assert.deepEqual(applied, []);
      yield* adapter.stopSession(threadId);
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
);

it.effect("explicit model override with none restores the model-derived thinking default", () =>
  Effect.gen(function* () {
    const model = (yield* Effect.promise(() => ModelRuntime.create())).getAvailableSnapshot()[0]!;
    const applied: string[] = [];
    const prompts: string[] = [];
    sdkSession(async () => {}, {
      presetCommand: true,
      onPrompt: (text) => prompts.push(text),
      setThinkingLevel: (level) => applied.push(level),
    });
    const adapter = yield* makePiAdapter();
    yield* adapter.startSession({
      ...start,
      modelSelection: {
        instanceId: ProviderInstanceId.make("pi"),
        model: `${model.provider}/${model.id}`,
        options: [
          { id: "preset", value: "none" },
          { id: "modelOverride", value: true },
        ],
      },
    });
    assert.deepEqual(prompts, ["/preset none"]);
    assert.deepEqual(applied, ["medium"]);
    yield* adapter.stopSession(threadId);
  }).pipe(Effect.scoped, Effect.provide(testLayer)),
);

it.effect("validates project presets from the effective extension config", () =>
  Effect.gen(function* () {
    const model = (yield* Effect.promise(() => ModelRuntime.create())).getAvailableSnapshot()[0]!;
    const projectDir = yield* Effect.acquireRelease(
      Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "pi-project-presets-"))),
      (path) => Effect.promise(() => NodeFSP.rm(path, { recursive: true, force: true })),
    );
    yield* Effect.promise(() =>
      NodeFSP.mkdir(NodePath.join(projectDir, CONFIG_DIR_NAME), { recursive: true }),
    );
    yield* Effect.promise(() =>
      NodeFSP.writeFile(
        NodePath.join(projectDir, CONFIG_DIR_NAME, "presets.json"),
        encodeJson({ projectpreset: { thinkingLevel: "high" } }),
      ),
    );
    const prompts: string[] = [];
    sdkSession(async () => {}, { presetCommand: true, onPrompt: (text) => prompts.push(text) });
    const adapter = yield* makePiAdapter();
    yield* adapter.startSession({
      ...start,
      cwd: projectDir,
      modelSelection: {
        instanceId: ProviderInstanceId.make("pi"),
        model: `${model.provider}/${model.id}`,
        options: [{ id: "preset", value: "projectpreset" }],
      },
    });
    assert.deepEqual(prompts, ["/preset projectpreset"]);
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
      assert.deepEqual(applied, []);
      assert.deepEqual(prompts, ["high"]);
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
          options: [
            { id: "modelOverride", value: true },
            { id: "thinkingLevel", value: "high" },
          ],
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
          options: [
            { id: "modelOverride", value: true },
            { id: "thinkingLevel", value: "off" },
          ],
        },
      });
      yield* adapter.sendTurn({ threadId, input: "second" });
      assert.deepEqual(calls, ["model", "thinking:off", "prompt", "prompt"]);
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
        modelSelection: {
          instanceId: ProviderInstanceId.make("pi"),
          model: `test/${model}`,
          options: [{ id: "modelOverride", value: true }],
        },
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
            options: [
              { id: "modelOverride", value: true },
              { id: "thinkingLevel", value: "high" },
            ],
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
          message: assistantMessage({ text: "done", stopReason: "stop" }),
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

for (const guard of ["running", "pending", "settling"] as const) {
  it.effect(`keeps successful handled Pi input pending while SDK work is ${guard}`, () =>
    Effect.gen(function* () {
      let emitSdk!: (event: AgentSessionEvent) => void;
      const returned = Promise.withResolvers<void>();
      let streaming = false;
      let pending = guard === "pending" ? 1 : 0;
      sdkSession(
        async (emit, preflight) => {
          emitSdk = emit;
          streaming = guard === "running";
          if (guard === "settling") emit({ type: "agent_start" });
          preflight(true);
          returned.resolve();
        },
        {
          isStreaming: () => streaming,
          pendingMessageCount: () => pending,
        },
      );
      const adapter = yield* makePiAdapter();
      const drained = yield* Deferred.make<void>();
      const events: ProviderRuntimeEvent[] = [];
      yield* adapter.streamEvents.pipe(
        Stream.runForEach((event) =>
          Effect.gen(function* () {
            events.push(event);
            if (event.type === "content.delta") yield* Deferred.succeed(drained, undefined);
          }),
        ),
        Effect.forkScoped({ startImmediately: true }),
      );
      yield* adapter.startSession(start);
      const send = yield* adapter
        .sendTurn({ threadId, input: "handled work" })
        .pipe(Effect.forkScoped({ startImmediately: true }));
      yield* Effect.promise(() => returned.promise);
      // The SDK promise returned before this drain sentinel. Observe the FIFO
      // runtime consumer, not a timeout/sleep, before asserting non-completion.
      emitSdk({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: "barrier", contentIndex: 0 },
      } as AgentSessionEvent);
      yield* Deferred.await(drained);
      assert.equal(events.filter((event) => event.type === "turn.completed").length, 0);
      assert.equal((yield* adapter.listSessions())[0]?.status, "running");
      streaming = false;
      pending = 0;
      emitSdk({ type: "agent_end", messages: [], willRetry: false });
      emitSdk({ type: "agent_settled" });
      yield* Fiber.join(send);
      assert.equal(events.filter((event) => event.type === "turn.completed").length, 1);
      yield* adapter.stopSession(threadId);
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );
}

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
        message: assistantMessage({
          text: "partial",
          stopReason: "error",
          errorMessage: "model failed",
        }),
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

it.effect("does not defer a preset or user prompt behind an unsettled SDK prompt", () =>
  Effect.gen(function* () {
    let releasePrompt!: () => void;
    const promptFinished = new Promise<void>((resolve) => {
      releasePrompt = resolve;
    });
    const calls: string[] = [];
    sdkSession(
      async (emit, preflight) => {
        preflight(true);
        emit({ type: "agent_settled" });
        // Pi emits agent_settled before prompt() has finished its async dispatch.
        await promptFinished;
      },
      { presetCommand: true, onPrompt: (text) => calls.push(text) },
    );
    const adapter = yield* makePiAdapter();
    const settled = yield* Deferred.make<void>();
    yield* adapter.streamEvents.pipe(
      Stream.runForEach((event) =>
        event.type === "turn.completed" ? Deferred.succeed(settled, undefined) : Effect.void,
      ),
      Effect.forkScoped({ startImmediately: true }),
    );
    yield* adapter.startSession(start);
    const first = yield* Effect.forkChild(adapter.sendTurn({ threadId, input: "first" }), {
      startImmediately: true,
    });
    yield* Deferred.await(settled);
    assert.equal((yield* adapter.listSessions())[0]?.status, "ready");
    const secondInput = {
      threadId,
      input: "second",
      modelSelection: {
        instanceId: ProviderInstanceId.make("pi"),
        model: "test/model",
        options: [{ id: "preset", value: "none" }],
      },
    };
    const rejected = yield* adapter.sendTurn(secondInput).pipe(Effect.flip);
    assert.equal(rejected._tag, "ProviderAdapterRequestError");
    assert.deepEqual(calls, ["first"]);
    releasePrompt();
    yield* Fiber.join(first);
    yield* adapter.sendTurn(secondInput);
    assert.deepEqual(calls, ["first", "/preset none", "second"]);
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
            message: {
              role: "assistant",
              content: [],
              stopReason: "aborted",
              api: "fixture",
              provider: "fixture",
              model: "fixture",
              timestamp: 1,
              usage: {
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
                totalTokens: 0,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
              },
            },
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

it.effect("keeps background subagent tasks on their originating turn across later turns", () =>
  Effect.gen(function* () {
    let prompts = 0;
    let releaseSecond!: () => void;
    const secondFinished = new Promise<void>((resolve) => {
      releaseSecond = resolve;
    });
    let secondEntered!: () => void;
    const secondStarted = new Promise<void>((resolve) => {
      secondEntered = resolve;
    });
    const agentBus = () =>
      vi.mocked(createEventBus).mock.results.at(-1)?.value as ReturnType<typeof createEventBus>;
    sdkSession(async (emit, preflight) => {
      preflight(true);
      if (prompts++ === 0) {
        agentBus().emit("subagents:started", { id: "late-success", description: "Scan" });
        agentBus().emit("subagents:started", { id: "late-failure", description: "Review" });
        emit({ type: "agent_settled" });
        return;
      }
      secondEntered();
      await secondFinished;
      emit({ type: "agent_settled" });
    });
    const adapter = yield* makePiAdapter();
    const events: ProviderRuntimeEvent[] = [];
    const preactiveStarted = yield* Deferred.make<void>();
    const tasksSettled = yield* Deferred.make<void>();
    yield* adapter.streamEvents.pipe(
      Stream.runForEach((event) =>
        Effect.gen(function* () {
          events.push(event);
          if (event.type === "task.started" && event.payload.taskId === "pi:before-turn")
            yield* Deferred.succeed(preactiveStarted, undefined);
          if (events.filter((entry) => entry.type === "task.completed").length === 3)
            yield* Deferred.succeed(tasksSettled, undefined);
        }),
      ),
      Effect.forkScoped({ startImmediately: true }),
    );
    yield* adapter.startSession(start);
    agentBus().emit("subagents:started", { id: "before-turn", description: "Early" });
    yield* Deferred.await(preactiveStarted);
    const first = yield* adapter.sendTurn({ threadId, input: "spawn two children" });
    const second = yield* Effect.forkChild(adapter.sendTurn({ threadId, input: "next turn" }), {
      startImmediately: true,
    });
    yield* Effect.promise(() => secondStarted);
    const secondTurnId = (yield* adapter.listSessions())[0]?.activeTurnId;
    assert.isDefined(secondTurnId);
    assert.notEqual(secondTurnId, first.turnId);
    agentBus().emit("subagents:completed", { id: "late-success", result: "found it" });
    agentBus().emit("subagents:failed", { id: "late-failure", error: "review failed" });
    agentBus().emit("subagents:completed", { id: "before-turn", result: "early result" });
    yield* Deferred.await(tasksSettled);
    assert.deepEqual(
      events
        .filter((event) => event.type === "task.started" || event.type === "task.completed")
        .map((event) => [
          event.type,
          event.payload.taskId,
          event.turnId,
          ...(event.type === "task.completed" ? [event.payload.status] : []),
        ]),
      [
        ["task.started", RuntimeTaskId.make("pi:before-turn"), undefined],
        ["task.started", RuntimeTaskId.make("pi:late-success"), first.turnId],
        ["task.started", RuntimeTaskId.make("pi:late-failure"), first.turnId],
        ["task.completed", RuntimeTaskId.make("pi:late-success"), first.turnId, "completed"],
        ["task.completed", RuntimeTaskId.make("pi:late-failure"), first.turnId, "failed"],
        ["task.completed", RuntimeTaskId.make("pi:before-turn"), undefined, "completed"],
      ],
    );
    // Only the actual Agent resume boundary admits another activation. A
    // bare late started cannot release a terminal ID or move its origin.
    agentBus().emit("subagents:started", { id: "late-failure", description: "Late duplicate" });
    releaseSecond();
    assert.equal((yield* Fiber.join(second)).turnId, secondTurnId);
    assert.equal(events.filter((event) => event.type === "task.started").length, 3);
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
          bus.emit("subagents:started", {
            id: "agent-2",
            type: "review",
            description: "Review changes",
          });
          emit({
            type: "message_end",
            message: {
              role: "assistant",
              content: [],
              stopReason: "stop",
              api: "fixture",
              provider: "fixture",
              model: "fixture",
              timestamp: 1,
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
          // pi-subagents buildEventData() includes both result and error,
          // plus lifecycle metadata even when a child fails.
          bus.emit("subagents:failed", {
            id: "agent-2",
            type: "review",
            description: "Review changes",
            result: "",
            error: "Review agent exited with code 1",
            status: "error",
            toolUses: 1,
            durationMs: 450,
            tokens: { input: 20, output: 4, total: 24 },
            usage: {
              input: 20,
              output: 4,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 24,
              cost: { total: 0.0005 },
            },
          });
          emit({ type: "agent_settled" });
        },
        {
          contextUsage: () => ({ tokens: 530, contextWindow: 200_000, percent: 0.265 }),
          modelMetadata: () => ({ reasoning: true, contextWindow: 200_000 }),
          autoCompactionEnabled: false,
        },
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
        contextUsageStatus: "estimated",
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
        compactsAutomatically: false,
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
            type: "task.started",
            turnId: turn.turnId,
            payload: {
              taskId: RuntimeTaskId.make("pi:agent-2"),
              description: "Review changes",
              taskType: "subagent",
              agentKind: "agent",
              title: "Review changes",
              role: "review",
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
          {
            type: "task.completed",
            turnId: turn.turnId,
            payload: {
              taskId: RuntimeTaskId.make("pi:agent-2"),
              status: "failed",
              error: "Review agent exited with code 1",
              typedUsage: {
                totalTokens: 24,
                inputTokens: 20,
                cachedInputTokens: 0,
                outputTokens: 4,
                toolUses: 1,
                durationMs: 450,
                costUsd: 0.0005,
              },
              taskType: "subagent",
              agentKind: "agent",
              title: "Review changes",
              role: "review",
            },
          },
        ],
      );
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
);
