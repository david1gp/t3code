// @effect-diagnostics nodeBuiltinImport:off - SDK persistence fixture uses Node paths.
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { assert, it } from "@effect/vitest";
import {
  ApprovalRequestId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import { ServerConfig } from "../../config.ts";
import { makePiAdapter } from "./PiAdapter.ts";

const testLayer = ServerConfig.layerTest(process.cwd(), { prefix: "pi-sdk-adapter-test-" }).pipe(
  Layer.provideMerge(NodeServices.layer),
);
const threadId = ThreadId.make("pi-adapter-thread");
const start = {
  threadId,
  provider: ProviderDriverKind.make("pi"),
  cwd: process.cwd(),
  runtimeMode: "full-access" as const,
};

it.effect("starts an SDK session in T3 state and disposes it without approvals", () =>
  Effect.gen(function* () {
    const adapter = yield* makePiAdapter();
    const session = yield* adapter.startSession(start);
    assert.equal(session.status, "ready");
    assert.match((session.resumeCursor as { sessionId: string }).sessionId, /^[\da-f-]{36}$/);
    assert.isTrue(yield* adapter.hasSession(threadId));
    assert.deepStrictEqual(yield* adapter.readThread(threadId), { threadId, turns: [] });
    assert.equal(adapter.capabilities.supportsConversationRollback, false);
    assert.equal(
      (yield* adapter.rollbackThread(threadId, 1).pipe(Effect.flip))._tag,
      "ProviderAdapterRequestError",
    );
    assert.equal(
      (yield* adapter
        .respondToRequest(threadId, ApprovalRequestId.make("approval"), "accept")
        .pipe(Effect.flip))._tag,
      "ProviderAdapterRequestError",
    );
    yield* adapter.stopSession(threadId);
    assert.isFalse(yield* adapter.hasSession(threadId));
  }).pipe(Effect.scoped, Effect.provide(testLayer)),
);

it.effect(
  "rejects missing resumed sessions and invalid cursors without creating a replacement",
  () =>
    Effect.gen(function* () {
      const adapter = yield* makePiAdapter();
      assert.equal(
        (yield* adapter
          .startSession({ ...start, resumeCursor: { sessionId: "../../outside" } })
          .pipe(Effect.flip))._tag,
        "ProviderAdapterValidationError",
      );
      assert.equal(
        (yield* adapter
          .startSession({
            ...start,
            resumeCursor: { schemaVersion: 1, sessionId: "00000000-0000-0000-0000-000000000001" },
          })
          .pipe(Effect.flip))._tag,
        "ProviderAdapterSessionNotFoundError",
      );
      assert.isFalse(yield* adapter.hasSession(threadId));
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
);

it.effect("resumes only an existing T3-owned SDK session and reads its persisted branch", () =>
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    const adapter = yield* makePiAdapter();
    const id = "00000000-0000-0000-0000-000000000002";
    const directory = NodePath.join(config.stateDir, "pi-sessions", "pi", threadId);
    const manager = SessionManager.create(process.cwd(), directory, { id });
    assert.equal(manager.getSessionId(), id);
    manager.appendMessage({
      role: "user",
      content: [{ type: "text", text: "remember" }],
      timestamp: 1,
    });
    manager.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "yes" }],
      api: "anthropic-messages",
      provider: "anthropic",
      model: "test",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: 2,
    });
    assert.isDefined(manager.getSessionFile());
    const fs = yield* FileSystem.FileSystem;
    assert.isTrue(
      (yield* fs.readDirectory(directory)).some((name) => name.endsWith(`_${id}.jsonl`)),
    );
    const session = yield* adapter.startSession({
      ...start,
      resumeCursor: { schemaVersion: 1, sessionId: id },
    });
    assert.deepStrictEqual(session.resumeCursor, { schemaVersion: 1, sessionId: id });
    const history = yield* adapter.readThread(threadId);
    assert.equal(history.turns.length, 1);
    assert.equal((history.turns[0]!.items[0] as { role: string }).role, "user");
    yield* adapter.stopSession(threadId);
    assert.equal(
      (yield* adapter.readThread(threadId).pipe(Effect.flip))._tag,
      "ProviderAdapterSessionNotFoundError",
    );
  }).pipe(Effect.scoped, Effect.provide(testLayer)),
);

it.effect("uses SDK model validation before prompting and never records an unavailable model", () =>
  Effect.gen(function* () {
    const adapter = yield* makePiAdapter();
    yield* adapter.startSession(start);
    const previousModel = (yield* adapter.listSessions())[0]?.model;
    assert.equal(
      (yield* adapter
        .sendTurn({
          threadId,
          input: "hello",
          modelSelection: { instanceId: ProviderInstanceId.make("pi"), model: "absent/absent" },
        })
        .pipe(Effect.flip))._tag,
      "ProviderAdapterRequestError",
    );
    assert.equal((yield* adapter.listSessions())[0]?.model, previousModel);
    assert.deepStrictEqual(yield* adapter.readThread(threadId), { threadId, turns: [] });
  }).pipe(Effect.scoped, Effect.provide(testLayer)),
);

it.effect("rejects non-image attachments instead of silently dropping them", () =>
  Effect.gen(function* () {
    const adapter = yield* makePiAdapter();
    yield* adapter.startSession(start);
    const error = yield* adapter
      .sendTurn({
        threadId,
        input: "",
        attachments: [
          { type: "file", id: "file-id", name: "notes.txt", mimeType: "text/plain", sizeBytes: 5 },
        ],
      })
      .pipe(Effect.flip);
    assert.equal(error._tag, "ProviderAdapterValidationError");
    if (error._tag === "ProviderAdapterValidationError") {
      assert.equal(error.issue, "Pi does not support 'file' attachments.");
    }
    assert.deepStrictEqual(yield* adapter.readThread(threadId), { threadId, turns: [] });
  }).pipe(Effect.scoped, Effect.provide(testLayer)),
);
