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
  parseSessionEntries,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type AgentSessionEvent,
  type ExtensionCommandContextActions,
  type SessionEntry,
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
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import { piPresetNamesFromJson, piPromptTemplatesToSlashCommands } from "./PiProvider.ts";
import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
} from "../Errors.ts";
import type { ProviderAdapterShape, ProviderThreadSnapshot } from "../Services/ProviderAdapter.ts";
import { piSummaryUsageObserve } from "../piSummaryUsageObserve.ts";
import type { PiAdapterFactoryOptions } from "../PiAdapterFactoryOptions.ts";
import { piSkillsToServerProviderSkills } from "../piSkillsToServerProviderSkills.ts";

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

const turnEntryType = "t3.turn";
const turnEntrySchema = Schema.Struct({ schemaVersion: Schema.Literal(1), turnId: TurnId });
const turnEntryDecode = Schema.decodeUnknownOption(turnEntrySchema);
const jsonEncode = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

function turnIdentityAppend(manager: SessionManager, sessionId: string): TurnId {
  const turnId = TurnId.make(`pi:${sessionId}:turn:${NodeCrypto.randomUUID()}`);
  manager.appendCustomEntry(turnEntryType, { schemaVersion: 1, turnId });
  return turnId;
}

function snapshotFromEntries(
  threadId: ThreadId,
  sessionId: string,
  entries: ReadonlyArray<SessionEntry>,
): ProviderThreadSnapshot {
  const turns: Array<{ id: TurnId; items: Array<unknown> }> = [];
  let associated = false;
  for (const entry of entries) {
    if (entry.type === "custom" && entry.customType === turnEntryType) {
      const association = turnEntryDecode(entry.data);
      if (association._tag === "Some") {
        associated = true;
        turns.push({ id: association.value.turnId, items: [] });
      }
      continue;
    }
    if (entry.type !== "message" && entry.type !== "custom_message") continue;
    const message =
      entry.type === "message"
        ? entry.message
        : {
            role: "custom",
            customType: entry.customType,
            content: entry.content,
            display: entry.display,
            details: entry.details,
            timestamp: Date.parse(entry.timestamp),
          };
    // Keep unmarked legacy history's IDs unchanged. A marked attempt owns all
    // its SDK messages, including steering and extension-only input.
    if (!associated && message.role === "user") {
      turns.push({ id: TurnId.make(`pi:${sessionId}:${turns.length}`), items: [message] });
      continue;
    }
    turns.at(-1)?.items.push(message);
  }
  return { threadId, turns };
}

type Turn = {
  readonly id: TurnId;
  readonly settled: Deferred.Deferred<void, ProviderAdapterRequestError>;
  interrupted: boolean;
  ran: boolean;
  failure: string | undefined;
  readonly assistantItems: Map<
    string,
    { readonly id: RuntimeItemId; readonly itemType: "assistant_message" | "reasoning" }
  >;
  segment: number;
  readonly usage: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    reasoning: number;
    reasoningAvailable: boolean;
    hasSubagents: boolean;
    costUsd: number;
    messages: number;
    priced: number;
    unresolved: number;
    readonly models: Set<string>;
    unknownModel: boolean;
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

/** Public pi-subagents bus payloads; the extension exports no lifecycle schema. */
type SubagentEvent = {
  readonly id?: unknown;
  readonly type?: unknown;
  readonly description?: unknown;
  readonly result?: unknown;
  readonly error?: unknown;
  readonly status?: unknown;
  readonly isBackground?: unknown;
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

type SubagentActivation = {
  readonly turnId: TurnId | undefined;
  readonly resumed: boolean;
  state: "pending" | "running" | "terminal";
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
  readonly completeIdlePrompt: (turn: Turn) => Effect.Effect<void>;
  readonly drainEvents: () => Effect.Effect<void>;
  readonly scope: Scope.Closeable;
  active: Turn | undefined;
  /** SDK callback-time association, independent of the queued runtime consumer. */
  historyTurnId: TurnId | undefined;
  /** Covers preflight and the SDK's asynchronous agent_settled dispatch. */
  pendingPrompt: boolean;
  /** One steering preflight at a time; no successor prompt may overtake it. */
  pendingSteer: boolean;
  dispatchSettled: Deferred.Deferred<void> | undefined;
  steeringSettled: Deferred.Deferred<void> | undefined;
  stopping: Deferred.Deferred<void, ProviderAdapterRequestError> | undefined;
  /** Background subagents settle after their spawning turn. */
  lastTurnId: TurnId | undefined;
  appliedPreset: string | undefined;
  appliedPresetModelOverride: boolean;
  /** Callback-time activation ownership; retain settled IDs to reject duplicate starts. */
  readonly subagents: Map<string, SubagentActivation>;
  stopped: boolean;
};

const unsupportedCommandAction = (action: string) => async (): Promise<never> => {
  throw new Error(`Pi extension command context action ${action} is unsupported by this adapter.`);
};

/** One SDK session per T3 thread, with persistence owned by T3. */
export const makePiAdapter = (options: PiAdapterFactoryOptions = {}) =>
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
      return ctx && !ctx.stopped && !ctx.stopping
        ? Effect.succeed(ctx)
        : Effect.fail(new ProviderAdapterSessionNotFoundError({ provider, threadId }));
    };
    // 0.87.1's emitSessionShutdownEvent is not a package export. Use its public
    // runner API so extension-owned resources are released before disposal.
    const shutdownSdk = (sdk: AgentSession) =>
      request("session_shutdown", async () => {
        if (sdk.extensionRunner.hasHandlers("session_shutdown"))
          await sdk.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
      }).pipe(Effect.ignore);
    const stop = (ctx: Session) =>
      Effect.gen(function* () {
        if (ctx.stopped) return;
        if (ctx.stopping) return yield* Deferred.await(ctx.stopping);
        const stopped = yield* Deferred.make<void, ProviderAdapterRequestError>();
        ctx.stopping = stopped;
        const result = yield* Effect.gen(function* () {
          if (ctx.active) ctx.active.interrupted = true;
          ctx.sdk.clearQueue();
          // dispose() disconnects SDK persistence synchronously; abort() waits
          // through tool results, persistence and asynchronous agent_settled.
          yield* request("abort", () => ctx.sdk.abort());
          // SDK-idle input handlers are uncancellable and can outlive disposal.
          // Do not await their dispatch; preflightResult fences stopping/stopped
          // sessions before the SDK can admit inference when they eventually resolve.
          yield* ctx.drainEvents();
          // A stopped idle preflight/handled prompt has no native settlement.
          if (ctx.active) yield* failPrompt(ctx, ctx.active, "Pi session stopped.");
          // Lets extensions (pi-subagents) stop their child sessions before dispose.
          yield* shutdownSdk(ctx.sdk);
          ctx.unsubscribe();
          ctx.sdk.dispose();
          ctx.stopped = true;
          sessions.delete(ctx.session.threadId);
          yield* Scope.close(ctx.scope, Exit.void);
          yield* emit({ type: "session.exited", ...base(ctx), payload: { exitKind: "graceful" } });
        }).pipe(Effect.exit);
        if (Exit.isFailure(result)) ctx.stopping = undefined;
        yield* Deferred.done(stopped, result);
        return yield* result;
      }).pipe(Effect.uninterruptible);

    const assistantItemStart = (
      ctx: Session,
      turn: Turn,
      contentIndex: number,
      itemType: "assistant_message" | "reasoning",
    ) =>
      Effect.gen(function* () {
        // SDK content indexes identify blocks, not ordinal text/reasoning counts.
        // Keep the kind in the key: an extension may replace a block's kind.
        const key = `${contentIndex}:${itemType}`;
        const existing = turn.assistantItems.get(key);
        if (existing) return existing.id;
        const id = RuntimeItemId.make(`pi:${turn.id}:${itemType}:${turn.segment++}`);
        turn.assistantItems.set(key, { id, itemType });
        yield* emit({
          type: "item.started",
          ...base(ctx, turn.id),
          itemId: id,
          payload: { itemType, status: "inProgress" },
        });
        return id;
      });
    const closeAssistant = (
      ctx: Session,
      turn: Turn,
      status: "completed" | "failed" = "completed",
      finalTexts?: ReadonlyMap<string, string>,
    ) =>
      Effect.gen(function* () {
        for (const [key, item] of turn.assistantItems) {
          yield* emit({
            type: "item.completed",
            ...base(ctx, turn.id),
            itemId: item.id,
            payload: {
              itemType: item.itemType,
              status,
              // Absent finalTexts means an early tool/settlement/failure closure,
              // not an authoritative empty response. Removed final blocks clear
              // their whole identified item, including already split display rows.
              ...(finalTexts ? { finalText: finalTexts.get(key) ?? "" } : {}),
            },
          });
        }
        turn.assistantItems.clear();
      });
    // Authoritative main-session requests only, never child tool results or session totals.
    const usageAccumulate = (turn: Turn, usage: AssistantUsage, model: string | undefined) => {
      const totals = turn.usage;
      totals.messages += 1;
      totals.input += count(usage.input);
      totals.output += count(usage.output);
      totals.cacheRead += count(usage.cacheRead);
      totals.cacheWrite += count(usage.cacheWrite);
      totals.reasoning += count(usage.reasoning);
      totals.reasoningAvailable &&= usage.reasoning !== undefined;
      const cost = usage.cost?.total;
      if (typeof cost === "number" && Number.isFinite(cost) && cost >= 0) {
        totals.costUsd += cost;
        totals.priced += 1;
      }
      if (model) totals.models.add(model);
      else totals.unknownModel = true;
    };
    const contextRecord = (
      ctx: Session,
      turnId: TurnId | undefined,
      model: string | undefined,
      context: ReturnType<AgentSession["getContextUsage"]>,
      usage?: AssistantUsage,
    ) =>
      Effect.gen(function* () {
        const parts = model ? modelParts(model) : undefined;
        // The SDK estimates occupancy, but its limit belongs to the selected model.
        // A response alias/override must never inherit another model's limit.
        const selected = ctx.sdk.model;
        const matchesSelection =
          parts && selected?.provider === parts.provider && selected.id === parts.modelId;
        const effectiveModel = matchesSelection
          ? selected
          : parts
            ? ctx.sdk.modelRuntime.getModel(parts.provider, parts.modelId)
            : undefined;
        const maxTokens = matchesSelection
          ? (context?.contextWindow ?? effectiveModel?.contextWindow)
          : effectiveModel?.contextWindow;
        const compactsAutomatically = ctx.sdk.autoCompactionEnabled;
        const reserve =
          compactsAutomatically && effectiveModel
            ? ctx.sdk.settingsManager.getCompactionSettings(effectiveModel).reserveTokens
            : undefined;
        const threshold =
          maxTokens !== undefined && reserve !== undefined ? maxTokens - reserve : undefined;
        const usedTokens =
          context?.tokens !== null && context?.tokens !== undefined
            ? count(context.tokens)
            : undefined;
        const input = usage
          ? count(usage.input) + count(usage.cacheRead) + count(usage.cacheWrite)
          : undefined;
        yield* emit({
          type: "thread.token-usage.updated",
          ...base(ctx, turnId),
          payload: {
            usage: {
              contextUsageStatus: usedTokens === undefined ? "unknown" : "estimated",
              ...(usedTokens !== undefined ? { usedTokens, lastUsedTokens: usedTokens } : {}),
              ...(maxTokens !== undefined && maxTokens > 0
                ? { maxTokens: Math.floor(maxTokens) }
                : {}),
              ...(usage
                ? {
                    inputTokens: input,
                    cachedInputTokens: count(usage.cacheRead),
                    outputTokens: count(usage.output),
                    lastInputTokens: input,
                    lastCachedInputTokens: count(usage.cacheRead),
                    lastOutputTokens: count(usage.output),
                  }
                : {}),
              ...(usage?.reasoning !== undefined
                ? { reasoningOutputTokens: count(usage.reasoning) }
                : {}),
              compactsAutomatically,
              ...(threshold !== undefined && threshold > 0
                ? { autoCompactThreshold: Math.floor(threshold) }
                : {}),
            },
          },
        });
      });
    const accountingModel = (turn: Turn) =>
      !turn.usage.unknownModel && turn.usage.models.size === 1
        ? [...turn.usage.models][0]
        : undefined;
    const turnAccounting = (ctx: Session, turn: Turn) => {
      const totals = turn.usage;
      if (!totals.messages && !totals.unresolved && !totals.hasSubagents) return {};
      const costModel = accountingModel(turn);
      return {
        tokenUsage: {
          usageScope: "main_agent" as const,
          usageStatus: totals.unresolved
            ? ("partial" as const)
            : totals.messages
              ? ("complete" as const)
              : ("unavailable" as const),
          hasSubagents: totals.hasSubagents,
          reasoningTokensAvailable:
            totals.messages > 0 && !totals.unresolved && totals.reasoningAvailable,
          ...(totals.messages
            ? {
                inputTokens: totals.input + totals.cacheRead + totals.cacheWrite,
                outputTokens: totals.output,
                cachedInputTokens: totals.cacheRead,
                cacheCreationTokens: totals.cacheWrite,
                ...(!totals.unresolved && totals.reasoningAvailable
                  ? { reasoningTokens: Math.min(totals.output, totals.reasoning) }
                  : {}),
              }
            : {}),
        },
        ...(totals.priced === totals.messages && !totals.unresolved && totals.priced > 0
          ? { totalCostUsd: totals.costUsd }
          : {}),
        ...(costModel ? { costModel } : {}),
        costSessionId: ctx.sessionId,
      };
    };
    const subagentEvent = (
      ctx: Session,
      kind: "created" | "started" | "completed" | "failed",
      data: SubagentEvent,
      activation: SubagentActivation,
    ) =>
      Effect.gen(function* () {
        const id = text(data.id);
        if (!id || ctx.stopped) return;
        // An explicitly absent callback-time origin must stay absent, even
        // when earlier queued SDK events have since opened a runtime turn.
        const turnId = activation.turnId;
        const owningTurn = ctx.active;
        if ((kind === "created" || kind === "started") && owningTurn && owningTurn.id === turnId)
          owningTurn.usage.hasSubagents = true;
        const role = text(data.type);
        const description = text(data.description) ?? role ?? "Pi subagent";
        const linkage = {
          taskType: "subagent",
          agentKind: "agent" as const,
          title: description,
          ...(role ? { role } : {}),
        };
        const taskId = RuntimeTaskId.make(`pi:${id}`);
        if (kind === "created") {
          // A repeated creation only arms the resume. Running is explicit at
          // started; do not clear the prior terminal result while still queued.
          if (activation.resumed) return;
          yield* emit({
            type: "task.updated",
            ...base(ctx, turnId),
            payload: {
              taskId,
              status: "pending",
              description,
              ...(typeof data.isBackground === "boolean"
                ? { isBackgrounded: data.isBackground }
                : {}),
              ...linkage,
            },
          });
          return;
        }
        if (kind === "started") {
          if (activation.resumed)
            yield* emit({
              type: "task.updated",
              ...base(ctx, turnId),
              payload: { taskId, status: "running", description, ...linkage },
            });
          yield* emit({
            type: "task.started",
            ...base(ctx, turnId),
            payload: { taskId, description, ...linkage },
          });
          return;
        }
        // The channel alone cannot distinguish provider errors from interruption.
        // Reject unknown/nonterminal statuses rather than fabricating completion.
        let status: "completed" | "failed" | "stopped";
        switch (data.status) {
          case undefined:
            status = kind;
            break;
          case "completed":
          case "steered":
            status = "completed";
            break;
          case "error":
            status = "failed";
            break;
          case "stopped":
          case "aborted":
            status = "stopped";
            break;
          case "queued":
          case "running":
          default:
            return;
        }
        const typedUsage = subagentUsage(data);
        const summary = text(data.result);
        const error = text(data.error);
        yield* emit({
          type: "task.completed",
          ...base(ctx, turnId),
          payload: {
            taskId,
            status,
            ...(summary ? { summary: summary.slice(0, 2_000) } : {}),
            ...(error ? { error: error.slice(0, 2_000) } : {}),
            ...(typedUsage ? { typedUsage } : {}),
            ...linkage,
          },
        });
      });
    const turnBegin = (ctx: Session, associatedId?: TurnId) =>
      Effect.gen(function* () {
        const id = associatedId ?? turnIdentityAppend(ctx.sdk.sessionManager, ctx.sessionId);
        if (!associatedId) ctx.historyTurnId = id;
        const turn: Turn = {
          id,
          settled: yield* Deferred.make<void, ProviderAdapterRequestError>(),
          interrupted: false,
          ran: false,
          failure: undefined,
          segment: 0,
          assistantItems: new Map(),
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            reasoning: 0,
            reasoningAvailable: true,
            hasSubagents: false,
            costUsd: 0,
            messages: 0,
            priced: 0,
            unresolved: 0,
            models: new Set(),
            unknownModel: false,
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
    const consume = (ctx: Session, event: AgentSessionEvent, associatedId?: TurnId) =>
      Effect.gen(function* () {
        // Extensions (e.g. background subagent completions) can start a run with
        // sendMessage({ triggerTurn: true }) after the user's turn settled.
        const turn =
          ctx.active ??
          (event.type === "agent_start" || event.type === "compaction_start"
            ? yield* turnBegin(ctx, associatedId)
            : undefined);
        if (!turn) return;
        if (event.type === "agent_start") turn.ran = true;
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
            const responseModel = message.responseModel ?? message.model;
            const identity =
              message.provider && responseModel
                ? `${message.provider}/${responseModel}`
                : undefined;
            usageAccumulate(turn, message.usage, identity);
            yield* contextRecord(ctx, turn.id, identity, ctx.sdk.getContextUsage(), message.usage);
            const finalTexts = new Map<string, string>();
            for (const [index, block] of message.content.entries()) {
              if (block.type !== "text" && block.type !== "thinking") continue;
              const itemType = block.type === "text" ? "assistant_message" : "reasoning";
              finalTexts.set(
                `${index}:${itemType}`,
                block.type === "text" ? block.text : block.thinking,
              );
              yield* assistantItemStart(ctx, turn, index, itemType);
            }
            yield* closeAssistant(
              ctx,
              turn,
              message.stopReason === "error" || message.stopReason === "aborted"
                ? "failed"
                : "completed",
              finalTexts,
            );
          }
          return;
        }
        if (event.type === "message_update") {
          const update = event.assistantMessageEvent;
          if (update.type !== "text_delta" && update.type !== "thinking_delta") return;
          const reasoning = update.type === "thinking_delta";
          const itemId = yield* assistantItemStart(
            ctx,
            turn,
            update.contentIndex,
            reasoning ? "reasoning" : "assistant_message",
          );
          yield* emit({
            type: "content.delta",
            ...base(ctx, turn.id),
            itemId,
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
        yield* turnComplete(ctx, turn);
      });
    const turnCostIncompleteEmit = (ctx: Session, turn: Turn) => {
      const totals = turn.usage;
      if (!totals.priced || (totals.priced === totals.messages && !totals.unresolved))
        return Effect.void;
      const costModel = accountingModel(turn);
      return emit({
        type: "turn.cost.updated",
        ...base(ctx, turn.id),
        turnId: turn.id,
        payload: {
          totalCostUsd: totals.costUsd,
          status: "provisional",
          costSessionId: ctx.sessionId,
          ...(costModel ? { costModel } : {}),
        },
      });
    };
    const turnComplete = (ctx: Session, turn: Turn) =>
      Effect.gen(function* () {
        yield* closeAssistant(ctx, turn);
        if (ctx.historyTurnId === turn.id) ctx.historyTurnId = undefined;
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
        yield* turnCostIncompleteEmit(ctx, turn);
        yield* Deferred.succeed(turn.settled, undefined).pipe(Effect.ignore);
      });

    const failPrompt = (ctx: Session, turn: Turn, detail: string) =>
      Effect.gen(function* () {
        if (ctx.active !== turn) return;
        if (!turn.interrupted) turn.failure = detail;
        yield* closeAssistant(ctx, turn, "failed");
        if (ctx.historyTurnId === turn.id) ctx.historyTurnId = undefined;
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
        yield* turnCostIncompleteEmit(ctx, turn);
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
        if (sessionFile) {
          // Validate without opening a manager whose in-memory branch would be
          // stale while the outgoing SDK still owns this file.
          const source = yield* fs.readFileString(sessionFile).pipe(
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
          const header = parseSessionEntries(source)[0];
          if (header?.type !== "session" || header.id !== sessionId)
            return yield* new ProviderAdapterProcessError({
              provider,
              threadId: input.threadId,
              detail: "Invalid Pi session header.",
            });
        }
        // Extensions publish on this bus; pi-subagents reports child lifecycle here.
        const eventBus = createEventBus();
        const agentDir = getAgentDir();
        const settingsManager = SettingsManager.create(cwd, agentDir);
        const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager, eventBus });
        yield* Effect.tryPromise({
          try: () => loader.reload(),
          catch: (cause) =>
            new ProviderAdapterProcessError({
              provider,
              threadId: input.threadId,
              detail: String(cause),
              cause,
            }),
        });
        const previous = sessions.get(input.threadId);
        // A same-file manager must only open after outgoing persistence settles.
        // Independent replacements can finish validation/binding before retiring
        // the usable session, and a failed start must not destroy that session.
        if (previous && sessionFile === previous.sdk.sessionManager.getSessionFile())
          yield* stop(previous);
        let transferred = false;
        let consuming = false;
        let scope: Scope.Closeable | undefined;
        let startupContext: Session | undefined;
        const observers: Array<() => void> = [];
        const unsubscribe = () => {
          for (const off of observers.splice(0)) off();
        };
        const opened = yield* Effect.acquireRelease(
          Effect.tryPromise({
            try: async () => {
              const manager = sessionFile
                ? SessionManager.open(sessionFile, ownedDirectory, cwd)
                : SessionManager.create(cwd, ownedDirectory, { id: sessionId });
              if (manager.getSessionId() !== sessionId)
                throw new Error("Pi returned a different session id.");
              if (!sessionFile) {
                // Pi defers creating a fresh file until an assistant is persisted.
                // Open its actual header first so state-only and rejected attempts
                // are durable too, without private flush APIs or fabricated messages.
                const path = manager.getSessionFile()!;
                await Effect.runPromise(
                  fs.writeFileString(path, `${jsonEncode(manager.getHeader())}\n`, {
                    flag: "wx",
                  }),
                );
                manager.setSessionFile(path);
              }
              const result = await createAgentSession({
                cwd,
                sessionManager: manager,
                settingsManager,
                resourceLoader: loader,
                modelRuntime,
                ...(model ? { model } : {}),
              });
              return result.session;
            },
            catch: (cause) =>
              new ProviderAdapterProcessError({
                provider,
                threadId: input.threadId,
                detail: String(cause),
                cause,
              }),
          }),
          (sdk) =>
            transferred
              ? Effect.void
              : Effect.gen(function* () {
                  if (startupContext) startupContext.stopped = true;
                  yield* request("abort", async () => {
                    sdk.clearQueue();
                    await sdk.abort();
                  }).pipe(Effect.ignore);
                  if (consuming && startupContext) yield* startupContext.drainEvents();
                  yield* shutdownSdk(sdk);
                }).pipe(
                  Effect.ensuring(
                    Effect.sync(() => {
                      if (startupContext) startupContext.unsubscribe();
                      unsubscribe();
                      sdk.dispose();
                    }).pipe(
                      Effect.ensuring(
                        Effect.suspend(() => (scope ? Scope.close(scope, Exit.void) : Effect.void)),
                      ),
                    ),
                  ),
                ),
        );
        scope = yield* Scope.make("sequential");
        const cursor = { schemaVersion: resumeVersion, sessionId };
        const now = nowIso();
        type Queued =
          | {
              readonly source: "sdk";
              readonly event: AgentSessionEvent;
              readonly turnId: TurnId | undefined;
            }
          | { readonly source: "idle-prompt"; readonly turn: Turn }
          | {
              readonly source: "context";
              readonly turnId: TurnId | undefined;
              readonly model: string | undefined;
              readonly context: ReturnType<AgentSession["getContextUsage"]>;
            }
          | {
              readonly source: "summary";
              readonly observation: Parameters<Parameters<typeof piSummaryUsageObserve>[1]>[0];
              readonly turnId: TurnId | undefined;
            }
          | {
              readonly source: "summary-end";
              readonly turnId: TurnId;
              readonly standalone: boolean;
              readonly unresolved: boolean;
              readonly aborted: boolean;
              readonly errorMessage: string | undefined;
            }
          | { readonly source: "drain"; readonly done: Deferred.Deferred<void> }
          | {
              readonly source: "subagent";
              readonly kind: "created" | "started" | "completed" | "failed";
              readonly data: SubagentEvent;
              readonly activation: SubagentActivation;
            };
        const events = yield* Queue.unbounded<Queued>();
        yield* Scope.addFinalizer(scope, Queue.shutdown(events));
        const ctx: Session = {
          sessionId,
          cwd,
          sdk: opened,
          unsubscribe: () => {},
          completeIdlePrompt: (turn) =>
            Queue.offer(events, { source: "idle-prompt", turn }).pipe(Effect.asVoid),
          drainEvents: () =>
            Effect.gen(function* () {
              const done = yield* Deferred.make<void>();
              yield* Queue.offer(events, { source: "drain", done });
              yield* Deferred.await(done);
            }),
          scope,
          stopped: false,
          active: undefined,
          historyTurnId: undefined,
          pendingPrompt: false,
          pendingSteer: false,
          dispatchSettled: undefined,
          steeringSettled: undefined,
          stopping: undefined,
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
        startupContext = ctx;
        ctx.session = {
          ...ctx.session,
          model: opened.model ? `${opened.model.provider}/${opened.model.id}` : undefined,
        };
        // Bind hooks and preset commands can run inference before they return.
        // Buffer once in the normal queue; no runtime work may precede the initial lifecycle.
        let subscribed = true;
        let startupAgentStarted = false;
        let summaryOwner:
          | {
              readonly turnId: TurnId;
              readonly standalone: boolean;
              observed: boolean;
            }
          | undefined;
        // Subscribe before binding and before the ordinary SDK listener: usage must
        // reach the queue before compaction_end can close a standalone activation.
        const summaries = piSummaryUsageObserve(opened, (observation) => {
          if (!subscribed || ctx.stopped) return;
          if (summaryOwner) summaryOwner.observed = true;
          Effect.runSync(
            Queue.offer(events, {
              source: "summary",
              observation,
              turnId: summaryOwner?.turnId,
            }),
          );
        });
        observers.push(summaries.unsubscribe);
        // The public bus has no activation ID. Agent's actual resume argument
        // supplies a one-shot admission boundary, including foreground resumes
        // (started only) and background resumes (created can follow started).
        const pendingResumes = new Map<
          string,
          { readonly toolCallId: string; readonly turnId: TurnId | undefined }
        >();
        observers.push(
          opened.subscribe((event) => {
            if (!subscribed) return;
            if (event.type === "compaction_start") {
              if (ctx.stopped || ctx.stopping) return;
              const standalone = ctx.historyTurnId === undefined;
              const turnId =
                ctx.historyTurnId ?? turnIdentityAppend(opened.sessionManager, sessionId);
              ctx.historyTurnId = turnId;
              summaryOwner = { turnId, standalone, observed: false };
            }
            if (event.type === "compaction_end") {
              const owner = summaryOwner;
              summaryOwner = undefined;
              Effect.runSync(
                Queue.offer(events, {
                  source: "context",
                  turnId: owner?.turnId,
                  model: opened.model ? `${opened.model.provider}/${opened.model.id}` : undefined,
                  context: opened.getContextUsage(),
                }),
              );
              if (owner) {
                if (owner.standalone && ctx.historyTurnId === owner.turnId)
                  ctx.historyTurnId = undefined;
                Effect.runSync(
                  Queue.offer(events, {
                    source: "summary-end",
                    turnId: owner.turnId,
                    standalone: owner.standalone,
                    unresolved: !owner.observed,
                    aborted: event.aborted,
                    errorMessage: event.errorMessage,
                  }),
                );
              }
              return;
            }
            // Public message_end listeners run before SDK persistence. Reserve an
            // extension activation at agent_start, not later in the queue consumer,
            // or its messages may precede their durable turn marker.
            if (event.type === "agent_start") {
              startupAgentStarted = true;
              if (!ctx.historyTurnId)
                ctx.historyTurnId = turnIdentityAppend(opened.sessionManager, sessionId);
            }
            const turnId = ctx.historyTurnId;
            if (event.type === "tool_execution_start" && event.toolName === "Agent") {
              const args = event.args;
              const id =
                args && typeof args === "object" ? text(Reflect.get(args, "resume")) : undefined;
              if (id && !pendingResumes.has(id))
                pendingResumes.set(id, { toolCallId: event.toolCallId, turnId });
            }
            if (event.type === "tool_execution_end")
              for (const [id, pending] of pendingResumes)
                if (pending.toolCallId === event.toolCallId) pendingResumes.delete(id);
            if (event.type === "agent_settled") ctx.historyTurnId = undefined;
            Effect.runSync(Queue.offer(events, { source: "sdk", event, turnId }));
          }),
        );
        for (const kind of ["created", "started", "completed", "failed"] as const)
          observers.push(
            eventBus.on(`subagents:${kind}`, (data) => {
              if (!subscribed || data === null || typeof data !== "object") return;
              const payload = data as SubagentEvent;
              const id = text(payload.id);
              if (!id) return;
              let activation = ctx.subagents.get(id);
              const pending = pendingResumes.get(id);
              if (kind === "created" || kind === "started") {
                if (activation?.state === "terminal") {
                  // Neither a duplicate started nor a late created is evidence
                  // of a new run. Require the real tool's pending resume first.
                  if (!pending) return;
                  activation = undefined;
                } else if (activation && (kind === "created" || activation.state === "running")) {
                  return;
                }
                if (!activation) {
                  activation = {
                    turnId: pending
                      ? pending.turnId
                      : (ctx.historyTurnId ?? ctx.active?.id ?? ctx.lastTurnId),
                    // A resumed SDK session may have task history retained by
                    // T3 even when this adapter instance has not observed it.
                    resumed: pending !== undefined || ctx.subagents.has(id),
                    state: "pending",
                  };
                  ctx.subagents.set(id, activation);
                  pendingResumes.delete(id);
                }
                if (kind === "started") activation.state = "running";
              } else {
                switch (payload.status) {
                  case undefined:
                  case "completed":
                  case "steered":
                  case "error":
                  case "stopped":
                  case "aborted":
                    break;
                  default:
                    return;
                }
                if (activation?.state === "terminal") return;
                if (!activation) {
                  activation = {
                    turnId: ctx.historyTurnId ?? ctx.active?.id ?? ctx.lastTurnId,
                    resumed: false,
                    state: "pending",
                  };
                  ctx.subagents.set(id, activation);
                }
                // Corrected manager callbacks fence prior generations at the
                // source. Here, duplicate terminals cannot release/relabel an
                // ID, and each queued event retains its original activation.
                activation.state = "terminal";
              }
              Effect.runSync(
                Queue.offer(events, { source: "subagent", kind, data: payload, activation }),
              );
            }),
          );
        ctx.unsubscribe = () => {
          subscribed = false;
          unsubscribe();
        };
        observers.push(
          opened.extensionRunner.onError((error) =>
            Effect.runFork(
              Effect.logWarning("Pi extension error", {
                extension: error.extensionPath,
                error: String(error.error),
              }),
            ),
          ),
        );
        yield* Effect.gen(function* () {
          // Headless binding awaits session_start and then resources_discover.
          yield* Effect.tryPromise({
            try: () =>
              opened.bindExtensions({
                mode: "rpc",
                commandContextActions: {
                  waitForIdle: () => {
                    // Registered commands run before Pi starts the prompt's agent
                    // turn. Waiting from an active run would wait on the command's
                    // own dispatch, so only expose the SDK idle primitive there.
                    if (!opened.isIdle)
                      return Promise.reject(
                        new Error(
                          "Pi command ctx.waitForIdle() is only supported while the agent is idle.",
                        ),
                      );
                    return opened.waitForIdle();
                  },
                  newSession: unsupportedCommandAction("newSession"),
                  fork: unsupportedCommandAction("fork"),
                  navigateTree: unsupportedCommandAction("navigateTree"),
                  switchSession: unsupportedCommandAction("switchSession"),
                  reload: unsupportedCommandAction("reload"),
                } satisfies ExtensionCommandContextActions,
              }),
            catch: (cause) =>
              new ProviderAdapterProcessError({
                provider,
                threadId: input.threadId,
                detail: String(cause),
                cause,
              }),
          });
          // A session_start extension may switch models; T3's explicit selection wins.
          if (model) {
            const current = opened.model;
            if (current?.provider !== model.provider || current.id !== model.id)
              yield* request("set_model", () => opened.setModel(model));
          }
          // Extension command dispatch is an SDK preflight, not a T3 turn. Apply it only
          // after extension binding and before exposing the session to real prompts.
          yield* applyPreset(ctx, preset, modelOverride);
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
            return yield* new ProviderAdapterValidationError({
              provider,
              operation: "startSession",
              issue: `Pi thinking level ${thinkingLevel} is not supported by this model.`,
            });
          }
          const initialThinkingLevel =
            thinkingLevel ??
            (preset === "none" || model !== undefined ? defaultThinkingLevel(opened.model) : null);
          if (initialThinkingLevel)
            yield* request("set_thinking_level", async () =>
              opened.setThinkingLevel(initialThinkingLevel),
            );
        });
        if (previous && !previous.stopped) yield* stop(previous);
        yield* emit({ type: "session.started", ...base(ctx), payload: { resume: cursor } });
        yield* emit({
          type: "session.state.changed",
          ...base(ctx),
          payload: { state: startupAgentStarted || !opened.isIdle ? "running" : "ready" },
        });
        yield* emit({
          type: "thread.started",
          ...base(ctx),
          payload: { providerThreadId: sessionId },
        });
        yield* Stream.fromQueue(events).pipe(
          Stream.runForEach((item) =>
            item.source === "drain"
              ? Deferred.succeed(item.done, undefined).pipe(Effect.asVoid)
              : ctx.stopped
                ? Effect.void
                : item.source === "sdk"
                  ? consume(ctx, item.event, item.turnId)
                  : item.source === "context"
                    ? contextRecord(ctx, item.turnId, item.model, item.context)
                    : item.source === "summary"
                      ? Effect.sync(() => {
                          if (!ctx.active || ctx.active.id !== item.turnId) return;
                          const identity = item.observation.modelIdentity;
                          usageAccumulate(
                            ctx.active,
                            item.observation.usage,
                            identity ? `${identity.provider}/${identity.model}` : undefined,
                          );
                        })
                      : item.source === "summary-end"
                        ? Effect.gen(function* () {
                            const turn = ctx.active;
                            if (!turn || turn.id !== item.turnId) return;
                            if (item.unresolved) turn.usage.unresolved += 1;
                            if (item.standalone) {
                              turn.interrupted = item.aborted;
                              turn.failure = item.errorMessage;
                              yield* turnComplete(ctx, turn);
                            }
                          })
                        : item.source === "idle-prompt"
                          ? ctx.active === item.turn &&
                            !item.turn.ran &&
                            ctx.sdk.isIdle &&
                            ctx.sdk.pendingMessageCount === 0
                            ? consume(ctx, { type: "agent_settled" })
                            : Effect.void
                          : subagentEvent(ctx, item.kind, item.data, item.activation),
          ),
          Effect.forkIn(scope),
        );
        consuming = true;
        yield* ctx.drainEvents();
        // Admission must see the drained startup activation, never the provisional idle context.
        sessions.set(input.threadId, ctx);
        transferred = true;
        if (options.publishInitializedResources) {
          // Read the bound runner, not an unbound discovery runner: startup and
          // preset handlers can register commands and install resources.
          const commands = opened.extensionRunner.getRegisteredCommands().map((command) => {
            const description = command.description?.trim();
            return {
              name: command.invocationName,
              ...(description ? { description } : {}),
            };
          });
          const names = new Set(commands.map((command) => command.name));
          yield* options.publishInitializedResources({
            cwd: ctx.cwd,
            checkedAt: nowIso(),
            slashCommands: [
              ...commands,
              ...piPromptTemplatesToSlashCommands(
                opened.resourceLoader.getPrompts().prompts,
              ).filter((command) => !names.has(command.name)),
            ],
            skills: piSkillsToServerProviderSkills(opened.resourceLoader.getSkills().skills),
          });
        }
        return ctx.session;
      }).pipe(Effect.scoped);

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
        if (ctx.stopping || ctx.stopped)
          return yield* new ProviderAdapterRequestError({
            provider,
            method: "prompt",
            detail: "Pi session is stopping.",
          });
        if (ctx.pendingSteer)
          return yield* new ProviderAdapterRequestError({
            provider,
            method: steering ? "steer" : "prompt",
            detail: "Pi is processing steering input; send again once it finishes.",
          });
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
        else ctx.pendingSteer = true;
        const dispatchSettled = yield* Deferred.make<void>();
        if (!steering) ctx.dispatchSettled = dispatchSettled;
        else ctx.steeringSettled = dispatchSettled;
        return yield* Effect.gen(function* () {
          // Do not mutate Pi's active preset/model until all send preflight and turn-eligibility
          // checks pass. In particular, rejected attachments or a busy turn must be side-effect free.
          yield* applyPreset(ctx, preset, modelOverride);
          if (ctx.stopping || ctx.stopped)
            return yield* new ProviderAdapterRequestError({
              provider,
              method: "prompt",
              detail: "Pi session is stopping.",
            });
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
          if (ctx.stopping || ctx.stopped)
            return yield* new ProviderAdapterRequestError({
              provider,
              method: "prompt",
              detail: "Pi session is stopping.",
            });
          const turn = steering ?? (yield* turnBegin(ctx));
          // T3 skill chips use $name; Pi owns body/base-directory expansion for both paths.
          // Native Pi expands only one leading skill command, not additional chips in args.
          const skillName = /^\$([^\s]+)/.exec(message)?.[1];
          const promptMessage =
            skillName &&
            ctx.sdk.resourceLoader.getSkills().skills.some((skill) => skill.name === skillName)
              ? `/skill:${skillName}${message.slice(skillName.length + 1)}`
              : message;
          const commandName = /^\/([^\s]+)/.exec(promptMessage)?.[1];
          const nativeCommand = commandName
            ? ctx.sdk.extensionRunner.getCommand(commandName)
            : undefined;
          if (steering && nativeCommand)
            return yield* new ProviderAdapterRequestError({
              provider,
              method: "steer",
              detail: `Pi extension command /${commandName} cannot be queued.`,
            });
          let commandError: string | undefined;
          const offCommandError = nativeCommand
            ? ctx.sdk.extensionRunner.onError((error) => {
                if (error.event === "command" && error.extensionPath === `command:${commandName}`)
                  commandError = error.error;
              })
            : () => {};
          let accepted = false;
          let deliveryTurnId = turn.id;
          const response = yield* Effect.tryPromise({
            try: async () => {
              try {
                if (ctx.stopping || ctx.stopped) throw new Error("Pi session is stopping.");
                if (
                  steering &&
                  (ctx.stopped ||
                    turn.interrupted ||
                    ctx.active !== turn ||
                    ctx.historyTurnId !== turn.id ||
                    !ctx.sdk.isStreaming)
                )
                  throw new Error(
                    "Pi's active turn ended before steering dispatch; send again once it settles.",
                  );
                // prompt() rechecks activity after asynchronous input handlers.
                // A successful streaming enqueue can also outlive its original run:
                // it yields before preflightResult, so reconcile delivery below.
                await ctx.sdk.prompt(promptMessage, {
                  ...(images.length ? { images } : {}),
                  ...(steering ? { streamingBehavior: "steer" as const } : {}),
                  preflightResult: (success) => {
                    accepted = success;
                    if (!success) return;
                    if (ctx.stopping || ctx.stopped || (steering && turn.interrupted)) {
                      // Intentional interruption discards pending input. This is not
                      // failed-steering cleanup: no request owns the global queues.
                      if (steering) ctx.sdk.clearQueue();
                      throw new Error(
                        "Pi session stopped or was interrupted while processing input.",
                      );
                    }
                    if (steering) {
                      // The idle branch calls this before agent.prompt(), while the
                      // queue branch calls it after enqueue. Reserve the successor's
                      // durable identity in either case, before any new persistence.
                      ctx.historyTurnId ??= turnIdentityAppend(
                        ctx.sdk.sessionManager,
                        ctx.sessionId,
                      );
                      deliveryTurnId = ctx.historyTurnId;
                    }
                  },
                });
              } finally {
                offCommandError();
              }
            },
            catch: (cause) =>
              new ProviderAdapterRequestError({
                provider,
                method: steering ? "steer" : "prompt",
                detail: String(cause),
                cause,
              }),
          }).pipe(Effect.exit);
          if (!steering) {
            yield* Deferred.succeed(dispatchSettled, undefined);
            if (ctx.dispatchSettled === dispatchSettled) ctx.dispatchSettled = undefined;
          }
          if (Exit.isFailure(response)) {
            // Failed preflight owns no queue entries. In particular, extension
            // follow-ups must survive an unrelated steering rejection.
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
          if (commandError !== undefined) {
            const detail = `Pi /${commandName} failed: ${commandError}`;
            yield* failPrompt(ctx, turn, detail);
            return yield* new ProviderAdapterRequestError({ provider, method: "prompt", detail });
          }
          if (!accepted) {
            if (!steering) yield* failPrompt(ctx, turn, "Pi did not accept the prompt.");
            return yield* new ProviderAdapterRequestError({
              provider,
              method: steering ? "steer" : "prompt",
              detail: "Pi did not accept the prompt.",
            });
          }
          if (steering) {
            yield* ctx.drainEvents();
            if (ctx.sdk.isIdle && ctx.sdk.pendingMessageCount > 0) {
              // AgentSession has no public continue(). agent.continue() skips its
              // session lifecycle, including agent_settled. A hidden custom input
              // uses the public session lifecycle to consume all preserved queues
              // without replaying the user's processed input or adding a user message.
              if (ctx.dispatchSettled) yield* Deferred.await(ctx.dispatchSettled);
              yield* ctx.drainEvents();
              if (turn.interrupted || ctx.stopping || ctx.stopped) {
                ctx.sdk.clearQueue();
                return yield* new ProviderAdapterRequestError({
                  provider,
                  method: "steer",
                  detail: "Pi was interrupted before queued input could continue.",
                });
              }
              if (ctx.sdk.isIdle && ctx.sdk.pendingMessageCount > 0) {
                ctx.historyTurnId ??= turnIdentityAppend(ctx.sdk.sessionManager, ctx.sessionId);
                deliveryTurnId = ctx.historyTurnId;
                yield* request("steer", () =>
                  ctx.sdk.sendCustomMessage(
                    { customType: "t3.queued-input", content: "", display: false },
                    { triggerTurn: true },
                  ),
                );
                yield* ctx.drainEvents();
                deliveryTurnId = ctx.lastTurnId ?? deliveryTurnId;
              }
            } else if (deliveryTurnId !== turn.id && ctx.lastTurnId !== deliveryTurnId) {
              // An input handler may handle the input after the original activation
              // settled without starting inference. Acknowledge a distinct no-run attempt.
              const handled = yield* turnBegin(ctx, deliveryTurnId);
              yield* ctx.completeIdlePrompt(handled);
              yield* Deferred.await(handled.settled);
              deliveryTurnId = handled.id;
            }
            return {
              threadId: input.threadId,
              turnId: deliveryTurnId,
              resumeCursor: ctx.session.resumeCursor,
            };
          }
          if (turn.interrupted && !ctx.stopped && ctx.active === turn) {
            ctx.sdk.clearQueue();
            yield* request("abort", () => ctx.sdk.abort());
          }
          // Commands and handled ordinary inputs may have no agent run. Queue an
          // idle/no-pending check behind their SDK events; inference or pending
          // extension work still completes only through native agent_settled.
          yield* ctx.completeIdlePrompt(turn);
          yield* Deferred.await(turn.settled);
          return {
            threadId: input.threadId,
            turnId: turn.id,
            resumeCursor: ctx.session.resumeCursor,
          };
        }).pipe(
          Effect.ensuring(
            Effect.gen(function* () {
              if (!steering) {
                ctx.pendingPrompt = false;
                ctx.dispatchSettled = undefined;
              } else {
                ctx.pendingSteer = false;
                ctx.steeringSettled = undefined;
              }
              yield* Deferred.succeed(dispatchSettled, undefined);
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
        return snapshotFromEntries(threadId, ctx.sessionId, ctx.sdk.sessionManager.getBranch());
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
      adapter.stopAll().pipe(Effect.orDie, Effect.ensuring(PubSub.shutdown(bus))),
    );
    return adapter;
  });
