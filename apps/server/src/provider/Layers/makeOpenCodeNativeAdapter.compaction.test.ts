// @effect-diagnostics globalFetch:off - fake I/O exercises the pinned native client.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { SessionInbox } from "@opencode/client/effect";
import {
  MessageId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  ProviderRuntimeEvent,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { ServerConfig } from "../../config.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import * as ProviderSessionRuntime from "../../persistence/ProviderSessionRuntime.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import * as AnalyticsService from "../../telemetry/AnalyticsService.ts";
import { openCodeNativeSessionEngineCreate } from "../openCodeNativeSessionEngineCreate.ts";
import { openCodeNativeWireSchema } from "../openCodeNativeWireSchema.ts";
import type { OpenCodeNativeInventory } from "../openCodeNativeInventorySchema.ts";
import { ProviderAdapterRegistry } from "../Services/ProviderAdapterRegistry.ts";
import { ProviderService } from "../Services/ProviderService.ts";
import { makeAdapterRegistryMock } from "../testUtils/providerAdapterRegistryMock.ts";
import { ProviderEventLoggers, NoOpProviderEventLoggers } from "./ProviderEventLoggers.ts";
import { makeProviderServiceLive } from "./ProviderService.ts";
import { ProviderSessionDirectoryLive } from "./ProviderSessionDirectory.ts";
import { makeOpenCodeNativeAdapter } from "./makeOpenCodeNativeAdapter.ts";

const threadId = ThreadId.make("native-manual-service");
const instanceId = ProviderInstanceId.make("opencode");
const requestId = MessageId.make("composer-compact");
const receiptId = "msg_actual_control";
const directory = process.cwd();
const session = { id: "ses_compact_service", location: { directory } };
const feedDecode = Schema.decodeUnknownSync(openCodeNativeWireSchema.feed);
const receiptDecode = Schema.decodeUnknownSync(Schema.toEncoded(SessionInbox.Compaction));
const runtimeDecode = Schema.decodeEffect(ProviderRuntimeEvent);
const usage = {
  cost: 0.25,
  tokens: { input: 10, output: 7, reasoning: 2, cache: { read: 3, write: 4 } },
};
const configLayer = ServerConfig.layerTest(directory, { prefix: "compact-service-" }).pipe(
  Layer.provideMerge(NodeServices.layer),
);

const ioCreate = () => {
  let demand = Promise.withResolvers<void>();
  let requested = Promise.withResolvers<void>();
  let stream!: ReadableStreamDefaultController<Uint8Array>;
  let closed = false;
  let sequence = 0;
  let pending!: { body: Record<string, unknown>; resolve: (response: Response) => void };
  const requests: Array<{ path: string; body?: Record<string, unknown> }> = [];
  const encode = (type: string, data: Record<string, unknown>, seq = ++sequence) => {
    const frame = {
      id: `evt_compact_${seq}`,
      created: 1,
      type,
      ...(type === "server.connected"
        ? {}
        : { durable: { aggregateID: session.id, seq, version: 1 } }),
      data,
    };
    feedDecode(frame);
    return new TextEncoder().encode(`data: ${JSON.stringify(frame)}\n\n`);
  };
  const fetch: typeof globalThis.fetch = async (input, options) => {
    const path = new URL(input instanceof Request ? input.url : String(input)).pathname;
    const body = options?.body
      ? (JSON.parse(String(options.body)) as Record<string, unknown>)
      : undefined;
    requests.push({ path, ...(body ? { body } : {}) });
    if (path === "/api/event")
      return new Response(
        new ReadableStream<Uint8Array>(
          {
            start(controller) {
              stream = controller;
              controller.enqueue(encode("server.connected", {}));
              options?.signal?.addEventListener(
                "abort",
                () => {
                  if (!closed) controller.close();
                  closed = true;
                  demand.resolve();
                },
                { once: true },
              );
            },
            pull() {
              demand.resolve();
            },
          },
          { highWaterMark: 0 },
        ),
        { headers: { "content-type": "text/event-stream" } },
      );
    if (path === "/api/session") return Response.json({ data: session });
    if (path.endsWith("/compact")) {
      const response = Promise.withResolvers<Response>();
      pending = { body: body!, resolve: response.resolve };
      options?.signal?.addEventListener("abort", () => response.reject(options.signal?.reason), {
        once: true,
      });
      requested.resolve();
      return response.promise;
    }
    if (path.endsWith("/prompt"))
      return Response.json({ data: { id: body!.id, sessionID: session.id, type: "user" } });
    if (path.endsWith("/permission") || path.endsWith("/form")) return Response.json({ data: [] });
    if (path.endsWith("/model") || path.endsWith("/agent"))
      return new Response(null, { status: 204 });
    if (path.endsWith("/interrupt")) return Response.json({ interrupted: true });
    if (path.includes("/inbox/")) return new Response(null, { status: 204 });
    return new Response(null, { status: 404 });
  };
  return {
    fetch,
    requests,
    requested: () => requested.promise,
    observe: async (type: string, data: Record<string, unknown> = {}, seq?: number) => {
      await demand.promise;
      demand = Promise.withResolvers<void>();
      stream.enqueue(encode(type, { sessionID: session.id, ...data }, seq));
      await demand.promise;
    },
    receipt: () => {
      const data = {
        id: receiptId,
        sessionID: session.id,
        type: "compaction",
        payload: {},
        time: { created: 1 },
        delivery: pending.body.delivery ?? "steer",
      };
      receiptDecode(data);
      pending.resolve(Response.json({ data }));
      requested = Promise.withResolvers<void>();
    },
    reject: () =>
      pending.resolve(
        Response.json(
          { _tag: "ConflictError", message: "control conflict", resource: "inbox" },
          { status: 409 },
        ),
      ),
    uncertain: () => pending.resolve(Response.json({ invalid: "receipt" })),
  };
};

const fixture = Effect.fnUntraced(function* (
  options: {
    inventory?: () => OpenCodeNativeInventory;
    modelSelection?: { instanceId: ProviderInstanceId; model: string };
  } = {},
) {
  const io = ioCreate();
  const adapter = yield* makeOpenCodeNativeAdapter({
    url: "http://native-fixture",
    ...(options.inventory ? { inventory: options.inventory } : {}),
    engineCreate: (options) => openCodeNativeSessionEngineCreate({ ...options, fetch: io.fetch }),
  });
  const directoryLayer = ProviderSessionDirectoryLive.pipe(
    Layer.provide(ProviderSessionRuntime.layer.pipe(Layer.provide(SqlitePersistenceMemory))),
  );
  const services = yield* Layer.build(
    makeProviderServiceLive().pipe(
      Layer.provide(NodeServices.layer),
      Layer.provide(
        Layer.succeed(
          ProviderAdapterRegistry,
          makeAdapterRegistryMock({ [ProviderDriverKind.make("opencode")]: adapter }),
        ),
      ),
      Layer.provide(directoryLayer),
      Layer.provide(ServerSettingsService.layerTest()),
      Layer.provide(configLayer),
      Layer.provide(AnalyticsService.layerTest),
      Layer.provide(Layer.succeed(ProviderEventLoggers, NoOpProviderEventLoggers)),
    ),
  );
  const provider = yield* ProviderService.pipe(Effect.provide(services));
  const queue = yield* Queue.unbounded<ProviderRuntimeEvent>();
  yield* Stream.runForEach(provider.streamEvents, (event) => Queue.offer(queue, event)).pipe(
    Effect.forkChild,
  );
  yield* Effect.yieldNow;
  yield* provider.startSession(threadId, {
    threadId,
    provider: ProviderDriverKind.make("opencode"),
    providerInstanceId: instanceId,
    cwd: directory,
    runtimeMode: "full-access",
    ...(options.modelSelection ? { modelSelection: options.modelSelection } : {}),
  });
  const through = Effect.fnUntraced(function* (
    predicate: (event: ProviderRuntimeEvent) => boolean,
  ) {
    const events: ProviderRuntimeEvent[] = [];
    while (true) {
      const event = yield* Queue.take(queue);
      yield* runtimeDecode(event);
      events.push(event);
      if (predicate(event)) return events;
    }
  });
  yield* through((event) => event.type === "thread.started");
  return { io, adapter, provider, through };
});

it.effect.each(["before", "after"] as const)(
  "ProviderService native compact settles canonical lifecycle %s actual receipt without prompt or duplicate charges",
  (order) =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const compacting = yield* f.provider
        .compactThread(threadId, undefined, requestId)
        .pipe(Effect.forkChild);
      yield* Effect.promise(f.io.requested);
      const lifecycle = Effect.promise(async () => {
        await f.io.observe("session.execution.started");
        await f.io.observe("session.inbox.delivered", { inboxID: receiptId });
        await f.io.observe("session.compaction.started", {
          reason: "manual",
          inputID: receiptId,
          recent: "",
        });
        await f.io.observe("session.compaction.ended", {
          reason: "manual",
          text: "summary",
          recent: "",
          model: { providerID: "fixture", id: "actual" },
          ...usage,
        });
      });
      if (order === "before") yield* lifecycle;
      f.io.receipt();
      if (order === "after") {
        const started = (yield* f.through((event) => event.type === "turn.started")).at(-1);
        assert.equal(started?.turnId, receiptId);
        assert.equal((yield* f.adapter.listSessions())[0]?.status, "running");
        const overlap = yield* f.provider.compactThread(threadId).pipe(Effect.result);
        assert.equal(overlap._tag, "Failure");
        const send = yield* f.adapter.sendTurn({ threadId, input: "busy" }).pipe(Effect.result);
        assert.equal(send._tag, "Failure");
        yield* lifecycle;
      }
      yield* Fiber.join(compacting);
      const events = yield* f.through((event) => event.type === "turn.completed");
      const compacted = events.find(
        (event) => event.type === "thread.state.changed" && event.payload.state === "compacted",
      );
      assert.equal(String(compacted?.requestId), String(requestId));
      const terminal = events.at(-1);
      assert.equal(terminal?.turnId, receiptId);
      if (terminal?.type === "turn.completed") {
        assert.equal(terminal.payload.state, "completed");
        assert.equal(terminal.payload.totalCostUsd, 0.25);
        assert.equal(terminal.payload.tokenUsage?.inputTokens, 17);
        assert.equal(terminal.payload.tokenUsage?.outputTokens, 9);
      }
      assert.equal(events.filter((event) => event.type === "turn.cost.updated").length, 1);
      assert.equal(
        events.some(
          (event) =>
            event.type === "thread.token-usage.updated" &&
            event.payload.usage.usedTokens !== undefined,
        ),
        false,
      );
      assert.equal((yield* f.adapter.listSessions())[0]?.status, "ready");
      assert.equal(
        f.io.requests.some((request) => request.path.endsWith("/prompt")),
        false,
      );
      assert.equal(f.io.requests.filter((request) => request.path.endsWith("/compact")).length, 1);
      // Execution ends later than the control. It cannot manufacture another terminal.
      yield* Effect.promise(() =>
        f.io.observe(
          "session.compaction.ended",
          {
            reason: "manual",
            text: "summary",
            recent: "",
            model: { providerID: "fixture", id: "actual" },
            ...usage,
          },
          5,
        ),
      );
      yield* Effect.promise(() => f.io.observe("session.execution.succeeded"));
      yield* f.provider.sendTurn({ threadId, input: "ordinary after compaction" });
      yield* Effect.promise(() => f.io.observe("session.execution.started"));
      const following = yield* f.through((event) => event.type === "turn.started");
      assert.equal(
        following.some(
          (event) =>
            event.type === "turn.completed" ||
            event.type === "turn.cost.updated" ||
            (event.type === "thread.state.changed" && event.payload.state === "compacted"),
        ),
        false,
      );
    }).pipe(Effect.provide(configLayer)),
);

it.effect(
  "ProviderService native compact charged failure is not reported compacted or safely completed",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const compacting = yield* f.provider
        .compactThread(threadId)
        .pipe(Effect.result, Effect.forkChild);
      yield* Effect.promise(f.io.requested);
      f.io.receipt();
      yield* f.through((event) => event.type === "turn.started");
      yield* Effect.promise(async () => {
        await f.io.observe("session.execution.started");
        await f.io.observe("session.inbox.delivered", { inboxID: receiptId });
        await f.io.observe("session.compaction.started", {
          reason: "manual",
          inputID: receiptId,
          recent: "",
        });
        await f.io.observe("session.compaction.failed", {
          reason: "manual",
          error: { type: "summary.failed", message: "charged failure" },
          ...usage,
        });
      });
      assert.equal((yield* Fiber.join(compacting))._tag, "Failure");
      const events = yield* f.through((event) => event.type === "turn.completed");
      assert.equal(
        events.some(
          (event) => event.type === "thread.state.changed" && event.payload.state === "compacted",
        ),
        false,
      );
      const terminal = events.at(-1);
      if (terminal?.type === "turn.completed") {
        assert.equal(terminal.payload.state, "failed");
        assert.equal(terminal.payload.totalCostUsd, 0.25);
      }
      assert.equal((yield* f.adapter.listSessions())[0]?.status, "ready");
    }).pipe(Effect.provide(configLayer)),
);

it.effect(
  "ProviderService native compact definite admission rejection keeps the session ready without terminal fabrication",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const compacting = yield* f.provider
        .compactThread(threadId)
        .pipe(Effect.result, Effect.forkChild);
      yield* Effect.promise(f.io.requested);
      f.io.reject();
      assert.equal((yield* Fiber.join(compacting))._tag, "Failure");
      assert.equal((yield* f.adapter.listSessions())[0]?.status, "ready");
      yield* f.provider.sendTurn({ threadId, input: "after rejection" });
      assert.equal(f.io.requests.filter((request) => request.path.endsWith("/prompt")).length, 1);
    }).pipe(Effect.provide(configLayer)),
);

it.effect(
  "ProviderService native compact uncertain receipt loses readiness without replay or fabricated completion",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const compacting = yield* f.provider
        .compactThread(threadId)
        .pipe(Effect.result, Effect.forkChild);
      yield* Effect.promise(f.io.requested);
      f.io.uncertain();
      assert.equal((yield* Fiber.join(compacting))._tag, "Failure");
      const events = yield* f.through((event) => event.type === "session.exited");
      assert.equal(
        events.some((event) => event.type === "turn.completed"),
        false,
      );
      assert.equal(
        events.some(
          (event) => event.type === "thread.state.changed" && event.payload.state === "compacted",
        ),
        false,
      );
      assert.equal((yield* f.adapter.listSessions())[0]?.status, "error");
      assert.equal(f.io.requests.filter((request) => request.path.endsWith("/compact")).length, 1);
    }).pipe(Effect.provide(configLayer)),
);

it.effect(
  "native compact refuses active ordinary work before changing model or interrupting its turn",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* f.provider.sendTurn({ threadId, input: "ordinary" });
      yield* Effect.promise(() => f.io.observe("session.execution.started"));
      yield* f.through((event) => event.type === "turn.started");
      const rejected = yield* f.provider
        .compactThread(threadId, { instanceId, model: "fixture/new" })
        .pipe(Effect.result);
      assert.equal(rejected._tag, "Failure");
      assert.equal((yield* f.adapter.listSessions())[0]?.status, "running");
      assert.equal(
        f.io.requests.some(
          (request) =>
            request.path.endsWith("/compact") ||
            request.path.endsWith("/interrupt") ||
            (request.path.endsWith("/model") && request.body),
        ),
        false,
      );
      yield* Effect.promise(() => f.io.observe("session.execution.succeeded"));
      const events = yield* f.through((event) => event.type === "turn.completed");
      assert.equal(
        events.some(
          (event) => event.type === "thread.state.changed" && event.payload.state === "compacted",
        ),
        false,
      );
    }).pipe(Effect.provide(configLayer)),
);

it.effect(
  "ProviderService accepted native control stays busy when enclosing execution ends without compaction and cancels authoritatively",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const settled = yield* Deferred.make<void>();
      const compacting = yield* f.provider.compactThread(threadId).pipe(
        Effect.result,
        Effect.tap(() => Deferred.succeed(settled, undefined)),
        Effect.forkChild,
      );
      yield* Effect.promise(f.io.requested);
      f.io.receipt();
      yield* f.through((event) => event.type === "turn.started");
      yield* Effect.promise(async () => {
        await f.io.observe("session.execution.started");
        await f.io.observe("session.execution.succeeded");
      });
      assert.equal(yield* Deferred.isDone(settled), false);
      assert.equal((yield* f.adapter.listSessions())[0]?.status, "running");
      assert.equal((yield* f.provider.compactThread(threadId).pipe(Effect.result))._tag, "Failure");
      yield* f.adapter.interruptTurn(threadId);
      yield* Effect.promise(() => f.io.observe("session.inbox.cancelled", { inboxID: receiptId }));
      assert.equal((yield* Fiber.join(compacting))._tag, "Failure");
      const events = yield* f.through((event) => event.type === "turn.completed");
      const terminal = events.at(-1);
      if (terminal?.type === "turn.completed") assert.equal(terminal.payload.state, "interrupted");
      assert.equal(
        events.some(
          (event) => event.type === "thread.state.changed" && event.payload.state === "compacted",
        ),
        false,
      );
      assert.equal((yield* f.adapter.listSessions())[0]?.status, "ready");
    }).pipe(Effect.provide(configLayer)),
);

it.effect.each(["explicit", "saved", "config"] as const)(
  "native compact resolves %s model precedence before official inbox invocation",
  (precedence) =>
    Effect.gen(function* () {
      let configured = "old";
      const f = yield* fixture({
        inventory: () => ({
          provider: [],
          model: [],
          command: [],
          skill: [],
          agent: [{ id: "review", name: "Review", mode: "primary", hidden: false }],
          configuredModel: { providerID: "fixture", id: configured },
        }),
        ...(precedence === "saved"
          ? { modelSelection: { instanceId, model: "fixture/saved" } }
          : {}),
      });
      configured = "new";
      const compacting = yield* f.provider
        .compactThread(
          threadId,
          precedence === "explicit"
            ? { instanceId, model: "fixture/explicit", options: [{ id: "agent", value: "plan" }] }
            : undefined,
        )
        .pipe(Effect.result, Effect.forkChild);
      yield* Effect.promise(f.io.requested);
      const modelSwitches = f.io.requests.filter(
        (request) => request.path.endsWith("/model") && request.body,
      );
      assert.deepStrictEqual(
        modelSwitches.map((request) => request.body),
        precedence === "saved"
          ? []
          : [
              {
                model: {
                  providerID: "fixture",
                  id: precedence === "explicit" ? "explicit" : "new",
                },
              },
            ],
      );
      assert.deepStrictEqual(
        f.io.requests
          .filter((request) => request.path.endsWith("/agent"))
          .map((request) => request.body),
        precedence === "explicit" ? [{ agent: "plan" }] : [],
      );
      assert.equal(f.io.requests.at(-1)?.path.endsWith("/compact"), true);
      assert.equal(
        f.io.requests.some((request) => request.path.endsWith("/prompt")),
        false,
      );
      f.io.reject();
      assert.equal((yield* Fiber.join(compacting))._tag, "Failure");
    }).pipe(Effect.provide(configLayer)),
);
