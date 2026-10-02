// @effect-diagnostics globalFetch:off - fake I/O drives the pinned client's parser and official schemas.
import { expect, it, vi } from "vite-plus/test";
import { SessionInbox } from "@opencode/client/effect";
import * as Schema from "effect/Schema";

import { openCodeNativeSessionEngineCreate } from "./openCodeNativeSessionEngineCreate.ts";
import { openCodeNativeWireSchema } from "./openCodeNativeWireSchema.ts";

const directory = "/native/manual-compaction";
const session = { id: "ses_manual_fixture", location: { directory } };
const feedDecode = Schema.decodeUnknownSync(openCodeNativeWireSchema.feed);
const receiptDecode = Schema.decodeUnknownSync(Schema.toEncoded(SessionInbox.Compaction));
type Event = Parameters<Parameters<typeof openCodeNativeSessionEngineCreate>[0]["onEvent"]>[0];
const usage = {
  cost: 0.25,
  tokens: { input: 10, output: 7, reasoning: 2, cache: { read: 3, write: 4 } },
};
const fixture = async () => {
  let demand = Promise.withResolvers<void>();
  let stream!: ReadableStreamDefaultController<Uint8Array>;
  let streamClosed = false;
  let sequence = 0;
  let pending:
    | {
        body: Record<string, unknown>;
        signal?: AbortSignal | null;
        resolve: (response: Response) => void;
        reject: (cause: unknown) => void;
      }
    | undefined;
  let requested = Promise.withResolvers<void>();
  const requests: Array<{
    path: string;
    method: string;
    body?: Record<string, unknown>;
    signal?: AbortSignal | null;
  }> = [];
  const events: Event[] = [];
  let usageTarget = 0;
  let usageObserved = 0;
  let usageBarrier = Promise.withResolvers<void>();
  let compactionTarget = 0;
  let compactionObserved = 0;
  let compactionBarrier = Promise.withResolvers<void>();
  const encode = (
    type: string,
    data: Record<string, unknown>,
    seq = ++sequence,
    id = `evt_manual_${seq}`,
  ) => {
    const frame = {
      id,
      created: 1,
      type,
      ...(type === "server.connected"
        ? {}
        : { durable: { aggregateID: data.sessionID, seq, version: 1 } }),
      data,
    };
    feedDecode(frame);
    return new TextEncoder().encode(`data: ${JSON.stringify(frame)}\n\n`);
  };
  const engine = openCodeNativeSessionEngineCreate({
    url: "http://native-fixture",
    onEvent: (event) => {
      events.push(event);
      if (event.type === "usage.updated" && ++usageObserved === usageTarget) usageBarrier.resolve();
      if (event.type === "compaction.completed" && ++compactionObserved === compactionTarget)
        compactionBarrier.resolve();
    },
    fetch: async (input, options) => {
      const path = new URL(input instanceof Request ? input.url : String(input)).pathname;
      const body = options?.body
        ? (JSON.parse(String(options.body)) as Record<string, unknown>)
        : undefined;
      requests.push({
        path,
        method: options?.method ?? "GET",
        ...(body ? { body } : {}),
        ...(options?.signal ? { signal: options.signal } : {}),
      });
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
                    if (!streamClosed) controller.close();
                    streamClosed = true;
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
        pending = {
          body: body!,
          ...(options?.signal ? { signal: options.signal } : {}),
          resolve: response.resolve,
          reject: response.reject,
        };
        options?.signal?.addEventListener("abort", () => response.reject(options.signal?.reason), {
          once: true,
        });
        requested.resolve();
        return response.promise;
      }
      if (path.endsWith("/prompt"))
        return Response.json({ data: { id: body!.id, sessionID: session.id, type: "user" } });
      if (path.endsWith("/permission") || path.endsWith("/form"))
        return Response.json({ data: [] });
      if (path.includes("/inbox/")) return new Response(null, { status: 204 });
      if (path.endsWith("/interrupt")) return Response.json({ interrupted: true });
      return new Response(null, { status: 404 });
    },
  });
  expect((await engine.start({ directory })).success).toBe(true);
  const observe = async (
    type: string,
    data: Record<string, unknown> = {},
    seq?: number,
    id?: string,
  ) => {
    await demand.promise;
    demand = Promise.withResolvers<void>();
    const durableSeq = seq ?? ++sequence;
    sequence = Math.max(sequence, durableSeq);
    const eventID = id ?? `evt_manual_${durableSeq}`;
    const eventData = { sessionID: session.id, ...data };
    stream.enqueue(encode(type, eventData, durableSeq, eventID));
    await demand.promise;
    return { id: eventID, seq: durableSeq, data: eventData };
  };
  const observeUsageBatch = async (count: number) => {
    usageTarget = usageObserved + count;
    usageBarrier = Promise.withResolvers<void>();
    const encoded = Array.from({ length: count }, (_, index) =>
      encode("session.usage.updated", {
        sessionID: session.id,
        cost: index,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      }),
    );
    const chunk = new Uint8Array(encoded.reduce((total, part) => total + part.length, 0));
    let offset = 0;
    for (const part of encoded) {
      chunk.set(part, offset);
      offset += part.length;
    }
    stream.enqueue(chunk);
    await usageBarrier.promise;
  };
  const observeCompactionBatch = async (count: number) => {
    compactionTarget = compactionObserved + count;
    compactionBarrier = Promise.withResolvers<void>();
    const encoded = Array.from({ length: count }, (_, index) => [
      encode("session.compaction.started", {
        sessionID: session.id,
        reason: "auto",
        recent: "",
      }),
      encode("session.compaction.ended", {
        sessionID: session.id,
        reason: "auto",
        text: `pressure-${compactionObserved + index}`,
        recent: "",
        ...usage,
      }),
    ]).flat();
    const chunk = new Uint8Array(encoded.reduce((total, part) => total + part.length, 0));
    let offset = 0;
    for (const part of encoded) {
      chunk.set(part, offset);
      offset += part.length;
    }
    stream.enqueue(chunk);
    await compactionBarrier.promise;
  };
  const receipt = (id = String(pending!.body.id)) => {
    const data = {
      id,
      sessionID: session.id,
      time: { created: 1 },
      type: "compaction",
      payload: {},
      delivery: pending!.body.delivery ?? "steer",
    };
    receiptDecode(data);
    pending!.resolve(Response.json({ data }));
    requested = Promise.withResolvers<void>();
  };
  return {
    engine,
    events,
    requests,
    observe,
    receipt,
    requested: () => requested.promise,
    observeUsageBatch,
    observeCompactionBatch,
    nextRequest: () => {
      requested = Promise.withResolvers<void>();
      return requested.promise;
    },
    disconnect: () => {
      streamClosed = true;
      stream.close();
    },
    pending: () => pending!,
    close: () => engine.stop({ interrupt: false }),
  };
};

it("keeps an auto terminal replay from consuming a newer attempt after real compaction history pressure", async () => {
  const f = await fixture();
  try {
    const first = await f.engine.send("ordinary");
    expect(first.success).toBe(true);
    const workStart = await f.observe("session.execution.started");
    await f.observe("session.compaction.started", {
      reason: "auto",
      recent: "",
    });
    const aTerminal = await f.observe(
      "session.compaction.ended",
      { reason: "auto", text: "A", recent: "", ...usage },
      undefined,
      "evt_compaction_A_terminal",
    );
    expect(aTerminal.seq).toBeGreaterThan(workStart.seq);

    // Keep all attempts in the same ordinary Work while exceeding the former
    // 4096-attempt retention cap with actual decoded start/terminal pairs.
    for (let index = 0; index < 4_100; index += 100)
      await f.observeCompactionBatch(Math.min(100, 4_100 - index));

    await f.observe("session.compaction.started", {
      reason: "auto",
      recent: "",
    });
    const attemptsBeforeReplay = f.events.filter((event) => event.type.startsWith("compaction."));
    const startB = attemptsBeforeReplay.findLast((event) => event.type === "compaction.started");
    const bKey = startB && "key" in startB ? startB.key : undefined;

    await f.observe("session.compaction.ended", aTerminal.data, aTerminal.seq, aTerminal.id);
    expect(f.events.filter((event) => event.type.startsWith("compaction."))).toEqual(
      attemptsBeforeReplay,
    );

    const bTerminal = await f.observe("session.compaction.ended", {
      reason: "auto",
      text: "B",
      recent: "",
      ...usage,
    });
    const attempts = f.events.filter((event) => event.type.startsWith("compaction."));
    expect(attempts).toHaveLength(2 * (4_100 + 2));
    const starts = attempts.filter((event) => event.type === "compaction.started");
    const completions = attempts.filter((event) => event.type === "compaction.completed");
    expect(starts).toHaveLength(4_100 + 2);
    expect(completions).toHaveLength(4_100 + 2);
    expect(completions.at(-1)).toMatchObject({
      key: bKey,
      eventID: bTerminal.id,
      durable: { seq: bTerminal.seq },
      compaction: { cost: usage.cost },
    });
    expect(f.events.filter((event) => event.type === "turn.completed")).toEqual([]);
    expect(f.events.filter((event) => event.type === "usage.recorded")).toHaveLength(0);
  } finally {
    await f.close();
  }
}, 120_000);

it.each(["before", "after"] as const)(
  "admits actual manual inbox ownership when compaction SSE arrives %s the receipt and settles before execution",
  async (order) => {
    const f = await fixture();
    try {
      const sending = f.engine.compact({ id: "msg_requested", delivery: "queue" });
      await f.requested();
      const lifecycle = async () => {
        // v2.0.18 and v2.0.21 runner control order; the success payload omits inputID.
        await f.observe("session.inbox.enqueued", {
          inboxID: "msg_existing",
          item: { type: "compaction", payload: {}, delivery: "queue" },
        });
        await f.observe("session.execution.started");
        await f.observe("session.inbox.delivered", { inboxID: "msg_existing" });
        await f.observe("session.compaction.started", {
          reason: "manual",
          recent: "",
          inputID: "msg_existing",
        });
        await f.observe("session.compaction.ended", {
          reason: "manual",
          text: "summary",
          recent: "",
          model: { id: "actual", providerID: "fixture" },
          ...usage,
        });
      };
      if (order === "before") {
        await lifecycle();
        expect(f.events).toEqual([{ type: "session.ready", sessionID: session.id }]);
      }
      f.receipt("msg_existing");
      expect(await sending).toEqual({
        success: true,
        data: { turnID: "msg_existing", inputID: "msg_existing" },
      });
      if (order === "after") {
        expect(f.events.filter((event) => event.type.startsWith("turn."))).toEqual([
          { type: "turn.started", turnID: "msg_existing" },
        ]);
        await lifecycle();
      }
      expect(f.requests.find((request) => request.path.endsWith("/compact"))).toMatchObject({
        method: "POST",
        body: { id: "msg_requested", delivery: "queue" },
      });
      expect(f.events.filter((event) => event.type.startsWith("turn."))).toEqual([
        { type: "turn.started", turnID: "msg_existing" },
        { type: "turn.completed", turnID: "msg_existing" },
      ]);
      const attempts = f.events.filter((event) => event.type.startsWith("compaction."));
      expect(attempts).toMatchObject([
        { type: "compaction.started", inputID: "msg_existing", turnID: "msg_existing" },
        {
          type: "compaction.completed",
          inputID: "msg_existing",
          turnID: "msg_existing",
          compaction: usage,
        },
      ]);
      expect(attempts[0] && "key" in attempts[0] ? attempts[0].key : undefined).toBe(
        attempts[1] && "key" in attempts[1] ? attempts[1].key : undefined,
      );
      await f.observe(
        "session.compaction.ended",
        { reason: "manual", text: "summary", recent: "", ...usage },
        5,
      );
      await f.observe("session.execution.succeeded");
      expect(f.events.filter((event) => event.type.startsWith("compaction."))).toHaveLength(2);
      expect(f.requests.some((request) => request.path.endsWith("/prompt"))).toBe(false);
    } finally {
      await f.close();
    }
  },
);

it.each([true, false])(
  "settles charged manual failure with inputID present=%s without waiting for execution or changing attempt usage",
  async (includeID) => {
    const f = await fixture();
    try {
      const sending = f.engine.compact({ id: "msg_failure" });
      await f.requested();
      f.receipt();
      await sending;
      await f.observe("session.execution.started");
      await f.observe("session.inbox.delivered", { inboxID: "msg_failure" });
      await f.observe("session.compaction.started", {
        reason: "manual",
        inputID: "msg_failure",
        recent: "",
      });
      await f.observe("session.compaction.failed", {
        reason: "manual",
        ...(includeID ? { inputID: "msg_failure" } : {}),
        error: { type: "summary.failed", message: "charged" },
        ...usage,
      });
      expect(f.events.filter((event) => event.type === "compaction.failed")).toMatchObject([
        { inputID: "msg_failure", compaction: usage },
      ]);
      expect(f.events.filter((event) => event.type === "turn.failed")).toMatchObject([
        { turnID: "msg_failure", reason: "failed", error: { message: "charged" } },
      ]);
      await f.observe("session.execution.failed", {
        error: { type: "summary.failed", message: "charged" },
      });
      expect(f.events.filter((event) => event.type === "turn.failed")).toHaveLength(1);
    } finally {
      await f.close();
    }
  },
);

it("keeps a delayed accepted control pending, rejects overlaps, and interrupts its actual inbox without inventing a charge", async () => {
  const f = await fixture();
  try {
    const sending = f.engine.compact();
    await f.requested();
    expect(await f.engine.compact()).toMatchObject({ success: false, rejected: true });
    expect(await f.engine.switchSelection({ agent: "plan" })).toMatchObject({
      success: false,
      rejected: true,
    });
    f.receipt("msg_delayed");
    await sending;
    expect(f.events.filter((event) => event.type === "turn.completed")).toEqual([]);
    expect(await f.engine.send("busy")).toMatchObject({ success: false, rejected: true });
    expect(await f.engine.compact()).toMatchObject({ success: false, rejected: true });
    expect(await f.engine.interrupt()).toEqual({ success: true, data: true });
    expect(f.requests.find((request) => request.path.endsWith("/inbox/msg_delayed"))).toMatchObject(
      { method: "DELETE" },
    );
    await f.observe("session.inbox.cancelled", { inboxID: "msg_delayed" });
    expect(f.events.filter((event) => event.type === "turn.failed")).toEqual([
      {
        type: "turn.failed",
        turnID: "msg_delayed",
        reason: "interrupted",
        interruptionReason: "user",
      },
    ]);
    expect(f.events.filter((event) => event.type.startsWith("compaction."))).toEqual([]);
  } finally {
    await f.close();
  }
});

it("rejects active ordinary work without invoking compact and leaves ordinary lifecycle unchanged", async () => {
  const f = await fixture();
  try {
    const sent = await f.engine.send("ordinary");
    expect(sent.success).toBe(true);
    expect(await f.engine.compact()).toMatchObject({ success: false, rejected: true });
    expect(f.requests.some((request) => request.path.endsWith("/compact"))).toBe(false);
    await f.observe("session.execution.started");
    await f.observe("session.execution.succeeded");
    expect(f.events.filter((event) => event.type.startsWith("turn."))).toHaveLength(2);
  } finally {
    await f.close();
  }
});

it("official conflict rejection releases admission without creating work or poisoning the next request", async () => {
  const f = await fixture();
  try {
    const sending = f.engine.compact({ id: "msg_conflict" });
    await f.requested();
    f.pending().resolve(
      Response.json(
        { _tag: "ConflictError", message: "ID conflicts", resource: "msg_conflict" },
        { status: 409 },
      ),
    );
    expect(await sending).toMatchObject({ success: false, rejected: true });
    expect(f.events.filter((event) => event.type.startsWith("turn."))).toEqual([]);
    const requested = f.nextRequest();
    const retry = f.engine.compact({ id: "msg_valid" });
    await requested;
    f.receipt();
    expect(await retry).toEqual({
      success: true,
      data: { turnID: "msg_valid", inputID: "msg_valid" },
    });
  } finally {
    await f.close();
  }
});

it("delivered manual interrupt settles on authoritative failure and preserves an unresolved attempt without a fabricated paid failure", async () => {
  const f = await fixture();
  try {
    const sending = f.engine.compact({ id: "msg_interrupt" });
    await f.requested();
    f.receipt();
    await sending;
    await f.observe("session.execution.started");
    await f.observe("session.inbox.delivered", { inboxID: "msg_interrupt" });
    await f.observe("session.compaction.started", {
      reason: "manual",
      inputID: "msg_interrupt",
      recent: "",
    });
    expect(await f.engine.interrupt()).toEqual({ success: true, data: true });
    expect(f.events.filter((event) => event.type === "turn.failed")).toEqual([]);
    // The runner publishes this uncharged terminal if compactManual is interrupted.
    await f.observe("session.compaction.failed", {
      reason: "manual",
      inputID: "msg_interrupt",
      error: { type: "aborted", message: "Compaction cancelled" },
    });
    await f.observe("session.execution.interrupted", { reason: "user" });
    expect(f.events.filter((event) => event.type === "turn.failed")).toHaveLength(1);
    expect(f.events.filter((event) => event.type === "compaction.failed")).toMatchObject([
      { compaction: { error: { type: "aborted" } } },
    ]);
    const failed = f.events.find((event) => event.type === "compaction.failed");
    expect(failed && "compaction" in failed && "cost" in failed.compaction).toBe(false);
    expect(f.requests.some((request) => request.path.includes("/inbox/"))).toBe(false);
  } finally {
    await f.close();
  }
});

it("an execution interruption settles admitted manual work but does not manufacture a compaction terminal", async () => {
  const f = await fixture();
  try {
    const sending = f.engine.compact({ id: "msg_interrupt" });
    await f.requested();
    f.receipt();
    await sending;
    await f.observe("session.execution.started");
    await f.observe("session.inbox.delivered", { inboxID: "msg_interrupt" });
    await f.observe("session.compaction.started", {
      reason: "manual",
      inputID: "msg_interrupt",
      recent: "",
    });
    await f.observe("session.execution.interrupted", { reason: "user" });
    expect(f.events.filter((event) => event.type === "turn.failed")).toEqual([
      {
        type: "turn.failed",
        turnID: "msg_interrupt",
        reason: "interrupted",
        interruptionReason: "user",
      },
    ]);
    expect(f.events.filter((event) => event.type.startsWith("compaction."))).toHaveLength(1);
  } finally {
    await f.close();
  }
});

it("enclosing execution success without a compaction terminal never fabricates completion of an accepted control", async () => {
  const f = await fixture();
  try {
    const sending = f.engine.compact({ id: "msg_pending" });
    await f.requested();
    f.receipt();
    await sending;
    await f.observe("session.execution.started");
    await f.observe("session.execution.succeeded");
    expect(f.events.filter((event) => event.type === "turn.completed")).toEqual([]);
    expect(await f.engine.compact()).toMatchObject({ success: false, rejected: true });
    expect(await f.engine.interrupt()).toEqual({ success: true, data: true });
    expect(f.requests.some((request) => request.path.endsWith("/inbox/msg_pending"))).toBe(true);
  } finally {
    await f.close();
  }
});

it("explicit stop cancels an undelivered manual inbox even when interrupt would leave queued controls parked", async () => {
  const f = await fixture();
  try {
    const sending = f.engine.compact({ id: "msg_stop" });
    await f.requested();
    f.receipt();
    await sending;
    expect(await f.engine.stop()).toEqual({ success: true, data: undefined });
    expect(f.requests.find((request) => request.path.endsWith("/inbox/msg_stop"))).toMatchObject({
      method: "DELETE",
    });
    expect(f.requests.some((request) => request.path.endsWith("/interrupt"))).toBe(false);
    expect(f.events.filter((event) => event.type === "compaction.failed")).toEqual([]);
  } finally {
    await f.close();
  }
});

it("ordinary delivery after a manual terminal owns a new turn within the same native busy period", async () => {
  const f = await fixture();
  try {
    const compact = f.engine.compact({ id: "msg_manual" });
    await f.requested();
    f.receipt();
    await compact;
    await f.observe("session.execution.started");
    await f.observe("session.inbox.delivered", { inboxID: "msg_manual" });
    await f.observe("session.compaction.started", {
      reason: "manual",
      inputID: "msg_manual",
      recent: "",
    });
    await f.observe("session.compaction.ended", {
      reason: "manual",
      text: "summary",
      recent: "",
      ...usage,
    });
    const sending = f.engine.send("steered successor");
    const request = f.requests.findLast((request) => request.path.endsWith("/prompt"));
    await f.observe("session.inbox.delivered", { inboxID: request!.body!.id });
    const sent = await sending;
    expect(sent.success).toBe(true);
    await f.observe("session.text.ended", {
      assistantMessageID: "msg_answer",
      ordinal: 0,
      text: "successor",
    });
    await f.observe("session.execution.succeeded");
    expect(f.events.filter((event) => event.type.startsWith("turn."))).toEqual([
      { type: "turn.started", turnID: "msg_manual" },
      { type: "turn.completed", turnID: "msg_manual" },
      { type: "turn.started", turnID: request!.body!.id },
      { type: "turn.completed", turnID: request!.body!.id },
    ]);
  } finally {
    await f.close();
  }
});

it("synthetic delivery after a manual terminal preserves its actual input owner and does not charge compaction twice", async () => {
  const f = await fixture();
  try {
    const compact = f.engine.compact({ id: "msg_manual" });
    await f.requested();
    f.receipt();
    await compact;
    await f.observe("session.execution.started");
    await f.observe("session.inbox.delivered", { inboxID: "msg_manual" });
    await f.observe("session.compaction.started", {
      reason: "manual",
      inputID: "msg_manual",
      recent: "",
    });
    await f.observe("session.compaction.ended", {
      reason: "manual",
      text: "summary",
      recent: "",
      ...usage,
    });
    await f.observe("session.inbox.enqueued", {
      inboxID: "msg_synthetic",
      item: {
        type: "synthetic",
        delivery: "steer",
        payload: { text: "background", description: "result" },
      },
    });
    await f.observe("session.inbox.delivered", { inboxID: "msg_synthetic" });
    await f.observe("session.text.ended", {
      assistantMessageID: "msg_answer",
      ordinal: 0,
      text: "synthetic answer",
    });
    await f.observe("session.execution.succeeded");
    expect(f.events.filter((event) => event.type === "turn.completed")).toEqual([
      { type: "turn.completed", turnID: "msg_manual" },
      { type: "turn.completed", turnID: "msg_synthetic" },
    ]);
    expect(f.events.filter((event) => event.type === "text.completed")).toMatchObject([
      { turnID: "msg_synthetic", text: "synthetic answer" },
    ]);
    expect(f.events.filter((event) => event.type === "compaction.completed")).toHaveLength(1);
  } finally {
    await f.close();
  }
});

it.each(["deadline", "stop", "loss", "transport", "invalid receipt"] as const)(
  "fences %s compaction admission without replay or fabricated work",
  async (action) => {
    const f = await fixture();
    try {
      if (action === "deadline") vi.useFakeTimers();
      const sending = f.engine.compact();
      await f.requested();
      const signal = f.pending().signal;
      await f.observe("session.execution.started");
      await f.observe("session.compaction.started", {
        reason: "manual",
        inputID: String(f.pending().body.id),
        recent: "",
      });
      if (action === "deadline") await vi.advanceTimersByTimeAsync(15_000);
      else if (action === "stop") await f.engine.stop({ interrupt: false });
      else if (action === "loss") f.disconnect();
      else if (action === "transport") f.pending().reject(new Error("lost receipt"));
      else
        f.pending().resolve(
          Response.json({ data: { type: "user", sessionID: session.id, id: f.pending().body.id } }),
        );
      expect(await sending).toMatchObject({
        success: false,
        error: { operation: "session.compact", detail: expect.stringContaining("uncertain") },
      });
      if (action === "deadline" || action === "stop") expect(signal?.aborted).toBe(true);
      expect((await f.engine.compact()).success).toBe(false);
      expect(f.requests.filter((request) => request.path.endsWith("/compact"))).toHaveLength(1);
      expect(
        f.events.filter(
          (event) => event.type.startsWith("turn.") || event.type.startsWith("compaction."),
        ),
      ).toEqual([]);
    } finally {
      vi.useRealTimers();
      await f.close();
    }
  },
);

it("does not let the enclosing compaction execution terminal close the next admitted ordinary turn", async () => {
  const f = await fixture();
  try {
    const compact = f.engine.compact({ id: "msg_manual" });
    await f.requested();
    f.receipt();
    await compact;
    await f.observe("session.execution.started");
    await f.observe("session.inbox.delivered", { inboxID: "msg_manual" });
    await f.observe("session.compaction.started", {
      reason: "manual",
      inputID: "msg_manual",
      recent: "",
    });
    await f.observe("session.compaction.ended", {
      reason: "manual",
      text: "summary",
      recent: "",
      ...usage,
    });
    const sending = f.engine.send("successor");
    // A native observable receipt drains any HTTP-admission buffering; use a
    // held compaction check as the exclusivity assertion rather than a sleep.
    await f.observe("session.execution.succeeded");
    await f.observe("session.execution.started");
    // The request receipt may be racing this start; the engine buffers it.
    await f.observe("session.execution.succeeded");
    const sent = await sending;
    expect(sent.success).toBe(true);
    expect(f.events.filter((event) => event.type === "turn.completed")).toHaveLength(2);
  } finally {
    await f.close();
  }
});
