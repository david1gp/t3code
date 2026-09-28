// @effect-diagnostics nodeBuiltinImport:off globalDate:off - Pi sessions persist under T3 state.
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";
import {
  createAgentSession,
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
  TurnId,
  type ProviderRuntimeEvent,
  type ProviderSession,
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
};
type Session = {
  session: ProviderSession;
  readonly sessionId: string;
  readonly sdk: AgentSession;
  unsubscribe: () => void;
  readonly scope: Scope.Closeable;
  active: Turn | undefined;
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
    const setModel = (ctx: Session, model: string) =>
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
        yield* request("set_model", () => ctx.sdk.setModel(selected));
        ctx.session = { ...ctx.session, model };
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
    const consume = (ctx: Session, event: AgentSessionEvent) =>
      Effect.gen(function* () {
        const turn = ctx.active;
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
          payload: turn.interrupted
            ? { state: "cancelled", stopReason: "cancelled" }
            : { state: "failed", stopReason: "error", errorMessage: detail },
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
        if (
          input.modelSelection?.instanceId === instanceId &&
          input.modelSelection.options?.length
        ) {
          return yield* new ProviderAdapterValidationError({
            provider,
            operation: "startSession",
            issue: "Pi model options are not supported by this adapter.",
          });
        }
        const previous = sessions.get(input.threadId);
        if (previous) yield* stop(previous);
        const resumedId = sessionIdFromCursor(input.resumeCursor);
        const sessionId = resumedId ?? NodeCrypto.randomUUID();
        const cwd = NodePath.resolve(input.cwd.trim());
        const ownedDirectory = NodePath.join(
          sessionDirectory,
          encodeURIComponent(instanceId),
          encodeURIComponent(input.threadId),
        );
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
              // Extensions have an interactive UI contract; do not load them without one.
              noExtensions: true,
            });
            await loader.reload();
            const modelRuntime = await ModelRuntime.create();
            const selection =
              input.modelSelection?.instanceId === instanceId
                ? input.modelSelection.model
                : undefined;
            const parts = selection ? modelParts(selection) : undefined;
            if (selection && !parts) throw new Error("Pi model must be provider/modelId.");
            const model = parts ? modelRuntime.getModel(parts.provider, parts.modelId) : undefined;
            if (parts && !model) throw new Error(`Pi model ${selection} was not found.`);
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
        });
        const scope = yield* Scope.make("sequential");
        const cursor = { schemaVersion: resumeVersion, sessionId };
        const now = nowIso();
        const ctx: Session = {
          sessionId,
          sdk: opened,
          unsubscribe: () => {},
          scope,
          stopped: false,
          active: undefined,
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
        const events = yield* Queue.unbounded<AgentSessionEvent>();
        ctx.unsubscribe = opened.subscribe((event) => {
          Effect.runSync(Queue.offer(events, event));
        });
        sessions.set(input.threadId, ctx);
        yield* Stream.fromQueue(events).pipe(
          Stream.runForEach((event) => (ctx.stopped ? Effect.void : consume(ctx, event))),
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
        const selection =
          input.modelSelection?.instanceId === instanceId ? input.modelSelection.model : undefined;
        if (selection && input.modelSelection?.options?.length) {
          return yield* new ProviderAdapterValidationError({
            provider,
            operation: "sendTurn",
            issue: "Pi model options are not supported by this adapter.",
          });
        }
        if (selection && selection !== ctx.session.model) {
          yield* setModel(ctx, selection);
        }
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
        const count = ctx.sdk.sessionManager
          .getEntries()
          .filter((entry) => entry.type === "message" && entry.message.role === "user").length;
        const turn: Turn = steering ?? {
          id: TurnId.make(`pi:${ctx.sessionId}:${count}`),
          settled: yield* Deferred.make<void, ProviderAdapterRequestError>(),
          interrupted: false,
          failure: undefined,
          segment: 0,
          assistantItem: undefined,
        };
        if (!steering) {
          ctx.active = turn;
          ctx.session = {
            ...ctx.session,
            activeTurnId: turn.id,
            status: "running",
            updatedAt: nowIso(),
          };
        }
        if (!steering) {
          yield* emit({
            type: "turn.started",
            ...base(ctx, turn.id),
            payload: { model: ctx.session.model },
          });
        }
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
