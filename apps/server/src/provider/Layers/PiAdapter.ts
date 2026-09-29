// @effect-diagnostics nodeBuiltinImport:off globalDate:off - Pi sessions persist under T3 state.
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";
import {
  createAgentSession,
  createEventBus,
  CONFIG_DIR_NAME,
  DefaultResourceLoader,
  getAgentDir,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type AgentSessionEvent,
} from "@earendil-works/pi-coding-agent";

import {
  EventId,
  ProviderDriverKind,
  ProviderInstanceId,
  RuntimeItemId,
  RuntimeTaskId,
  TurnId,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type ProviderSessionStartInput,
  type ThreadId,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import { piPresetNamesFromJson } from "./PiProvider.ts";
import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
} from "../Errors.ts";
import type { ProviderAdapterShape, ProviderThreadSnapshot } from "../Services/ProviderAdapter.ts";

const provider = ProviderDriverKind.make("pi");
const resumeVersion = 1;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function sessionIdFromCursor(cursor: unknown): string | undefined {
  const value =
    cursor !== null && typeof cursor === "object"
      ? (cursor as { schemaVersion?: unknown; sessionId?: unknown })
      : undefined;
  return value?.schemaVersion === resumeVersion &&
    typeof value.sessionId === "string" &&
    uuidPattern.test(value.sessionId)
    ? value.sessionId
    : undefined;
}

function modelParts(model: string): { provider: string; modelId: string } | undefined {
  const separator = model.indexOf("/");
  if (separator <= 0 || separator === model.length - 1) return undefined;
  return { provider: model.slice(0, separator), modelId: model.slice(separator + 1) };
}

const thinkingLevels = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const satisfies ReadonlyArray<Parameters<AgentSession["setThinkingLevel"]>[0]>;

function modelSupportsThinkingLevel(
  model: NonNullable<AgentSession["model"]>,
  level: (typeof thinkingLevels)[number],
): boolean {
  if (!model.reasoning) return level === "off";
  const mapped = model.thinkingLevelMap?.[level];
  if (mapped === null) return false;
  return level !== "xhigh" && level !== "max" ? true : mapped !== undefined;
}

function defaultThinkingLevel(
  model: AgentSession["model"],
): (typeof thinkingLevels)[number] | null {
  if (!model) return null;
  if (!model.reasoning) return "off";
  const supported = thinkingLevels.filter((level) => modelSupportsThinkingLevel(model, level));
  return (
    supported.find((level) => thinkingLevels.indexOf(level) >= thinkingLevels.indexOf("medium")) ??
    supported.at(-1) ??
    null
  );
}

function selectedOptions(
  selection: ProviderSessionStartInput["modelSelection"],
  instanceId: ProviderInstanceId,
  operation: "startSession" | "sendTurn",
  fs: FileSystem.FileSystem,
  cwd: string,
) {
  if (selection?.instanceId !== instanceId || !selection.options?.length)
    return Effect.succeed({ preset: undefined, thinkingLevel: null, modelOverride: false });
  const values = new Map<string, unknown>();
  for (const option of selection.options) {
    if (
      (option.id !== "preset" && option.id !== "thinkingLevel" && option.id !== "modelOverride") ||
      values.has(option.id)
    )
      return Effect.fail(
        new ProviderAdapterValidationError({
          provider,
          operation,
          issue: "Pi supports one preset, one thinkingLevel, and one modelOverride model option.",
        }),
      );
    values.set(option.id, option.value);
  }
  const presetValue = values.get("preset");
  if (values.has("preset") && (typeof presetValue !== "string" || !presetValue.trim()))
    return Effect.fail(
      new ProviderAdapterValidationError({
        provider,
        operation,
        issue: "Invalid Pi preset name.",
      }),
    );
  const thinkingValue = values.get("thinkingLevel");
  const modelOverride = values.get("modelOverride");
  if (values.has("modelOverride") && typeof modelOverride !== "boolean")
    return Effect.fail(
      new ProviderAdapterValidationError({
        provider,
        operation,
        issue: "Pi modelOverride must be a boolean.",
      }),
    );
  const thinkingLevel = values.has("thinkingLevel")
    ? (thinkingLevels.find((value) => value === thinkingValue) ?? null)
    : null;
  if (values.has("thinkingLevel") && !thinkingLevel)
    return Effect.fail(
      new ProviderAdapterValidationError({
        provider,
        operation,
        issue: `Invalid Pi thinking level: ${String(thinkingValue)}.`,
      }),
    );
  if (!values.has("preset"))
    return Effect.succeed({
      preset: undefined,
      thinkingLevel,
      modelOverride: modelOverride === true,
    });
  const preset = presetValue as string;
  if (preset === "none")
    return Effect.succeed({ preset, thinkingLevel, modelOverride: modelOverride === true });
  // Pi dispatches slash commands by their first whitespace-delimited argument.
  // Keep the name a single safe token, then require it to exist in the effective config.
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(preset))
    return Effect.fail(
      new ProviderAdapterValidationError({
        provider,
        operation,
        issue: "Invalid Pi preset name.",
      }),
    );
  const readPresets = (path: string) =>
    fs.readFile(path).pipe(
      Effect.map((source) => {
        let config: unknown;
        try {
          config = JSON.parse(new TextDecoder().decode(source));
        } catch {
          config = undefined;
        }
        return config;
      }),
      Effect.orElseSucceed(() => ({})),
    );
  return Effect.all([
    readPresets(NodePath.join(getAgentDir(), "presets.json")),
    readPresets(NodePath.join(cwd, CONFIG_DIR_NAME, "presets.json")),
  ]).pipe(
    Effect.map(([globalConfig, projectConfig]) =>
      piPresetNamesFromJson({
        ...(typeof globalConfig === "object" &&
        globalConfig !== null &&
        !Array.isArray(globalConfig)
          ? globalConfig
          : {}),
        ...(typeof projectConfig === "object" &&
        projectConfig !== null &&
        !Array.isArray(projectConfig)
          ? projectConfig
          : {}),
      }),
    ),
    Effect.flatMap((names) =>
      names.includes(preset)
        ? Effect.succeed({ preset, thinkingLevel, modelOverride: modelOverride === true })
        : Effect.fail(
            new ProviderAdapterValidationError({
              provider,
              operation,
              issue: `Pi preset '${preset}' is unavailable in the effective presets.json.`,
            }),
          ),
    ),
  );
}

function snapshotFromMessages(
  threadId: ThreadId,
  sessionId: string,
  messages: ReadonlyArray<{ role: string }>,
): ProviderThreadSnapshot {
  const turns: Array<{ id: TurnId; items: Array<unknown> }> = [];
  for (const message of messages) {
    if (message.role === "user") {
      turns.push({ id: TurnId.make(`pi:${sessionId}:${turns.length}`), items: [message] });
    } else if (turns.length > 0) {
      turns[turns.length - 1]!.items.push(message);
    }
  }
  return { threadId, turns };
}

type Turn = {
  readonly id: TurnId;
  readonly settled: Deferred.Deferred<void, ProviderAdapterRequestError>;
  interrupted: boolean;
  failure: string | undefined;
  assistantItem: RuntimeItemId | undefined;
  segment: number;
  readonly usage: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    reasoning: number;
    costUsd: number;
    messages: number;
  };
};

type AssistantUsage = {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly reasoning?: number;
  readonly cost?: { readonly total?: number };
};

const count = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.round(value) : 0;

/** pi-subagents lifecycle payloads on `pi.events` (subagents:started/completed/failed). */
type SubagentEvent = {
  readonly id?: unknown;
  readonly type?: unknown;
  readonly description?: unknown;
  readonly result?: unknown;
  readonly error?: unknown;
  readonly toolUses?: unknown;
  readonly durationMs?: unknown;
  readonly usage?: {
    readonly input?: unknown;
    readonly output?: unknown;
    readonly cacheRead?: unknown;
    readonly cacheWrite?: unknown;
    readonly totalTokens?: unknown;
    readonly cost?: { readonly total?: unknown };
  };
};

const text = (value: unknown) =>
  typeof value === "string" && value.trim() ? value.trim() : undefined;

function subagentUsage(event: SubagentEvent) {
  const usage = event.usage;
  if (!usage) return undefined;
  const cacheRead = count(usage.cacheRead);
  const cost = usage.cost?.total;
  return {
    totalTokens: count(usage.totalTokens),
    inputTokens: count(usage.input) + cacheRead + count(usage.cacheWrite),
    cachedInputTokens: cacheRead,
    outputTokens: count(usage.output),
    ...(typeof event.toolUses === "number" ? { toolUses: count(event.toolUses) } : {}),
    ...(typeof event.durationMs === "number" ? { durationMs: count(event.durationMs) } : {}),
    ...(typeof cost === "number" && Number.isFinite(cost) && cost >= 0 ? { costUsd: cost } : {}),
  };
}
type Session = {
  session: ProviderSession;
  readonly sessionId: string;
  readonly cwd: string;
  readonly sdk: AgentSession;
  unsubscribe: () => void;
  readonly scope: Scope.Closeable;
  active: Turn | undefined;
  /** Covers preflight and the SDK's asynchronous agent_settled dispatch. */
  pendingPrompt: boolean;
  /** Background subagents settle after their spawning turn. */
  lastTurnId: TurnId | undefined;
  appliedPreset: string | undefined;
  appliedPresetModelOverride: boolean;
  /** A child keeps its originating turn even if a later turn becomes active. */
  readonly subagents: Map<string, TurnId | undefined>;
  stopped: boolean;
};

/** One SDK session per T3 thread, with persistence owned by T3. */
export const makePiAdapter = (
  options: {
    readonly instanceId?: ProviderInstanceId;
  } = {},
) =>
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    const fs = yield* FileSystem.FileSystem;
    const instanceId = options.instanceId ?? ProviderInstanceId.make("pi");
    const sessionDirectory = NodePath.join(config.stateDir, "pi-sessions");
    const sessions = new Map<ThreadId, Session>();
    const bus = yield* PubSub.unbounded<ProviderRuntimeEvent>();
    const nowIso = () => DateTime.formatIso(DateTime.makeUnsafe(Date.now()));
    const stamp = () => ({ eventId: EventId.make(NodeCrypto.randomUUID()), createdAt: nowIso() });
    const emit = (event: ProviderRuntimeEvent) => PubSub.publish(bus, event).pipe(Effect.asVoid);
    const base = (ctx: Session, turnId?: TurnId) => ({
      ...stamp(),
      provider,
      providerInstanceId: instanceId,
      threadId: ctx.session.threadId,
      ...(turnId ? { turnId } : {}),
    });
    const request = <A>(method: string, run: () => Promise<A>) =>
      Effect.tryPromise({
        try: run,
        catch: (cause) =>
          new ProviderAdapterRequestError({ provider, method, detail: String(cause), cause }),
      });
    const setModel = (
      ctx: Session,
      model: string,
      thinkingLevel: (typeof thinkingLevels)[number] | null,
    ) =>
      Effect.gen(function* () {
        const parts = modelParts(model);
        if (!parts)
          return yield* new ProviderAdapterValidationError({
            provider,
            operation: "set_model",
            issue: "Pi model must be provider/modelId.",
          });
        const selected = ctx.sdk.modelRuntime.getModel(parts.provider, parts.modelId);
        if (!selected)
          return yield* new ProviderAdapterRequestError({
            provider,
            method: "set_model",
            detail: `Pi model ${model} was not found.`,
          });
        if (thinkingLevel && !modelSupportsThinkingLevel(selected, thinkingLevel))
          return yield* new ProviderAdapterValidationError({
            provider,
            operation: "sendTurn",
            issue: `Pi thinking level ${thinkingLevel} is not supported by this model.`,
          });
        yield* request("set_model", () => ctx.sdk.setModel(selected));
        ctx.session = { ...ctx.session, model };
      });
    const applyPreset = (ctx: Session, name: string | undefined, modelOverride: boolean) =>
      Effect.gen(function* () {
        // The selection was checked against the effective config; without the extension
        // command it cannot be applied, so reject rather than proceed with stale state.
        if (
          name === undefined ||
          (ctx.appliedPreset === name &&
            (name === "none" || ctx.appliedPresetModelOverride === modelOverride))
        )
          return;
        const command = ctx.sdk.extensionRunner.getCommand("preset");
        if (!command)
          return yield* new ProviderAdapterRequestError({
            provider,
            method: "preset",
            detail: "The Pi preset command is unavailable in this session.",
          });
        yield* request("preset", async () => {
          // The SDK catches extension command handler rejections and resolves prompt().
          // Listen only for this command during its dispatch, not unrelated extension errors.
          let commandError: string | undefined;
          const off = ctx.sdk.extensionRunner.onError((error) => {
            if (error.event === "command" && error.extensionPath === "command:preset")
              commandError = error.error;
          });
          try {
            await ctx.sdk.prompt(`/preset ${name}`);
          } finally {
            off();
          }
          if (commandError !== undefined)
            throw new Error(`Pi preset command failed: ${commandError}`);
        });
        ctx.appliedPreset = name;
        ctx.appliedPresetModelOverride = modelOverride;
      });
    const requireSession = (threadId: ThreadId) => {
      const ctx = sessions.get(threadId);
      return ctx && !ctx.stopped
        ? Effect.succeed(ctx)
        : Effect.fail(new ProviderAdapterSessionNotFoundError({ provider, threadId }));
    };
    const stop = (ctx: Session) =>
      Effect.gen(function* () {
        if (ctx.stopped) return;
        ctx.stopped = true;
        sessions.delete(ctx.session.threadId);
        if (ctx.active) {
          yield* Deferred.fail(
            ctx.active.settled,
            new ProviderAdapterRequestError({
              provider,
              method: "prompt",
              detail: "Pi session stopped before the turn settled.",
            }),
          ).pipe(Effect.ignore);
          ctx.active = undefined;
        }
        ctx.unsubscribe();
        // Lets extensions (pi-subagents) stop their child sessions before dispose.
        if (ctx.sdk.extensionRunner.hasHandlers("session_shutdown"))
          yield* Effect.promise(() =>
            ctx.sdk.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }),
          ).pipe(Effect.ignore);
        ctx.sdk.dispose();
        yield* Scope.close(ctx.scope, Exit.void);
        yield* emit({ type: "session.exited", ...base(ctx), payload: { exitKind: "graceful" } });
      });

    const closeAssistant = (
      ctx: Session,
      turn: Turn,
      status: "completed" | "failed" = "completed",
    ) =>
      Effect.gen(function* () {
        if (!turn.assistantItem) return;
        yield* emit({
          type: "item.completed",
          ...base(ctx, turn.id),
          itemId: turn.assistantItem,
          payload: { itemType: "assistant_message", status },
        });
        turn.assistantItem = undefined;
      });
    // Main-agent usage only: pi-subagents children report through task events.
    const recordUsage = (ctx: Session, turn: Turn, usage: AssistantUsage | undefined) =>
      Effect.gen(function* () {
        if (!usage) return;
        const totals = turn.usage;
        totals.messages += 1;
        totals.input += count(usage.input);
        totals.output += count(usage.output);
        totals.cacheRead += count(usage.cacheRead);
        totals.cacheWrite += count(usage.cacheWrite);
        totals.reasoning += count(usage.reasoning);
        const cost = usage.cost?.total;
        if (typeof cost === "number" && Number.isFinite(cost) && cost >= 0) totals.costUsd += cost;
        const context = ctx.sdk.getContextUsage();
        const input = count(usage.input) + count(usage.cacheRead) + count(usage.cacheWrite);
        const usedTokens =
          context?.tokens !== null && context?.tokens !== undefined
            ? count(context.tokens)
            : input + count(usage.output);
        if (usedTokens <= 0) return;
        yield* emit({
          type: "thread.token-usage.updated",
          ...base(ctx, turn.id),
          payload: {
            usage: {
              usedTokens,
              lastUsedTokens: usedTokens,
              ...(context && context.contextWindow > 0
                ? { maxTokens: Math.floor(context.contextWindow) }
                : {}),
              inputTokens: input,
              cachedInputTokens: count(usage.cacheRead),
              outputTokens: count(usage.output),
              ...(usage.reasoning !== undefined
                ? { reasoningOutputTokens: count(usage.reasoning) }
                : {}),
              lastInputTokens: input,
              lastCachedInputTokens: count(usage.cacheRead),
              lastOutputTokens: count(usage.output),
              compactsAutomatically: true,
            },
          },
        });
      });
    const turnAccounting = (ctx: Session, turn: Turn) => {
      const totals = turn.usage;
      if (!totals.messages) return {};
      return {
        tokenUsage: {
          usageScope: "main_agent" as const,
          usageStatus: "complete" as const,
          hasSubagents: false,
          inputTokens: totals.input + totals.cacheRead + totals.cacheWrite,
          outputTokens: totals.output,
          cachedInputTokens: totals.cacheRead,
          cacheCreationTokens: totals.cacheWrite,
          reasoningTokens: Math.min(totals.output, totals.reasoning),
        },
        totalCostUsd: totals.costUsd,
        ...(ctx.session.model ? { costModel: ctx.session.model } : {}),
        costSessionId: ctx.sessionId,
      };
    };
    const subagentEvent = (
      ctx: Session,
      kind: "started" | "completed" | "failed",
      data: SubagentEvent,
    ) =>
      Effect.gen(function* () {
        const id = text(data.id);
        if (!id || ctx.stopped) return;
        const turnId =
          kind === "started" || !ctx.subagents.has(id)
            ? (ctx.active?.id ?? ctx.lastTurnId)
            : ctx.subagents.get(id);
        const role = text(data.type);
        const description = text(data.description) ?? role ?? "Pi subagent";
        const linkage = {
          taskType: "subagent",
          agentKind: "agent" as const,
          title: description,
          ...(role ? { role } : {}),
        };
        const taskId = RuntimeTaskId.make(`pi:${id}`);
        if (kind === "started") {
          if (ctx.subagents.has(id)) return;
          ctx.subagents.set(id, turnId);
          yield* emit({
            type: "task.started",
            ...base(ctx, turnId),
            payload: { taskId, description, ...linkage },
          });
          return;
        }
        ctx.subagents.delete(id);
        const typedUsage = subagentUsage(data);
        const summary = kind === "failed" ? text(data.error) : text(data.result);
        yield* emit({
          type: "task.completed",
          ...base(ctx, turnId),
          payload: {
            taskId,
            status: kind,
            ...(summary ? { summary: summary.slice(0, 2_000) } : {}),
            ...(typedUsage ? { typedUsage } : {}),
            ...linkage,
          },
        });
      });
    const turnBegin = (ctx: Session, id: TurnId) =>
      Effect.gen(function* () {
        const turn: Turn = {
          id,
          settled: yield* Deferred.make<void, ProviderAdapterRequestError>(),
          interrupted: false,
          failure: undefined,
          segment: 0,
          assistantItem: undefined,
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            reasoning: 0,
            costUsd: 0,
            messages: 0,
          },
        };
        ctx.active = turn;
        ctx.lastTurnId = turn.id;
        ctx.session = {
          ...ctx.session,
          activeTurnId: turn.id,
          status: "running",
          updatedAt: nowIso(),
        };
        yield* emit({
          type: "turn.started",
          ...base(ctx, turn.id),
          payload: { model: ctx.session.model, effort: ctx.sdk.thinkingLevel },
        });
        return turn;
      });
    const consume = (ctx: Session, event: AgentSessionEvent) =>
      Effect.gen(function* () {
        // Extensions (e.g. background subagent completions) can start a run with
        // sendMessage({ triggerTurn: true }) after the user's turn settled.
        const turn =
          ctx.active ??
          (event.type === "agent_start"
            ? yield* turnBegin(
                ctx,
                TurnId.make(`pi:${ctx.sessionId}:ext:${NodeCrypto.randomUUID()}`),
              )
            : undefined);
        if (!turn) return;
        // An interrupt can arrive while Pi is still running prompt preflight.
        if (event.type === "agent_start" && turn.interrupted) {
          ctx.sdk.clearQueue();
          yield* request("abort", () => ctx.sdk.abort());
          return;
        }
        if (event.type === "message_end") {
          const message = event.message;
          if (message.role === "assistant") {
            turn.failure =
              message.stopReason === "error"
                ? String(message.errorMessage ?? "Pi model failed")
                : undefined;
            if (message.stopReason === "aborted") turn.interrupted = true;
            yield* recordUsage(ctx, turn, message.usage);
            yield* closeAssistant(
              ctx,
              turn,
              message.stopReason === "error" || message.stopReason === "aborted"
                ? "failed"
                : "completed",
            );
          }
          return;
        }
        if (event.type === "message_update") {
          const update = event.assistantMessageEvent;
          if (update.type !== "text_delta" && update.type !== "thinking_delta") return;
          const reasoning = update.type === "thinking_delta";
          if (!reasoning && !turn.assistantItem) {
            turn.assistantItem = RuntimeItemId.make(`pi:${turn.id}:assistant:${turn.segment++}`);
            yield* emit({
              type: "item.started",
              ...base(ctx, turn.id),
              itemId: turn.assistantItem,
              payload: { itemType: "assistant_message", status: "inProgress" },
            });
          }
          yield* emit({
            type: "content.delta",
            ...base(ctx, turn.id),
            ...(reasoning ? {} : { itemId: turn.assistantItem }),
            payload: {
              streamKind: reasoning ? "reasoning_text" : "assistant_text",
              delta: update.delta,
              contentIndex: update.contentIndex,
            },
          });
          return;
        }
        if (
          event.type === "tool_execution_start" ||
          event.type === "tool_execution_update" ||
          event.type === "tool_execution_end"
        ) {
          if (!event.toolCallId.trim()) return;
          yield* closeAssistant(ctx, turn);
          const toolName = event.toolName;
          const itemType =
            toolName === "bash"
              ? "command_execution"
              : toolName === "edit" || toolName === "write"
                ? "file_change"
                : toolName === "Agent" || toolName === "SubagentWorkflow"
                  ? "collab_agent_tool_call"
                  : "dynamic_tool_call";
          const completed = event.type === "tool_execution_end";
          yield* emit({
            type:
              event.type === "tool_execution_start"
                ? "item.started"
                : completed
                  ? "item.completed"
                  : "item.updated",
            ...base(ctx, turn.id),
            itemId: RuntimeItemId.make(event.toolCallId),
            payload: {
              itemType,
              status: completed
                ? event.type === "tool_execution_end" && event.isError
                  ? "failed"
                  : "completed"
                : "inProgress",
              title: toolName,
              data: completed
                ? event.type === "tool_execution_end"
                  ? event.result
                  : undefined
                : event.type === "tool_execution_update"
                  ? event.partialResult
                  : event.type === "tool_execution_start"
                    ? event.args
                    : undefined,
            },
          });
          return;
        }
        if (event.type !== "agent_settled") return;
        yield* closeAssistant(ctx, turn);
        ctx.active = undefined;
        ctx.session = {
          ...ctx.session,
          status: "ready",
          activeTurnId: undefined,
          updatedAt: nowIso(),
        };
        yield* emit({
          type: "turn.completed",
          ...base(ctx, turn.id),
          payload: {
            state: turn.interrupted ? "cancelled" : turn.failure ? "failed" : "completed",
            stopReason: turn.interrupted ? "cancelled" : turn.failure ? "error" : null,
            ...(turn.failure ? { errorMessage: turn.failure } : {}),
            ...turnAccounting(ctx, turn),
          },
        });
        yield* Deferred.succeed(turn.settled, undefined).pipe(Effect.ignore);
      });

    const failPrompt = (ctx: Session, turn: Turn, detail: string) =>
      Effect.gen(function* () {
        if (ctx.active !== turn) return;
        if (!turn.interrupted) turn.failure = detail;
        yield* closeAssistant(ctx, turn, "failed");
        ctx.active = undefined;
        ctx.session = {
          ...ctx.session,
          status: "ready",
          activeTurnId: undefined,
          updatedAt: nowIso(),
        };
        yield* emit({
          type: "turn.completed",
          ...base(ctx, turn.id),
          payload: {
            ...(turn.interrupted
              ? { state: "cancelled" as const, stopReason: "cancelled" }
              : { state: "failed" as const, stopReason: "error", errorMessage: detail }),
            ...turnAccounting(ctx, turn),
          },
        });
        if (turn.interrupted) {
          yield* Deferred.succeed(turn.settled, undefined).pipe(Effect.ignore);
        } else {
          yield* Deferred.fail(
            turn.settled,
            new ProviderAdapterRequestError({ provider, method: "prompt", detail }),
          ).pipe(Effect.ignore);
        }
      });

    const startSession: ProviderAdapterShape<
      | ProviderAdapterRequestError
      | ProviderAdapterProcessError
      | ProviderAdapterSessionNotFoundError
      | ProviderAdapterValidationError
    >["startSession"] = (input) =>
      Effect.gen(function* () {
        if (input.provider !== undefined && input.provider !== provider) {
          return yield* new ProviderAdapterValidationError({
            provider,
            operation: "startSession",
            issue: "Provider must be pi.",
          });
        }
        if (!input.cwd?.trim()) {
          return yield* new ProviderAdapterValidationError({
            provider,
            operation: "startSession",
            issue: "cwd is required.",
          });
        }
        if (input.resumeCursor !== undefined && !sessionIdFromCursor(input.resumeCursor)) {
          return yield* new ProviderAdapterValidationError({
            provider,
            operation: "startSession",
            issue: "Invalid Pi resume cursor.",
          });
        }
        const { preset, thinkingLevel, modelOverride } = yield* selectedOptions(
          input.modelSelection,
          instanceId,
          "startSession",
          fs,
          NodePath.resolve(input.cwd.trim()),
        );
        const resumedId = sessionIdFromCursor(input.resumeCursor);
        const sessionId = resumedId ?? NodeCrypto.randomUUID();
        const cwd = NodePath.resolve(input.cwd.trim());
        const ownedDirectory = NodePath.join(
          sessionDirectory,
          encodeURIComponent(instanceId),
          encodeURIComponent(input.threadId),
        );
        const files = resumedId
          ? yield* fs.readDirectory(ownedDirectory).pipe(Effect.orElseSucceed(() => [] as string[]))
          : [];
        const filename = files.find((name) => name.endsWith(`_${sessionId}.jsonl`));
        const sessionFile = filename ? NodePath.join(ownedDirectory, filename) : undefined;
        if (resumedId && !sessionFile)
          return yield* new ProviderAdapterSessionNotFoundError({
            provider,
            threadId: input.threadId,
          });
        const { modelRuntime, model } = yield* Effect.tryPromise({
          try: async () => {
            const modelRuntime = await ModelRuntime.create();
            // A model can be a client-supplied default, not a deliberate choice.
            // Let session_start own the SDK model unless T3 explicitly overrides it.
            const selection =
              input.modelSelection?.instanceId === instanceId && modelOverride
                ? input.modelSelection.model
                : undefined;
            const parts = selection ? modelParts(selection) : undefined;
            if (selection && !parts) throw new Error("Pi model must be provider/modelId.");
            const model = parts ? modelRuntime.getModel(parts.provider, parts.modelId) : undefined;
            if (parts && !model) throw new Error(`Pi model ${selection} was not found.`);
            return { modelRuntime, model };
          },
          catch: (cause) =>
            new ProviderAdapterProcessError({
              provider,
              threadId: input.threadId,
              detail: String(cause),
              cause,
            }),
        });
        if (thinkingLevel && model && !modelSupportsThinkingLevel(model, thinkingLevel))
          return yield* new ProviderAdapterValidationError({
            provider,
            operation: "startSession",
            issue: `Pi thinking level ${thinkingLevel} is not supported by this model.`,
          });
        if (!resumedId)
          yield* fs.makeDirectory(ownedDirectory, { recursive: true }).pipe(
            Effect.mapError(
              (cause) =>
                new ProviderAdapterProcessError({
                  provider,
                  threadId: input.threadId,
                  detail: cause.message,
                  cause,
                }),
            ),
          );
        // Extensions publish on this bus; pi-subagents reports child lifecycle here.
        const eventBus = createEventBus();
        const opened = yield* Effect.tryPromise({
          try: async () => {
            const manager = sessionFile
              ? SessionManager.open(sessionFile, ownedDirectory, cwd)
              : SessionManager.create(cwd, ownedDirectory, { id: sessionId });
            if (manager.getSessionId() !== sessionId)
              throw new Error("Pi returned a different session id.");
            const agentDir = getAgentDir();
            const settingsManager = SettingsManager.create(cwd, agentDir);
            const loader = new DefaultResourceLoader({
              cwd,
              agentDir,
              settingsManager,
              eventBus,
            });
            await loader.reload();
            const result = await createAgentSession({
              cwd,
              sessionManager: manager,
              settingsManager,
              resourceLoader: loader,
              modelRuntime,
              ...(model ? { model } : {}),
            });
            // Headless binding, as in Pi's print mode: extensions see hasUI === false.
            // This emits session_start, so extension tools (e.g. pi-subagents) register.
            await result.session.bindExtensions({
              mode: "rpc",
              onError: (error) =>
                Effect.runFork(
                  Effect.logWarning("Pi extension error", {
                    extension: error.extensionPath,
                    error: String(error.error),
                  }),
                ),
            });
            // A session_start extension (e.g. a preset) may switch models; T3's selection wins.
            const current = result.session.model;
            if (model && (current?.provider !== model.provider || current.id !== model.id))
              await result.session.setModel(model);
            return result.session;
          },
          catch: (cause) =>
            new ProviderAdapterProcessError({
              provider,
              threadId: input.threadId,
              detail: String(cause),
              cause,
            }),
        });
        const previous = sessions.get(input.threadId);
        if (previous) yield* stop(previous);
        const scope = yield* Scope.make("sequential");
        const cursor = { schemaVersion: resumeVersion, sessionId };
        const now = nowIso();
        const ctx: Session = {
          sessionId,
          cwd,
          sdk: opened,
          unsubscribe: () => {},
          scope,
          stopped: false,
          active: undefined,
          pendingPrompt: false,
          lastTurnId: undefined,
          appliedPreset: undefined,
          appliedPresetModelOverride: false,
          subagents: new Map(),
          session: {
            provider,
            providerInstanceId: instanceId,
            threadId: input.threadId,
            cwd,
            status: "ready",
            runtimeMode: input.runtimeMode,
            createdAt: now,
            updatedAt: now,
            resumeCursor: cursor,
          },
        };
        ctx.session = {
          ...ctx.session,
          model: opened.model ? `${opened.model.provider}/${opened.model.id}` : undefined,
        };
        // Extension command dispatch is an SDK preflight, not a T3 turn. Apply it only
        // after extension binding and before exposing the session to real prompts.
        const presetResult = yield* applyPreset(ctx, preset, modelOverride).pipe(Effect.exit);
        if (Exit.isFailure(presetResult)) {
          opened.dispose();
          return yield* Effect.failCause(presetResult.cause);
        }
        ctx.session = {
          ...ctx.session,
          model: opened.model ? `${opened.model.provider}/${opened.model.id}` : undefined,
        };
        if (model) {
          const current = opened.model;
          if (current?.provider !== model.provider || current.id !== model.id)
            yield* request("set_model", () => opened.setModel(model));
          ctx.session = { ...ctx.session, model: `${model.provider}/${model.id}` };
        }
        if (
          thinkingLevel &&
          opened.model &&
          !modelSupportsThinkingLevel(opened.model, thinkingLevel)
        ) {
          opened.dispose();
          return yield* new ProviderAdapterValidationError({
            provider,
            operation: "startSession",
            issue: `Pi thinking level ${thinkingLevel} is not supported by this model.`,
          });
        }
        const initialThinkingLevel =
          thinkingLevel ??
          (preset === "none" || model !== undefined ? defaultThinkingLevel(opened.model) : null);
        if (initialThinkingLevel) opened.setThinkingLevel(initialThinkingLevel);
        type Queued =
          | { readonly source: "sdk"; readonly event: AgentSessionEvent }
          | {
              readonly source: "subagent";
              readonly kind: "started" | "completed" | "failed";
              readonly data: SubagentEvent;
            };
        const events = yield* Queue.unbounded<Queued>();
        const unsubscribeSdk = opened.subscribe((event) => {
          Effect.runSync(Queue.offer(events, { source: "sdk", event }));
        });
        const unsubscribeBus = (["started", "completed", "failed"] as const).map((kind) =>
          eventBus.on(`subagents:${kind}`, (data) => {
            if (data !== null && typeof data === "object")
              Effect.runSync(
                Queue.offer(events, { source: "subagent", kind, data: data as SubagentEvent }),
              );
          }),
        );
        ctx.unsubscribe = () => {
          unsubscribeSdk();
          for (const off of unsubscribeBus) off();
        };
        sessions.set(input.threadId, ctx);
        yield* Stream.fromQueue(events).pipe(
          Stream.runForEach((item) =>
            ctx.stopped
              ? Effect.void
              : item.source === "sdk"
                ? consume(ctx, item.event)
                : subagentEvent(ctx, item.kind, item.data),
          ),
          Effect.forkIn(scope),
        );
        yield* emit({ type: "session.started", ...base(ctx), payload: { resume: cursor } });
        yield* emit({ type: "session.state.changed", ...base(ctx), payload: { state: "ready" } });
        yield* emit({
          type: "thread.started",
          ...base(ctx),
          payload: { providerThreadId: sessionId },
        });
        return ctx.session;
      });

    const sendTurn: ProviderAdapterShape<
      | ProviderAdapterRequestError
      | ProviderAdapterProcessError
      | ProviderAdapterSessionNotFoundError
      | ProviderAdapterValidationError
    >["sendTurn"] = (input) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(input.threadId);
        const message = input.input?.trim() ?? "";
        if (!message && !input.attachments?.length) {
          return yield* new ProviderAdapterValidationError({
            provider,
            operation: "sendTurn",
            issue: "Pi requires a prompt or image.",
          });
        }
        const unsupportedAttachment = input.attachments?.find(
          (attachment) => attachment.type !== "image",
        );
        if (unsupportedAttachment) {
          return yield* new ProviderAdapterValidationError({
            provider,
            operation: "sendTurn",
            issue: `Pi does not support '${unsupportedAttachment.type}' attachments.`,
          });
        }
        const { preset, thinkingLevel, modelOverride } = yield* selectedOptions(
          input.modelSelection,
          instanceId,
          "sendTurn",
          fs,
          ctx.cwd,
        );
        const selection =
          input.modelSelection?.instanceId === instanceId && modelOverride
            ? input.modelSelection.model
            : undefined;
        const images: Array<{ type: "image"; data: string; mimeType: string }> = [];
        for (const attachment of input.attachments ?? []) {
          const path = resolveAttachmentPath({ attachmentsDir: config.attachmentsDir, attachment });
          if (!path)
            return yield* new ProviderAdapterValidationError({
              provider,
              operation: "sendTurn",
              issue: "Invalid image attachment.",
            });
          const bytes = yield* fs.readFile(path).pipe(
            Effect.mapError(
              (cause) =>
                new ProviderAdapterRequestError({
                  provider,
                  method: "prompt",
                  detail: cause.message,
                  cause,
                }),
            ),
          );
          images.push({
            type: "image",
            data: Buffer.from(bytes).toString("base64"),
            mimeType: attachment.mimeType,
          });
        }
        const steering = ctx.active;
        // Pi's prompt() only interprets streamingBehavior after asynchronous preflight.
        // Never let a second prompt start while the first has not entered an agent run.
        if (steering && !ctx.sdk.isStreaming)
          return yield* new ProviderAdapterRequestError({
            provider,
            method: "steer",
            detail: "Pi is still preparing the active turn; send again once it starts.",
          });
        // An extension-triggered run whose agent_start has not been consumed yet.
        if (!steering && (ctx.pendingPrompt || ctx.sdk.isStreaming))
          return yield* new ProviderAdapterRequestError({
            provider,
            method: "prompt",
            detail:
              "Pi is finishing a prompt or starting a follow-up run; send again once it settles.",
          });
        // agent_settled clears active before Pi finishes emitting the event. prompt()
        // would otherwise defer both /preset and the next user prompt, reporting success
        // before either has run. Reserve the SDK prompt slot across all async preflight.
        if (!steering) ctx.pendingPrompt = true;
        return yield* Effect.gen(function* () {
          // Do not mutate Pi's active preset/model until all send preflight and turn-eligibility
          // checks pass. In particular, rejected attachments or a busy turn must be side-effect free.
          yield* applyPreset(ctx, preset, modelOverride);
          ctx.session = {
            ...ctx.session,
            model: ctx.sdk.model ? `${ctx.sdk.model.provider}/${ctx.sdk.model.id}` : undefined,
          };
          // Presets can change the SDK model/thinking level. An explicit T3 choice always wins.
          if (selection && selection !== ctx.session.model)
            yield* setModel(ctx, selection, thinkingLevel);
          else if (selection) {
            const current = ctx.sdk.model;
            const parts = modelParts(selection);
            if (parts && (current?.provider !== parts.provider || current.id !== parts.modelId))
              yield* setModel(ctx, selection, thinkingLevel);
          }
          if (thinkingLevel && !ctx.sdk.getAvailableThinkingLevels().includes(thinkingLevel))
            return yield* new ProviderAdapterValidationError({
              provider,
              operation: "sendTurn",
              issue: `Pi thinking level ${thinkingLevel} is not supported by this model.`,
            });
          const promptThinkingLevel =
            thinkingLevel ??
            (preset === "none" || selection !== undefined
              ? defaultThinkingLevel(ctx.sdk.model)
              : null);
          if (promptThinkingLevel) ctx.sdk.setThinkingLevel(promptThinkingLevel);
          const count = ctx.sdk.sessionManager
            .getEntries()
            .filter((entry) => entry.type === "message" && entry.message.role === "user").length;
          const turn =
            steering ?? (yield* turnBegin(ctx, TurnId.make(`pi:${ctx.sessionId}:${count}`)));
          let accepted = false;
          const prompt = steering
            ? ctx.sdk.steer(message, images.length ? images : undefined)
            : ctx.sdk.prompt(message, {
                ...(images.length ? { images } : {}),
                preflightResult: (success) => {
                  accepted = success;
                },
              });
          const response = yield* Effect.tryPromise({
            try: () => prompt,
            catch: (cause) =>
              new ProviderAdapterRequestError({
                provider,
                method: "prompt",
                detail: String(cause),
                cause,
              }),
          }).pipe(Effect.exit);
          if (Exit.isFailure(response)) {
            if (!steering) yield* failPrompt(ctx, turn, String(response.cause));
            if (!steering && turn.interrupted) {
              return {
                threadId: input.threadId,
                turnId: turn.id,
                resumeCursor: ctx.session.resumeCursor,
              };
            }
            return yield* Effect.failCause(response.cause);
          }
          if (!steering && !accepted) {
            yield* failPrompt(ctx, turn, "Pi did not accept the prompt.");
            return yield* new ProviderAdapterRequestError({
              provider,
              method: "prompt",
              detail: "Pi did not accept the prompt.",
            });
          }
          if (steering)
            return {
              threadId: input.threadId,
              turnId: turn.id,
              resumeCursor: ctx.session.resumeCursor,
            };
          if (turn.interrupted && !ctx.stopped && ctx.active === turn) {
            ctx.sdk.clearQueue();
            yield* request("abort", () => ctx.sdk.abort());
          }
          yield* Deferred.await(turn.settled);
          return {
            threadId: input.threadId,
            turnId: turn.id,
            resumeCursor: ctx.session.resumeCursor,
          };
        }).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              if (!steering) ctx.pendingPrompt = false;
            }),
          ),
        );
      });

    const interruptTurn: ProviderAdapterShape<
      ProviderAdapterRequestError | ProviderAdapterSessionNotFoundError
    >["interruptTurn"] = (threadId, turnId) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        if (!ctx.active || (turnId && ctx.active.id !== turnId)) return;
        const turn = ctx.active;
        turn.interrupted = true;
        ctx.sdk.clearQueue();
        if (ctx.active === turn) {
          yield* request("abort", () => ctx.sdk.abort());
        }
      });
    const readThread: ProviderAdapterShape<
      ProviderAdapterRequestError | ProviderAdapterSessionNotFoundError
    >["readThread"] = (threadId) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        // The active branch preserves Pi's append-only history without duplicating message_end.
        return snapshotFromMessages(
          threadId,
          ctx.sessionId,
          ctx.sdk.sessionManager
            .getBranch()
            .filter((entry) => entry.type === "message")
            .map((entry) => entry.message),
        );
      });
    const unsupported = (method: string) =>
      Effect.fail(
        new ProviderAdapterRequestError({
          provider,
          method,
          detail: "Pi does not support this T3 operation.",
        }),
      );
    const adapter = {
      provider,
      capabilities: {
        sessionModelSwitch: "in-session",
        supportsConversationRollback: false,
      } as const,
      startSession,
      sendTurn,
      interruptTurn,
      respondToRequest: (_threadId: ThreadId, _requestId: string, _decision: string) =>
        unsupported("respondToRequest"),
      respondToUserInput: (_threadId: ThreadId, _requestId: string, _answers: unknown) =>
        unsupported("respondToUserInput"),
      stopSession: (threadId: ThreadId) => Effect.flatMap(requireSession(threadId), stop),
      listSessions: () =>
        Effect.sync(() => [...sessions.values()].map((ctx) => ({ ...ctx.session }))),
      hasSession: (threadId: ThreadId) => Effect.sync(() => sessions.has(threadId)),
      readThread,
      rollbackThread: (threadId: ThreadId, numTurns: number) =>
        Effect.gen(function* () {
          yield* requireSession(threadId);
          if (!Number.isInteger(numTurns) || numTurns < 1)
            return yield* new ProviderAdapterValidationError({
              provider,
              operation: "rollbackThread",
              issue: "numTurns must be an integer >= 1.",
            });
          return yield* unsupported("thread/rollback");
        }),
      stopAll: () => Effect.forEach([...sessions.values()], stop, { discard: true }),
      streamEvents: Stream.fromPubSub(bus),
    } satisfies ProviderAdapterShape<
      | ProviderAdapterRequestError
      | ProviderAdapterProcessError
      | ProviderAdapterSessionNotFoundError
      | ProviderAdapterValidationError
    >;
    yield* Effect.addFinalizer(() =>
      adapter.stopAll().pipe(Effect.tap(() => PubSub.shutdown(bus))),
    );
    return adapter;
  });
