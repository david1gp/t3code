import * as NodeCrypto from "node:crypto";

import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";

import type { FormInfo, PermissionRequest, V2Event } from "@opencode/client";

import { openCodeNativeClientCreate } from "./openCodeNativeClientCreate.ts";
import { OpenCodeRuntimeError } from "./opencodeRuntime.ts";

type Result<T> =
  | { readonly success: true; readonly data: T }
  | { readonly success: false; readonly error: OpenCodeRuntimeError; readonly rejected?: true };

type Session = { readonly id: string; readonly location: { readonly directory: string } };
const fields = Schema.Record(Schema.String, Schema.Unknown);
const nativeError = Schema.Struct({
  type: Schema.String,
  message: Schema.String,
  status: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 100, maximum: 599 }))),
});
const tokens = Schema.Struct({
  input: Schema.Finite,
  output: Schema.Finite,
  reasoning: Schema.Finite,
  cache: Schema.Struct({ read: Schema.Finite, write: Schema.Finite }),
});
const content = Schema.Array(
  Schema.Union([
    Schema.Struct({ type: Schema.Literal("text"), text: Schema.String }),
    Schema.Struct({
      type: Schema.Literal("file"),
      uri: Schema.String,
      mime: Schema.String,
      name: Schema.optionalKey(Schema.String),
    }),
  ]),
).check(Schema.isMinLength(1));
const base = { sessionID: Schema.String };
const assistant = { ...base, assistantMessageID: Schema.String };
const fragment = { ...assistant, ordinal: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)) };
const tool = { ...assistant, id: Schema.String };
const accounting = { cost: Schema.Finite, tokens };
const finish = Schema.Literals([
  "stop",
  "length",
  "tool-calls",
  "content-filter",
  "error",
  "unknown",
]);
const stepEnd = {
  ...assistant,
  finish,
  rawFinish: Schema.optionalKey(Schema.String),
  providerState: Schema.optionalKey(fields),
  ...accounting,
  snapshot: Schema.optionalKey(Schema.String),
  files: Schema.optionalKey(Schema.Array(Schema.String)),
};
const stepFailure = {
  ...assistant,
  error: nativeError,
  finish: Schema.optionalKey(Schema.Literal("content-filter")),
  rawFinish: Schema.optionalKey(Schema.String),
  providerState: Schema.optionalKey(fields),
  cost: Schema.optionalKey(Schema.Finite),
  tokens: Schema.optionalKey(tokens),
  snapshot: Schema.optionalKey(Schema.String),
  files: Schema.optionalKey(Schema.Array(Schema.String)),
};
const event = <const T extends string, F extends Schema.Struct.Fields>(type: T, data: F) =>
  Schema.Struct({
    id: Schema.String.check(Schema.isStartsWith("evt_")),
    created: Schema.Finite,
    type: Schema.Literal(type),
    data: Schema.Struct(data),
  });

// Public payloads from v2.0.18 packages/schema/src/session-event.ts, not SDK/v2
// or dev. Opaque provider state stays opaque; accounting retains native units.
const nativeEvent = Schema.Union([
  event("session.created", {
    ...base,
    parentID: Schema.optionalKey(Schema.String),
    location: Schema.Struct({ directory: Schema.String }),
    projectID: Schema.String,
    slug: Schema.String,
    title: Schema.optionalKey(Schema.String),
    agent: Schema.optionalKey(Schema.String),
    model: Schema.optionalKey(Schema.Struct({ id: Schema.String, providerID: Schema.String })),
    version: Schema.String,
  }),
  event("session.execution.started", base),
  event("session.execution.succeeded", base),
  event("session.execution.failed", { ...base, error: nativeError }),
  event("session.execution.interrupted", {
    ...base,
    reason: Schema.Literals(["user", "shutdown", "superseded", "inactivity"]),
  }),
  event("session.step.started", {
    ...assistant,
    agent: Schema.String,
    model: Schema.Struct({
      id: Schema.String,
      providerID: Schema.String,
      variant: Schema.optionalKey(Schema.String),
    }),
    started: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    snapshot: Schema.optionalKey(Schema.String),
  }),
  event("session.step.streamed", assistant),
  event("session.step.ended", stepEnd),
  event("session.step.failed", stepFailure),
  event("session.text.started", fragment),
  event("session.text.delta", { ...fragment, delta: Schema.String }),
  event("session.text.ended", {
    ...fragment,
    text: Schema.String,
    state: Schema.optionalKey(fields),
  }),
  event("session.reasoning.started", { ...fragment, state: Schema.optionalKey(fields) }),
  event("session.reasoning.delta", { ...fragment, delta: Schema.String }),
  event("session.reasoning.ended", {
    ...fragment,
    text: Schema.String,
    state: Schema.optionalKey(fields),
  }),
  event("session.tool.input.started", { ...tool, name: Schema.String }),
  event("session.tool.input.delta", { ...tool, delta: Schema.String }),
  event("session.tool.input.ended", { ...tool, text: Schema.String }),
  event("session.tool.called", {
    ...tool,
    input: fields,
    executed: Schema.Boolean,
    state: Schema.optionalKey(fields),
  }),
  event("session.tool.progress", { ...tool, metadata: fields }),
  event("session.tool.success", {
    ...tool,
    content,
    executed: Schema.Boolean,
    metadata: Schema.optionalKey(fields),
    resultState: Schema.optionalKey(fields),
  }),
  event("session.tool.failed", {
    ...tool,
    error: nativeError,
    executed: Schema.Boolean,
    content: Schema.optionalKey(content),
    metadata: Schema.optionalKey(fields),
    resultState: Schema.optionalKey(fields),
  }),
  event("session.usage.updated", { ...base, ...accounting }),
  event("session.synthetic", {
    ...base,
    text: Schema.String,
    description: Schema.optionalKey(Schema.String),
    metadata: Schema.optionalKey(fields),
  }),
]);
type NativeEvent = typeof nativeEvent.Type;
type Data<T extends NativeEvent["type"]> = Extract<NativeEvent, { type: T }>["data"];
const nativeEventFromClient = (message: V2Event) =>
  Schema.decodeUnknownExit(nativeEvent)({
    id: message.id,
    created: "created" in message ? message.created : undefined,
    type: message.type,
    data: message.data,
  });
const REQUEST_TIMEOUT_MS = 15_000;
const requestWithDeadline = async <T>(
  parent: AbortSignal | undefined,
  perform: (signal: AbortSignal) => Promise<T>,
): Promise<T> => {
  const deadline = new AbortController();
  // @effect-diagnostics-next-line globalTimers:off -- Native client HTTP calls run outside an Effect runtime.
  const timer = setTimeout(
    () => deadline.abort(new Error("Native request deadline exceeded.")),
    REQUEST_TIMEOUT_MS,
  );
  try {
    return await perform(parent ? AbortSignal.any([parent, deadline.signal]) : deadline.signal);
  } finally {
    clearTimeout(timer);
  }
};
type Scope = {
  readonly turnID: string;
  readonly sessionID: string;
  readonly parentToolKey?: string;
  readonly parentSessionID?: string;
};
type ChildInfo = {
  readonly title?: string;
  readonly agent?: string;
  readonly model?: { readonly id: string; readonly providerID: string };
  readonly directory?: string;
};
type ToolSnapshot = {
  readonly id: string;
  readonly assistantMessageID: string;
  readonly name: string;
  readonly inputText: string;
  readonly input?: Readonly<Record<string, unknown>>;
  readonly executed?: boolean;
  readonly state?: Readonly<Record<string, unknown>>;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly resultState?: Readonly<Record<string, unknown>>;
};
type FragmentEvent = Scope & {
  readonly key: string;
  readonly assistantMessageID: string;
  readonly ordinal: number;
} & (
    | {
        readonly type: "text.started" | "reasoning.started";
        readonly state?: Readonly<Record<string, unknown>>;
      }
    | { readonly type: "text.delta" | "reasoning.delta"; readonly delta: string }
    | {
        readonly type: "text.completed" | "reasoning.completed";
        readonly text: string;
        readonly state?: Readonly<Record<string, unknown>>;
      }
  );
type ToolEventBase = Scope & { readonly key: string };
type Event =
  | { readonly type: "session.ready"; readonly sessionID: string }
  | { readonly type: "turn.started"; readonly turnID: string }
  | {
      readonly type: "permission.asked";
      readonly turnID: string;
      readonly request: PermissionRequest;
    }
  | {
      readonly type: "permission.replied";
      readonly turnID: string;
      readonly sessionID: string;
      readonly requestID: string;
      readonly decision?: "once" | "always" | "reject";
    }
  | { readonly type: "form.created"; readonly turnID: string; readonly form: FormInfo }
  | {
      readonly type: "form.resolved";
      readonly turnID: string;
      readonly sessionID: string;
      readonly formID: string;
      readonly answer: Readonly<Record<string, unknown>>;
    }
  | FragmentEvent
  | (Scope & { readonly type: "step.started"; readonly step: Data<"session.step.started"> })
  | (Scope & { readonly type: "step.streamed"; readonly step: Data<"session.step.streamed"> })
  | (Scope & { readonly type: "step.completed"; readonly step: Data<"session.step.ended"> })
  | (Scope & { readonly type: "step.failed"; readonly step: Data<"session.step.failed"> })
  | (ToolEventBase & {
      readonly type: "tool.started" | "tool.input.completed";
      readonly tool: ToolSnapshot;
    })
  | (ToolEventBase & {
      readonly type: "tool.called";
      readonly tool: ToolSnapshot & {
        readonly input: typeof fields.Type;
        readonly executed: boolean;
      };
    })
  | (ToolEventBase & {
      readonly type: "tool.progress";
      readonly tool: ToolSnapshot & { readonly metadata: typeof fields.Type };
    })
  | (ToolEventBase & {
      readonly type: "tool.input.delta";
      readonly tool: ToolSnapshot;
      readonly delta: string;
    })
  | (ToolEventBase & {
      readonly type: "tool.completed";
      readonly tool: ToolSnapshot & {
        readonly content: typeof content.Type;
        readonly executed: boolean;
      };
    })
  | (ToolEventBase & {
      readonly type: "tool.failed";
      readonly tool: ToolSnapshot & {
        readonly error: typeof nativeError.Type;
        readonly content?: typeof content.Type;
        readonly executed: boolean;
      };
    })
  | (Scope & { readonly type: "child.attached" | "child.updated"; readonly info: ChildInfo })
  | (Scope & { readonly type: "child.started" })
  | (Scope & { readonly type: "child.completed"; readonly summary?: string })
  | (Scope & { readonly type: "child.failed"; readonly error: typeof nativeError.Type })
  | (Scope & {
      readonly type: "child.interrupted";
      readonly reason: Data<"session.execution.interrupted">["reason"] | "cancelled";
    })
  | {
      readonly type: "usage.updated";
      readonly sessionID: string;
      readonly scope: "session";
      readonly cost: number;
      readonly tokens: typeof tokens.Type;
    }
  | { readonly type: "turn.completed"; readonly turnID: string }
  | {
      readonly type: "turn.failed";
      readonly turnID: string;
      readonly reason: "failed";
      readonly error: typeof nativeError.Type;
    }
  | {
      readonly type: "turn.failed";
      readonly turnID: string;
      readonly reason: "interrupted";
      readonly interruptionReason: Data<"session.execution.interrupted">["reason"];
    }
  | { readonly type: "stream.lost"; readonly sessionID: string };

type Block = {
  readonly kind: "text" | "reasoning";
  readonly assistantMessageID: string;
  readonly ordinal: number;
  text: string;
  ended: boolean;
};
type Work = {
  scope: Scope;
  info: ChildInfo;
  started: boolean;
  terminal: boolean;
  readonly blocks: Map<string, Block>;
  readonly tools: Map<
    string,
    { snapshot: ToolSnapshot; inputEnded: boolean; called: boolean; ended: boolean }
  >;
  readonly steps: Map<string, { started: boolean; streamed: boolean; ended: boolean }>;
};
const workCreate = (scope: Scope): Work => ({
  scope,
  info: {},
  started: false,
  terminal: false,
  blocks: new Map(),
  tools: new Map(),
  steps: new Map(),
});
const boundedAdd = (set: Set<string>, key: string) => {
  set.add(key);
  if (set.size > 4096) {
    const oldest = set.values().next().value;
    if (oldest !== undefined) set.delete(oldest);
  }
};

const fail = (operation: string, detail: string): Result<never> => ({
  success: false,
  error: new OpenCodeRuntimeError({ operation, detail }),
});
const rejectSend = (detail: string): Result<never> => ({
  success: false,
  error: new OpenCodeRuntimeError({ operation: "session.prompt", detail }),
  rejected: true,
});

const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const sessionFrom = (body: unknown): Session | undefined => {
  const value = record(body);
  const location = record(value?.location);
  if (typeof value?.id !== "string" || !/^ses_[\w-]+$/.test(value.id)) return;
  if (typeof location?.directory !== "string") return;
  return { id: value.id, location: { directory: location.directory } };
};

/** v2.0.18 standalone session engine. One engine owns one session.
 * The experimental session log is not a safe reconnect source in this release: Bus.configured
 * defaults to persist=false (server routes only enable it when configured), and log.synced
 * reports the sequence watermark even when no event rows were retained. There is no complete
 * session-event snapshot API or retention/gap proof. An idle session may have finished a turn
 * while T3 was offline; never adopt it based on current state alone. */
export const openCodeNativeSessionEngineCreate = (input: {
  readonly url: string;
  readonly serverPassword?: string;
  readonly fetch?: typeof fetch;
  readonly onEvent: (event: Event) => void;
}) => {
  const client = openCodeNativeClientCreate(input);
  let session: Session | undefined;
  let abort: AbortController | undefined;
  let connected = false;
  let active: Work | undefined;
  let lastTurnID: string | undefined;
  const children = new Map<string, Work>();
  const childParents = new Map<string, string>();
  const retiredMessages = new Set<string>();
  let admitting = false;
  let uncertain = false;
  let disconnected = false;
  let admissionEvents: V2Event[] = [];
  const permissions = new Map<
    string,
    { request: PermissionRequest; turnID: string; replying: boolean }
  >();
  const forms = new Map<string, { form: FormInfo; turnID: string; replying: boolean }>();
  const settledRequests = new Set<string>();

  const requestSettle = (
    kind: "permission" | "form",
    id: string,
    sessionID: string,
    answer?: Readonly<Record<string, unknown>>,
    decision?: "once" | "always" | "reject",
  ) => {
    if (sessionID !== session?.id || settledRequests.has(`${kind}:${id}`)) return;
    const pending = kind === "permission" ? permissions.get(id) : forms.get(id);
    if (!pending) return;
    settledRequests.add(`${kind}:${id}`);
    if (kind === "permission") {
      permissions.delete(id);
      emit({
        type: "permission.replied",
        turnID: pending.turnID,
        sessionID,
        requestID: id,
        ...(decision ? { decision } : {}),
      });
      return;
    }
    forms.delete(id);
    emit({
      type: "form.resolved",
      turnID: pending.turnID,
      sessionID,
      formID: id,
      answer: answer ?? {},
    });
  };
  const permissionOpen = (request: PermissionRequest) => {
    if (!session || !lastTurnID) return;
    if (
      request.sessionID !== session.id ||
      !request.id?.trim() ||
      !request.action?.trim() ||
      !Array.isArray(request.resources) ||
      permissions.has(request.id) ||
      settledRequests.has(`permission:${request.id}`)
    )
      return;
    permissions.set(request.id, { request, turnID: lastTurnID, replying: false });
    emit({ type: "permission.asked", turnID: lastTurnID, request });
  };
  const formOpen = (form: FormInfo) => {
    if (
      !session ||
      !lastTurnID ||
      form.sessionID !== session.id ||
      !form.id?.trim() ||
      !form.title?.trim() ||
      !Array.isArray(form.fields) ||
      !form.fields.length ||
      forms.has(form.id) ||
      settledRequests.has(`form:${form.id}`)
    )
      return;
    forms.set(form.id, { form, turnID: lastTurnID, replying: false });
    emit({ type: "form.created", turnID: lastTurnID, form });
  };
  const dispatch = (message: V2Event) => {
    if (message.type === "permission.replied") {
      requestSettle(
        "permission",
        message.data.requestID,
        message.data.sessionID,
        undefined,
        message.data.reply,
      );
      return;
    }
    if (message.type === "form.replied" || message.type === "form.cancelled") {
      requestSettle(
        "form",
        message.data.id,
        message.data.sessionID,
        message.type === "form.replied" ? message.data.answer : {},
      );
      return;
    }
    if (message.type === "permission.asked") {
      permissionOpen(message.data);
      return;
    }
    if (message.type === "form.created") {
      formOpen(message.data.form);
      return;
    }
    const decoded = nativeEventFromClient(message);
    if (Exit.isSuccess(decoded)) translate(decoded.value);
  };
  const reconcilePending = async (closeMissing = true): Promise<Result<void>> => {
    if (!session || !connected || disconnected || !lastTurnID)
      return fail("session.pending", "Native session is not ready for pending requests.");
    const id = session.id;
    try {
      const [pendingPermissions, pendingForms] = await Promise.all([
        requestWithDeadline(abort?.signal, (signal) =>
          client.permission.list({ sessionID: id }, { signal }),
        ),
        requestWithDeadline(abort?.signal, (signal) =>
          client.session.form.list({ sessionID: id }, { signal }),
        ),
      ]);
      if (disconnected || session?.id !== id)
        return fail("session.pending", "Native event stream lost during pending reconciliation.");
      for (const request of pendingPermissions) permissionOpen(request);
      for (const form of pendingForms) formOpen(form);
      if (closeMissing) {
        const permissionIDs = new Set(pendingPermissions.map((request) => request.id));
        const formIDs = new Set(pendingForms.map((form) => form.id));
        for (const requestID of permissions.keys()) {
          if (!permissionIDs.has(requestID)) requestSettle("permission", requestID, id);
        }
        for (const formID of forms.keys()) {
          if (!formIDs.has(formID)) requestSettle("form", formID, id);
        }
      }
      return { success: true, data: undefined };
    } catch (cause) {
      return fail(
        "session.pending",
        cause instanceof Error ? cause.message : "Native pending request reconciliation failed.",
      );
    }
  };

  const emit = (event: Event) => input.onEvent(event);
  const workStart = (work: Work) => {
    if (work.started || work.terminal) return;
    work.started = true;
    if (work.scope.parentSessionID) emit({ type: "child.started", ...work.scope });
    else emit({ type: "turn.started", turnID: work.scope.turnID });
  };
  const itemsSettle = (
    work: Work,
    error?: typeof nativeError.Type,
    assistantMessageID?: string,
  ) => {
    const unfinished = error ?? {
      type: "native.incomplete",
      message: "Execution ended before item settlement.",
    };
    for (const [key, block] of work.blocks) {
      if (block.ended || (assistantMessageID && block.assistantMessageID !== assistantMessageID))
        continue;
      block.ended = true;
      emit({
        type: `${block.kind}.completed`,
        ...work.scope,
        key,
        assistantMessageID: block.assistantMessageID,
        ordinal: block.ordinal,
        text: block.text,
      });
    }
    for (const [key, item] of work.tools) {
      if (
        item.ended ||
        (assistantMessageID && item.snapshot.assistantMessageID !== assistantMessageID)
      )
        continue;
      item.ended = true;
      if (!item.inputEnded)
        emit({ type: "tool.input.completed", ...work.scope, key, tool: item.snapshot });
      emit({
        type: "tool.failed",
        ...work.scope,
        key,
        tool: { ...item.snapshot, executed: item.snapshot.executed ?? false, error: unfinished },
      });
    }
  };
  const workSettle = (work: Work, error?: typeof nativeError.Type) => {
    work.terminal = true;
    itemsSettle(work, error);
    const unfinished = error ?? {
      type: "native.incomplete",
      message: "Execution ended before step settlement.",
    };
    for (const [assistantMessageID, step] of work.steps) {
      boundedAdd(retiredMessages, `${work.scope.sessionID}:${assistantMessageID}`);
      if (step.ended || !step.started) continue;
      step.ended = true;
      emit({
        type: "step.failed",
        ...work.scope,
        step: { sessionID: work.scope.sessionID, assistantMessageID, error: unfinished },
      });
    }
  };
  const childAttach = (work: Work, key: string, snapshot: ToolSnapshot) => {
    // v2.0.18 has no session.child.* events. Subagent progress/result metadata
    // identifies the actual child before prompting it; creation alone cannot
    // disambiguate concurrent tool calls. Background tool success is NOT child completion.
    const id = snapshot.metadata?.sessionID;
    if (
      snapshot.name !== "subagent" ||
      !snapshot.input ||
      typeof id !== "string" ||
      !/^ses_[\w-]+$/.test(id) ||
      id === session?.id ||
      id === work.scope.sessionID ||
      (childParents.has(id) && childParents.get(id) !== work.scope.sessionID)
    )
      return;
    let child = children.get(id);
    if (!child) {
      child = workCreate({
        sessionID: id,
        turnID: work.scope.turnID,
        parentToolKey: key,
        parentSessionID: work.scope.sessionID,
      });
      const agent = snapshot.input.agent;
      if (typeof agent === "string" && agent.trim()) child.info = { agent };
      children.set(id, child);
      emit({ type: "child.attached", ...child.scope, info: child.info });
    } else if (child.scope.parentSessionID !== work.scope.sessionID) {
      return;
    } else if (child.scope.parentToolKey && child.scope.parentToolKey !== key) {
      return;
    } else if (!child.scope.parentToolKey) {
      child.scope = { ...child.scope, parentToolKey: key };
    }
    if (child.terminal) return;
    const agent = snapshot.input.agent;
    if (typeof agent === "string" && agent.trim() && child.info.agent !== agent) {
      child.info = { ...child.info, agent };
      emit({ type: "child.updated", ...child.scope, info: child.info });
    }
    if (snapshot.metadata?.status !== "completed" || child.terminal) return;
    workSettle(child);
    emit({ type: "child.completed", ...child.scope });
  };
  const translate = (message: NativeEvent) => {
    if (message.type === "session.created") {
      const data = message.data;
      if (!data.parentID || !/^ses_[\w-]+$/.test(data.sessionID)) return;
      if (!childParents.has(data.sessionID) && childParents.size >= 4096) {
        for (const id of childParents.keys()) {
          if (!children.has(id)) {
            childParents.delete(id);
            break;
          }
        }
      }
      if (childParents.size < 4096 || childParents.has(data.sessionID))
        childParents.set(data.sessionID, data.parentID);
      const existing = children.get(data.sessionID);
      const parent =
        data.parentID === session?.id
          ? (active ?? (existing?.scope.parentSessionID === session?.id ? existing : undefined))
          : children.get(data.parentID);
      if (!parent || (parent.terminal && parent !== existing) || data.sessionID === data.parentID)
        return;
      if (existing && existing.scope.parentSessionID !== data.parentID) return;
      if (existing?.terminal) return;
      const child =
        existing ??
        workCreate({
          sessionID: data.sessionID,
          turnID: parent.scope.turnID,
          parentSessionID: data.parentID,
        });
      child.info = {
        ...(data.title?.trim() ? { title: data.title } : {}),
        ...(data.agent?.trim() ? { agent: data.agent } : {}),
        ...(data.model ? { model: data.model } : {}),
        directory: data.location.directory,
      };
      if (!existing) {
        children.set(data.sessionID, child);
        emit({ type: "child.attached", ...child.scope, info: child.info });
      } else emit({ type: "child.updated", ...child.scope, info: child.info });
      return;
    }
    const { data } = message;
    const child = children.get(data.sessionID);
    const work = data.sessionID === session?.id ? active : child;
    if (message.type === "session.usage.updated") {
      // v2.0.18 session/projector.ts emits cumulative totals, including non-turn work. Never add
      // these to step totals or combine child totals with the main agent.
      emit({ type: "usage.updated", ...message.data, scope: "session" });
      return;
    }
    if (message.type === "session.synthetic") {
      const metadata = message.data.metadata;
      const target =
        typeof metadata?.childID === "string" ? children.get(metadata.childID) : undefined;
      if (
        metadata?.source !== "subagent" ||
        !target ||
        target.terminal ||
        target.scope.parentSessionID !== data.sessionID
      )
        return;
      if (
        metadata.state !== "completed" &&
        metadata.state !== "error" &&
        metadata.state !== "cancelled"
      )
        return;
      const error = { type: "subagent.failed", message: message.data.text };
      workSettle(
        target,
        metadata.state === "error"
          ? error
          : metadata.state === "cancelled"
            ? { type: "subagent.cancelled", message: "Subagent cancelled." }
            : undefined,
      );
      if (metadata.state === "completed")
        emit({ type: "child.completed", ...target.scope, summary: message.data.text });
      if (metadata.state === "error") emit({ type: "child.failed", ...target.scope, error });
      if (metadata.state === "cancelled")
        emit({ type: "child.interrupted", ...target.scope, reason: "cancelled" });
      return;
    }
    if (!work || work.terminal) return;
    const scope = work.scope;
    if ("assistantMessageID" in data) {
      if (retiredMessages.has(`${data.sessionID}:${data.assistantMessageID}`)) return;
    }
    if (message.type === "session.execution.started") {
      workStart(work);
      return;
    }
    if (
      message.type === "session.execution.succeeded" ||
      message.type === "session.execution.failed" ||
      message.type === "session.execution.interrupted"
    ) {
      // The first child execution frame may be its terminal (fast or background work).
      // Attachment already established ancestry; do not silently lose a confirmed terminal.
      if (!work.started && !child) return;
      const error = message.type === "session.execution.failed" ? message.data.error : undefined;
      const interruption =
        message.type === "session.execution.interrupted" ? message.data.reason : undefined;
      workSettle(
        work,
        error ??
          (interruption
            ? { type: "execution.interrupted", message: `Execution interrupted: ${interruption}.` }
            : undefined),
      );
      if (child) {
        if (error) emit({ type: "child.failed", ...scope, error });
        else if (interruption) emit({ type: "child.interrupted", ...scope, reason: interruption });
        else emit({ type: "child.completed", ...scope });
        return;
      }
      active = undefined;
      if (error) emit({ type: "turn.failed", turnID: scope.turnID, reason: "failed", error });
      else if (interruption)
        emit({
          type: "turn.failed",
          turnID: scope.turnID,
          reason: "interrupted",
          interruptionReason: interruption,
        });
      else emit({ type: "turn.completed", turnID: scope.turnID });
      return;
    }
    if (
      message.type === "session.step.started" ||
      message.type === "session.step.streamed" ||
      message.type === "session.step.ended" ||
      message.type === "session.step.failed"
    ) {
      const id = message.data.assistantMessageID;
      let step = work.steps.get(id);
      if (step?.ended) return;
      workStart(work);
      if (!step) {
        step = { started: false, streamed: false, ended: false };
        work.steps.set(id, step);
      }
      if (message.type === "session.step.started") {
        if (step.started) return;
        step.started = true;
        emit({ type: "step.started", ...scope, step: message.data });
        return;
      }
      if (message.type === "session.step.streamed") {
        if (step.streamed) return;
        step.streamed = true;
        emit({ type: "step.streamed", ...scope, step: message.data });
        return;
      }
      step.ended = true;
      itemsSettle(
        work,
        message.type === "session.step.failed" ? message.data.error : undefined,
        id,
      );
      if (message.type === "session.step.ended")
        emit({ type: "step.completed", ...scope, step: message.data });
      else emit({ type: "step.failed", ...scope, step: message.data });
      // A failed attempt may be retried. Only execution.* settles the turn.
      return;
    }
    if (
      message.type === "session.text.started" ||
      message.type === "session.text.delta" ||
      message.type === "session.text.ended" ||
      message.type === "session.reasoning.started" ||
      message.type === "session.reasoning.delta" ||
      message.type === "session.reasoning.ended"
    ) {
      const part = message.data;
      const kind = message.type.startsWith("session.text.") ? "text" : "reasoning";
      const key = `${part.sessionID}:${part.assistantMessageID}:${kind}:${part.ordinal}`;
      let block = work.blocks.get(key);
      if (block?.ended || work.steps.get(part.assistantMessageID)?.ended) return;
      workStart(work);
      if (!block) {
        block = {
          kind,
          assistantMessageID: part.assistantMessageID,
          ordinal: part.ordinal,
          text: "",
          ended: false,
        };
        work.blocks.set(key, block);
        if (!work.steps.has(part.assistantMessageID)) {
          work.steps.set(part.assistantMessageID, {
            started: false,
            streamed: false,
            ended: false,
          });
        }
        emit({
          type: `${kind}.started`,
          ...scope,
          key,
          assistantMessageID: part.assistantMessageID,
          ordinal: part.ordinal,
          ...("state" in part ? { state: part.state } : {}),
        });
      }
      const ref = {
        ...scope,
        key,
        assistantMessageID: part.assistantMessageID,
        ordinal: part.ordinal,
      };
      if ("delta" in part) {
        block.text += part.delta;
        emit({ type: `${kind}.delta`, ...ref, delta: part.delta });
      }
      if ("text" in part) {
        block.ended = true;
        block.text = part.text;
        emit({
          type: `${kind}.completed`,
          ...ref,
          text: part.text,
          ...(part.state ? { state: part.state } : {}),
        });
      }
      return;
    }
    if (!("id" in data) || !("assistantMessageID" in data)) return;
    if (work.steps.get(data.assistantMessageID)?.ended) return;
    const key = `${data.sessionID}:${data.assistantMessageID}:tool:${data.id}`;
    let item = work.tools.get(key);
    if (item?.ended) return;
    if (message.type === "session.tool.input.started") {
      if (item) return;
      workStart(work);
      item = {
        snapshot: {
          id: data.id,
          assistantMessageID: data.assistantMessageID,
          name: message.data.name,
          inputText: "",
        },
        inputEnded: false,
        called: false,
        ended: false,
      };
      work.tools.set(key, item);
      if (!work.steps.has(data.assistantMessageID)) {
        work.steps.set(data.assistantMessageID, { started: false, streamed: false, ended: false });
      }
      emit({ type: "tool.started", ...scope, key, tool: item.snapshot });
      return;
    }
    // Called/results have no name in v2.0.18. Do not invent one or misattribute
    // an orphan event to another step's tool with the same provider call id.
    if (!item) return;
    if (message.type === "session.tool.input.delta") {
      if (item.inputEnded || item.called) return;
      item.snapshot = { ...item.snapshot, inputText: item.snapshot.inputText + message.data.delta };
      emit({
        type: "tool.input.delta",
        ...scope,
        key,
        tool: item.snapshot,
        delta: message.data.delta,
      });
      return;
    }
    if (message.type === "session.tool.input.ended") {
      if (item.inputEnded || item.called) return;
      item.inputEnded = true;
      item.snapshot = { ...item.snapshot, inputText: message.data.text };
      emit({ type: "tool.input.completed", ...scope, key, tool: item.snapshot });
      return;
    }
    if (message.type === "session.tool.called") {
      if (item.called) return;
      if (!item.inputEnded) {
        item.inputEnded = true;
        emit({ type: "tool.input.completed", ...scope, key, tool: item.snapshot });
      }
      item.called = true;
      const called = {
        ...item.snapshot,
        input: message.data.input,
        executed: message.data.executed,
        ...(message.data.state ? { state: message.data.state } : {}),
      };
      item.snapshot = called;
      emit({ type: "tool.called", ...scope, key, tool: called });
      return;
    }
    if (message.type === "session.tool.progress") {
      if (!item.called) return;
      const progress = { ...item.snapshot, metadata: message.data.metadata };
      item.snapshot = progress;
      emit({ type: "tool.progress", ...scope, key, tool: progress });
      childAttach(work, key, progress);
      return;
    }
    if (message.type === "session.tool.success" || message.type === "session.tool.failed") {
      if (message.type === "session.tool.success" && !item.called) return;
      item.ended = true;
      if (!item.inputEnded)
        emit({ type: "tool.input.completed", ...scope, key, tool: item.snapshot });
      // Terminal metadata is self-contained, not merged with live progress.
      const { metadata: _metadata, ...previous } = item.snapshot;
      const result = {
        ...previous,
        executed: message.data.executed,
        ...(message.data.metadata ? { metadata: message.data.metadata } : {}),
        ...(message.data.resultState ? { resultState: message.data.resultState } : {}),
      };
      item.snapshot = result;
      childAttach(work, key, result);
      if (message.type === "session.tool.success") {
        emit({
          type: "tool.completed",
          ...scope,
          key,
          tool: { ...result, content: message.data.content },
        });
        return;
      }
      emit({
        type: "tool.failed",
        ...scope,
        key,
        tool: {
          ...result,
          error: message.data.error,
          ...(message.data.content ? { content: message.data.content } : {}),
        },
      });
    }
  };
  const lost = () => {
    if (disconnected) return;
    disconnected = true;
    connected = false;
    admissionEvents = [];
    if (session && abort && !abort.signal.aborted)
      emit({ type: "stream.lost", sessionID: session.id });
  };

  const listen = (controller: AbortController, ready: (result: Result<void>) => void) => {
    const seen = new Set<string>();
    const pump = async () => {
      try {
        for await (const frame of client.event.subscribe({ signal: controller.signal })) {
          const message = frame;
          const data = record(message.data);
          const messageSessionID =
            message.type === "form.created" ? record(data?.form)?.sessionID : data?.sessionID;
          if (message?.type === "server.connected" && data) {
            if (!disconnected) {
              connected = true;
              ready({ success: true, data: undefined });
            }
            continue;
          }
          if (
            !session ||
            !connected ||
            disconnected ||
            typeof messageSessionID !== "string" ||
            (messageSessionID !== session.id &&
              !children.has(messageSessionID) &&
              message.type !== "session.created")
          )
            continue;
          // The global /api/event feed is volatile. Dedup within one subscription only;
          // do not use its event id as a durable replay cursor.
          // The official union adds durable/location fields that this engine does
          // not use. Bridge only the shared envelope and let its payload schema validate.
          const interactive =
            message.type === "permission.asked" ||
            message.type === "permission.replied" ||
            message.type === "form.created" ||
            message.type === "form.replied" ||
            message.type === "form.cancelled";
          if (interactive) {
            const candidate = message.type === "form.created" ? record(data?.form) : data;
            if (
              !candidate ||
              typeof candidate.sessionID !== "string" ||
              typeof (message.type === "permission.replied"
                ? candidate.requestID
                : candidate.id) !== "string"
            )
              continue;
            if (
              message.type === "permission.asked" &&
              (typeof candidate.action !== "string" ||
                !Array.isArray(candidate.resources) ||
                !candidate.resources.every((resource) => typeof resource === "string"))
            )
              continue;
            if (
              message.type === "form.created" &&
              (typeof candidate.title !== "string" || !Array.isArray(candidate.fields))
            )
              continue;
            if (
              message.type === "permission.replied" &&
              candidate.reply !== "once" &&
              candidate.reply !== "always" &&
              candidate.reply !== "reject"
            )
              continue;
            if (message.type === "form.replied" && !record(candidate.answer)) continue;
          } else if (Exit.isFailure(nativeEventFromClient(message))) continue;
          if (seen.has(message.id)) continue;
          boundedAdd(seen, message.id);
          // The server can execute (and finish) before the admission HTTP response.
          // Never announce a turn until its receipt has been validated.
          if (admitting) {
            // A stalled HTTP response must not let the live feed grow an unbounded buffer.
            if (admissionEvents.length >= 4096) {
              uncertain = true;
              lost();
              break;
            }
            admissionEvents.push(message);
          } else if (!uncertain) dispatch(message);
        }
      } catch {
        ready(fail("event.subscribe", "Native session event stream failed."));
      } finally {
        if (!controller.signal.aborted) {
          ready(fail("event.subscribe", "Native session event stream closed."));
          lost();
        }
      }
    };
    void pump();
  };

  return {
    start: async (options: {
      readonly directory: string;
      readonly title?: string;
      readonly model?: {
        readonly id: string;
        readonly providerID: string;
        readonly variant?: string;
      };
      readonly agent?: string;
      readonly resumeSessionId?: string;
    }): Promise<Result<Session>> => {
      if (abort) return fail("session.start", "Session engine already started.");
      if (!options.directory.startsWith("/") || !options.directory.trim())
        return fail("session.start", "Expected an absolute directory.");
      if (options.resumeSessionId)
        return fail(
          "session.resume",
          "Native v2.0.18 cannot verify a durable event boundary across T3 downtime; refusing to adopt the existing session.",
        );
      const controller = new AbortController();
      abort = controller;
      let settle!: (value: Result<void>) => void;
      let settled = false;
      const ready = new Promise<Result<void>>((resolve) => {
        settle = (value) => {
          if (!settled) {
            settled = true;
            resolve(value);
          }
        };
      });
      listen(controller, settle);
      // @effect-diagnostics-next-line globalTimers:off -- The standalone client waits for its event stream, outside an Effect runtime.
      const timer = setTimeout(
        () => settle(fail("event.subscribe", "Native session event stream did not connect.")),
        5000,
      );
      const connectedResult = await ready;
      clearTimeout(timer);
      if (!connectedResult.success) {
        controller.abort();
        abort = undefined;
        return connectedResult;
      }
      let response: Session;
      try {
        response = await requestWithDeadline(controller.signal, (signal) =>
          client.session.create(
            {
              location: { directory: options.directory },
              // Native session defaults inherit agent/config rules, which may ask or deny.
              // This engine is only started for T3 full-access sessions.
              permissions: [{ action: "*", resource: "*", effect: "allow" }],
              ...(options.title ? { title: options.title } : {}),
              ...(options.model ? { model: options.model } : {}),
              ...(options.agent ? { agent: options.agent } : {}),
            },
            { signal },
          ),
        );
      } catch (cause) {
        controller.abort();
        abort = undefined;
        return fail(
          "session.create",
          cause instanceof Error ? cause.message : "Native session request failed.",
        );
      }
      const found = sessionFrom(response);
      if (!found || found.location.directory !== options.directory) {
        controller.abort();
        abort = undefined;
        return fail("session.create", "Invalid native session response or mismatched directory.");
      }
      session = found;
      if (!connected || disconnected) {
        controller.abort();
        abort = undefined;
        session = undefined;
        return fail("event.subscribe", "Native session event stream closed during start.");
      }
      emit({ type: "session.ready", sessionID: found.id });
      return { success: true, data: found };
    },
    send: async (text: string): Promise<Result<{ readonly turnID: string }>> => {
      if (!session || !connected || disconnected || !abort || abort.signal.aborted)
        return fail("session.prompt", "Session event stream is not ready.");
      const currentSession = session;
      if (uncertain)
        return fail("session.prompt", "Session already has pending or uncertain work.");
      if (active || admitting)
        return rejectSend("Session already has pending work; wait for its terminal event.");
      if (!text.trim()) return rejectSend("Prompt text is required.");
      admitting = true;
      const id = `msg_${NodeCrypto.randomUUID().replaceAll("-", "")}`;
      active = workCreate({ turnID: id, sessionID: session.id });
      lastTurnID = id;
      const controller = abort;
      let receipt: unknown;
      try {
        receipt = await requestWithDeadline(controller.signal, (signal) =>
          client.session.prompt({ sessionID: currentSession.id, id, text }, { signal }),
        );
      } catch (cause) {
        // A failed HTTP response may still have admitted the durable inbox item.
        // Keep the turn blocked until explicit stop; never retry it automatically.
        uncertain = true;
        admitting = false;
        admissionEvents = [];
        return fail(
          "session.prompt",
          cause instanceof Error ? cause.message : "Native prompt request failed.",
        );
      }
      const promptReceipt = record(receipt);
      if (
        promptReceipt?.type !== "user" ||
        promptReceipt.id !== id ||
        promptReceipt.sessionID !== session?.id
      ) {
        uncertain = true;
        admitting = false;
        admissionEvents = [];
        return fail(
          "session.prompt",
          "Invalid native prompt admission receipt; outcome uncertain.",
        );
      }
      if (controller.signal.aborted || !connected || disconnected) {
        uncertain = true;
        admitting = false;
        admissionEvents = [];
        return fail("session.prompt", "Native session event stream closed during admission.");
      }
      // Keep admitting set while draining so even a terminal in the buffered
      // frames cannot permit another send before this receipt has settled.
      for (const event of admissionEvents) dispatch(event);
      admissionEvents = [];
      admitting = false;
      // The volatile feed may have raced request creation during admission.
      // A failed list does not prove there is no pending request; fail closed.
      const reconciled = await reconcilePending(false);
      if (!reconciled.success) {
        uncertain = true;
        return reconciled;
      }
      return { success: true, data: { turnID: id } };
    },
    reconcilePending: () => reconcilePending(),
    replyPermission: async (
      requestID: string,
      decision: "once" | "always" | "reject",
    ): Promise<Result<void>> => {
      const pending = permissions.get(requestID);
      if (
        !session ||
        !connected ||
        disconnected ||
        !pending ||
        pending.request.sessionID !== session.id ||
        pending.replying
      )
        return fail("permission.reply", "No pending permission request in this session.");
      pending.replying = true;
      try {
        await client.permission.reply({ sessionID: session.id, requestID, decision });
        requestSettle("permission", requestID, session.id, undefined, decision);
        return { success: true, data: undefined };
      } catch (cause) {
        // An HTTP failure can still have applied the decision; never send it twice.
        await reconcilePending();
        return fail(
          "permission.reply",
          cause instanceof Error ? cause.message : "Permission reply outcome uncertain.",
        );
      }
    },
    replyForm: async (
      formID: string,
      answer:
        | Readonly<Record<string, string | number | boolean | ReadonlyArray<string>>>
        | undefined,
    ): Promise<Result<void>> => {
      const pending = forms.get(formID);
      if (
        !session ||
        !connected ||
        disconnected ||
        !pending ||
        pending.form.sessionID !== session.id ||
        pending.replying
      )
        return fail("session.form.reply", "No pending form in this session.");
      pending.replying = true;
      try {
        if (answer) await client.session.form.reply({ sessionID: session.id, formID, answer });
        else await client.session.form.cancel({ sessionID: session.id, formID });
        requestSettle("form", formID, session.id, answer);
        return { success: true, data: undefined };
      } catch (cause) {
        await reconcilePending();
        return fail(
          "session.form.reply",
          cause instanceof Error ? cause.message : "Form reply outcome uncertain.",
        );
      }
    },
    recover: async (): Promise<Result<void>> =>
      fail(
        "session.recover",
        "Native v2.0.18 cannot prove lossless recovery: durable log persistence and a complete snapshot are not guaranteed. Stop this engine; do not retry uncertain prompts.",
      ),
    interrupt: async (): Promise<Result<boolean>> => {
      if (!session) return fail("session.interrupt", "Session has not started.");
      let response: { readonly interrupted: boolean };
      try {
        response = await client.session.interrupt({ sessionID: session.id });
      } catch (cause) {
        return fail(
          "session.interrupt",
          cause instanceof Error ? cause.message : "Native interrupt request failed.",
        );
      }
      const interrupted = response.interrupted;
      if (typeof interrupted !== "boolean")
        return fail("session.interrupt", "Invalid native interrupt response.");
      // Do not fabricate a turn terminal: the execution.interrupted event is authoritative.
      return { success: true, data: interrupted };
    },
    stop: async (): Promise<Result<void>> => {
      if (!abort) return { success: true, data: undefined };
      let stopFailure: Result<void> | undefined;
      if (active || admitting || uncertain) {
        try {
          const response = await requestWithDeadline(abort.signal, (signal) =>
            client.session.interrupt({ sessionID: session!.id }, { signal }),
          );
          if (typeof response.interrupted !== "boolean" || !response.interrupted)
            stopFailure = fail(
              "session.interrupt",
              "Native interrupt did not confirm cancellation; outcome uncertain. Local engine stopped.",
            );
        } catch (cause) {
          stopFailure = fail(
            "session.interrupt",
            `${cause instanceof Error ? cause.message : "Native interrupt request failed."} Outcome uncertain; local engine stopped.`,
          );
        }
      }
      abort.abort();
      abort = undefined;
      connected = false;
      active = undefined;
      lastTurnID = undefined;
      permissions.clear();
      forms.clear();
      settledRequests.clear();
      children.clear();
      childParents.clear();
      retiredMessages.clear();
      uncertain = false;
      admitting = false;
      admissionEvents = [];
      disconnected = false;
      session = undefined;
      return stopFailure ?? { success: true, data: undefined };
    },
  };
};
