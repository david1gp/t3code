import * as NodeCrypto from "node:crypto";

import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import { Form, Permission, Session, SessionInbox } from "@opencode/client/effect";

import {
  isConflictError,
  isFormInvalidAnswerError,
  type SessionCompactInput,
  type SessionPromptInput,
} from "@opencode/client";
import { composerSkillMentionsResolve } from "@t3tools/shared/composerInlineTokens";

import { openCodeNativeClientCreate } from "./openCodeNativeClientCreate.ts";
import { openCodeNativeEventDisposition } from "./openCodeNativeEventDisposition.ts";
import { openCodeNativeWireSchema } from "./openCodeNativeWireSchema.ts";
import {
  type OpenCodeNativeInventory,
  openCodeNativeInventorySchema,
} from "./openCodeNativeInventorySchema.ts";
import { OpenCodeRuntimeError } from "./opencodeRuntime.ts";

type NativeFrame =
  | typeof openCodeNativeWireSchema.feed.Type
  | Exclude<typeof openCodeNativeWireSchema.log.Type, { type: "log.synced" }>;
type PermissionRequest = Extract<NativeFrame, { type: "permission.asked" }>["data"];
type FormInfo = Extract<NativeFrame, { type: "form.created" }>["data"]["form"];

type Result<T> =
  | { readonly success: true; readonly data: T }
  | { readonly success: false; readonly error: OpenCodeRuntimeError; readonly rejected?: true };

type Session = { readonly id: string; readonly location: { readonly directory: string } };
const fields = Schema.Record(Schema.String, Schema.Unknown);
const nativeError = Schema.toEncoded(Session.Event.Step.Failed.data.fields.error);
const tokens = Schema.toEncoded(Session.Event.Step.Ended.data.fields.tokens);
const content = Schema.toEncoded(Session.Event.Tool.Success.data.fields.content);
const nativeEvent = openCodeNativeWireSchema.session;
type NativeEvent = typeof nativeEvent.Type;
type Data<T extends NativeEvent["type"]> = Extract<NativeEvent, { type: T }>["data"];
const nativeEventFromClient = (message: NativeFrame) =>
  Schema.decodeUnknownExit(nativeEvent)(message);
const feedDecode = Schema.decodeUnknownExit(openCodeNativeWireSchema.feed);
const logDecode = Schema.decodeUnknownExit(openCodeNativeWireSchema.log);
const formDecode = Schema.decodeUnknownExit(Schema.toEncoded(Form.Info));
const permissionDecode = Schema.decodeUnknownExit(Schema.toEncoded(Permission.Request));
const compactionReceiptDecode = Schema.decodeUnknownExit(Schema.toEncoded(SessionInbox.Compaction));
const commandInventoryDecode = Schema.decodeExit(openCodeNativeInventorySchema.command);
const skillInventoryDecode = Schema.decodeExit(openCodeNativeInventorySchema.skill);
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
  | {
      readonly type: "model.selected";
      readonly sessionID: string;
      readonly model: Data<"session.model.selected">["model"];
    }
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
  | (Scope & {
      readonly type: "compaction.started" | "compaction.completed" | "compaction.failed";
      /** Stable attempt identity, shared by start and terminal; never just the event type. */
      readonly key: string;
      readonly eventID: string;
      readonly durable: Extract<NativeEvent, { type: "session.compaction.started" }>["durable"];
      readonly metadata?: Readonly<Record<string, unknown>>;
      readonly compaction:
        | Data<"session.compaction.started">
        | Data<"session.compaction.ended">
        | Data<"session.compaction.failed">;
      readonly inputID?: string;
    })
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
  | (Scope & {
      readonly type: "child.started";
      /** Explicit transition for a reused session; the native launch tool key, not an execution ID. */
      readonly reactivation?: { readonly key: string };
    })
  | (Scope & { readonly type: "child.completed"; readonly summary?: string })
  | (Scope & { readonly type: "child.failed"; readonly error: typeof nativeError.Type })
  | (Scope & {
      readonly type: "child.interrupted";
      readonly reason: Data<"session.execution.interrupted">["reason"] | "cancelled";
    })
  | {
      readonly type: "usage.recorded";
      readonly eventID: string;
      readonly durable: Extract<NativeEvent, { type: "session.usage.recorded" }>["durable"];
      readonly scope: "session";
      readonly usage: Data<"session.usage.recorded">;
    }
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
  | { readonly type: "stream.lost"; readonly sessionID: string; readonly detail?: string };

type Block = {
  readonly kind: "text" | "reasoning";
  readonly assistantMessageID: string;
  readonly ordinal: number;
  text: string;
  ended: boolean;
};
type Work = {
  scope: Scope;
  readonly activationID: number;
  manualInput?: { readonly id: string; delivered: boolean };
  info: ChildInfo;
  started: boolean;
  terminal: boolean;
  sequenceLatest: number;
  sequenceFloor: number;
  reactivationKey?: string;
  readonly blocks: Map<string, Block>;
  readonly tools: Map<
    string,
    { snapshot: ToolSnapshot; inputEnded: boolean; called: boolean; ended: boolean }
  >;
  readonly steps: Map<string, { started: boolean; streamed: boolean; ended: boolean }>;
  readonly compactions: Map<string, CompactionAttempt>;
};
type CompactionAttempt = {
  activationID: number;
  reason: "auto" | "manual";
  inputID?: string;
  ended: boolean;
  terminalEventID?: string;
};
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
/** A failure the server definitely did not apply, so the session stays usable. */
const reject = (operation: string, detail: string): Result<never> => ({
  success: false,
  error: new OpenCodeRuntimeError({ operation, detail }),
  rejected: true,
});
const rejectSend = (detail: string) => reject("session.prompt", detail);

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
 * session-event snapshot API, retention/gap proof, or atomic quiescence fence. Resume observes
 * the target before independent readiness reads and refuses observed concurrent activity.
 * Readiness is not lossless recovery: unowned work needs a validated synthetic inbox
 * boundary; otherwise it fails closed without reconstructing a transcript. */
export const openCodeNativeSessionEngineCreate = (input: {
  readonly url: string;
  readonly serverPassword?: string;
  readonly fetch?: typeof fetch;
  readonly inventory?: (directory: string) => OpenCodeNativeInventory | undefined;
  readonly onEvent: (event: Event) => void;
}) => {
  const client = openCodeNativeClientCreate(input);
  const compactionsBySession = new Map<string, Map<string, CompactionAttempt>>();
  let nextActivationID = 0;
  const workCreate = (scope: Scope): Work => {
    let compactions = compactionsBySession.get(scope.sessionID);
    if (!compactions) {
      compactions = new Map();
      compactionsBySession.set(scope.sessionID, compactions);
    }
    return {
      scope,
      activationID: ++nextActivationID,
      info: {},
      started: false,
      terminal: false,
      sequenceLatest: -1,
      sequenceFloor: 0,
      blocks: new Map(),
      tools: new Map(),
      steps: new Map(),
      compactions,
    };
  };
  let session: Session | undefined;
  let abort: AbortController | undefined;
  let connected = false;
  // One buffered frame is enough to refuse adoption; no transcript is reconstructed.
  let provisionalResume: { readonly sessionID: string; observed?: NativeFrame } | undefined;
  let resumed = false;
  let active: Work | undefined;
  // A manual control settles before the native busy period. Do not let that
  // period's delayed terminal close a newly admitted ordinary input.
  let manualExecution = false;
  let commandWork: Work | undefined;
  // Admission is not execution: a wake during settlement belongs to a successor,
  // even when its enqueue precedes the outgoing execution's terminal publication.
  const admittedInputs = new Map<
    string,
    { work?: Work; readonly resolve: (turnID: string) => void }
  >();
  const syntheticInputs = new Map<string, Data<"session.inbox.enqueued">>();
  // A native start has no input identity. Hold it until delivery of an observed synthetic
  // admission identifies the activation; enqueue (including resume:false) is not a run.
  let unownedExecution: NativeFrame[] = [];
  const inputAdmit = (id: string) => {
    let resolve!: (turnID: string) => void;
    const turn = new Promise<string>((settle) => {
      resolve = settle;
    });
    const admitted: { work?: Work; readonly resolve: (turnID: string) => void } = { resolve };
    admittedInputs.set(id, admitted);
    if (!active && !manualExecution) {
      // A validated T3 receipt supersedes unowned frames in the pre-admission prefix.
      // They must not reopen a retired activation after this input has settled.
      unownedExecution = [];
      active = workCreate({ turnID: id, sessionID: session!.id });
      lastTurnID = id;
      admitted.work = active;
      resolve(id);
    }
    return { admitted, turn };
  };
  const inputTurn = async (admission: ReturnType<typeof inputAdmit>): Promise<Result<string>> => {
    if (admission.admitted.work)
      return { success: true, data: admission.admitted.work.scope.turnID };
    const controller = abort;
    try {
      const turnID = await requestWithDeadline(
        controller?.signal,
        (signal) =>
          new Promise<string>((resolve, reject) => {
            const cancelled = () => reject(signal.reason);
            signal.addEventListener("abort", cancelled, { once: true });
            if (signal.aborted) cancelled();
            void admission.turn.then((turnID) => {
              signal.removeEventListener("abort", cancelled);
              resolve(turnID);
            });
          }),
      );
      return { success: true, data: turnID };
    } catch (cause) {
      if (abort === controller) uncertain = true;
      return fail(
        "session.prompt",
        `${cause instanceof Error ? cause.message : "Native input execution boundary unavailable."} Outcome uncertain; do not replay the input.`,
      );
    }
  };
  const dispatchedEvents = new Set<string>();
  let lastTurnID: string | undefined;
  const children = new Map<string, Work>();
  const childParents = new Map<string, string>();
  const childLaunches = new Set<string>();
  const retiredMessages = new Set<string>();
  let admitting = false;
  let associating = false;
  let switching = false;
  let uncertain = false;
  let disconnected = false;
  let admissionEvents: NativeFrame[] = [];
  // Actual retained/log or public-feed observations, never synchronization watermarks.
  const admissionSequences = new Set<number>();
  let admissionWake: (() => void) | undefined;
  let nativeSequence = -1;
  let turnSequenceFloor = 0;
  // Woken whenever the main turn settles or the engine loses its stream.
  const idleWaiters = new Set<() => void>();
  const idleNotify = () => {
    for (const wake of idleWaiters) wake();
    idleWaiters.clear();
  };
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
  const dispatch = (message: NativeFrame) => {
    if (dispatchedEvents.has(message.id)) return;
    if ("durable" in message) {
      const child = children.get(message.durable.aggregateID);
      if (child && message.durable.seq < child.sequenceFloor) return;
    }
    if (
      "durable" in message &&
      message.durable.aggregateID === session?.id &&
      message.durable.seq < turnSequenceFloor
    )
      return;
    const parent = record(message.data)?.sessionID === session?.id;
    const syntheticEnqueue =
      message.type === "session.inbox.enqueued" && message.data.item.type === "synthetic";
    if (
      parent &&
      !active &&
      manualExecution &&
      message.type === "session.inbox.delivered" &&
      syntheticInputs.has(message.data.inboxID)
    ) {
      active = workCreate({ turnID: message.data.inboxID, sessionID: session!.id });
      lastTurnID = message.data.inboxID;
      turnSequenceFloor = message.durable.seq;
      unownedExecution = [];
      workStart(active);
    }
    if (
      parent &&
      !active &&
      !admittedInputs.size &&
      (unownedExecution.length > 0 || message.type === "session.execution.started")
    ) {
      if (
        message.type === "session.inbox.delivered" &&
        syntheticInputs.has(message.data.inboxID) &&
        unownedExecution.length > 0
      ) {
        const id = message.data.inboxID;
        active = workCreate({ turnID: id, sessionID: session!.id });
        lastTurnID = id;
        const frames = unownedExecution;
        unownedExecution = [];
        for (const frame of frames) dispatch(frame);
      } else if (message.type === "session.execution.started") {
        // Delivery names the actual consumed input; enqueue order alone cannot
        // distinguish a queued/suspended input from a later steer wake.
        if (unownedExecution.length === 0) unownedExecution.push(message);
        return;
      } else if (
        !syntheticEnqueue &&
        message.type !== "session.inbox.cancelled" &&
        message.type !== "session.inbox.delivery.changed" &&
        /^session\.(execution|inbox|step|text|reasoning|tool|shell|retry|compaction)\./u.test(
          message.type,
        )
      ) {
        lost(
          "Native resumed session activity has no admitted owner; safe adoption is unavailable. No prompt was replayed and no transcript recovery is guaranteed.",
        );
        return;
      }
    }
    if (
      resumed &&
      !lastTurnID &&
      !syntheticEnqueue &&
      !(message.type === "session.inbox.cancelled" && syntheticInputs.has(message.data.inboxID)) &&
      !(
        message.type === "session.inbox.delivery.changed" &&
        syntheticInputs.has(message.data.inboxID)
      ) &&
      !(message.type === "session.inbox.delivered" && syntheticInputs.has(message.data.inboxID)) &&
      (message.type === "form.created"
        ? message.data.form.sessionID === session?.id
        : record(message.data)?.sessionID === session?.id) &&
      (message.type === "permission.asked" ||
        message.type === "form.created" ||
        /^session\.(execution|inbox|step|text|reasoning|tool|shell|retry|compaction)\./u.test(
          message.type,
        ))
    ) {
      lost(
        "Native resumed session activity has no admitted owner; safe adoption is unavailable. No prompt was replayed and no transcript recovery is guaranteed.",
      );
      return;
    }
    boundedAdd(dispatchedEvents, message.id);
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
    // A list response can predate live requests received while the HTTP calls are in flight.
    const knownPermissions = new Map(permissions);
    const knownForms = new Map(forms);
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
      for (const request of pendingPermissions) {
        const decoded = permissionDecode(request);
        if (Exit.isFailure(decoded))
          return fail("session.pending", "Invalid native permission response.");
        permissionOpen(decoded.value);
      }
      for (const form of pendingForms) {
        const decoded = formDecode(form);
        if (Exit.isFailure(decoded))
          return fail("session.pending", "Invalid native form response.");
        formOpen(decoded.value);
      }
      if (closeMissing) {
        const permissionIDs = new Set(pendingPermissions.map((request) => request.id));
        const formIDs = new Set(pendingForms.map((form) => form.id));
        for (const [requestID, pending] of knownPermissions) {
          if (!permissionIDs.has(requestID) && permissions.get(requestID) === pending)
            requestSettle("permission", requestID, id);
        }
        for (const [formID, pending] of knownForms) {
          if (!formIDs.has(formID) && forms.get(formID) === pending)
            requestSettle("form", formID, id);
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
    if (work.scope.parentSessionID)
      emit({
        type: "child.started",
        ...work.scope,
        ...(work.reactivationKey ? { reactivation: { key: work.reactivationKey } } : {}),
      });
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
  const manualSettle = (
    work: Work,
    outcome: {
      readonly error?: typeof nativeError.Type;
      readonly interruption?: Data<"session.execution.interrupted">["reason"];
    },
  ) => {
    if (work.terminal) return;
    workSettle(work, outcome.error);
    if (active === work) active = undefined;
    idleNotify();
    if (outcome.interruption)
      emit({
        type: "turn.failed",
        turnID: work.scope.turnID,
        reason: "interrupted",
        interruptionReason: outcome.interruption,
      });
    else if (outcome.error)
      emit({
        type: "turn.failed",
        turnID: work.scope.turnID,
        reason: "failed",
        error: outcome.error,
      });
    else emit({ type: "turn.completed", turnID: work.scope.turnID });
  };
  const childAttach = (
    work: Work,
    key: string,
    snapshot: ToolSnapshot,
    runningProgress = false,
  ) => {
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
    const seenLaunch = childLaunches.has(key);
    boundedAdd(childLaunches, key);
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
    } else if (
      (child.scope.parentToolKey && child.scope.parentToolKey !== key) ||
      (child.terminal && !child.scope.parentToolKey)
    ) {
      // A session is durable identity, not an activation. Only the upstream reuse
      // admission's running progress may replace settled work, never a tool result
      // or a replay of an older launch. Keep the old Work/scope untouched.
      if (
        !child.terminal ||
        !runningProgress ||
        snapshot.metadata?.status !== "running" ||
        snapshot.input.sessionID !== id ||
        seenLaunch
      )
        return;
      const previous = child;
      child = workCreate({
        sessionID: id,
        turnID: work.scope.turnID,
        parentToolKey: key,
        parentSessionID: work.scope.sessionID,
      });
      child.info = previous.info;
      child.sequenceFloor = previous.sequenceLatest + 1;
      child.sequenceLatest = previous.sequenceLatest;
      child.reactivationKey = key;
      children.set(id, child);
      emit({ type: "child.attached", ...child.scope, info: child.info });
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
  const childNotification = (
    sessionID: string,
    payload: { readonly text: string; readonly metadata?: Readonly<Record<string, unknown>> },
  ) => {
    const metadata = payload.metadata;
    const target =
      typeof metadata?.childID === "string" ? children.get(metadata.childID) : undefined;
    if (
      metadata?.source !== "subagent" ||
      !target ||
      target.terminal ||
      // Both supported notification shapes have childID but no launch/execution
      // identity. A delayed old job notification cannot settle reused work; its
      // own execution terminal (or matching foreground tool result) must do so.
      target.reactivationKey !== undefined ||
      target.scope.parentSessionID !== sessionID
    )
      return;
    if (
      metadata.state !== "completed" &&
      metadata.state !== "error" &&
      metadata.state !== "cancelled"
    )
      return;
    const error = { type: "subagent.failed", message: payload.text };
    workSettle(
      target,
      metadata.state === "error"
        ? error
        : metadata.state === "cancelled"
          ? { type: "subagent.cancelled", message: "Subagent cancelled." }
          : undefined,
    );
    if (metadata.state === "completed")
      emit({ type: "child.completed", ...target.scope, summary: payload.text });
    if (metadata.state === "error") emit({ type: "child.failed", ...target.scope, error });
    if (metadata.state === "cancelled")
      emit({ type: "child.interrupted", ...target.scope, reason: "cancelled" });
  };
  const translate = (message: NativeEvent) => {
    if (openCodeNativeEventDisposition[message.type] !== "translated") return;
    if (message.type === "session.inbox.enqueued") {
      if (message.data.item.type !== "synthetic") return;
      if (message.data.sessionID === session?.id) {
        if (syntheticInputs.size >= 4096) {
          lost("Native synthetic input buffer exceeded its 4096-input capacity.");
          return;
        }
        syntheticInputs.set(message.data.inboxID, message.data);
      }
      // SubagentCompletion.deliver admits a synthetic inbox item, not a user message
      // or necessarily a legacy session.synthetic event. Completion belongs to the
      // child's spawning turn even when the parent is idle or on a later activation.
      childNotification(message.data.sessionID, message.data.item.payload);
      return;
    }
    if (message.type === "session.inbox.cancelled") {
      if (message.data.sessionID === session?.id) syntheticInputs.delete(message.data.inboxID);
      if (
        active?.manualInput?.id === message.data.inboxID &&
        message.data.sessionID === session?.id
      ) {
        if (!active.manualInput.delivered) manualExecution = false;
        manualSettle(active, { interruption: "user" });
      }
      return;
    }
    if (message.type === "session.inbox.delivered") {
      if (message.data.sessionID !== session?.id) return;
      syntheticInputs.delete(message.data.inboxID);
      if (active?.manualInput?.id === message.data.inboxID) {
        active.manualInput.delivered = true;
        return;
      }
      const admitted = admittedInputs.get(message.data.inboxID);
      if (!admitted) return;
      if (!active && manualExecution) {
        // Manual control completion is earlier than the busy-period terminal.
        // An ordinary steer may be consumed in that same native execution.
        active = workCreate({ turnID: message.data.inboxID, sessionID: session!.id });
        turnSequenceFloor = message.durable.seq;
        lastTurnID = message.data.inboxID;
        workStart(active);
      }
      if (!active) return;
      admitted.work = active;
      admitted.resolve(active.scope.turnID);
      admittedInputs.delete(message.data.inboxID);
      return;
    }
    if (
      message.type === "session.execution.started" &&
      message.data.sessionID === session?.id &&
      !active
    ) {
      // Admission stays exclusive until association, so there is at most one
      // unresolved T3 input. A successor may fail before promoting it; start,
      // not delivery alone, establishes that new activation's ownership.
      const next = admittedInputs.entries().next().value;
      if (next) {
        const [id, admitted] = next;
        active = workCreate({ turnID: id, sessionID: message.data.sessionID });
        turnSequenceFloor = message.durable.seq;
        lastTurnID = id;
        admitted.work = active;
        admitted.resolve(id);
      }
    }
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
          ? (active ??
            commandWork ??
            (existing?.scope.parentSessionID === session?.id ? existing : undefined))
          : children.get(data.parentID);
      if (
        !parent ||
        (parent.terminal && parent !== existing && parent !== commandWork) ||
        data.sessionID === data.parentID
      )
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
    if (
      data.sessionID === session?.id &&
      (message.type === "session.execution.succeeded" ||
        message.type === "session.execution.failed" ||
        message.type === "session.execution.interrupted")
    )
      manualExecution = false;
    const child = children.get(data.sessionID);
    const work = data.sessionID === session?.id ? active : child;
    if (message.type === "session.model.selected" && data.sessionID === session?.id) {
      emit({ type: "model.selected", ...message.data });
      return;
    }
    if (message.type === "session.usage.updated") {
      // v2.0.18 session/projector.ts emits cumulative totals, including non-turn work. Never add
      // these to step totals or combine child totals with the main agent.
      emit({ type: "usage.updated", ...message.data, scope: "session" });
      return;
    }
    if (message.type === "session.usage.recorded") {
      // Title work is session-scoped. Compaction records repeat the public terminal's
      // charge, without an attempt ID, so neither is additive turn accounting.
      emit({
        type: "usage.recorded",
        eventID: message.id,
        durable: message.durable,
        scope: "session",
        usage: message.data,
      });
      return;
    }
    if (message.type === "session.synthetic") {
      childNotification(data.sessionID, message.data);
      return;
    }
    if (!work || work.terminal) return;
    if (child && "durable" in message) {
      if (message.durable.seq < child.sequenceFloor) return;
      // Running progress precedes prompt admission. An outgoing execution's
      // delayed terminal in that gap must not terminate the pending activation.
      if (child.reactivationKey && !child.started && message.type !== "session.execution.started")
        return;
      if (message.type === "session.execution.started" && !child.started)
        child.sequenceFloor = message.durable.seq;
      child.sequenceLatest = Math.max(child.sequenceLatest, message.durable.seq);
    }
    if (child?.reactivationKey && !child.started && message.type !== "session.execution.started")
      return;
    const scope = work.scope;
    if (
      message.type === "session.compaction.started" ||
      message.type === "session.compaction.ended" ||
      message.type === "session.compaction.failed"
    ) {
      const compaction = message.data;
      const inputID = "inputID" in compaction ? compaction.inputID : undefined;
      if (message.type !== "session.compaction.started") {
        const previous = [...work.compactions].find(
          ([, attempt]) => attempt.terminalEventID === message.id,
        );
        if (previous) return;
      }
      if (
        work.manualInput &&
        (compaction.reason !== "manual" ||
          (inputID !== undefined && inputID !== work.manualInput.id) ||
          (message.type === "session.compaction.started" && inputID === undefined))
      )
        return;
      const open = [...work.compactions]
        .toReversed()
        .find(
          ([, attempt]) =>
            attempt.activationID === work.activationID &&
            !attempt.ended &&
            attempt.reason === compaction.reason &&
            (inputID === undefined || attempt.inputID === inputID),
        );
      const key =
        message.type === "session.compaction.started" ? message.id : (open?.[0] ?? message.id);
      // Terminals without inputID only belong to this control through its observed
      // attempt, not merely because another manual request owns the session now.
      if (work.manualInput && message.type !== "session.compaction.started" && !open && !inputID)
        return;
      if (work.manualInput) work.manualInput.delivered = true;
      const existing = work.compactions.get(key);
      const attempt = (existing?.activationID === work.activationID ? existing : undefined) ?? {
        activationID: work.activationID,
        reason: compaction.reason,
        ...(inputID ? { inputID } : {}),
        ended: false,
      };
      if (message.type !== "session.compaction.started") {
        attempt.ended = true;
        attempt.terminalEventID = message.id;
      }
      work.compactions.set(key, attempt);
      workStart(work);
      emit({
        type:
          message.type === "session.compaction.started"
            ? "compaction.started"
            : message.type === "session.compaction.ended"
              ? "compaction.completed"
              : "compaction.failed",
        ...scope,
        key,
        eventID: message.id,
        durable: message.durable,
        compaction,
        ...(message.metadata ? { metadata: message.metadata } : {}),
        ...(attempt.inputID ? { inputID: attempt.inputID } : {}),
      });
      if (work.manualInput && message.type !== "session.compaction.started")
        manualSettle(
          work,
          message.type === "session.compaction.failed" ? { error: message.data.error } : {},
        );
      return;
    }
    if ("assistantMessageID" in data) {
      if (retiredMessages.has(`${data.sessionID}:${data.assistantMessageID}`)) return;
    }
    if (message.type === "session.execution.started") {
      if (!child && !work.started) turnSequenceFloor = message.durable.seq;
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
      if (work.manualInput) {
        // Success of an enclosing execution is not proof that the accepted
        // compaction ran. Failures/interruptions do settle its admitted work,
        // without inventing a charged compaction attempt.
        if (error || interruption)
          manualSettle(work, {
            ...(error ? { error } : {}),
            ...(interruption ? { interruption } : {}),
          });
        return;
      }
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
      for (const [id, admitted] of admittedInputs) {
        if (admitted.work === work) admittedInputs.delete(id);
      }
      idleNotify();
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
      childAttach(work, key, progress, true);
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
  const lost = (detail: string) => {
    if (disconnected) return;
    disconnected = true;
    connected = false;
    admissionEvents = [];
    admissionWake?.();
    idleNotify();
    if (session && abort && !abort.signal.aborted)
      emit({ type: "stream.lost", sessionID: session.id, detail });
    abort?.abort(new Error(detail));
  };

  const listen = (controller: AbortController, ready: (result: Result<void>) => void) => {
    const seen = new Set<string>();
    const pump = async () => {
      let detail = "Native session event stream closed.";
      try {
        for await (const frame of client.event.subscribe({ signal: controller.signal })) {
          if (controller.signal.aborted || abort !== controller) break;
          const decoded = feedDecode(frame);
          if (Exit.isFailure(decoded)) continue;
          const message = decoded.value;
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
          if (provisionalResume && provisionalResume.sessionID === messageSessionID) {
            provisionalResume.observed ??= message;
            continue;
          }
          if (
            !session ||
            !connected ||
            disconnected ||
            typeof messageSessionID !== "string" ||
            (messageSessionID !== session.id &&
              !children.has(messageSessionID) &&
              message.type !== "session.created" &&
              !(
                admitting &&
                admissionEvents.some(
                  (event) =>
                    event.type === "session.created" && event.data.sessionID === messageSessionID,
                )
              ))
          )
            continue;
          if ("durable" in message && message.durable.aggregateID === session.id) {
            nativeSequence = Math.max(nativeSequence, message.durable.seq);
            // Count every parent durable frame, including types the UI does not translate.
            if (admitting) admissionSequences.add(message.durable.seq);
            admissionWake?.();
          }
          // The global /api/event feed is volatile. Dedup within one subscription only;
          // do not use its event id as a durable replay cursor.
          if (seen.has(message.id)) continue;
          boundedAdd(seen, message.id);
          // The server can execute (and finish) before the admission HTTP response.
          // Never announce a turn until its receipt has been validated.
          if (admitting) {
            // A stalled HTTP response must not let the live feed grow an unbounded buffer.
            if (admissionEvents.length >= 4096) {
              uncertain = true;
              detail =
                "Native session event stream admission buffer exceeded its 4096-event capacity.";
              lost(detail);
              break;
            }
            admissionEvents.push(message);
          } else if (!uncertain) dispatch(message);
        }
      } catch (cause) {
        detail = cause instanceof Error ? cause.message : "Native session event stream failed.";
      } finally {
        if (!controller.signal.aborted) {
          ready(fail("event.subscribe", detail));
          lost(detail);
        }
      }
    };
    void pump();
  };

  type Selection = {
    readonly model?: {
      readonly id: string;
      readonly providerID: string;
      readonly variant?: string;
    };
    readonly agent?: string;
  };
  const switchNow = async (selection: Selection): Promise<Result<void>> => {
    const controller = abort!;
    const sessionID = session!.id;
    if (active) {
      const idle = new Promise<void>((resolve) => idleWaiters.add(resolve));
      let response: { readonly interrupted: boolean };
      try {
        response = await requestWithDeadline(controller.signal, (signal) =>
          client.session.interrupt({ sessionID }, { signal }),
        );
      } catch (cause) {
        uncertain = true;
        return fail(
          "session.interrupt",
          cause instanceof Error ? cause.message : "Native interrupt request failed.",
        );
      }
      if (typeof response.interrupted !== "boolean") {
        uncertain = true;
        return fail("session.interrupt", "Invalid native interrupt response.");
      }
      // Only the execution terminal proves the old turn stopped. A false response means it
      // was already settling, so the same terminal is still on its way.
      let timer: ReturnType<typeof setTimeout> | undefined;
      const settled = await Promise.race([
        idle.then(() => true),
        new Promise<false>((resolve) => {
          // @effect-diagnostics-next-line globalTimers:off -- The standalone client waits for its event stream, outside an Effect runtime.
          timer = setTimeout(() => resolve(false), REQUEST_TIMEOUT_MS);
        }),
      ]);
      clearTimeout(timer);
      if (!session || session.id !== sessionID || !abort || !connected || disconnected)
        return fail("session.interrupt", "Native session closed while interrupting.");
      if (!settled || active) {
        uncertain = true;
        return fail(
          "session.interrupt",
          "Native turn did not confirm interruption; outcome uncertain.",
        );
      }
    }
    try {
      if (selection.model) {
        const model = selection.model;
        await requestWithDeadline(controller.signal, (signal) =>
          client.session.switchModel({ sessionID, model }, { signal }),
        );
      }
      if (selection.agent) {
        const agent = selection.agent;
        await requestWithDeadline(controller.signal, (signal) =>
          client.session.switchAgent({ sessionID, agent }, { signal }),
        );
      }
    } catch (cause) {
      return reject(
        "session.switch",
        cause instanceof Error ? cause.message : "Native model or agent switch failed.",
      );
    }
    return { success: true, data: undefined };
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
      const controller = new AbortController();
      abort = controller;
      const resumeID = options.resumeSessionId;
      const resumeObservation: typeof provisionalResume = resumeID
        ? { sessionID: resumeID }
        : undefined;
      provisionalResume = resumeObservation;
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
      controller.signal.addEventListener(
        "abort",
        () => settle(fail("session.start", "Native session start cancelled locally.")),
        { once: true },
      );
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
        if (abort === controller) abort = undefined;
        if (provisionalResume === resumeObservation) provisionalResume = undefined;
        return connectedResult;
      }
      if (resumeID) {
        // These independent reads can reject observed busy state, not lock the session idle.
        // The subscription already observes the provisional target, including work that
        // starts and finishes between reads. log.synced would not close this race either.
        let adopted: Session | undefined;
        try {
          const [info, running, inbox, pendingPermissions, pendingForms] = await Promise.all([
            requestWithDeadline(controller.signal, (signal) =>
              client.session.get({ sessionID: resumeID }, { signal }),
            ),
            requestWithDeadline(controller.signal, (signal) => client.session.active({ signal })),
            requestWithDeadline(controller.signal, (signal) =>
              client.session.inbox.list({ sessionID: resumeID }, { signal }),
            ),
            requestWithDeadline(controller.signal, (signal) =>
              client.permission.list({ sessionID: resumeID }, { signal }),
            ),
            requestWithDeadline(controller.signal, (signal) =>
              client.session.form.list({ sessionID: resumeID }, { signal }),
            ),
          ]);
          const found = sessionFrom(info);
          if (
            found?.id === resumeID &&
            found.location.directory === options.directory &&
            !record(running)?.[resumeID] &&
            inbox.length === 0 &&
            pendingPermissions.length === 0 &&
            pendingForms.length === 0
          )
            adopted = found;
        } catch {
          adopted = undefined;
        }
        if (
          !adopted ||
          resumeObservation?.observed ||
          !connected ||
          disconnected ||
          controller.signal.aborted ||
          abort !== controller
        ) {
          const concurrent = resumeObservation?.observed !== undefined;
          controller.abort();
          if (abort === controller) abort = undefined;
          if (provisionalResume === resumeObservation) provisionalResume = undefined;
          return fail(
            "session.resume",
            concurrent
              ? "Native OpenCode target changed during resume observation; safe adoption is unavailable. Refusing concurrent work without replaying prompts or claiming lossless recovery."
              : "Native OpenCode session is busy, missing or unreachable; safe adoption is unavailable. Refusing to adopt it without replaying prompts or claiming lossless recovery.",
          );
        }
        session = adopted;
        resumed = true;
        provisionalResume = undefined;
        emit({ type: "session.ready", sessionID: adopted.id });
        return { success: true, data: adopted };
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
      if (!connected || disconnected || controller.signal.aborted || abort !== controller) {
        controller.abort();
        abort = undefined;
        session = undefined;
        return fail("event.subscribe", "Native session event stream closed during start.");
      }
      emit({ type: "session.ready", sessionID: found.id });
      return { success: true, data: found };
    },
    /** Switches model and/or agent. A running turn is interrupted first and the switch waits
        for its confirmed terminal, so the next prompt starts a fresh turn on the new selection.
        The switch calls are idempotent setters: their failure leaves the session usable. */
    switchSelection: async (selection: {
      readonly model?: {
        readonly id: string;
        readonly providerID: string;
        readonly variant?: string;
      };
      readonly agent?: string;
    }): Promise<Result<void>> => {
      if (!session || !connected || disconnected || !abort || abort.signal.aborted)
        return fail("session.switch", "Session event stream is not ready.");
      if (uncertain)
        return fail("session.switch", "Session already has pending or uncertain work.");
      if (active?.manualInput || manualExecution)
        return reject("session.switch", "Manual compaction is still pending or settling.");
      if (admitting || associating || switching || unownedExecution.length > 0)
        return reject(
          "session.switch",
          "A message is still being admitted. Try again in a moment.",
        );
      switching = true;
      try {
        return await switchNow(selection);
      } finally {
        switching = false;
      }
    },
    /** Admits a manual inbox control, not a user message. The receipt is admission,
     * never completion; its actual ID may be an already-pending native control. */
    compact: async (
      options: Pick<SessionCompactInput, "id" | "delivery"> = {},
    ): Promise<Result<{ readonly turnID: string; readonly inputID: string }>> => {
      const currentSession = session;
      const controller = abort;
      if (!currentSession || !connected || disconnected || !controller || controller.signal.aborted)
        return fail("session.compact", "Session event stream is not ready.");
      if (uncertain)
        return fail("session.compact", "Session already has pending or uncertain work.");
      if (
        active ||
        manualExecution ||
        admitting ||
        associating ||
        switching ||
        unownedExecution.length
      )
        return reject("session.compact", "Session already has active or pending work.");
      admitting = true;
      admissionSequences.clear();
      const sequenceFloor = nativeSequence + 1;
      const id = options.id ?? `msg_${NodeCrypto.randomUUID().replaceAll("-", "")}`;
      const admissionUncertain = (detail: string): Result<never> => {
        if (abort === controller) {
          uncertain = true;
          admitting = false;
          admissionEvents = [];
          admissionSequences.clear();
        }
        return fail("session.compact", `${detail} Outcome uncertain; do not replay the input.`);
      };
      let receipt: unknown;
      try {
        receipt = await requestWithDeadline(controller.signal, (signal) =>
          client.session.compact({ sessionID: currentSession.id, ...options, id }, { signal }),
        );
      } catch (cause) {
        if (isConflictError(cause) && abort === controller && !controller.signal.aborted) {
          for (const event of admissionEvents) dispatch(event);
          admissionEvents = [];
          admitting = false;
          return reject("session.compact", cause.message);
        }
        return admissionUncertain(
          cause instanceof Error ? cause.message : "Native compaction request failed.",
        );
      }
      const decoded = compactionReceiptDecode(receipt);
      if (Exit.isFailure(decoded) || decoded.value.sessionID !== currentSession.id)
        return admissionUncertain("Invalid native compaction admission receipt.");
      if (abort !== controller || controller.signal.aborted || !connected || disconnected)
        return admissionUncertain("Native session closed during compaction admission.");
      const inputID = decoded.value.id;
      commandWork = undefined;
      unownedExecution = [];
      const work = workCreate({ turnID: inputID, sessionID: currentSession.id });
      work.manualInput = { id: inputID, delivered: false };
      active = work;
      manualExecution = true;
      turnSequenceFloor = sequenceFloor;
      lastTurnID = inputID;
      // Own the canonical work at admission, even when execution is delayed.
      workStart(work);
      for (const event of admissionEvents) dispatch(event);
      admissionEvents = [];
      admitting = false;
      return { success: true, data: { turnID: inputID, inputID } };
    },
    send: async (
      text: string,
      attachments: Pick<SessionPromptInput, "files" | "agents" | "skills" | "delivery"> = {},
    ): Promise<Result<{ readonly turnID: string }>> => {
      if (!session || !connected || disconnected || !abort || abort.signal.aborted)
        return fail("session.prompt", "Session event stream is not ready.");
      const currentSession = session;
      if (uncertain)
        return fail("session.prompt", "Session already has pending or uncertain work.");
      if (admitting || associating || switching || unownedExecution.length > 0)
        return rejectSend("A message is still being admitted. Try again in a moment.");
      if (active?.manualInput) return rejectSend("Manual compaction is still pending.");
      if (!text.trim() && !attachments.files?.length)
        return rejectSend("Prompt text or at least one file is required.");
      admitting = true;
      admissionSequences.clear();
      const controller = abort;
      const slash = /^\s*\/(\S+)(?:\s+|$)/u.exec(text);
      const cached = input.inventory?.(currentSession.location.directory);
      let command: string | undefined;
      let promptText = text;
      let skills = attachments.skills;
      try {
        if (slash) {
          const inventory =
            cached?.command ??
            (await requestWithDeadline(controller.signal, async (signal) => {
              const response = await client.command.list(
                { location: currentSession.location },
                { signal },
              );
              const decoded = commandInventoryDecode(response);
              if (
                Exit.isFailure(decoded) ||
                decoded.value.location.directory !== currentSession.location.directory
              )
                throw new Error("Invalid native command inventory or mismatched location.");
              return decoded.value.data;
            }));
          if (inventory.some((entry) => entry.name === slash[1])) command = slash[1];
        }
        // Command mentions refer to its submitted argument text, not the slash prefix.
        promptText = command ? text.slice(slash![0].length) : text;
        if (/(?:^|[\s([{])\p{Sc}/u.test(promptText)) {
          const inventory =
            cached?.skill ??
            (await requestWithDeadline(controller.signal, async (signal) => {
              const response = await client.skill.list(
                { location: currentSession.location },
                { signal },
              );
              const decoded = skillInventoryDecode(response);
              if (
                Exit.isFailure(decoded) ||
                decoded.value.location.directory !== currentSession.location.directory
              )
                throw new Error("Invalid native skill inventory or mismatched location.");
              return decoded.value.data;
            }));
          const resolved = composerSkillMentionsResolve(
            promptText,
            inventory.map((skill) => skill.name),
          ).flatMap((reference) => {
            const skill = inventory.find((entry) => entry.name === reference.value);
            if (!skill) return [];
            return [
              {
                id: skill.id,
                name: skill.name,
                mention: {
                  start: reference.start,
                  end: reference.end,
                  text: reference.source,
                },
              },
            ];
          });
          if (resolved.length) skills = [...(skills ?? []), ...resolved];
        }
      } catch (cause) {
        for (const event of admissionEvents) dispatch(event);
        admissionEvents = [];
        admitting = false;
        return rejectSend(
          cause instanceof Error ? cause.message : "Native workspace inventory failed.",
        );
      }
      if (
        controller.signal.aborted ||
        !connected ||
        disconnected ||
        session?.id !== currentSession.id
      ) {
        admitting = false;
        admissionEvents = [];
        return fail("session.prompt", "Native session closed during workspace lookup.");
      }
      if (command) {
        // /command has no caller id or prompt receipt. log.synced is only a live admission
        // fence here, not a replay/recovery guarantee: even persist=false retains its watermark.
        let after: number | undefined;
        const commandUncertain = (detail: string): Result<never> => {
          // Disposal may have already released this admission. Do not poison a replacement.
          if (abort === controller) {
            uncertain = true;
            admitting = false;
            admissionEvents = [];
            admissionSequences.clear();
            admissionWake = undefined;
          }
          return fail("session.command", `${detail} Outcome uncertain; do not replay the command.`);
        };
        try {
          await requestWithDeadline(controller.signal, async (signal) => {
            for await (const frame of client.session.log(
              {
                sessionID: currentSession.id,
                ...(nativeSequence >= 0 ? { after: nativeSequence } : {}),
                follow: false,
              },
              { signal },
            )) {
              const decoded = logDecode(frame);
              if (Exit.isFailure(decoded)) throw new Error("Invalid native session log response.");
              const event = decoded.value;
              if (event.type !== "log.synced" || event.aggregateID !== currentSession.id) continue;
              after = event.seq ?? -1;
              break;
            }
            if (after === undefined) throw new Error("Native command admission fence missing.");
          });
        } catch (cause) {
          return commandUncertain(
            cause instanceof Error ? cause.message : "Native command admission fence failed.",
          );
        }
        if (after === undefined) return commandUncertain("Native command admission fence missing.");
        const fenceAfter = after;
        if (controller.signal.aborted || !connected || disconnected)
          return commandUncertain("Native session closed during command admission fence.");
        // Frames already buffered before the request belong to prior work.
        for (const event of admissionEvents) dispatch(event);
        admissionEvents = [];
        commandWork = undefined;
        try {
          await requestWithDeadline(controller.signal, (signal) =>
            client.session.command(
              {
                sessionID: currentSession.id,
                name: command,
                text: promptText,
                ...attachments,
                ...(skills ? { skills } : {}),
                ...(active && !attachments.delivery ? { delivery: "steer" as const } : {}),
              },
              { signal },
            ),
          );
        } catch (cause) {
          // Nothing is announced before both receipts. Failed expansion/admission must not
          // manufacture a running turn; an uncertain server outcome still fails closed.
          return commandUncertain(
            cause instanceof Error ? cause.message : "Native command request failed.",
          );
        }
        // v2.0.18 awaits the command handler before 204. Its awaited parent enqueues
        // are committed by then, but the global SSE feed can still be behind.
        const logged: NativeFrame[] = [];
        let through: number | undefined;
        try {
          await requestWithDeadline(controller.signal, async (signal) => {
            for await (const frame of client.session.log(
              {
                sessionID: currentSession.id,
                ...(fenceAfter >= 0 ? { after: fenceAfter } : {}),
                follow: false,
              },
              { signal },
            )) {
              const decoded = logDecode(frame);
              if (Exit.isFailure(decoded)) throw new Error("Invalid native session log response.");
              const event = decoded.value;
              if (event.type === "log.synced") {
                if (event.aggregateID !== currentSession.id) continue;
                through = event.seq ?? -1;
                break;
              }
              if (
                event.durable.aggregateID !== currentSession.id ||
                event.durable.seq <= fenceAfter
              )
                continue;
              logged.push(event);
            }
            if (through === undefined || through < fenceAfter)
              throw new Error("Native command completion watermark missing or regressed.");
          });
        } catch (cause) {
          return commandUncertain(
            cause instanceof Error ? cause.message : "Native command completion receipt failed.",
          );
        }
        // A marker can beat its SSE prefix or cover unretained rows. Bus.log also advances
        // across unknown types, and session.log filters non-session events: integer gaps
        // are legitimate. Neither a marker nor a later observed sequence proves coverage
        // of a missing inbox/execution event. Wait only within the deadline, then report
        // uncertainty rather than infer a no-run command from an incomplete prefix.
        const watermark = through!;
        for (const event of logged) {
          if ("durable" in event) admissionSequences.add(event.durable.seq);
        }
        let covered = fenceAfter;
        const prefixComplete = () => {
          while (covered < watermark && admissionSequences.has(covered + 1)) covered++;
          return covered === watermark;
        };
        const streamAvailable = () =>
          !controller.signal.aborted &&
          connected &&
          !disconnected &&
          session?.id === currentSession.id;
        try {
          await requestWithDeadline(controller.signal, async (signal) => {
            while (!prefixComplete() && streamAvailable()) {
              await new Promise<void>((resolve, reject) => {
                const cancelled = () => {
                  signal.removeEventListener("abort", cancelled);
                  admissionWake = undefined;
                  reject(signal.reason);
                };
                admissionWake = () => {
                  signal.removeEventListener("abort", cancelled);
                  admissionWake = undefined;
                  resolve();
                };
                signal.addEventListener("abort", cancelled, { once: true });
                if (signal.aborted) cancelled();
              });
            }
          });
        } catch (cause) {
          return commandUncertain(
            cause instanceof Error ? cause.message : "Native command prefix coverage unavailable.",
          );
        } finally {
          admissionWake = undefined;
        }
        if (!streamAvailable()) {
          return commandUncertain("Native session event stream closed during command admission.");
        }
        // Replay the ordered parent prefix first, then the SSE tail/children. dispatch
        // deduplicates IDs across both transports, including SSE arriving after this drain.
        admissionEvents = [...logged, ...admissionEvents];
        const promptEvent = admissionEvents.find(
          (event) =>
            event.type === "session.inbox.enqueued" &&
            event.data.sessionID === currentSession.id &&
            event.data.item.type === "user" &&
            event.durable.aggregateID === currentSession.id &&
            event.durable.seq > fenceAfter &&
            event.durable.seq <= watermark,
        );
        const prompt =
          promptEvent?.type === "session.inbox.enqueued"
            ? { id: promptEvent.data.inboxID, seq: promptEvent.durable.seq }
            : undefined;
        if (!prompt) {
          const steering = active;
          const turnID =
            steering?.scope.turnID ?? `command_${NodeCrypto.randomUUID().replaceAll("-", "")}`;
          commandWork = steering ?? workCreate({ turnID, sessionID: currentSession.id });
          if (!steering) {
            active = commandWork;
            turnSequenceFloor = fenceAfter + 1;
            lastTurnID = turnID;
            workStart(commandWork);
          }
          for (const event of admissionEvents) dispatch(event);
          admissionEvents = [];
          admitting = false;
          if (!steering && commandWork && !commandWork.terminal) {
            workSettle(commandWork);
            active = undefined;
            idleNotify();
            emit({ type: "turn.completed", turnID });
          }
          const reconciled = await reconcilePending(false);
          if (!reconciled.success) {
            uncertain = true;
            return reconciled;
          }
          return { success: true, data: { turnID } };
        }
        // A prior running turn may have settled while the command expanded. Drain only that
        // prefix against it, then bind the new prompt (or steer) before its execution frames.
        const prefix = admissionEvents.filter(
          (event) =>
            "durable" in event &&
            event.durable.aggregateID === currentSession.id &&
            event.durable.seq < prompt.seq,
        );
        for (const event of prefix) dispatch(event);
        const admission = inputAdmit(prompt.id);
        if (active?.scope.turnID === prompt.id) {
          turnSequenceFloor = prompt.seq;
        }
        for (const event of admissionEvents) {
          if (
            "durable" in event &&
            event.durable.aggregateID === currentSession.id &&
            event.durable.seq < prompt.seq
          )
            continue;
          dispatch(event);
        }
        admissionEvents = [];
        associating = true;
        admitting = false;
        const associated = await inputTurn(admission);
        associating = false;
        if (!associated.success) return associated;
        const reconciled = await reconcilePending(false);
        if (!reconciled.success) {
          uncertain = true;
          return reconciled;
        }
        return { success: true, data: { turnID: associated.data } };
      }
      commandWork = undefined;
      const id = `msg_${NodeCrypto.randomUUID().replaceAll("-", "")}`;
      // Delivery defaults to steer, but preparation/settlement can move this input
      // into a successor. Only delivery or a new execution establishes ownership.
      const steering = active;
      let receipt: unknown;
      try {
        receipt = await requestWithDeadline(controller.signal, (signal) =>
          client.session.prompt(
            {
              sessionID: currentSession.id,
              id,
              text: promptText,
              ...attachments,
              ...(skills ? { skills } : {}),
              ...(steering && !attachments.delivery ? { delivery: "steer" as const } : {}),
            },
            { signal },
          ),
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
      const admission = inputAdmit(id);
      for (const event of admissionEvents) dispatch(event);
      admissionEvents = [];
      associating = true;
      admitting = false;
      const associated = await inputTurn(admission);
      associating = false;
      if (!associated.success) return associated;
      // The volatile feed may have raced request creation during admission.
      // A failed list does not prove there is no pending request; fail closed.
      const reconciled = await reconcilePending(false);
      if (!reconciled.success) {
        uncertain = true;
        return reconciled;
      }
      return { success: true, data: { turnID: associated.data } };
    },
    reconcilePending: () => reconcilePending(),
    replyPermission: async (
      requestID: string,
      decision: "once" | "always" | "reject",
    ): Promise<Result<void>> => {
      const pending = permissions.get(requestID);
      const controller = abort;
      const currentSession = session;
      if (
        !currentSession ||
        !controller ||
        controller.signal.aborted ||
        !connected ||
        disconnected ||
        !pending ||
        pending.request.sessionID !== currentSession.id ||
        pending.replying
      )
        return fail("permission.reply", "No pending permission request in this session.");
      pending.replying = true;
      try {
        await requestWithDeadline(controller.signal, (signal) =>
          client.permission.reply(
            { sessionID: currentSession.id, requestID, decision },
            { signal },
          ),
        );
        if (
          abort !== controller ||
          controller.signal.aborted ||
          (permissions.has(requestID) && permissions.get(requestID) !== pending)
        )
          return fail("permission.reply", "Native permission request closed during reply.");
        requestSettle("permission", requestID, currentSession.id, undefined, decision);
        return { success: true, data: undefined };
      } catch (cause) {
        // An HTTP failure can still have applied the decision; never send it twice.
        if (
          abort === controller &&
          !controller.signal.aborted &&
          permissions.get(requestID) === pending
        )
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
      const controller = abort;
      const currentSession = session;
      if (
        !currentSession ||
        !controller ||
        controller.signal.aborted ||
        !connected ||
        disconnected ||
        !pending ||
        pending.form.sessionID !== currentSession.id ||
        pending.replying
      )
        return fail("session.form.reply", "No pending form in this session.");
      pending.replying = true;
      try {
        await requestWithDeadline(controller.signal, (signal) =>
          answer
            ? client.session.form.reply(
                { sessionID: currentSession.id, formID, answer },
                { signal },
              )
            : client.session.form.cancel({ sessionID: currentSession.id, formID }, { signal }),
        );
        if (
          abort !== controller ||
          controller.signal.aborted ||
          (forms.has(formID) && forms.get(formID) !== pending)
        )
          return fail("session.form.reply", "Native form closed during reply.");
        requestSettle("form", formID, currentSession.id, answer);
        return { success: true, data: undefined };
      } catch (cause) {
        // Native validation rejects before settlement. Only that definite, matching
        // rejection permits correction; transport failures may have applied the answer.
        if (answer && isFormInvalidAnswerError(cause) && cause.id === formID) {
          if (abort === controller && !controller.signal.aborted && forms.get(formID) === pending)
            pending.replying = false;
          return reject("session.form.reply", cause.message);
        }
        if (abort === controller && !controller.signal.aborted && forms.get(formID) === pending)
          await reconcilePending();
        return fail(
          "session.form.reply",
          cause instanceof Error ? cause.message : "Form reply outcome uncertain.",
        );
      }
    },
    /** Context window of a model, or undefined when the server does not report one. */
    contextLimit: async (model: {
      readonly id: string;
      readonly providerID: string;
    }): Promise<number | undefined> => {
      if (!session) return undefined;
      try {
        const response = await requestWithDeadline(abort?.signal, (signal) =>
          client.model.list({ location: { directory: session!.location.directory } }, { signal }),
        );
        const models = (response as { readonly data?: ReadonlyArray<unknown> }).data ?? [];
        for (const entry of models) {
          const info = record(entry);
          if (
            info?.providerID !== model.providerID ||
            (info.id !== model.id && info.modelID !== model.id)
          )
            continue;
          const limit = record(info.limit)?.context;
          return typeof limit === "number" && Number.isFinite(limit) && limit > 0
            ? Math.floor(limit)
            : undefined;
        }
      } catch {
        // The meter is optional; a missing limit only drops the percentage.
      }
      return undefined;
    },
    recover: async (): Promise<Result<void>> =>
      fail(
        "session.recover",
        "Native v2.0.18 cannot prove lossless recovery: durable log persistence and a complete snapshot are not guaranteed. Stop this engine; do not retry uncertain prompts.",
      ),
    interrupt: async (): Promise<Result<boolean>> => {
      if (!session) return fail("session.interrupt", "Session has not started.");
      const manual = active;
      if (manual?.manualInput && !manual.manualInput.delivered) {
        const controller = abort;
        try {
          await requestWithDeadline(controller?.signal, (signal) =>
            client.session.inbox.cancel(
              { sessionID: manual.scope.sessionID, inboxID: manual.manualInput!.id },
              { signal },
            ),
          );
        } catch (cause) {
          if (abort === controller) uncertain = true;
          return fail(
            "session.interrupt",
            `${cause instanceof Error ? cause.message : "Native inbox cancellation failed."} Outcome uncertain; do not replay the input.`,
          );
        }
        if (abort !== controller || controller?.signal.aborted)
          return fail("session.interrupt", "Native session closed during inbox cancellation.");
        manualExecution = false;
        manualSettle(manual, { interruption: "user" });
        return { success: true, data: true };
      }
      const id = session.id;
      let response: { readonly interrupted: boolean };
      try {
        response = await requestWithDeadline(abort?.signal, (signal) =>
          client.session.interrupt({ sessionID: id }, { signal }),
        );
      } catch (cause) {
        uncertain = true;
        return fail(
          "session.interrupt",
          cause instanceof Error ? cause.message : "Native interrupt request failed.",
        );
      }
      const interrupted = response.interrupted;
      if (typeof interrupted !== "boolean") {
        uncertain = true;
        return fail("session.interrupt", "Invalid native interrupt response.");
      }
      // Do not fabricate a turn terminal: the execution.interrupted event is authoritative.
      return { success: true, data: interrupted };
    },
    /** Local disposal is used by recovery; only explicit stops interrupt native work. */
    stop: async (options?: { readonly interrupt?: boolean }): Promise<Result<void>> => {
      if (!abort) return { success: true, data: undefined };
      // Cancel all local requests before waiting for the remote interrupt receipt.
      // In particular, a stalled interrupt must not leave a reply mutation running.
      abort.abort();
      let stopFailure: Result<void> | undefined;
      let cancelledManual = false;
      if (options?.interrupt !== false && active?.manualInput && !active.manualInput.delivered) {
        try {
          await requestWithDeadline(undefined, (signal) =>
            client.session.inbox.cancel(
              { sessionID: active!.scope.sessionID, inboxID: active!.manualInput!.id },
              { signal },
            ),
          );
          cancelledManual = true;
        } catch (cause) {
          stopFailure = fail(
            "session.interrupt",
            `${cause instanceof Error ? cause.message : "Native inbox cancellation failed."} Outcome uncertain; local engine stopped.`,
          );
        }
      }
      if (
        options?.interrupt !== false &&
        !cancelledManual &&
        (active || manualExecution || admitting || associating || uncertain)
      ) {
        try {
          const response = await requestWithDeadline(
            abort.signal.aborted ? undefined : abort.signal,
            (signal) => client.session.interrupt({ sessionID: session!.id }, { signal }),
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
      admissionWake?.();
      admissionWake = undefined;
      admissionSequences.clear();
      abort = undefined;
      connected = false;
      provisionalResume = undefined;
      resumed = false;
      active = undefined;
      manualExecution = false;
      admittedInputs.clear();
      syntheticInputs.clear();
      unownedExecution = [];
      commandWork = undefined;
      dispatchedEvents.clear();
      lastTurnID = undefined;
      nativeSequence = -1;
      turnSequenceFloor = 0;
      permissions.clear();
      forms.clear();
      settledRequests.clear();
      children.clear();
      compactionsBySession.clear();
      childParents.clear();
      childLaunches.clear();
      retiredMessages.clear();
      uncertain = false;
      admitting = false;
      associating = false;
      admissionEvents = [];
      disconnected = false;
      session = undefined;
      idleNotify();
      return stopFailure ?? { success: true, data: undefined };
    },
  };
};
