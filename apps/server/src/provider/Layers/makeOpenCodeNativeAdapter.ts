// @effect-diagnostics nodeBuiltinImport:off globalDate:off - native client runs in Node.
import * as NodeCrypto from "node:crypto";
import * as NodeURL from "node:url";

import {
  EventId,
  RuntimeRequestId,
  ProviderDriverKind,
  ProviderInstanceId,
  RuntimeItemId,
  RuntimeTaskId,
  ThreadId,
  TurnId,
  type ProviderRuntimeEvent,
  type ProviderUserInputAnswers,
  type ProviderSession,
  type ProviderSessionStartInput,
  type TurnTokenUsage,
  type ThreadTokenUsageSnapshot,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";
import * as Scope from "effect/Scope";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import {
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
} from "../Errors.ts";
import type { openCodeNativeInventoryLoad } from "../openCodeNativeInventoryLoad.ts";
import { openCodeNativeInventoryDefaultsResolve } from "../openCodeNativeInventoryDefaultsResolve.ts";
import { openCodeNativeSessionEngineCreate } from "../openCodeNativeSessionEngineCreate.ts";
import type { OpenCodeNativeInventory } from "../openCodeNativeInventorySchema.ts";
import { toOpenCodeFileParts } from "../opencodeRuntime.ts";
import type { ProviderAdapterShape } from "../Services/ProviderAdapter.ts";

const provider = ProviderDriverKind.make("opencode");
type NativeEvent = Parameters<
  Parameters<typeof openCodeNativeSessionEngineCreate>[0]["onEvent"]
>[0];
type Engine = ReturnType<typeof openCodeNativeSessionEngineCreate>;
const emptyInventory: OpenCodeNativeInventory = {
  provider: [],
  model: [],
  agent: [],
  command: [],
  skill: [],
};
type NativeForm = Extract<NativeEvent, { type: "form.created" }>["form"];
type NativeField = NativeForm["fields"][number];
const requestType = (action: string) =>
  action === "read"
    ? ("file_read_approval" as const)
    : action === "edit" || action === "write"
      ? ("file_change_approval" as const)
      : ("command_execution_approval" as const);
const formSupported = (form: NativeForm) =>
  form.fields.every(
    (field) =>
      field.key?.trim() &&
      field.type !== "external" &&
      !field.hidden &&
      !field.when?.length &&
      ["string", "multiselect", "boolean", "number", "integer"].includes(field.type) &&
      ((field.type !== "string" && field.type !== "multiselect") ||
        !field.options?.some((option) => !option.label?.trim() || !option.value?.trim())),
  ) && new Set(form.fields.map((field) => field.key)).size === form.fields.length;
const formAnswer = (form: NativeForm, answers: ProviderUserInputAnswers) => {
  const result: Record<string, string | number | boolean | ReadonlyArray<string>> = {};
  if (Object.keys(answers).some((key) => !form.fields.some((field) => field.key === key))) return;
  for (const field of form.fields) {
    const value = answers[field.key];
    if (value === undefined || (value === "" && field.type !== "string")) {
      if ("required" in field && field.required) return;
      continue;
    }
    if (field.type === "external") return;
    if (field.type === "multiselect") {
      const selected = Array.isArray(value) ? value : [value];
      if (
        !selected.every(
          (entry) =>
            typeof entry === "string" &&
            (field.custom || field.options.some((option) => option.value === entry)),
        ) ||
        (field.minItems !== undefined && selected.length < field.minItems) ||
        (field.maxItems !== undefined && selected.length > field.maxItems)
      )
        return;
      result[field.key] = selected as string[];
      continue;
    }
    if (field.type === "boolean") {
      if (value !== true && value !== false && value !== "true" && value !== "false") return;
      result[field.key] = value === true || value === "true";
      continue;
    }
    if (field.type === "number" || field.type === "integer") {
      const number =
        typeof value === "number"
          ? value
          : typeof value === "string" && value.trim()
            ? Number(value)
            : NaN;
      if (
        !Number.isFinite(number) ||
        (field.type === "integer" && !Number.isInteger(number)) ||
        (typeof field.minimum === "number" && number < field.minimum) ||
        (typeof field.maximum === "number" && number > field.maximum)
      )
        return;
      result[field.key] = number;
      continue;
    }
    if (
      typeof value !== "string" ||
      (field.required && value.length === 0) ||
      (field.options !== undefined &&
        !field.custom &&
        !field.options.some((option) => option.value === value)) ||
      (field.minLength !== undefined && value.length < field.minLength) ||
      (field.maxLength !== undefined && value.length > field.maxLength)
    )
      return;
    // Match native core/form validation, not JSON Schema's stricter format rules.
    const pattern = field.pattern;
    if (pattern !== undefined) {
      const matches = Result.try(() => new RegExp(pattern).test(value));
      if (!Result.getOrElse(matches, () => false)) return;
    }
    if (field.format === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) return;
    if (field.format === "uri" && !URL.canParse(value)) return;
    if (field.format === "date") {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return;
      const date = new Date(`${value}T00:00:00.000Z`);
      if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) return;
    }
    if (field.format === "date-time" && Number.isNaN(new Date(value).getTime())) return;
    result[field.key] = value;
  }
  return result;
};
const formQuestion = (field: NativeField, title: string) => ({
  id: field.key,
  header: field.title?.trim() || field.key,
  question: [title, field.description].filter(Boolean).join(" — "),
  options:
    field.type === "boolean"
      ? [
          { label: "Yes", description: "", value: "true" },
          { label: "No", description: "", value: "false" },
        ]
      : field.type === "string" || field.type === "multiselect"
        ? (field.options ?? []).map((option) => ({
            label: option.label,
            description: option.description ?? "",
            value: option.value,
          }))
        : [],
  allowCustomAnswer:
    field.type !== "boolean" &&
    ((field.type !== "string" && field.type !== "multiselect") ||
      field.custom ||
      (field.type === "string" ? field.options === undefined : !field.options?.length)),
  multiSelect: field.type === "multiselect",
});
type ChildEvent = Extract<NativeEvent, { type: "child.attached" | "child.updated" }>;
type StepAccounting = {
  readonly model?: string | undefined;
  readonly cost?: number;
  readonly tokens?: Extract<NativeEvent, { type: "step.completed" }>["step"]["tokens"];
  readonly completed: boolean;
  readonly compactionEventID?: string;
};
type ChildActivation = {
  readonly turnId: TurnId;
  readonly parentId: string;
  parentToolKey: string | undefined;
  info: ChildEvent["info"];
  status: "running" | "completed" | "failed" | "stopped";
  readonly steps: Map<string, StepAccounting>;
  readonly unresolvedSteps: Set<string>;
  readonly tools: Set<string>;
  result?: { readonly assistantMessageID: string; readonly blocks: Map<number, string> };
};
type Child = ChildActivation & {
  // One flat archive retains billing scopes without retaining earlier history arrays.
  // Task usage is session-lifetime cumulative; do not truncate old activation records.
  readonly history: Array<ChildActivation>;
  pendingAttachment?: ChildEvent;
};
type CostAccounting = {
  readonly usage: Context["usage"];
  readonly unresolvedSteps: Set<string>;
  lastCostUsd: number | undefined;
};
type SettledCostAccounting = CostAccounting & { readonly model: string | undefined };
type Context = {
  session: ProviderSession;
  readonly engine: Engine;
  readonly sessionId: string;
  // Only T3 choices are sticky; resolved native defaults stay refreshable at turn admission.
  modelSelection: ProviderSessionStartInput["modelSelection"];
  readonly inventory: OpenCodeNativeInventory | undefined;
  nativeModel: OpenCodeNativeInventory["configuredModel"];
  readonly defaultAgent: string;
  activeAgent: string | undefined;
  selectionVerified: boolean;
  readonly usage: Map<string, StepAccounting>;
  readonly unresolvedSteps: Set<string>;
  lastCostUsd: number | undefined;
  readonly settledCosts: Map<TurnId, SettledCostAccounting>;
  readonly children: Map<string, Child>;
  modelGeneration: number;
  readonly stepModels: Map<string, string>;
  readonly contextLimits: Map<string, Promise<number | undefined>>;
  contextUsage: ThreadTokenUsageSnapshot | undefined;
  readonly permissions: Map<string, Extract<NativeEvent, { type: "permission.asked" }>["request"]>;
  readonly forms: Map<string, NativeForm>;
  readonly settledRequests: Set<string>;
  active: TurnId | undefined;
  pending: TurnId | undefined;
  lastSettled: TurnId | undefined;
  manualCompacting?: boolean;
  manualCompactionAdmitting?: boolean;
  manualCompactionTurnId?: TurnId | undefined;
  lost: boolean;
  recovery: Fiber.Fiber<void> | undefined;
};

/** Native v2 adapter. Recovery adopts only the same quiescent native session, without replay. */
export const makeOpenCodeNativeAdapter = (options: {
  readonly url: string;
  readonly serverPassword?: string;
  readonly instanceId?: ProviderInstanceId;
  readonly engineCreate?: typeof openCodeNativeSessionEngineCreate;
  readonly inventory?: (directory: string) => OpenCodeNativeInventory | undefined;
  readonly inventoryLoad?: (directory: string) => ReturnType<typeof openCodeNativeInventoryLoad>;
}) =>
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    const fileSystem = yield* FileSystem.FileSystem;
    const instanceId = options.instanceId ?? ProviderInstanceId.make("opencode");
    const scope = yield* Scope.Scope;
    let disposed = false;
    let stopGeneration = 0;
    const sessions = new Map<ThreadId, Context>();
    const starting = new Map<ThreadId, { engine: Engine; cancelled: boolean }>();
    const losses = yield* Queue.unbounded<Context>();
    const bus = yield* Queue.unbounded<ProviderRuntimeEvent>();
    const now = () => new Date().toISOString();
    const base = (ctx: Context, turnId?: TurnId) => ({
      eventId: EventId.make(NodeCrypto.randomUUID()),
      createdAt: now(),
      provider,
      providerInstanceId: instanceId,
      threadId: ctx.session.threadId,
      ...(turnId ? { turnId } : {}),
    });
    const emit = (event: ProviderRuntimeEvent) => {
      Queue.offerUnsafe(bus, event);
    };
    const markLost = (ctx: Context, reason: string) => {
      if (disposed || ctx.lost || sessions.get(ctx.session.threadId) !== ctx) return;
      ctx.lost = true;
      ctx.session = { ...ctx.session, status: "error", lastError: reason, updatedAt: now() };
      for (const [childId, child] of ctx.children) {
        if (child.status !== "running") continue;
        emit({
          type: "runtime.warning",
          ...base(ctx, child.turnId),
          payload: {
            message: `The outcome of related OpenCode child session ${childId} is unknown because the parent session was lost: ${reason}`,
          },
        });
      }
      emit({
        type: "session.exited",
        ...base(ctx),
        payload: { reason, recoverable: true, exitKind: "error" },
      });
      Queue.offerUnsafe(losses, ctx);
    };
    const unsupported = (method: string) =>
      Effect.fail(
        new ProviderAdapterRequestError({
          provider,
          method,
          detail: "Native OpenCode v2 does not yet support this T3 operation.",
        }),
      );
    /** Splits a T3 selection into the native model ref and agent, rejecting anything else. */
    const nativeSelection = (
      operation: "startSession" | "sendTurn" | "compactThread",
      selection: ProviderSessionStartInput["modelSelection"],
    ) => {
      if (!selection) return Effect.succeed(undefined);
      const [providerID, ...modelParts] = selection.model.split("/");
      const id = modelParts.join("/");
      const options = selection.options ?? [];
      const variant = options.find((option) => option.id === "variant")?.value;
      const agent = options.find((option) => option.id === "agent")?.value;
      if (
        selection.instanceId !== instanceId ||
        !providerID?.trim() ||
        !id.trim() ||
        options.some((option) => option.id !== "variant" && option.id !== "agent") ||
        new Set(options.map((option) => option.id)).size !== options.length ||
        (variant !== undefined && (typeof variant !== "string" || !variant.trim())) ||
        (agent !== undefined && (typeof agent !== "string" || !agent.trim()))
      )
        return Effect.fail(
          new ProviderAdapterValidationError({
            provider,
            operation,
            issue:
              "Native v2 model selection requires a bound provider/model and supported string options.",
          }),
        );
      return Effect.succeed({
        model: {
          id,
          providerID,
          ...(typeof variant === "string" ? { variant } : {}),
        },
        ...(typeof agent === "string" ? { agent } : {}),
      });
    };
    const requireSession = (threadId: ThreadId) => {
      const ctx = sessions.get(threadId);
      return !disposed && ctx && !ctx.lost
        ? Effect.succeed(ctx)
        : Effect.fail(new ProviderAdapterSessionNotFoundError({ provider, threadId }));
    };
    const result = <T>(
      method: string,
      promise: Promise<
        | { readonly success: true; readonly data: T }
        | { readonly success: false; readonly error: { readonly detail: string } }
      >,
    ) =>
      Effect.flatMap(
        Effect.promise(() => promise),
        (value) =>
          value.success
            ? Effect.succeed(value.data)
            : Effect.fail(
                new ProviderAdapterRequestError({ provider, method, detail: value.error.detail }),
              ),
      );
    const childActivations = (ctx: Context) =>
      [...ctx.children.values()].flatMap((child) => [...child.history, child]);
    const childCostPending = (ctx: Context, turnId: TurnId) =>
      childActivations(ctx).some(
        (child) => child.turnId === turnId && child.status === "running",
      ) || [...ctx.children.values()].some((child) => child.pendingAttachment?.turnID === turnId);
    const tokenUsage = (ctx: Context): TurnTokenUsage | undefined => {
      if (!ctx.usage.size) return undefined;
      const totals = [...ctx.usage.values()].flatMap((step) => (step.tokens ? [step.tokens] : []));
      if (!totals.length) return undefined;
      return {
        usageScope: "main_agent",
        usageStatus:
          totals.length === ctx.usage.size && ctx.unresolvedSteps.size === 0
            ? "complete"
            : "partial",
        hasSubagents: childActivations(ctx).some((child) => child.turnId === ctx.active),
        inputTokens: totals.reduce(
          (n, step) => n + step.input + step.cache.read + step.cache.write,
          0,
        ),
        outputTokens: totals.reduce((n, step) => n + step.output + step.reasoning, 0),
        cachedInputTokens: totals.reduce((n, step) => n + step.cache.read, 0),
        cacheCreationTokens: totals.reduce((n, step) => n + step.cache.write, 0),
        reasoningTokens: totals.reduce((n, step) => n + step.reasoning, 0),
      };
    };
    const failedStepRecord = (
      steps: Map<string, StepAccounting>,
      unresolved: Set<string>,
      step: Extract<NativeEvent, { type: "step.failed" }>["step"],
    ) => {
      const id = step.assistantMessageID;
      if (steps.get(id)?.completed) return;
      if (step.cost === undefined || !Number.isFinite(step.cost) || step.cost < 0) {
        const knownTokens = step.tokens ?? steps.get(id)?.tokens;
        steps.set(id, { ...(knownTokens ? { tokens: knownTokens } : {}), completed: false });
        unresolved.add(id);
        return;
      }
      unresolved.delete(id);
      steps.set(id, {
        cost: step.cost,
        ...(step.tokens ? { tokens: step.tokens } : {}),
        completed: false,
      });
    };
    const turnCost = (
      ctx: Context,
      turnId: TurnId,
      complete: boolean,
      accounting: CostAccounting,
    ) => {
      const children = childActivations(ctx).filter((child) => child.turnId === turnId);
      if (
        complete &&
        (childCostPending(ctx, turnId) ||
          accounting.unresolvedSteps.size > 0 ||
          children.some(
            (child) =>
              child.status === "running" || child.unresolvedSteps.size > 0 || !child.steps.size,
          ))
      )
        return undefined;
      let total = 0;
      let hasPricedStep = false;
      for (const steps of [accounting.usage, ...children.map((child) => child.steps)]) {
        for (const step of steps.values()) {
          if (step.cost === undefined || !Number.isFinite(step.cost) || step.cost < 0) {
            if (complete) return undefined;
            continue;
          }
          hasPricedStep = true;
          total += step.cost;
        }
      }
      // Child-only turns are priced from their child steps; never infer a zero without a priced step.
      return hasPricedStep && Number.isFinite(total) ? total : undefined;
    };
    const turnCostEmit = (ctx: Context, turnId: TurnId) => {
      const accounting = ctx.active === turnId ? ctx : ctx.settledCosts.get(turnId);
      if (!accounting) return;
      const cost = turnCost(ctx, turnId, false, accounting);
      if (cost === undefined || cost === accounting.lastCostUsd) return;
      accounting.lastCostUsd = cost;
      const model = accountingModel(ctx, turnId, accounting);
      emit({
        type: "turn.cost.updated",
        ...base(ctx, turnId),
        turnId,
        payload: {
          totalCostUsd: cost,
          costSessionId: ctx.sessionId,
          ...(model ? { costModel: model } : {}),
        },
      });
    };
    const settledCostFinish = (ctx: Context, turnId: TurnId) => {
      const accounting = ctx.settledCosts.get(turnId);
      if (!accounting || childCostPending(ctx, turnId)) return;
      const cost = turnCost(ctx, turnId, true, accounting);
      const model = accountingModel(ctx, turnId, accounting);
      ctx.settledCosts.delete(turnId);
      if (cost === undefined) return;
      emit({
        type: "turn.cost.updated",
        ...base(ctx, turnId),
        turnId,
        payload: {
          totalCostUsd: cost,
          status: "final",
          costSessionId: ctx.sessionId,
          ...(model ? { costModel: model } : {}),
        },
      });
    };
    const childLinkage = (ctx: Context, id: string, child: Child) => {
      const url = new URL(options.url);
      const directory = child.info.directory ?? ctx.session.cwd ?? config.cwd;
      url.pathname = `${url.pathname.replace(/\/+$/, "")}/${Buffer.from(directory, "utf8").toString("base64url")}/session/${encodeURIComponent(id)}`;
      return {
        taskType: "subagent",
        agentKind: "agent" as const,
        runHandles: { sessionUrl: url.toString() },
        // Lets clients replace the launch tool row with the agent row.
        ...(child.parentToolKey ? { toolUseId: `opencode:${child.parentToolKey}` } : {}),
        ...(child.info.title?.trim() ? { title: child.info.title } : {}),
        ...(child.info.agent?.trim() ? { role: child.info.agent } : {}),
        ...(child.info.model
          ? { model: `${child.info.model.providerID}/${child.info.model.id}` }
          : {}),
        ...(child.parentId !== ctx.sessionId ? { parentAgentId: child.parentId } : {}),
      };
    };
    const childUsage = (child: Child) => {
      const activations = [...child.history, child];
      const steps = [
        ...new Map(activations.flatMap((activation) => [...activation.steps])).values(),
      ];
      const tools = new Set(activations.flatMap((activation) => [...activation.tools]));
      if (!steps.length && !tools.size) return undefined;
      const reported = steps.flatMap((step) => (step.tokens ? [step.tokens] : []));
      const inputTokens = reported.reduce(
        (n, step) => n + step.input + step.cache.read + step.cache.write,
        0,
      );
      const outputTokens = reported.reduce((n, step) => n + step.output + step.reasoning, 0);
      return {
        totalTokens: inputTokens + outputTokens,
        inputTokens,
        cachedInputTokens: reported.reduce((n, step) => n + step.cache.read, 0),
        outputTokens,
        reasoningOutputTokens: reported.reduce((n, step) => n + step.reasoning, 0),
        toolUses: tools.size,
        ...(steps.some((step) => step.cost !== undefined)
          ? { costUsd: steps.reduce((n, step) => n + (step.cost ?? 0), 0) }
          : {}),
      };
    };
    const accountingModel = (ctx: Context, turnId: TurnId, accounting: CostAccounting = ctx) => {
      const models = new Set(
        [
          ...accounting.usage.values(),
          ...childActivations(ctx)
            .filter((child) => child.turnId === turnId)
            .flatMap((child) => [...child.steps.values()]),
        ].flatMap((step) => (step.model ? [step.model] : [])),
      );
      return models.size > 1
        ? undefined
        : (models.values().next().value ??
            (ctx.active === turnId ? ctx.session.model : ctx.settledCosts.get(turnId)?.model));
    };
    const effectiveModelSet = (ctx: Context, model: string) => {
      if (ctx.session.model === model) return;
      ctx.modelGeneration++;
      ctx.contextLimits.clear();
      ctx.session = { ...ctx.session, model, updatedAt: now() };
    };
    const contextSnapshotEmit = (
      ctx: Context,
      turnId: TurnId | undefined,
      usage: ThreadTokenUsageSnapshot,
    ) => {
      ctx.contextUsage = usage;
      const generation = ctx.modelGeneration;
      const model = ctx.session.model;
      const publish = (maxTokens?: number) => {
        if (
          disposed ||
          ctx.lost ||
          sessions.get(ctx.session.threadId) !== ctx ||
          ctx.modelGeneration !== generation ||
          ctx.contextUsage !== usage
        )
          return;
        emit({
          type: "thread.token-usage.updated",
          ...base(ctx, turnId),
          payload: {
            usage: { ...usage, ...(maxTokens ? { maxTokens } : {}) },
          },
        });
      };
      // Occupancy is available immediately; model metadata is optional and asynchronous.
      publish();
      const [providerID, ...rest] = model?.split("/") ?? [];
      if (!model || !providerID || !rest.length) return;
      let lookup = ctx.contextLimits.get(model);
      if (!lookup) {
        lookup = ctx.engine.contextLimit({ providerID, id: rest.join("/") });
        ctx.contextLimits.set(model, lookup);
      }
      void lookup.then(publish, () => undefined);
    };
    // Native counts describe the last request, not a measured current transcript.
    const contextUsageEmit = (
      ctx: Context,
      turnId: TurnId,
      tokens: {
        input: number;
        output: number;
        reasoning: number;
        cache: { read: number; write: number };
      },
    ) => {
      const n = (value: number) => (Number.isFinite(value) && value > 0 ? Math.round(value) : 0);
      const inputTokens = n(tokens.input) + n(tokens.cache.read) + n(tokens.cache.write);
      const usedTokens = inputTokens + n(tokens.output) + n(tokens.reasoning);
      contextSnapshotEmit(ctx, turnId, {
        contextUsageStatus: "estimated",
        usedTokens,
        lastUsedTokens: usedTokens,
        inputTokens,
        cachedInputTokens: n(tokens.cache.read),
        outputTokens: n(tokens.output),
        reasoningOutputTokens: n(tokens.reasoning),
        lastInputTokens: inputTokens,
        lastCachedInputTokens: n(tokens.cache.read),
        lastOutputTokens: n(tokens.output),
        lastReasoningOutputTokens: n(tokens.reasoning),
      });
    };
    const onEvent = (ctx: Context, event: NativeEvent) => {
      if (sessions.get(ctx.session.threadId) !== ctx) return;
      if (event.type === "session.ready") return;
      if (event.type === "stream.lost") {
        if (event.sessionID !== ctx.sessionId) return;
        const reason = "Native event stream lost; turn outcome is uncertain.";
        markLost(ctx, event.detail ? `${reason} ${event.detail}` : reason);
        return;
      }
      if (ctx.lost) return;
      if (event.type === "model.selected") {
        if (event.sessionID !== ctx.sessionId) return;
        ctx.nativeModel = event.model;
        effectiveModelSet(ctx, `${event.model.providerID}/${event.model.id}`);
        contextSnapshotEmit(ctx, ctx.active, { contextUsageStatus: "unknown" });
        return;
      }
      if (
        event.type === "compaction.started" ||
        event.type === "compaction.completed" ||
        event.type === "compaction.failed"
      ) {
        const child =
          event.sessionID === ctx.sessionId ? undefined : ctx.children.get(event.sessionID);
        const owner = child
          ? [...child.history, child].find(
              (activation) =>
                activation.turnId === event.turnID &&
                activation.parentId === event.parentSessionID &&
                activation.parentToolKey === event.parentToolKey,
            )
          : undefined;
        if (event.sessionID !== ctx.sessionId && !owner) return;
        // Like step accounting, retired child activations are immutable; delayed
        // frames cannot charge the reused session's current activation.
        if (child && (owner !== child || child.status !== "running")) return;
        const accounting =
          owner ??
          (ctx.active === event.turnID ? ctx : ctx.settledCosts.get(TurnId.make(event.turnID)));
        if (!accounting) return;
        const steps = "steps" in accounting ? accounting.steps : accounting.usage;
        const key = `compaction:${event.sessionID}:${event.key}`;
        // A stable attempt belongs to its original activation, even after session reuse.
        if (
          child &&
          [...child.history, child].some(
            (activation) =>
              activation !== owner &&
              (activation.steps.has(key) ||
                activation.unresolvedSteps.has(key) ||
                [...activation.steps.values()].some(
                  (step) => step.compactionEventID === event.eventID,
                )),
          )
        )
          return;
        // The engine's feed-ID cache is bounded. Keep the terminal ID on its
        // billing record too: replay after cache eviction may use the terminal
        // ID as its attempt key rather than the already-closed start ID.
        if (
          steps.has(key) ||
          [...steps.values()].some((step) => step.compactionEventID === event.eventID) ||
          (event.type === "compaction.started" && accounting.unresolvedSteps.has(key))
        )
          return;
        if (!child && ctx.active === event.turnID) {
          // providerContext is a versioned replacement-message payload, not occupancy
          // (2.0.18 and 2.0.21). Summary request tokens must never populate the meter.
          contextSnapshotEmit(ctx, TurnId.make(event.turnID), { contextUsageStatus: "unknown" });
        }
        if (event.type === "compaction.started") {
          accounting.unresolvedSteps.add(key);
          return;
        }
        const cost = "cost" in event.compaction ? event.compaction.cost : undefined;
        const tokens = "tokens" in event.compaction ? event.compaction.tokens : undefined;
        const knownCost = cost !== undefined && Number.isFinite(cost) && cost >= 0;
        steps.set(key, {
          compactionEventID: event.eventID,
          ...("model" in event.compaction && event.compaction.model
            ? { model: `${event.compaction.model.providerID}/${event.compaction.model.id}` }
            : {}),
          ...(knownCost ? { cost } : {}),
          ...(tokens ? { tokens } : {}),
          completed: true,
        });
        accounting.unresolvedSteps.delete(key);
        if (!knownCost) accounting.unresolvedSteps.add(key);
        const id = TurnId.make(event.turnID);
        turnCostEmit(ctx, id);
        if (owner === child && child?.status === "running")
          emit({
            type: "task.progress",
            ...base(ctx, id),
            payload: {
              taskId: RuntimeTaskId.make(event.sessionID),
              status: child.status,
              description: child.info.title?.trim() || "OpenCode child session",
              typedUsage: childUsage(child),
              ...childLinkage(ctx, event.sessionID, child),
            },
          });
        return;
      }
      if (event.type === "permission.asked") {
        const { request } = event;
        if (
          request.sessionID !== ctx.sessionId ||
          ctx.settledRequests.has(`permission:${request.id}`) ||
          ctx.permissions.has(request.id)
        )
          return;
        ctx.permissions.set(request.id, request);
        emit({
          type: "request.opened",
          ...base(ctx, TurnId.make(event.turnID)),
          requestId: RuntimeRequestId.make(request.id),
          payload: {
            requestType: requestType(request.action),
            detail: request.message?.trim() || [request.action, ...request.resources].join("\n"),
            args: {
              action: request.action,
              resources: request.resources,
              metadata: request.metadata,
            },
            options: [
              { decision: "accept", label: "Allow once" },
              {
                decision: "acceptForSession",
                label: "Allow for workspace",
                warning:
                  "Applies to matching requests in other OpenCode sessions in this workspace.",
              },
              { decision: "decline", label: "Deny" },
            ],
          },
        });
        return;
      }
      if (event.type === "form.created") {
        const { form } = event;
        if (
          form.sessionID !== ctx.sessionId ||
          ctx.settledRequests.has(`form:${form.id}`) ||
          ctx.forms.has(form.id)
        )
          return;
        const supported = formSupported(form);
        if (!supported) {
          emit({
            type: "runtime.warning",
            ...base(ctx),
            payload: {
              message:
                "Native OpenCode form contains fields T3 cannot safely answer. Cancel it here to unblock the turn, or use the native client to answer it.",
            },
          });
        }
        ctx.forms.set(form.id, form);
        emit({
          type: "user-input.requested",
          ...base(ctx, TurnId.make(event.turnID)),
          requestId: RuntimeRequestId.make(form.id),
          payload: {
            questions: supported
              ? form.fields.map((field) => formQuestion(field, form.title))
              : [
                  {
                    id: "native-form-action",
                    header: "Unsupported form",
                    question: `${form.title} contains fields T3 cannot safely answer. Cancel this form or answer it in the native OpenCode client.`,
                    options: [{ label: "Cancel form", description: "", value: "cancel" }],
                    allowCustomAnswer: false,
                    multiSelect: false,
                  },
                ],
          },
        });
        return;
      }
      if (event.type === "permission.replied") {
        const request = ctx.permissions.get(event.requestID);
        if (
          event.sessionID !== ctx.sessionId ||
          !request ||
          ctx.settledRequests.has(`permission:${event.requestID}`)
        )
          return;
        ctx.permissions.delete(event.requestID);
        ctx.settledRequests.add(`permission:${event.requestID}`);
        emit({
          type: "request.resolved",
          ...base(ctx, TurnId.make(event.turnID)),
          requestId: RuntimeRequestId.make(event.requestID),
          payload: {
            requestType: requestType(request.action),
            ...(event.decision
              ? {
                  decision:
                    event.decision === "once"
                      ? "accept"
                      : event.decision === "always"
                        ? "acceptForSession"
                        : "decline",
                }
              : {}),
          },
        });
        return;
      }
      if (event.type === "form.resolved") {
        if (
          event.sessionID !== ctx.sessionId ||
          !ctx.forms.has(event.formID) ||
          ctx.settledRequests.has(`form:${event.formID}`)
        )
          return;
        ctx.forms.delete(event.formID);
        ctx.settledRequests.add(`form:${event.formID}`);
        emit({
          type: "user-input.resolved",
          ...base(ctx, TurnId.make(event.turnID)),
          requestId: RuntimeRequestId.make(event.formID),
          payload: { answers: event.answer },
        });
        return;
      }
      if (event.type.startsWith("child.")) {
        const childEvent = event as Extract<NativeEvent, { type: `child.${string}` }>;
        if (!childEvent.parentSessionID) return;
        const parent = ctx.children.get(childEvent.parentSessionID);
        if (childEvent.parentSessionID !== ctx.sessionId && !parent) return;
        const child = ctx.children.get(childEvent.sessionID);
        if (childEvent.type === "child.attached") {
          if (child) {
            // Attachment/info precedes execution start. It is not itself permission
            // to reopen a settled task or change its previously emitted scope.
            if (
              child.status !== "running" &&
              child.parentId === childEvent.parentSessionID &&
              childEvent.parentToolKey &&
              ![...child.history, child].some(
                (activation) => activation.parentToolKey === childEvent.parentToolKey,
              ) &&
              (parent ? parent.turnId === childEvent.turnID : ctx.active === childEvent.turnID)
            )
              child.pendingAttachment = childEvent;
            return;
          }
          if (!parent && ctx.active !== childEvent.turnID) return;
          const info = childEvent.info;
          const next: Child = {
            turnId: parent?.turnId ?? TurnId.make(childEvent.turnID),
            parentId: childEvent.parentSessionID,
            parentToolKey: childEvent.parentToolKey,
            info,
            status: "running",
            steps: new Map(),
            unresolvedSteps: new Set(),
            tools: new Set(),
            history: [],
          };
          if (childEvent.turnID !== next.turnId) return;
          ctx.children.set(childEvent.sessionID, next);
          emit({
            type: "task.started",
            ...base(ctx, next.turnId),
            payload: {
              taskId: RuntimeTaskId.make(childEvent.sessionID),
              description: info.title?.trim() || "OpenCode child session",
              ...childLinkage(ctx, childEvent.sessionID, next),
            },
          });
          return;
        }
        if (child && childEvent.type === "child.started" && childEvent.reactivation) {
          const attached = child.pendingAttachment;
          if (
            child.status === "running" ||
            !attached ||
            attached.turnID !== childEvent.turnID ||
            attached.parentSessionID !== childEvent.parentSessionID ||
            attached.parentToolKey !== childEvent.parentToolKey ||
            childEvent.reactivation.key !== attached.parentToolKey
          )
            return;
          delete child.pendingAttachment;
          const { history, ...activation } = child;
          history.push(activation);
          const next: Child = {
            turnId: TurnId.make(childEvent.turnID),
            parentId: childEvent.parentSessionID,
            parentToolKey: attached.parentToolKey,
            info: attached.info,
            status: "running",
            steps: new Map(),
            unresolvedSteps: new Set(),
            tools: new Set(),
            history,
          };
          ctx.children.set(childEvent.sessionID, next);
          emit({
            type: "task.updated",
            ...base(ctx, next.turnId),
            payload: {
              taskId: RuntimeTaskId.make(childEvent.sessionID),
              status: "running",
              description: next.info.title?.trim() || "OpenCode child session",
              ...childLinkage(ctx, childEvent.sessionID, next),
            },
          });
          return;
        }
        if (
          child?.pendingAttachment &&
          childEvent.type === "child.updated" &&
          child.pendingAttachment.turnID === childEvent.turnID &&
          child.pendingAttachment.parentSessionID === childEvent.parentSessionID &&
          child.pendingAttachment.parentToolKey === childEvent.parentToolKey
        ) {
          child.pendingAttachment = {
            ...child.pendingAttachment,
            info: { ...child.pendingAttachment.info, ...childEvent.info },
          };
          return;
        }
        if (
          !child ||
          child.parentId !== childEvent.parentSessionID ||
          child.turnId !== childEvent.turnID ||
          child.status !== "running" ||
          (child.history.length > 0
            ? child.parentToolKey !== childEvent.parentToolKey
            : childEvent.parentToolKey !== undefined &&
              child.parentToolKey !== undefined &&
              child.parentToolKey !== childEvent.parentToolKey)
        )
          return;
        child.parentToolKey ??= childEvent.parentToolKey;
        if (childEvent.type === "child.updated") {
          child.info = { ...child.info, ...childEvent.info };
          emit({
            type: "task.progress",
            ...base(ctx, child.turnId),
            payload: {
              taskId: RuntimeTaskId.make(childEvent.sessionID),
              description: child.info.title?.trim() || "OpenCode child session",
              status: "running",
              ...childLinkage(ctx, childEvent.sessionID, child),
            },
          });
          return;
        }
        if (childEvent.type === "child.started") return;
        child.status =
          childEvent.type === "child.completed"
            ? "completed"
            : childEvent.type === "child.failed"
              ? "failed"
              : "stopped";
        const typedUsage = childUsage(child);
        const summary =
          childEvent.type === "child.completed"
            ? (childEvent.summary ??
              (child.result
                ? [...child.result.blocks]
                    .sort(([a], [b]) => a - b)
                    .map(([, text]) => text)
                    .join("\n")
                : undefined))
            : undefined;
        emit({
          type: "task.completed",
          ...base(ctx, child.turnId),
          payload: {
            taskId: RuntimeTaskId.make(childEvent.sessionID),
            status: child.status,
            ...(summary?.trim() ? { summary } : {}),
            ...(childEvent.type === "child.failed" ? { summary: childEvent.error.message } : {}),
            ...(childEvent.type === "child.interrupted"
              ? { summary: `Execution interrupted: ${childEvent.reason}.` }
              : {}),
            ...(typedUsage ? { typedUsage } : {}),
            ...childLinkage(ctx, childEvent.sessionID, child),
          },
        });
        settledCostFinish(ctx, child.turnId);
        return;
      }
      if ("sessionID" in event && "turnID" in event && event.sessionID !== ctx.sessionId) {
        const child = ctx.children.get(event.sessionID);
        if (
          !child ||
          child.status !== "running" ||
          event.turnID !== child.turnId ||
          (child.history.length > 0
            ? event.parentToolKey !== child.parentToolKey ||
              event.parentSessionID !== child.parentId
            : event.parentToolKey !== undefined &&
              child.parentToolKey !== undefined &&
              event.parentToolKey !== child.parentToolKey) ||
          ("step" in event &&
            child.history.some(
              (activation) =>
                activation.steps.has(event.step.assistantMessageID) ||
                activation.unresolvedSteps.has(event.step.assistantMessageID),
            ))
        )
          return;
        const messageId =
          "assistantMessageID" in event
            ? event.assistantMessageID
            : "tool" in event
              ? event.tool.assistantMessageID
              : undefined;
        if (
          messageId &&
          child.history.some(
            (activation) =>
              activation.steps.has(messageId) ||
              activation.unresolvedSteps.has(messageId) ||
              activation.result?.assistantMessageID === messageId,
          )
        )
          return;
        if (event.type === "text.completed") {
          if (child.result?.assistantMessageID !== event.assistantMessageID)
            child.result = { assistantMessageID: event.assistantMessageID, blocks: new Map() };
          child.result.blocks.set(event.ordinal, event.text);
          return;
        }
        if (event.type === "step.started" || event.type === "step.streamed") {
          if (event.type === "step.started") {
            ctx.stepModels.set(
              event.step.assistantMessageID,
              `${event.step.model.providerID}/${event.step.model.id}`,
            );
            child.info = { ...child.info, model: event.step.model };
          }
          if (!child.steps.has(event.step.assistantMessageID))
            child.unresolvedSteps.add(event.step.assistantMessageID);
          return;
        }
        if (event.type === "step.failed") {
          failedStepRecord(child.steps, child.unresolvedSteps, event.step);
          const accounting = child.steps.get(event.step.assistantMessageID);
          const model = ctx.stepModels.get(event.step.assistantMessageID);
          if (accounting && model)
            child.steps.set(event.step.assistantMessageID, { ...accounting, model });
          ctx.stepModels.delete(event.step.assistantMessageID);
          turnCostEmit(ctx, child.turnId);
        } else if (event.type === "step.completed") {
          child.unresolvedSteps.delete(event.step.assistantMessageID);
          child.steps.set(event.step.assistantMessageID, {
            model: ctx.stepModels.get(event.step.assistantMessageID),
            tokens: event.step.tokens,
            cost: event.step.cost,
            completed: true,
          });
          ctx.stepModels.delete(event.step.assistantMessageID);
          turnCostEmit(ctx, child.turnId);
        } else if (event.type === "tool.called") {
          child.tools.add(event.key);
        } else return;
        emit({
          type: "task.progress",
          ...base(ctx, child.turnId),
          payload: {
            taskId: RuntimeTaskId.make(event.sessionID),
            description: child.info.title?.trim() || "OpenCode child session",
            status: "running",
            ...(event.type === "tool.called" && event.tool.name.trim()
              ? { lastToolName: event.tool.name }
              : {}),
            typedUsage: childUsage(child),
            ...childLinkage(ctx, event.sessionID, child),
          },
        });
        return;
      }
      const turnId = ctx.active;
      if (event.type === "turn.started") {
        const id = TurnId.make(event.turnID);
        if (ctx.manualCompactionAdmitting && ctx.manualCompacting) ctx.manualCompactionTurnId = id;
        ctx.usage.clear();
        ctx.unresolvedSteps.clear();
        ctx.lastCostUsd = undefined;
        ctx.pending = undefined;
        ctx.active = id;
        ctx.session = { ...ctx.session, status: "running", activeTurnId: id, updatedAt: now() };
        emit({ type: "turn.started", ...base(ctx, id), payload: {} });
        return;
      }
      if (event.type === "turn.completed" || event.type === "turn.failed") {
        const id = TurnId.make(event.turnID);
        if (ctx.active !== id) return;
        ctx.lastSettled = id;
        ctx.pending = undefined;
        const usage = tokenUsage(ctx);
        const cost = turnCost(ctx, id, true, ctx);
        const costModel = accountingModel(ctx, id);
        if (cost === undefined && childCostPending(ctx, id))
          ctx.settledCosts.set(id, {
            usage: new Map(ctx.usage),
            unresolvedSteps: new Set(ctx.unresolvedSteps),
            lastCostUsd: ctx.lastCostUsd,
            model: costModel,
          });
        ctx.active = undefined;
        ctx.usage.clear();
        ctx.unresolvedSteps.clear();
        ctx.session = {
          ...ctx.session,
          status: "ready",
          activeTurnId: undefined,
          updatedAt: now(),
        };
        const manual = ctx.manualCompactionTurnId === id;
        const compacted = manual && event.type === "turn.completed";
        if (manual) {
          ctx.manualCompacting = false;
          ctx.manualCompactionTurnId = undefined;
        }
        if (compacted)
          emit({
            type: "thread.state.changed",
            ...base(ctx, id),
            payload: { state: "compacted" },
          });
        emit({
          type: "turn.completed",
          ...base(ctx, id),
          payload:
            event.type === "turn.completed"
              ? {
                  state: "completed",
                  ...(usage ? { tokenUsage: usage } : {}),
                  ...(cost !== undefined
                    ? {
                        totalCostUsd: cost,
                        costSessionId: ctx.sessionId,
                        ...(costModel ? { costModel } : {}),
                      }
                    : {}),
                }
              : {
                  state: event.reason === "interrupted" ? "interrupted" : "failed",
                  errorMessage:
                    event.reason === "failed"
                      ? event.error.message
                      : `Execution interrupted: ${event.interruptionReason}.`,
                  ...(usage ? { tokenUsage: usage } : {}),
                  ...(cost !== undefined
                    ? {
                        totalCostUsd: cost,
                        costSessionId: ctx.sessionId,
                        ...(costModel ? { costModel } : {}),
                      }
                    : {}),
                },
        });
        return;
      }
      if (event.type === "step.started" || event.type === "step.streamed") {
        if (
          event.type === "step.started" &&
          turnId &&
          event.turnID === turnId &&
          event.sessionID === ctx.sessionId
        ) {
          const model = `${event.step.model.providerID}/${event.step.model.id}`;
          ctx.stepModels.set(event.step.assistantMessageID, model);
          const changed = ctx.session.model !== model;
          effectiveModelSet(ctx, model);
          if (changed) contextSnapshotEmit(ctx, turnId, { contextUsageStatus: "unknown" });
        }
        if (
          turnId &&
          event.turnID === turnId &&
          event.sessionID === ctx.sessionId &&
          !ctx.usage.has(event.step.assistantMessageID)
        )
          ctx.unresolvedSteps.add(event.step.assistantMessageID);
        return;
      }
      if (event.type === "step.failed") {
        if (turnId && event.turnID === turnId && event.sessionID === ctx.sessionId) {
          failedStepRecord(ctx.usage, ctx.unresolvedSteps, event.step);
          const model = ctx.stepModels.get(event.step.assistantMessageID);
          if (model) effectiveModelSet(ctx, model);
          const accounting = ctx.usage.get(event.step.assistantMessageID);
          if (model && accounting)
            ctx.usage.set(event.step.assistantMessageID, { ...accounting, model });
          ctx.stepModels.delete(event.step.assistantMessageID);
          turnCostEmit(ctx, turnId);
          if (event.step.tokens) contextUsageEmit(ctx, turnId, event.step.tokens);
          else contextSnapshotEmit(ctx, turnId, { contextUsageStatus: "unknown" });
        }
        return;
      }
      if (event.type === "step.completed") {
        if (turnId && event.turnID === turnId && event.sessionID === ctx.sessionId) {
          const model = ctx.stepModels.get(event.step.assistantMessageID);
          if (model) effectiveModelSet(ctx, model);
          ctx.unresolvedSteps.delete(event.step.assistantMessageID);
          ctx.usage.set(event.step.assistantMessageID, {
            model,
            tokens: event.step.tokens,
            cost: event.step.cost,
            completed: true,
          });
          ctx.stepModels.delete(event.step.assistantMessageID);
          turnCostEmit(ctx, turnId);
          contextUsageEmit(ctx, turnId, event.step.tokens);
        }
        return;
      }
      // Session totals are cumulative, not turn totals; child events have separate ancestry.
      if (
        !turnId ||
        !("sessionID" in event) ||
        event.sessionID !== ctx.sessionId ||
        !("key" in event)
      )
        return;
      const itemId = RuntimeItemId.make(`opencode:${event.key}`);
      if (event.type === "text.started" || event.type === "reasoning.started") {
        emit({
          type: "item.started",
          ...base(ctx, turnId),
          itemId,
          payload: {
            itemType: event.type === "text.started" ? "assistant_message" : "reasoning",
            status: "inProgress",
          },
        });
        return;
      }
      if (event.type === "text.delta" || event.type === "reasoning.delta") {
        emit({
          type: "content.delta",
          ...base(ctx, turnId),
          itemId,
          payload: {
            streamKind: event.type === "text.delta" ? "assistant_text" : "reasoning_text",
            delta: event.delta,
          },
        });
        return;
      }
      if (event.type === "text.completed" || event.type === "reasoning.completed") {
        emit({
          type: "item.completed",
          ...base(ctx, turnId),
          itemId,
          payload: {
            itemType: event.type === "text.completed" ? "assistant_message" : "reasoning",
            status: "completed",
            finalText: event.text,
          },
        });
        return;
      }
      if (
        event.type === "tool.started" ||
        event.type === "tool.input.delta" ||
        event.type === "tool.input.completed" ||
        event.type === "tool.called" ||
        event.type === "tool.progress" ||
        event.type === "tool.completed" ||
        event.type === "tool.failed"
      ) {
        const itemType =
          event.tool.name === "bash"
            ? "command_execution"
            : event.tool.name === "edit" || event.tool.name === "write"
              ? "file_change"
              : event.tool.name === "subagent" || event.tool.name === "task"
                ? "collab_agent_tool_call"
                : "dynamic_tool_call";
        emit({
          type:
            event.type === "tool.started"
              ? "item.started"
              : event.type === "tool.completed" || event.type === "tool.failed"
                ? "item.completed"
                : "item.updated",
          ...base(ctx, turnId),
          itemId,
          payload: {
            itemType,
            ...(event.tool.name.trim() ? { title: event.tool.name } : {}),
            status:
              event.type === "tool.failed"
                ? "failed"
                : event.type === "tool.completed"
                  ? "completed"
                  : "inProgress",
            data: {
              tool: event.tool.name,
              ...(event.tool.input ? { input: event.tool.input } : {}),
              ...(event.tool.inputText ? { inputText: event.tool.inputText } : {}),
              ...(event.type === "tool.completed" || event.type === "tool.failed"
                ? { content: event.tool.content }
                : {}),
              ...(event.type === "tool.failed" ? { error: event.tool.error } : {}),
              ...((event.type === "tool.progress" ||
                event.type === "tool.completed" ||
                event.type === "tool.failed") &&
              event.tool.metadata !== undefined
                ? { metadata: event.tool.metadata }
                : {}),
            },
          },
        });
      }
    };

    const recover = Effect.fnUntraced(function* (previous: Context) {
      const threadId = previous.session.threadId;
      let delay = 250;
      while (sessions.get(threadId) === previous && previous.lost) {
        if (disposed) return;
        yield* Effect.sleep(`${delay} millis`);
        if (disposed || sessions.get(threadId) !== previous) return;
        let candidate: Context | undefined;
        let candidateLost = false;
        let adopted = false;
        const engine = (options.engineCreate ?? openCodeNativeSessionEngineCreate)({
          url: options.url,
          ...(options.inventory ? { inventory: options.inventory } : {}),
          ...(options.serverPassword ? { serverPassword: options.serverPassword } : {}),
          onEvent: (event) => {
            if (event.type === "stream.lost") candidateLost = true;
            if (adopted && candidate) onEvent(candidate, event);
          },
        });
        const recovered = yield* Effect.gen(function* () {
          const parsed = yield* nativeSelection("startSession", previous.modelSelection);
          const started = yield* Effect.promise(() =>
            engine.start({
              directory: previous.session.cwd ?? config.cwd,
              resumeSessionId: previous.sessionId,
              ...(parsed?.model ? { model: parsed.model } : {}),
              ...(previous.activeAgent ? { agent: previous.activeAgent } : {}),
            }),
          );
          if (
            !started.success ||
            started.data.id !== previous.sessionId ||
            candidateLost ||
            disposed ||
            sessions.get(threadId) !== previous
          )
            return false;
          // Fresh execution state isolates all late responses from the abandoned engine.
          candidate = {
            ...previous,
            engine,
            // Resume preserves remote state, including switches whose responses were lost.
            // Reassert the desired model and agent only before the next new user turn.
            activeAgent: undefined,
            selectionVerified: false,
            session: {
              ...previous.session,
              status: "ready",
              activeTurnId: undefined,
              lastError: undefined,
              updatedAt: now(),
            },
            usage: new Map(),
            unresolvedSteps: new Set(),
            lastCostUsd: undefined,
            settledCosts: new Map(),
            children: new Map(),
            modelGeneration: 0,
            stepModels: new Map(),
            contextLimits: new Map(),
            contextUsage: undefined,
            permissions: new Map(),
            forms: new Map(),
            settledRequests: new Set(),
            active: undefined,
            pending: undefined,
            lastSettled: undefined,
            lost: false,
            recovery: undefined,
          };
          // No yield between checking the stream, ownership transfer, and readiness.
          sessions.set(threadId, candidate);
          adopted = true;
          const expiredBase = base(previous, previous.active ?? previous.pending);
          for (const [id, request] of previous.permissions)
            emit({
              type: "request.expired",
              ...expiredBase,
              eventId: EventId.make(NodeCrypto.randomUUID()),
              requestId: RuntimeRequestId.make(id),
              payload: {
                requestType: requestType(request.action),
                reason:
                  "Native observation was lost; quiescent recovery confirmed this request is no longer pending.",
              },
            });
          for (const id of previous.forms.keys())
            emit({
              type: "request.expired",
              ...expiredBase,
              eventId: EventId.make(NodeCrypto.randomUUID()),
              requestId: RuntimeRequestId.make(id),
              payload: {
                requestType: "tool_user_input",
                reason:
                  "Native observation was lost; quiescent recovery confirmed this form is no longer pending.",
              },
            });
          emit({ type: "session.started", ...base(candidate), payload: {} });
          emit({ type: "session.state.changed", ...base(candidate), payload: { state: "ready" } });
          yield* Effect.promise(() => previous.engine.stop({ interrupt: false }));
          return true;
        }).pipe(
          Effect.ensuring(
            Effect.promise(() =>
              adopted ? Promise.resolve(undefined) : engine.stop({ interrupt: false }),
            ),
          ),
        );
        if (recovered) return;
        delay = Math.min(delay * 2, 5_000);
      }
    });
    yield* Effect.gen(function* () {
      while (true) {
        const ctx = yield* Queue.take(losses);
        if (disposed || sessions.get(ctx.session.threadId) !== ctx || !ctx.lost || ctx.recovery)
          continue;
        ctx.recovery = yield* recover(ctx).pipe(
          Effect.ignore,
          Effect.interruptible,
          Effect.forkIn(scope),
        );
      }
    }).pipe(Effect.interruptible, Effect.forkIn(scope));

    const selectionApply = Effect.fnUntraced(function* (
      ctx: Context,
      next: ProviderSessionStartInput["modelSelection"],
      operation: "sendTurn" | "compactThread",
      interactionMode?: "default" | "plan",
    ) {
      if (!ctx.selectionVerified && (ctx.active || ctx.pending))
        return yield* new ProviderAdapterRequestError({
          provider,
          method: "session.switch",
          detail: "Wait for native work to settle before reasserting an unverified selection.",
        });
      const parsed = yield* nativeSelection(operation, next ?? ctx.modelSelection);
      const inventory = options.inventory?.(ctx.session.cwd ?? config.cwd) ?? ctx.inventory;
      const resolved = openCodeNativeInventoryDefaultsResolve(inventory ?? emptyInventory, {
        ...(parsed ? (next ? { explicit: parsed } : { saved: parsed }) : {}),
        ...(interactionMode === "plan" ? { agent: "plan" } : {}),
      });
      // Explicit/saved choices win over refreshed native configuration.
      const agent = resolved.agent ?? ctx.defaultAgent;
      const switchModel =
        resolved.model &&
        (!ctx.selectionVerified ||
          resolved.model.providerID !== ctx.nativeModel?.providerID ||
          resolved.model.id !== ctx.nativeModel?.id ||
          resolved.model.variant !== ctx.nativeModel?.variant)
          ? resolved.model
          : undefined;
      const switchAgent = agent !== ctx.activeAgent ? agent : undefined;
      if (switchModel || switchAgent) {
        const switched = yield* Effect.promise(() =>
          ctx.engine.switchSelection({
            ...(switchModel ? { model: switchModel } : {}),
            ...(switchAgent ? { agent: switchAgent } : {}),
          }),
        );
        if (!switched.success) {
          if (!switched.rejected)
            markLost(ctx, "Native interrupt outcome is uncertain; do not retry in this session.");
          return yield* new ProviderAdapterRequestError({
            provider,
            method: "session.switch",
            detail: switched.error.detail,
          });
        }
      }
      if (disposed || ctx.lost || sessions.get(ctx.session.threadId) !== ctx)
        return yield* unsupported("session.switch: context replaced");
      ctx.activeAgent = agent;
      ctx.selectionVerified = true;
      if (next) ctx.modelSelection = next;
      if (switchModel) {
        ctx.nativeModel = switchModel;
        effectiveModelSet(ctx, `${switchModel.providerID}/${switchModel.id}`);
        contextSnapshotEmit(ctx, ctx.active, { contextUsageStatus: "unknown" });
      }
    });

    const adapter: ProviderAdapterShape<
      | ProviderAdapterRequestError
      | ProviderAdapterValidationError
      | ProviderAdapterSessionNotFoundError
    > = {
      provider,
      capabilities: {
        sessionModelSwitch: "in-session",
        supportsConversationRollback: false,
      } as const,
      compaction: {
        type: "native",
        start: (threadId, modelSelection) =>
          Effect.gen(function* () {
            const ctx = yield* requireSession(threadId);
            // A sticky native switch interrupts work; compact must never use it to
            // bypass admission or manufacture safe completion of an existing turn.
            if (ctx.active || ctx.pending || ctx.manualCompacting)
              return yield* new ProviderAdapterRequestError({
                provider,
                method: "session.compact",
                detail: "Session already has active or pending work.",
              });
            ctx.manualCompacting = true;
            yield* selectionApply(ctx, modelSelection, "compactThread").pipe(
              Effect.onError(() =>
                Effect.sync(() => {
                  ctx.manualCompacting = false;
                }),
              ),
            );
            ctx.manualCompactionAdmitting = true;
            const admission = yield* Effect.promise(() => ctx.engine.compact());
            ctx.manualCompactionAdmitting = false;
            if (!admission.success) {
              ctx.manualCompacting = false;
              if (!admission.rejected)
                markLost(
                  ctx,
                  "Native compaction admission uncertain; do not retry in this session.",
                );
              return yield* new ProviderAdapterRequestError({
                provider,
                method: "session.compact",
                detail: admission.error.detail,
              });
            }
            if (ctx.lost || sessions.get(threadId) !== ctx)
              return yield* unsupported("session.compact: stream lost");
            const id = TurnId.make(admission.data.turnID);
            if (ctx.active !== id && ctx.lastSettled !== id) ctx.pending = id;
          }),
      },
      startSession: (input) =>
        Effect.gen(function* () {
          const generation = stopGeneration;
          if (disposed) return yield* unsupported("session.start: adapter disposed");
          if (input.runtimeMode !== "full-access")
            return yield* new ProviderAdapterValidationError({
              provider,
              operation: "startSession",
              issue: "Native v2 permission modes are not supported yet.",
            });
          const raw = input.resumeCursor;
          const cursor =
            raw !== null && typeof raw === "object" && !Array.isArray(raw)
              ? (raw as Record<string, unknown>)
              : undefined;
          if (
            raw !== undefined &&
            (cursor?.schemaVersion !== 1 ||
              typeof cursor.sessionId !== "string" ||
              !/^ses_[\w-]+$/.test(cursor.sessionId))
          )
            return yield* new ProviderAdapterValidationError({
              provider,
              operation: "startSession",
              issue: "Unrecognized native OpenCode resume cursor; refusing to start a new session.",
            });
          const resumeSessionId = cursor?.sessionId as string | undefined;
          const selection = input.modelSelection;
          const parsed = yield* nativeSelection("startSession", selection);
          if (sessions.has(input.threadId) || starting.has(input.threadId))
            return yield* new ProviderAdapterValidationError({
              provider,
              operation: "startSession",
              issue: "Session already started.",
            });
          const cwd = input.cwd ?? config.cwd;
          const inventory =
            options.inventory?.(cwd) ??
            (options.inventoryLoad
              ? yield* options.inventoryLoad(cwd).pipe(
                  Effect.mapError(
                    (cause) =>
                      new ProviderAdapterRequestError({
                        provider,
                        method: cause.operation,
                        detail: cause.detail,
                        cause,
                      }),
                  ),
                )
              : undefined);
          const resolved = openCodeNativeInventoryDefaultsResolve(
            inventory ?? emptyInventory,
            parsed ? { explicit: parsed } : {},
          );
          const defaultAgent = resolved.defaultAgent ?? "build";
          if (disposed || generation !== stopGeneration)
            return yield* unsupported("session.start: adapter stopped during inventory load");
          if (sessions.has(input.threadId) || starting.has(input.threadId))
            return yield* new ProviderAdapterValidationError({
              provider,
              operation: "startSession",
              issue: "Session already started.",
            });
          let ctx!: Context;
          let startLost = false;
          const engine = (options.engineCreate ?? openCodeNativeSessionEngineCreate)({
            url: options.url,
            ...(options.inventory ? { inventory: options.inventory } : {}),
            ...(options.serverPassword ? { serverPassword: options.serverPassword } : {}),
            onEvent: (event) => {
              if (event.type === "stream.lost") startLost = true;
              if (ctx) onEvent(ctx, event);
            },
          });
          const ownership = { engine, cancelled: false };
          starting.set(input.threadId, ownership);
          const started = yield* result(
            "session.start",
            engine.start({
              directory: cwd,
              ...(resumeSessionId ? { resumeSessionId } : {}),
              ...(input.title ? { title: input.title } : {}),
              ...(resolved.model ? { model: resolved.model } : {}),
              ...(resumeSessionId
                ? parsed?.agent
                  ? { agent: parsed.agent }
                  : {}
                : resolved.agent
                  ? { agent: resolved.agent }
                  : {}),
            }),
          ).pipe(
            Effect.onExit((exit) =>
              Effect.gen(function* () {
                if (starting.get(input.threadId) === ownership) starting.delete(input.threadId);
                if (
                  exit._tag === "Failure" ||
                  ownership.cancelled ||
                  startLost ||
                  disposed ||
                  generation !== stopGeneration
                )
                  yield* Effect.promise(() => engine.stop({ interrupt: false }));
              }),
            ),
          );
          if (disposed || generation !== stopGeneration || ownership.cancelled || startLost)
            return yield* new ProviderAdapterRequestError({
              provider,
              method: "session.start",
              detail: "Native session closed during start.",
            });
          const timestamp = now();
          ctx = {
            engine,
            sessionId: started.id,
            modelSelection: selection,
            inventory,
            nativeModel: resolved.model,
            defaultAgent,
            // Adoption preserves native state; start options do not reveal its stored agent.
            // Reconcile an unknown agent before admitting the resumed session's first input.
            activeAgent: resumeSessionId ? undefined : (resolved.agent ?? defaultAgent),
            selectionVerified: !resumeSessionId,
            usage: new Map(),
            unresolvedSteps: new Set(),
            lastCostUsd: undefined,
            settledCosts: new Map(),
            children: new Map(),
            modelGeneration: 0,
            stepModels: new Map(),
            contextLimits: new Map(),
            contextUsage: undefined,
            permissions: new Map(),
            forms: new Map(),
            settledRequests: new Set(),
            lost: false,
            recovery: undefined,
            active: undefined,
            pending: undefined,
            lastSettled: undefined,
            session: {
              provider,
              providerInstanceId: instanceId,
              threadId: input.threadId,
              cwd,
              ...(resolved.model
                ? { model: `${resolved.model.providerID}/${resolved.model.id}` }
                : {}),
              runtimeMode: input.runtimeMode,
              resumeCursor: { schemaVersion: 1, sessionId: started.id },
              status: "ready",
              createdAt: timestamp,
              updatedAt: timestamp,
            },
          };
          sessions.set(input.threadId, ctx);
          emit({ type: "session.started", ...base(ctx), payload: {} });
          emit({ type: "session.state.changed", ...base(ctx), payload: { state: "ready" } });
          emit({ type: "thread.started", ...base(ctx), payload: { providerThreadId: started.id } });
          return ctx.session;
        }),
      sendTurn: (input) =>
        Effect.gen(function* () {
          const ctx = yield* requireSession(input.threadId);
          if (ctx.manualCompacting)
            return yield* new ProviderAdapterRequestError({
              provider,
              method: "session.prompt",
              detail: "Manual compaction is still pending or settling.",
            });
          const text = input.input ?? "";
          const fileParts = toOpenCodeFileParts({
            attachments: input.attachments,
            resolveAttachmentPath: (attachment) =>
              resolveAttachmentPath({ attachmentsDir: config.attachmentsDir, attachment }),
          });
          if (!text.trim() && fileParts.length === 0)
            return yield* new ProviderAdapterValidationError({
              provider,
              operation: "sendTurn",
              issue: "OpenCode turns require text input or at least one attachment.",
            });
          // Inline supported files so a remote OpenCode server does not need access to T3's
          // attachment directory. Pasted text and unsupported/oversized files keep their
          // existing ProviderService prompt-path fallback instead of native file parts.
          const files = yield* Effect.forEach(fileParts, (part) =>
            fileSystem.readFile(NodeURL.fileURLToPath(part.url)).pipe(
              Effect.mapError(
                (cause) =>
                  new ProviderAdapterRequestError({
                    provider,
                    method: "session.prompt",
                    detail: cause.message,
                    cause,
                  }),
              ),
              Effect.map((bytes) => ({
                uri: `data:${part.mime.trim().toLowerCase()};base64,${Buffer.from(bytes).toString("base64")}`,
                ...(part.filename !== undefined ? { name: part.filename } : {}),
              })),
            ),
          );
          if (disposed || ctx.lost || sessions.get(input.threadId) !== ctx)
            return yield* unsupported("session.prompt: context replaced");
          yield* selectionApply(ctx, input.modelSelection, "sendTurn", input.interactionMode);
          const admission = yield* Effect.promise(() =>
            ctx.engine.send(text, files.length ? { files } : {}),
          );
          if (!admission.success) {
            if (!admission.rejected)
              markLost(ctx, "Native prompt admission uncertain; do not retry in this session.");
            return yield* new ProviderAdapterRequestError({
              provider,
              method: "session.prompt",
              detail: admission.error.detail,
            });
          }
          const started = admission.data;
          if (ctx.lost || sessions.get(input.threadId) !== ctx)
            return yield* unsupported("session.prompt: stream lost");
          const id = TurnId.make(started.turnID);
          if (ctx.active !== id && ctx.lastSettled !== id) ctx.pending = id;
          return { threadId: input.threadId, turnId: id };
        }),
      interruptTurn: (threadId, turnId) =>
        Effect.gen(function* () {
          const ctx = yield* requireSession(threadId);
          const inFlight = ctx.active ?? ctx.pending;
          if (!inFlight || (turnId && inFlight !== turnId)) return;
          const interrupted = yield* Effect.promise(() => ctx.engine.interrupt());
          if (!interrupted.success)
            markLost(ctx, "Native interrupt outcome is uncertain; do not retry in this session.");
          yield* result("session.interrupt", Promise.resolve(interrupted));
        }),
      stopSession: (threadId) =>
        Effect.gen(function* () {
          const ctx = sessions.get(threadId);
          if (!ctx) {
            const pending = starting.get(threadId);
            if (!pending)
              return yield* new ProviderAdapterSessionNotFoundError({ provider, threadId });
            pending.cancelled = true;
            yield* Effect.promise(() => pending.engine.stop({ interrupt: false }));
            return;
          }
          sessions.delete(threadId);
          if (ctx.recovery) yield* Fiber.interrupt(ctx.recovery);
          const stopped = yield* Effect.promise(() => ctx.engine.stop());
          if (!stopped.success) {
            if (!ctx.lost)
              emit({
                type: "session.exited",
                ...base(ctx),
                payload: {
                  reason: "Native session stopped locally; remote interrupt outcome is uncertain.",
                  recoverable: false,
                  exitKind: "error",
                },
              });
            return yield* result("session.stop", Promise.resolve(stopped));
          }
          if (!ctx.active && !ctx.pending) {
            for (const [childId, child] of ctx.children) {
              if (child.status !== "running") continue;
              emit({
                type: "runtime.warning",
                ...base(ctx, child.turnId),
                payload: {
                  message: `The outcome of related OpenCode child session ${childId} is unknown because the idle parent session was stopped.`,
                },
              });
            }
          }
          if (!ctx.lost)
            emit({ type: "session.exited", ...base(ctx), payload: { exitKind: "graceful" } });
        }),
      listSessions: () =>
        Effect.sync(() => [...sessions.values()].map((ctx) => ({ ...ctx.session }))),
      hasSession: (threadId) =>
        Effect.sync(() => sessions.has(threadId) && !sessions.get(threadId)!.lost),
      respondToRequest: (threadId, requestId, decision) =>
        Effect.gen(function* () {
          const ctx = yield* requireSession(threadId);
          if (ctx.settledRequests.has(`permission:${requestId}`)) return;
          if (!ctx.permissions.has(requestId))
            return yield* unsupported("respondToRequest: unknown request");
          const reply: "once" | "always" | "reject" =
            decision === "accept"
              ? "once"
              : decision === "acceptForSession" || decision === "acceptAlways"
                ? "always"
                : "reject";
          yield* result("permission.reply", ctx.engine.replyPermission(requestId, reply));
        }),
      respondToUserInput: (threadId, requestId, answers) =>
        Effect.gen(function* () {
          const ctx = yield* requireSession(threadId);
          if (ctx.settledRequests.has(`form:${requestId}`)) return;
          const form = ctx.forms.get(requestId);
          if (!form) return yield* unsupported("respondToUserInput: unknown form");
          if (!formSupported(form)) {
            if (
              Object.keys(answers).length !== 0 &&
              (Object.keys(answers).length !== 1 || answers["native-form-action"] !== "cancel")
            )
              return yield* new ProviderAdapterValidationError({
                provider,
                operation: "respondToUserInput",
                issue:
                  "Unsupported native form can only be cancelled here or answered in the native client.",
              });
            yield* result("session.form.cancel", ctx.engine.replyForm(requestId, undefined));
            return;
          }
          // An explicit empty answer cancels the native form; never submit invented defaults.
          const answer = Object.keys(answers).length ? formAnswer(form, answers) : undefined;
          if (Object.keys(answers).length && !answer)
            return yield* new ProviderAdapterValidationError({
              provider,
              operation: "respondToUserInput",
              issue: "Invalid native form answer.",
            });
          yield* result("session.form.reply", ctx.engine.replyForm(requestId, answer));
        }),
      readThread: () => unsupported("readThread"),
      rollbackThread: () => unsupported("rollbackThread"),
      stopAll: () =>
        Effect.gen(function* () {
          stopGeneration++;
          let firstError: ProviderAdapterRequestError | undefined;
          const pendingStarts = [...starting.values()];
          const contexts = [...sessions.values()];
          for (const pending of pendingStarts) pending.cancelled = true;
          sessions.clear();
          for (const pending of pendingStarts)
            yield* Effect.promise(() => pending.engine.stop({ interrupt: false }));
          for (const ctx of contexts) {
            if (ctx.recovery) yield* Fiber.interrupt(ctx.recovery);
            const stopped = yield* Effect.result(result("session.stop", ctx.engine.stop()));
            if (Result.isFailure(stopped)) {
              if (!ctx.lost)
                emit({
                  type: "session.exited",
                  ...base(ctx),
                  payload: {
                    reason:
                      "Native session stopped locally; remote interrupt outcome is uncertain.",
                    recoverable: false,
                    exitKind: "error",
                  },
                });
              firstError ??= stopped.failure;
            } else if (!ctx.lost) {
              emit({ type: "session.exited", ...base(ctx), payload: { exitKind: "graceful" } });
            }
          }
          if (firstError) return yield* firstError;
        }),
      streamEvents: Stream.fromQueue(bus),
    };
    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        // Permanent scope closure must fence admission before any asynchronous cleanup.
        disposed = true;
        yield* adapter.stopAll();
      }).pipe(
        Effect.ensuring(Effect.all([Queue.shutdown(bus), Queue.shutdown(losses)])),
        Effect.orDie,
      ),
    );
    return adapter;
  });
