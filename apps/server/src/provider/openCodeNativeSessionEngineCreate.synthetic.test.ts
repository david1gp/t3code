// @effect-diagnostics globalFetch:off - fake I/O drives the pinned client's real SSE parser and schemas.
import { expect, it } from "vite-plus/test";

import { openCodeNativeSessionEngineCreate } from "./openCodeNativeSessionEngineCreate.ts";

const directory = "/native/synthetic-fixture";
const session = { id: "ses_synthetic_fixture", location: { directory } };
type Event = Parameters<Parameters<typeof openCodeNativeSessionEngineCreate>[0]["onEvent"]>[0];
const fixture = async (resume = false) => {
  let demand = Promise.withResolvers<void>();
  let stream!: ReadableStreamDefaultController<Uint8Array>;
  let sequence = 0;
  const events: Event[] = [];
  const requests: string[] = [];
  const encode = (type: string, data: Record<string, unknown>, seq = ++sequence) =>
    new TextEncoder().encode(
      `data: ${JSON.stringify({
        id: `evt_synthetic_${seq}`,
        created: 1,
        type,
        ...(type === "server.connected"
          ? {}
          : {
              durable: { aggregateID: data.sessionID, seq, version: 1 },
            }),
        data,
      })}\n\n`,
    );
  const engine = openCodeNativeSessionEngineCreate({
    url: "http://native-fixture",
    onEvent: (event) => events.push(event),
    fetch: async (input, options) => {
      const path = new URL(input instanceof Request ? input.url : String(input)).pathname;
      requests.push(path);
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
                    controller.close();
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
      if (path === "/api/session" || path === `/api/session/${session.id}`)
        return Response.json({ data: session });
      if (path === "/api/session/active") return Response.json({ data: {} });
      if (["inbox", "permission", "form"].some((kind) => path.endsWith(`/${kind}`)))
        return Response.json({ data: [] });
      return new Response(null, { status: 404 });
    },
  });
  expect(
    await engine.start({ directory, ...(resume ? { resumeSessionId: session.id } : {}) }),
  ).toEqual({ success: true, data: session });
  const observe = async (type: string, data: Record<string, unknown> = {}, seq?: number) => {
    await demand.promise;
    demand = Promise.withResolvers<void>();
    stream.enqueue(encode(type, { sessionID: session.id, ...data }, seq));
    await demand.promise;
  };
  return {
    engine,
    events,
    requests,
    observe,
    // Session.synthetic defaults delivery to steer. SubagentCompletion.deliver uses
    // this same inbox item and its notificationID as the stable inputID (2.0.18/2.0.21).
    enqueue: (id: string, metadata?: Record<string, unknown>, delivery = "steer") =>
      observe("session.inbox.enqueued", {
        inboxID: id,
        item: {
          type: "synthetic",
          delivery,
          payload: {
            text: "child result",
            description: "background work",
            ...(metadata ? { metadata } : {}),
          },
        },
      }),
    answer: (text = "background answer") =>
      observe("session.text.ended", {
        assistantMessageID: `msg_answer_${sequence}`,
        ordinal: 0,
        text,
      }),
    close: () => engine.stop({ interrupt: false }),
  };
};

for (const resume of [false, true]) {
  for (const startFirst of [false, true]) {
    it(`routes ${resume ? "adopted idle" : "fresh idle"} synthetic wake once when execution starts ${startFirst ? "before" : "after"} enqueue`, async () => {
      const f = await fixture(resume);
      try {
        if (startFirst) await f.observe("session.execution.started");
        await f.enqueue("msg_notification");
        if (!startFirst) {
          expect(f.events.filter((event) => event.type === "turn.started")).toEqual([]);
          await f.observe("session.execution.started");
        }
        await f.observe("session.inbox.delivered", { inboxID: "msg_notification" });
        await f.answer();
        await f.observe("session.execution.succeeded");
        await f.observe("session.execution.succeeded");
        expect(f.events.filter((event) => event.type.startsWith("turn."))).toEqual([
          { type: "turn.started", turnID: "msg_notification" },
          { type: "turn.completed", turnID: "msg_notification" },
        ]);
        expect(f.events.filter((event) => event.type === "text.completed")).toMatchObject([
          { turnID: "msg_notification", text: "background answer" },
        ]);
        expect(f.requests.some((path) => /\/(prompt|interrupt|log)$/u.test(path))).toBe(false);
      } finally {
        await f.close();
      }
    });
  }
}

it("synthetic resume:false admission and cancellation never fabricate execution or an answer", async () => {
  const f = await fixture(true);
  try {
    await f.enqueue("msg_parked");
    expect(f.events).toEqual([{ type: "session.ready", sessionID: session.id }]);
    await f.observe("session.inbox.cancelled", { inboxID: "msg_parked" });
    await f.observe("session.execution.started");
    await f.observe("session.text.ended", {
      assistantMessageID: "msg_unowned",
      ordinal: 0,
      text: "unsafe",
    });
    expect(
      f.events.filter((event) => event.type.startsWith("turn.") || event.type.startsWith("text.")),
    ).toEqual([]);
    expect(f.events).toMatchObject([{ type: "session.ready" }, { type: "stream.lost" }]);
  } finally {
    await f.close();
  }
});

it("active parent consumes synthetic steer in its existing activation without stranding a later wake", async () => {
  const f = await fixture();
  try {
    await f.enqueue("msg_first");
    await f.observe("session.execution.started");
    await f.observe("session.inbox.delivered", { inboxID: "msg_first" });
    await f.enqueue("msg_steer");
    await f.observe("session.inbox.delivered", { inboxID: "msg_steer" });
    await f.answer("steered answer");
    await f.observe("session.execution.succeeded");
    await f.enqueue("msg_next");
    await f.observe("session.execution.started");
    await f.observe("session.inbox.delivered", { inboxID: "msg_next" });
    await f.answer("next answer");
    await f.observe("session.execution.succeeded");
    expect(f.events.filter((event) => event.type.startsWith("turn."))).toEqual([
      { type: "turn.started", turnID: "msg_first" },
      { type: "turn.completed", turnID: "msg_first" },
      { type: "turn.started", turnID: "msg_next" },
      { type: "turn.completed", turnID: "msg_next" },
    ]);
  } finally {
    await f.close();
  }
});

it("synthetic wake enqueued during settlement starts a successor and cannot complete the old turn again", async () => {
  const f = await fixture();
  try {
    await f.enqueue("msg_old");
    await f.observe("session.execution.started");
    await f.observe("session.inbox.delivered", { inboxID: "msg_old" });
    await f.enqueue("msg_successor");
    await f.observe("session.execution.succeeded");
    await f.observe("session.execution.started");
    await f.observe("session.inbox.delivered", { inboxID: "msg_successor" });
    await f.answer();
    await f.observe("session.execution.succeeded");
    expect(f.events.filter((event) => event.type === "turn.completed")).toEqual([
      { type: "turn.completed", turnID: "msg_old" },
      { type: "turn.completed", turnID: "msg_successor" },
    ]);
    expect(f.events.filter((event) => event.type === "text.completed")).toMatchObject([
      { turnID: "msg_successor", text: "background answer" },
    ]);
  } finally {
    await f.close();
  }
});

for (const state of ["completed", "error", "cancelled"] as const) {
  it(`child ${state} inbox notification settles the spawning child once and wakes a new parent turn`, async () => {
    const f = await fixture();
    try {
      await f.enqueue("msg_spawning");
      await f.observe("session.execution.started");
      await f.observe("session.inbox.delivered", { inboxID: "msg_spawning" });
      await f.observe("session.created", {
        sessionID: "ses_background",
        parentID: session.id,
        location: { directory },
        title: "Background child",
        projectID: "proj_fixture",
        slug: "background",
        version: "2.0.18",
      });
      await f.observe("session.execution.started", { sessionID: "ses_background" });
      await f.observe("session.execution.succeeded");
      const metadata = {
        source: "subagent",
        childID: "ses_background",
        agent: "explore",
        state,
        jobID: "job_background",
      };
      await f.enqueue("msg_child_notification", metadata);
      await f.observe("session.synthetic", { text: "duplicate legacy notification", metadata });
      expect(f.events.filter((event) => event.type.startsWith("turn."))).toEqual([
        { type: "turn.started", turnID: "msg_spawning" },
        { type: "turn.completed", turnID: "msg_spawning" },
      ]);
      const terminal =
        state === "completed"
          ? "child.completed"
          : state === "error"
            ? "child.failed"
            : "child.interrupted";
      expect(f.events.filter((event) => event.type === terminal)).toMatchObject([
        { turnID: "msg_spawning", sessionID: "ses_background", parentSessionID: session.id },
      ]);
      await f.observe("session.execution.started");
      await f.observe("session.inbox.delivered", { inboxID: "msg_child_notification" });
      await f.answer();
      await f.observe("session.execution.succeeded");
      expect(f.events.filter((event) => event.type === "text.completed")).toMatchObject([
        { turnID: "msg_child_notification", text: "background answer" },
      ]);
      expect(f.events.filter((event) => event.type === "turn.completed")).toEqual([
        { type: "turn.completed", turnID: "msg_spawning" },
        { type: "turn.completed", turnID: "msg_child_notification" },
      ]);
    } finally {
      await f.close();
    }
  });
}

it("idle synthetic promotion prioritizes steer over queued work without mistaking admission for execution", async () => {
  const f = await fixture(true);
  try {
    await f.enqueue("msg_queued", undefined, "queue");
    await f.enqueue("msg_steer");
    expect(f.events).toEqual([{ type: "session.ready", sessionID: session.id }]);
    await f.observe("session.execution.started");
    await f.observe("session.inbox.delivered", { inboxID: "msg_steer" });
    await f.observe("session.inbox.delivered", { inboxID: "msg_queued" });
    await f.answer();
    await f.observe("session.execution.succeeded");
    expect(f.events.filter((event) => event.type.startsWith("turn."))).toEqual([
      { type: "turn.started", turnID: "msg_steer" },
      { type: "turn.completed", turnID: "msg_steer" },
    ]);
  } finally {
    await f.close();
  }
});

it("synthetic execution uses the delivered input identity instead of an earlier suspended queue admission", async () => {
  const f = await fixture(true);
  try {
    await f.enqueue("msg_suspended", undefined, "queue");
    await f.enqueue("msg_wakeup");
    await f.observe("session.execution.started");
    expect(f.events).toEqual([{ type: "session.ready", sessionID: session.id }]);
    await f.observe("session.inbox.delivered", { inboxID: "msg_wakeup" });
    await f.answer();
    await f.observe("session.execution.succeeded");
    expect(f.events.filter((event) => event.type.startsWith("turn."))).toEqual([
      { type: "turn.started", turnID: "msg_wakeup" },
      { type: "turn.completed", turnID: "msg_wakeup" },
    ]);
  } finally {
    await f.close();
  }
});

it("synthetic successor retains cursor floors against late outgoing terminals and answers", async () => {
  const f = await fixture();
  try {
    await f.enqueue("msg_old");
    await f.observe("session.execution.started");
    await f.observe("session.inbox.delivered", { inboxID: "msg_old" });
    await f.observe("session.execution.succeeded");
    await f.enqueue("msg_new");
    await f.observe("session.execution.started");
    await f.observe("session.inbox.delivered", { inboxID: "msg_new" });
    await f.observe("session.execution.succeeded", {}, 2);
    await f.observe(
      "session.text.ended",
      {
        assistantMessageID: "msg_stale_answer",
        ordinal: 0,
        text: "stale",
      },
      3,
    );
    await f.answer("current");
    await f.observe("session.execution.succeeded");
    expect(f.events.filter((event) => event.type === "text.completed")).toMatchObject([
      { turnID: "msg_new", text: "current" },
    ]);
    expect(f.events.filter((event) => event.type === "turn.completed")).toEqual([
      { type: "turn.completed", turnID: "msg_old" },
      { type: "turn.completed", turnID: "msg_new" },
    ]);
  } finally {
    await f.close();
  }
});
