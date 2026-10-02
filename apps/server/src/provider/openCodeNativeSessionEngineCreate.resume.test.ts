// @effect-diagnostics globalFetch:off - fake I/O drives the pinned client's real SSE parser.
import { expect, it } from "vite-plus/test";

import { openCodeNativeSessionEngineCreate } from "./openCodeNativeSessionEngineCreate.ts";

const directory = "/native/resume-fixture";
const session = { id: "ses_resume_fixture", location: { directory } };
const json = (data: unknown) => Response.json({ data });

const fixture = (heldPath = `/api/session/${session.id}/inbox`) => {
  const readRequested = Promise.withResolvers<void>();
  const response = Promise.withResolvers<Response>();
  let demand = Promise.withResolvers<void>();
  let stream!: ReadableStreamDefaultController<Uint8Array>;
  let sequence = 0;
  const requests: string[] = [];
  const events: Array<{ readonly type: string }> = [];
  const encode = (type: string, data: Record<string, unknown>) =>
    new TextEncoder().encode(
      `data: ${JSON.stringify({
        id: `evt_resume_${sequence++}`,
        created: 1,
        type,
        ...(type === "server.connected"
          ? {}
          : { durable: { aggregateID: data.sessionID, seq: sequence, version: 1 } }),
        data,
      })}\n\n`,
    );
  const fetchImpl: typeof fetch = async (input, options) => {
    const path = new URL(input instanceof Request ? input.url : String(input)).pathname;
    requests.push(path);
    if (path === "/api/event") {
      const body = new ReadableStream<Uint8Array>(
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
      );
      return new Response(body, { headers: { "content-type": "text/event-stream" } });
    }
    if (path === heldPath) {
      readRequested.resolve();
      return response.promise;
    }
    if (path === `/api/session/${session.id}`) return json(session);
    if (path === "/api/session/active") return json({});
    if (["inbox", "permission", "form"].some((kind) => path.endsWith(`/${kind}`))) return json([]);
    return new Response(null, { status: 404 });
  };
  const engine = openCodeNativeSessionEngineCreate({
    url: "http://native-fixture",
    fetch: fetchImpl,
    onEvent: (event) => events.push(event),
  });
  return {
    engine,
    requests,
    events,
    readRequested: readRequested.promise,
    release: () =>
      response.resolve(
        json(
          heldPath === `/api/session/${session.id}`
            ? session
            : heldPath === "/api/session/active"
              ? {}
              : [],
        ),
      ),
    // A new reader demand occurs only after the engine consumed the previous frame.
    observe: async (type: string, data: Record<string, unknown> = {}) => {
      await demand.promise;
      demand = Promise.withResolvers<void>();
      stream.enqueue(encode(type, { sessionID: session.id, ...data }));
      await demand.promise;
    },
  };
};

for (const held of ["active", "inbox", "permission", "form"] as const) {
  it(`resume rejects execution that starts and finishes while the independent ${held} read is pending`, async () => {
    const f = fixture(
      held === "active" ? "/api/session/active" : `/api/session/${session.id}/${held}`,
    );
    try {
      const started = f.engine.start({ directory, resumeSessionId: session.id });
      await f.readRequested;
      await f.observe("session.execution.started");
      await f.observe("session.execution.succeeded");
      f.release();
      expect(await started).toMatchObject({
        success: false,
        error: { operation: "session.resume", detail: expect.stringContaining("changed during") },
      });
      expect(f.events).toEqual([]);
      expect((await f.engine.send("never replay")).success).toBe(false);
      expect(f.requests.some((path) => /\/(prompt|interrupt|log)$/u.test(path))).toBe(false);
    } finally {
      f.release();
      await f.engine.stop({ interrupt: false });
    }
  });
}

it("resume observes its provisional target even before the session-info response exists", async () => {
  const f = fixture(`/api/session/${session.id}`);
  try {
    const started = f.engine.start({ directory, resumeSessionId: session.id });
    await f.readRequested;
    await f.observe("session.execution.started");
    f.release();
    expect(await started).toMatchObject({
      success: false,
      error: { operation: "session.resume", detail: expect.stringContaining("changed during") },
    });
    expect(f.events).toEqual([]);
  } finally {
    f.release();
    await f.engine.stop({ interrupt: false });
  }
});

it("resume ignores other-session activity but fails closed on unowned target output after readiness", async () => {
  const f = fixture();
  try {
    const started = f.engine.start({ directory, resumeSessionId: session.id });
    await f.readRequested;
    await f.observe("session.execution.started", { sessionID: "ses_other" });
    f.release();
    expect(await started).toEqual({ success: true, data: session });
    expect(f.events).toEqual([{ type: "session.ready", sessionID: session.id }]);
    // It is a readiness handoff, not a lock: activity after the reads must not disappear.
    await f.observe("session.execution.started");
    await f.observe("session.text.ended", {
      assistantMessageID: "msg_unowned",
      ordinal: 0,
      text: "unsafe",
    });
    expect(f.events).toMatchObject([
      { type: "session.ready" },
      { type: "stream.lost", detail: expect.stringContaining("safe adoption is unavailable") },
    ]);
    expect((await f.engine.send("never replay")).success).toBe(false);
    expect(f.requests.some((path) => /\/(prompt|interrupt|log)$/u.test(path))).toBe(false);
  } finally {
    await f.engine.stop({ interrupt: false });
  }
});

it("local disposal fences a pending provisional resume without interrupting or publishing readiness", async () => {
  const f = fixture();
  try {
    const started = f.engine.start({ directory, resumeSessionId: session.id });
    await f.readRequested;
    expect(await f.engine.stop({ interrupt: false })).toEqual({ success: true, data: undefined });
    f.release();
    expect(await started).toMatchObject({ success: false, error: { operation: "session.resume" } });
    expect(f.events).toEqual([]);
    expect(f.requests.some((path) => /\/(prompt|interrupt|log)$/u.test(path))).toBe(false);
  } finally {
    f.release();
    await f.engine.stop({ interrupt: false });
  }
});
