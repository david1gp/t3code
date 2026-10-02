// @effect-diagnostics globalFetch:off - fake I/O drives the pinned client's parser and official schemas.
import { expect, it } from "vite-plus/test";
import { SessionInbox } from "@opencode/client/effect";
import * as Schema from "effect/Schema";

import { openCodeNativeSessionEngineCreate } from "./openCodeNativeSessionEngineCreate.ts";
import { openCodeNativeWireSchema } from "./openCodeNativeWireSchema.ts";

const directory = "/native/activation-ownership";
const session = { id: "ses_activation_fixture", location: { directory } };
const feedDecode = Schema.decodeUnknownSync(openCodeNativeWireSchema.feed);
const receiptDecode = Schema.decodeUnknownSync(Schema.toEncoded(SessionInbox.Compaction));
type Event = Parameters<Parameters<typeof openCodeNativeSessionEngineCreate>[0]["onEvent"]>[0];

it("does not let a retired activation's unresolved compaction settle later manual ownership", async () => {
  let demand = Promise.withResolvers<void>();
  let stream!: ReadableStreamDefaultController<Uint8Array>;
  let sequence = 0;
  let pendingCompact: ((response: Response) => void) | undefined;
  let compactRequested = Promise.withResolvers<void>();
  const events: Event[] = [];
  const encode = (type: string, data: Record<string, unknown>) => {
    const frame = {
      id: `evt_activation_${++sequence}`,
      created: 1,
      type,
      ...(type === "server.connected"
        ? {}
        : { durable: { aggregateID: data.sessionID, seq: sequence, version: 1 } }),
      data,
    };
    feedDecode(frame);
    return new TextEncoder().encode(`data: ${JSON.stringify(frame)}\n\n`);
  };
  const engine = openCodeNativeSessionEngineCreate({
    url: "http://native-activation-fixture",
    onEvent: (event) => events.push(event),
    fetch: async (input, options) => {
      const path = new URL(input instanceof Request ? input.url : String(input)).pathname;
      const body = options?.body
        ? (JSON.parse(String(options.body)) as Record<string, unknown>)
        : {};
      if (path === "/api/event")
        return new Response(
          new ReadableStream<Uint8Array>(
            {
              start(controller) {
                stream = controller;
                controller.enqueue(encode("server.connected", {}));
                options?.signal?.addEventListener("abort", () => controller.close(), {
                  once: true,
                });
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
        pendingCompact = response.resolve;
        compactRequested.resolve();
        return response.promise;
      }
      if (path.endsWith("/prompt"))
        return Response.json({ data: { id: body.id, sessionID: session.id, type: "user" } });
      if (path.endsWith("/permission") || path.endsWith("/form"))
        return Response.json({ data: [] });
      if (path.includes("/inbox/")) return new Response(null, { status: 204 });
      if (path.endsWith("/interrupt")) return Response.json({ interrupted: true });
      return new Response(null, { status: 404 });
    },
  });

  const observe = async (type: string, data: Record<string, unknown> = {}) => {
    await demand.promise;
    demand = Promise.withResolvers<void>();
    stream.enqueue(encode(type, { sessionID: session.id, ...data }));
    await demand.promise;
  };
  try {
    expect((await engine.start({ directory })).success).toBe(true);
    const first = await engine.send("first activation");
    expect(first.success).toBe(true);
    if (!first.success) return;
    await observe("session.execution.started");
    await observe("session.compaction.started", { reason: "manual", recent: "" });
    await observe("session.execution.succeeded");

    const compacting = engine.compact({ id: "msg_new_control" });
    await compactRequested.promise;
    const receipt = {
      id: "msg_new_control",
      sessionID: session.id,
      time: { created: 1 },
      type: "compaction",
      payload: {},
      delivery: "steer",
    };
    receiptDecode(receipt);
    pendingCompact!(Response.json({ data: receipt }));
    expect(await compacting).toEqual({
      success: true,
      data: { turnID: "msg_new_control", inputID: "msg_new_control" },
    });

    await observe("session.compaction.ended", {
      reason: "manual",
      text: "retired result",
      recent: "",
      cost: 0.25,
      tokens: { input: 10, output: 7, reasoning: 2, cache: { read: 3, write: 4 } },
    });
    expect(events.filter((event) => event.type.startsWith("compaction."))).toEqual([
      expect.objectContaining({ type: "compaction.started", turnID: expect.any(String) }),
    ]);
    expect(events.filter((event) => event.type === "turn.completed")).toHaveLength(1);
    expect(events.find((event) => event.type === "turn.completed")).toMatchObject({
      turnID: first.data.turnID,
    });

    await observe("session.execution.started");
    await observe("session.compaction.started", {
      reason: "manual",
      inputID: "msg_new_control",
      recent: "",
    });
    await observe("session.compaction.ended", {
      reason: "manual",
      text: "current result",
      recent: "",
      cost: 0.25,
      tokens: { input: 10, output: 7, reasoning: 2, cache: { read: 3, write: 4 } },
    });
    expect(events.filter((event) => event.type === "compaction.completed")).toHaveLength(1);
    expect(events.find((event) => event.type === "compaction.completed")).toMatchObject({
      turnID: "msg_new_control",
      inputID: "msg_new_control",
      compaction: { cost: 0.25 },
    });
    expect(events.filter((event) => event.type === "turn.completed")).toHaveLength(2);
    expect(events.filter((event) => event.type === "turn.completed")[1]).toMatchObject({
      turnID: "msg_new_control",
    });
  } finally {
    await engine.stop({ interrupt: false });
  }
});
