// @effect-diagnostics nodeBuiltinImport:off globalDate:off - native client runs in Node.
import * as NodeCrypto from "node:crypto";

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
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Scope from "effect/Scope";
import * as Queue from "effect/Queue";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";

import { ServerConfig } from "../../config.ts";
import {
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
} from "../Errors.ts";
import { openCodeNativeSessionEngineCreate } from "../openCodeNativeSessionEngineCreate.ts";
import type { OpenCodeNativeInventory } from "../openCodeNativeInventorySchema.ts";
import type { ProviderAdapterShape } from "../Services/ProviderAdapter.ts";

const provider = ProviderDriverKind.make("opencode");
type NativeEvent = Parameters<
  Parameters<typeof openCodeNativeSessionEngineCreate>[0]["onEvent"]
>[0];
type Engine = ReturnType<typeof openCodeNativeSessionEngineCreate>;
type Selection = ProviderSessionStartInput["modelSelection"];
const selectionEquals = (a: NonNullable<Selection>, b: Selection) =>
  b !== undefined &&
  a.instanceId === b.instanceId &&
  a.model === b.model &&
  (a.options ?? []).length === (b.options ?? []).length &&
  (a.options ?? []).every((option) =>
    (b.options ?? []).some((prior) => prior.id === option.id && prior.value === option.value),
  );
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
    if (value === undefined || value === "") {
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
      (field.options?.length &&
        !field.custom &&
        !field.options.some((option) => option.value === value)) ||
      (field.minLength !== undefined && value.length < field.minLength) ||
      (field.maxLength !== undefined && value.length > field.maxLength)
    )
      return;
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
      !field.options?.length),
  multiSelect: field.type === "multiselect",
});
type ChildEvent = Extract<NativeEvent, { type: "child.attached" | "child.updated" }>;
type StepAccounting = {
  readonly cost: number;
  readonly tokens?: Extract<NativeEvent, { type: "step.completed" }>["step"]["tokens"];
  readonly completed: boolean;
};
type Child = {
  readonly turnId: TurnId;
  readonly parentId: string;
  parentToolKey: string | undefined;
  info: ChildEvent["info"];
  status: "running" | "completed" | "failed" | "stopped";
  readonly steps: Map<string, StepAccounting>;
  readonly unresolvedSteps: Set<string>;
  readonly tools: Set<string>;
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
  modelSelection: ProviderSessionStartInput["modelSelection"];
  selectionVerified: boolean;
  readonly fragments: Map<string, string>;
  readonly usage: Map<string, StepAccounting>;
  readonly unresolvedSteps: Set<string>;
  lastCostUsd: number | undefined;
  readonly settledCosts: Map<TurnId, SettledCostAccounting>;
  readonly children: Map<string, Child>;
  /** undefined = not looked up yet, null = server reported no limit. */
  contextLimit: number | null | undefined;
  readonly permissions: Map<string, Extract<NativeEvent, { type: "permission.asked" }>["request"]>;
  readonly forms: Map<string, NativeForm>;
  readonly settledRequests: Set<string>;
  active: TurnId | undefined;
  pending: TurnId | undefined;
  lastSettled: TurnId | undefined;
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
}) =>
  Effect.gen(function* () {
    const config = yield* ServerConfig;
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
      operation: "startSession" | "sendTurn",
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
    const tokenUsage = (ctx: Context): TurnTokenUsage | undefined => {
      if (!ctx.usage.size) return undefined;
      const totals = [...ctx.usage.values()].flatMap((step) => (step.tokens ? [step.tokens] : []));
      if (!totals.length) return undefined;
      return {
        usageScope: "main_agent",
        usageStatus: totals.length === ctx.usage.size ? "complete" : "partial",
        hasSubagents: [...ctx.children.values()].some((child) => child.turnId === ctx.active),
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
        steps.delete(id);
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
      const children = [...ctx.children.values()].filter((child) => child.turnId === turnId);
      if (
        complete &&
        (accounting.unresolvedSteps.size > 0 ||
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
          if (!Number.isFinite(step.cost) || step.cost < 0) {
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
      const model = ctx.active === turnId ? ctx.session.model : ctx.settledCosts.get(turnId)?.model;
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
      if (
        !accounting ||
        [...ctx.children.values()].some(
          (child) => child.turnId === turnId && child.status === "running",
        )
      )
        return;
      const cost = turnCost(ctx, turnId, true, accounting);
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
          ...(accounting.model ? { costModel: accounting.model } : {}),
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
      if (!child.steps.size && !child.tools.size) return undefined;
      const steps = [...child.steps.values()];
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
        toolUses: child.tools.size,
        costUsd: steps.reduce((n, step) => n + step.cost, 0),
      };
    };
    // The last step's prompt size is the live context size (same rule as the legacy adapter).
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
      const usedTokens = inputTokens + n(tokens.output);
      if (usedTokens <= 0) return;
      const emitUsage = () =>
        emit({
          type: "thread.token-usage.updated",
          ...base(ctx, turnId),
          payload: {
            usage: {
              usedTokens,
              lastUsedTokens: usedTokens,
              ...(ctx.contextLimit ? { maxTokens: ctx.contextLimit } : {}),
              inputTokens,
              cachedInputTokens: n(tokens.cache.read),
              outputTokens: n(tokens.output),
              reasoningOutputTokens: n(tokens.reasoning),
              lastInputTokens: inputTokens,
              lastCachedInputTokens: n(tokens.cache.read),
              lastOutputTokens: n(tokens.output),
              lastReasoningOutputTokens: n(tokens.reasoning),
            },
          },
        });
      const [providerID, ...rest] = ctx.session.model?.split("/") ?? [];
      if (ctx.contextLimit !== undefined || !providerID || !rest.length) return emitUsage();
      void ctx.engine
        .contextLimit({ providerID, id: rest.join("/") })
        .then((limit) => {
          ctx.contextLimit = limit ?? null;
        })
        .finally(() => {
          if (!ctx.lost && sessions.get(ctx.session.threadId) === ctx) emitUsage();
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
          if (child || (!parent && ctx.active !== childEvent.turnID)) return;
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
        if (
          !child ||
          child.parentId !== childEvent.parentSessionID ||
          child.turnId !== childEvent.turnID ||
          child.status !== "running"
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
        emit({
          type: "task.completed",
          ...base(ctx, child.turnId),
          payload: {
            taskId: RuntimeTaskId.make(childEvent.sessionID),
            status: child.status,
            ...(childEvent.type === "child.completed" && childEvent.summary?.trim()
              ? { summary: childEvent.summary }
              : {}),
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
        if (!child || child.status !== "running" || event.turnID !== child.turnId) return;
        if (event.type === "step.started" || event.type === "step.streamed") {
          if (!child.steps.has(event.step.assistantMessageID))
            child.unresolvedSteps.add(event.step.assistantMessageID);
          return;
        }
        if (event.type === "step.failed") {
          failedStepRecord(child.steps, child.unresolvedSteps, event.step);
          turnCostEmit(ctx, child.turnId);
        } else if (event.type === "step.completed") {
          child.unresolvedSteps.delete(event.step.assistantMessageID);
          child.steps.set(event.step.assistantMessageID, {
            tokens: event.step.tokens,
            cost: event.step.cost,
            completed: true,
          });
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
        if (
          cost === undefined &&
          [...ctx.children.values()].some(
            (child) => child.turnId === id && child.status === "running",
          )
        )
          ctx.settledCosts.set(id, {
            usage: new Map(ctx.usage),
            unresolvedSteps: new Set(ctx.unresolvedSteps),
            lastCostUsd: ctx.lastCostUsd,
            model: ctx.session.model,
          });
        ctx.active = undefined;
        ctx.usage.clear();
        ctx.unresolvedSteps.clear();
        ctx.fragments.clear();
        ctx.session = {
          ...ctx.session,
          status: "ready",
          activeTurnId: undefined,
          updatedAt: now(),
        };
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
                        ...(ctx.session.model ? { costModel: ctx.session.model } : {}),
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
                        ...(ctx.session.model ? { costModel: ctx.session.model } : {}),
                      }
                    : {}),
                },
        });
        return;
      }
      if (event.type === "step.started" || event.type === "step.streamed") {
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
          turnCostEmit(ctx, turnId);
        }
        return;
      }
      if (event.type === "step.completed") {
        if (turnId && event.turnID === turnId && event.sessionID === ctx.sessionId) {
          ctx.unresolvedSteps.delete(event.step.assistantMessageID);
          ctx.usage.set(event.step.assistantMessageID, {
            tokens: event.step.tokens,
            cost: event.step.cost,
            completed: true,
          });
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
        ctx.fragments.set(event.key, "");
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
        ctx.fragments.set(event.key, (ctx.fragments.get(event.key) ?? "") + event.delta);
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
        const prior = ctx.fragments.get(event.key) ?? "";
        if (event.text.startsWith(prior) && event.text.length > prior.length)
          emit({
            type: "content.delta",
            ...base(ctx, turnId),
            itemId,
            payload: {
              streamKind: event.type === "text.completed" ? "assistant_text" : "reasoning_text",
              delta: event.text.slice(prior.length),
            },
          });
        ctx.fragments.delete(event.key);
        emit({
          type: "item.completed",
          ...base(ctx, turnId),
          itemId,
          payload: {
            itemType: event.type === "text.completed" ? "assistant_message" : "reasoning",
            status: "completed",
            detail: event.text || undefined,
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
              ...(event.type === "tool.progress" ? { metadata: event.tool.metadata } : {}),
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
              ...(parsed?.agent ? { agent: parsed.agent } : {}),
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
            selectionVerified: false,
            session: {
              ...previous.session,
              status: "ready",
              activeTurnId: undefined,
              lastError: undefined,
              updatedAt: now(),
            },
            fragments: new Map(),
            usage: new Map(),
            unresolvedSteps: new Set(),
            lastCostUsd: undefined,
            settledCosts: new Map(),
            children: new Map(),
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
          if (disposed || generation !== stopGeneration)
            return yield* unsupported("session.start: adapter stopped");
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
              ...(parsed?.model ? { model: parsed.model } : {}),
              ...(parsed?.agent ? { agent: parsed.agent } : {}),
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
            selectionVerified: !resumeSessionId,
            fragments: new Map(),
            usage: new Map(),
            unresolvedSteps: new Set(),
            lastCostUsd: undefined,
            settledCosts: new Map(),
            children: new Map(),
            contextLimit: undefined,
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
              ...(selection ? { model: selection.model } : {}),
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
          const text = input.input ?? "";
          if (
            !text.trim() ||
            input.attachments?.length ||
            input.continuation ||
            input.interactionMode === "plan"
          )
            return yield* new ProviderAdapterValidationError({
              provider,
              operation: "sendTurn",
              issue:
                "Native v2 currently supports plain text turns only (no attachments, plan mode or continuation).",
            });
          if (disposed || ctx.lost || sessions.get(input.threadId) !== ctx)
            return yield* unsupported("session.prompt: context replaced");
          if (!ctx.selectionVerified && (ctx.active || ctx.pending))
            return yield* new ProviderAdapterRequestError({
              provider,
              method: "session.switch",
              detail: "Wait for native work to settle before reasserting an unverified selection.",
            });
          const next = input.modelSelection;
          const desired = next ?? ctx.modelSelection;
          if (!ctx.selectionVerified || (next && !selectionEquals(next, ctx.modelSelection))) {
            const parsed = yield* nativeSelection("sendTurn", desired);
            const prior = ctx.modelSelection;
            const priorVariant = prior?.options?.find((option) => option.id === "variant")?.value;
            const priorAgent = prior?.options?.find((option) => option.id === "agent")?.value;
            // OpenCode switches are sticky setters: only send the parts that changed. A running
            // turn is interrupted first, so this prompt starts a new turn on the new selection.
            const switchModel =
              parsed?.model &&
              (!ctx.selectionVerified ||
                desired?.model !== ctx.session.model ||
                parsed.model.variant !== priorVariant)
                ? parsed.model
                : undefined;
            const switchAgent = !ctx.selectionVerified
              ? (parsed?.agent ?? "build")
              : parsed?.agent && parsed.agent !== priorAgent
                ? parsed.agent
                : undefined;
            if (switchModel || switchAgent) {
              const switched = yield* Effect.promise(() =>
                ctx.engine.switchSelection({
                  ...(switchModel ? { model: switchModel } : {}),
                  ...(switchAgent ? { agent: switchAgent } : {}),
                }),
              );
              if (!switched.success) {
                // An unconfirmed interrupt may leave the old turn running; fail closed.
                if (!switched.rejected)
                  markLost(
                    ctx,
                    "Native interrupt outcome is uncertain; do not retry in this session.",
                  );
                return yield* new ProviderAdapterRequestError({
                  provider,
                  method: "session.switch",
                  detail: switched.error.detail,
                });
              }
            }
            if (disposed || ctx.lost || sessions.get(input.threadId) !== ctx)
              return yield* unsupported("session.prompt: context replaced");
            ctx.selectionVerified = true;
            if (next) ctx.modelSelection = next;
            if (switchModel && desired) {
              ctx.contextLimit = undefined;
              ctx.session = { ...ctx.session, model: desired.model, updatedAt: now() };
            }
          }
          const admission = yield* Effect.promise(() => ctx.engine.send(text));
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
