// @effect-diagnostics nodeBuiltinImport:off cryptoRandomUUID:off globalDate:off - isolated HTTP/SSE protocol fixture.
// @effect-diagnostics globalFetch:off - this test wraps native fetch to simulate aborts.
import * as NodeHttp from "node:http";
import * as NodeNet from "node:net";

import { describe, expect, it, vi } from "vite-plus/test";

import { openCodeNativeSessionEngineCreate } from "./openCodeNativeSessionEngineCreate.ts";
import type { OpenCodeNativeInventory } from "./openCodeNativeInventorySchema.ts";

const directory = "/tmp/native workspace";
const session = { id: "ses_fixture", location: { directory } };

const fixture = async (
  handler: (request: NodeHttp.IncomingMessage, response: NodeHttp.ServerResponse) => void,
) => {
  const server = NodeHttp.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as NodeNet.AddressInfo).port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
};

const bodyRead = async (req: NodeHttp.IncomingMessage) => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
};

const send = (res: NodeHttp.ServerResponse, body: unknown) => {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};

const frame = (
  res: Pick<NodeHttp.ServerResponse, "write">,
  type: string,
  data: Record<string, unknown>,
  id: string = crypto.randomUUID(),
  seq = 1,
) => {
  const event = {
    id: `evt_${id}`,
    type,
    created: Date.now(),
    ...([
      "server.connected",
      "session.text.delta",
      "session.reasoning.delta",
      "session.tool.input.delta",
      "session.tool.progress",
      "session.usage.updated",
    ].includes(type)
      ? {}
      : { durable: { aggregateID: data.sessionID ?? "ses_fixture", seq, version: 1 } }),
    data,
  };
  res.write(`data: ${JSON.stringify(event)}\n\n`);
  return event;
};

type EngineEvent = Parameters<
  Parameters<typeof openCodeNativeSessionEngineCreate>[0]["onEvent"]
>[0];
const captureCreate = () => {
  const events: EngineEvent[] = [];
  const waiters = new Set<(event: EngineEvent) => void>();
  return {
    events,
    receive: (event: EngineEvent) => {
      events.push(event);
      for (const waiter of waiters) waiter(event);
    },
    wait: (predicate: (event: EngineEvent) => boolean): Promise<EngineEvent> => {
      const found = events.find(predicate);
      if (found) return Promise.resolve(found);
      return new Promise((resolve) => {
        const waiter = (event: EngineEvent) => {
          if (!predicate(event)) return;
          waiters.delete(waiter);
          resolve(event);
        };
        waiters.add(waiter);
      });
    },
  };
};

const usage = {
  cost: 0.25,
  tokens: { input: 10, output: 7, reasoning: 2, cache: { read: 3, write: 4 } },
};
const workspaceInventory: OpenCodeNativeInventory = {
  provider: [],
  model: [],
  agent: [],
  command: [{ name: "review" }],
  skill: [
    { id: "native_skill_7f42", name: "review", path: "/native/opaque/review/SKILL.md" },
    { id: "native_skill_98ab", name: "quality", path: "/native/opaque/quality/SKILL.md" },
  ],
};
const sessionFixture = async (
  fetchImpl: typeof fetch = fetch,
  cachedInventory?: OpenCodeNativeInventory,
) => {
  const capture = captureCreate();
  let stream: NodeHttp.ServerResponse | undefined;
  let logReads = 0;
  const logRequests: Array<{ after: number; follow: string | null }> = [];
  const loggedEvents: ReturnType<typeof frame>[] = [];
  let retainLog = true;
  let heldLog: (() => void) | undefined;
  let logRequested: (() => void) | undefined;
  let pendingPermissions: Record<string, unknown>[] = [];
  let pendingForms: Record<string, unknown>[] = [];
  const replies: Array<{ path: string; body: Record<string, unknown> }> = [];
  const switches: Array<{ path: string; body: Record<string, unknown> }> = [];
  let rejectReplies = false;
  let rejectInterrupt = false;
  let interrupted = true;
  let prompts = 0;
  const promptBodies: Record<string, unknown>[] = [];
  const inventoryRequests: string[] = [];
  let rejectedInventory: "command" | "skill" | undefined;
  const commandBodies: Array<{ path: string; body: Record<string, unknown> }> = [];
  let heldCommand: NodeHttp.ServerResponse | undefined;
  let commandRequested: (() => void) | undefined;
  let interrupts = 0;
  let heldPermissionList: NodeHttp.ServerResponse | undefined;
  let permissionListRequested: (() => void) | undefined;
  let heldFormList: NodeHttp.ServerResponse | undefined;
  let formListRequested: (() => void) | undefined;
  const server = await fixture((req, res) => {
    if (req.url === "/api/event") {
      stream = res;
      res.writeHead(200, { "content-type": "text/event-stream" });
      frame(res, "server.connected", {});
      return;
    }
    if (req.url === "/api/session") {
      send(res, { data: session });
      return;
    }
    if (req.url === "/api/session/ses_fixture/permission") {
      if (permissionListRequested) {
        heldPermissionList = res;
        permissionListRequested();
        permissionListRequested = undefined;
        return;
      }
      send(res, { data: pendingPermissions });
      return;
    }
    if (req.url === "/api/session/ses_fixture/form") {
      if (formListRequested) {
        heldFormList = res;
        formListRequested();
        formListRequested = undefined;
        return;
      }
      send(res, { data: pendingForms });
      return;
    }
    if (
      req.url?.endsWith("/reply") &&
      (req.url.includes("/permission/") || req.url.includes("/form/"))
    ) {
      void bodyRead(req).then((body) => {
        replies.push({ path: req.url!, body });
        if (rejectReplies) res.writeHead(503).end();
        else res.writeHead(204).end();
      });
      return;
    }
    if (req.method === "DELETE" && req.url?.includes("/form/")) {
      replies.push({ path: req.url, body: {} });
      res.writeHead(204).end();
      return;
    }
    const url = new URL(req.url!, "http://fixture");
    if (url.pathname === "/api/command" || url.pathname === "/api/skill") {
      inventoryRequests.push(req.url!);
      if (url.pathname === `/api/${rejectedInventory}`) {
        res.writeHead(503).end();
        return;
      }
      send(res, {
        location: { directory },
        data:
          url.pathname === "/api/command" ? workspaceInventory.command : workspaceInventory.skill,
      });
      return;
    }
    if (url.pathname === "/api/session/ses_fixture/command") {
      void bodyRead(req).then((body) => {
        commandBodies.push({ path: url.pathname, body });
        heldCommand = res;
        commandRequested?.();
        commandRequested = undefined;
      });
      return;
    }
    if (req.url?.includes("/log")) {
      logReads++;
      const after = Number(url.searchParams.get("after") ?? -1);
      logRequests.push({ after, follow: url.searchParams.get("follow") });
      const respond = () => {
        const parentEvents = loggedEvents.filter(
          (event) => event.durable?.aggregateID === session.id,
        );
        const seq = Math.max(100, ...parentEvents.map((event) => event.durable!.seq));
        const prefix = retainLog
          ? parentEvents.filter((event) => event.durable!.seq > after && event.durable!.seq <= seq)
          : [];
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end(
          [...prefix, { type: "log.synced", aggregateID: session.id, seq }]
            .map((event) => `data: ${JSON.stringify(event)}\n\n`)
            .join(""),
        );
      };
      if (logRequested) {
        heldLog = respond;
        logRequested();
        logRequested = undefined;
        return;
      }
      respond();
      return;
    }
    if (req.url?.endsWith("/prompt")) {
      prompts++;
      void bodyRead(req).then((body) => {
        promptBodies.push(body);
        send(res, { data: { id: body.id, sessionID: session.id, type: "user" } });
      });
      return;
    }
    if (req.url?.endsWith("/model") || req.url?.endsWith("/agent")) {
      void bodyRead(req).then((body) => {
        switches.push({ path: req.url!, body });
        res.writeHead(204).end();
      });
      return;
    }
    if (req.url?.endsWith("/interrupt")) {
      interrupts++;
      if (rejectInterrupt) res.writeHead(503).end();
      else send(res, { interrupted });
      return;
    }
    res.writeHead(404).end();
  });
  const engine = openCodeNativeSessionEngineCreate({
    url: server.url,
    fetch: fetchImpl,
    ...(cachedInventory ? { inventory: () => cachedInventory } : {}),
    onEvent: capture.receive,
  });
  expect((await engine.start({ directory })).success).toBe(true);
  let marker = 1000;
  const write = (type: string, data: Record<string, unknown> = {}, id?: string, seq = 1) => {
    const event = frame(stream!, type, { sessionID: session.id, ...data }, id, seq);
    loggedEvents.push(event);
  };
  const writeLog = (type: string, data: Record<string, unknown> = {}, id?: string, seq = 1) => {
    const event = frame({ write: () => true }, type, { sessionID: session.id, ...data }, id, seq);
    loggedEvents.push(event);
  };
  return {
    ...capture,
    engine,
    write,
    writeLog,
    logRequests,
    replayLogged: () => {
      for (const event of loggedEvents) stream!.write(`data: ${JSON.stringify(event)}\n\n`);
    },
    setLogRetention: (value: boolean) => {
      retainLog = value;
    },
    holdNextLog: () => {
      const requested = new Promise<void>((resolve) => {
        logRequested = resolve;
      });
      return {
        requested,
        release: () => {
          if (!heldLog) throw new Error("No log request to release");
          heldLog();
          heldLog = undefined;
        },
      };
    },
    promptCount: () => prompts,
    promptBodies,
    inventoryRequests,
    setInventoryFailure: (endpoint?: "command" | "skill") => {
      rejectedInventory = endpoint;
    },
    commandBodies,
    holdNextCommand: () => {
      const requested = new Promise<void>((resolve) => {
        commandRequested = resolve;
      });
      return {
        requested,
        release: (status = 204) => {
          if (!heldCommand) throw new Error("No command request to release");
          heldCommand.writeHead(status).end();
          heldCommand = undefined;
        },
      };
    },
    interrupts: () => interrupts,
    disconnect: () => stream!.end(),
    logReads: () => logReads,
    replies,
    switches,
    setPending: (permissions: Record<string, unknown>[], forms: Record<string, unknown>[]) => {
      pendingPermissions = permissions;
      pendingForms = forms;
    },
    holdNextPermissionList: () => {
      const requested = new Promise<void>((resolve) => {
        permissionListRequested = resolve;
      });
      return {
        requested,
        release: () => {
          if (!heldPermissionList) throw new Error("No permission list request to release");
          send(heldPermissionList, { data: pendingPermissions });
          heldPermissionList = undefined;
        },
      };
    },
    holdNextFormList: () => {
      const requested = new Promise<void>((resolve) => {
        formListRequested = resolve;
      });
      return {
        requested,
        release: () => {
          if (!heldFormList) throw new Error("No form list request to release");
          send(heldFormList, { data: pendingForms });
          heldFormList = undefined;
        },
      };
    },
    failReplies: () => {
      rejectReplies = true;
    },
    failInterrupt: () => {
      rejectInterrupt = true;
    },
    setInterrupted: (value: boolean) => {
      interrupted = value;
    },
    admit: async () => {
      const result = await engine.send("fixture prompt");
      expect(result.success).toBe(true);
      if (!result.success) throw new Error("fixture admission failed");
      return result.data.turnID;
    },
    // An observable SSE receipt drains earlier ignored/duplicate frames too.
    drain: async () => {
      const cost = ++marker;
      write("session.usage.updated", { ...usage, cost });
      await capture.wait((event) => event.type === "usage.updated" && event.cost === cost);
    },
    close: async () => {
      await engine.stop();
      await server.close();
    },
  };
};

const stalledFetch = (stalledPath: string) => {
  const nativeFetch = globalThis.fetch;
  let stalled = false;
  let requestReceived!: () => void;
  const requested = new Promise<void>((resolve) => {
    requestReceived = resolve;
  });
  const fetchImpl = (async (
    input: Parameters<typeof globalThis.fetch>[0],
    init?: Parameters<typeof globalThis.fetch>[1],
  ) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    if (!stalled || url.pathname !== stalledPath) return nativeFetch(input, init);
    requestReceived();
    return await new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      if (!signal) return;
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  }) as typeof globalThis.fetch;
  return {
    fetch: fetchImpl,
    requested,
    stall: () => (stalled = true),
    resume: () => (stalled = false),
  };
};

const stepStart = (assistantMessageID: string) => ({
  assistantMessageID,
  agent: "build",
  model: { id: "model", providerID: "provider", variant: "high" },
  started: 42,
});
const stepEnd = (assistantMessageID: string, finish = "stop") => ({
  assistantMessageID,
  finish,
  ...usage,
});

// A read-after-marker receipt proves the SSE consumer requested its next frame after
// processing the preceding batch. This makes cross-transport race tests deterministic.
const commandTransportReceipts = () => {
  let commandResponseReceived!: () => void;
  let eventBatchConsumed!: () => void;
  let completionLogReceived!: () => void;
  let logReads = 0;
  const completionLogResponse = new Promise<void>((resolve) => {
    completionLogReceived = resolve;
  });
  const commandResponse = new Promise<void>((resolve) => {
    commandResponseReceived = resolve;
  });
  const eventBatch = new Promise<void>((resolve) => {
    eventBatchConsumed = resolve;
  });
  const fetchImpl: typeof fetch = async (request, init) => {
    const response = await fetch(request, init);
    const path = new URL(request instanceof Request ? request.url : String(request)).pathname;
    if (path.endsWith("/command")) commandResponseReceived();
    if (path.endsWith("/log") && ++logReads === 2) completionLogReceived();
    if (path !== "/api/event") return response;
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let tail = "";
    let markerRead = false;
    return new Response(
      new ReadableStream<Uint8Array>(
        {
          async pull(controller) {
            if (markerRead) eventBatchConsumed();
            const result = await reader.read();
            if (result.done) {
              controller.close();
              return;
            }
            tail = (tail + decoder.decode(result.value, { stream: true })).slice(-1000);
            markerRead ||= tail.includes("evt_command_receipt");
            controller.enqueue(result.value);
          },
          cancel: () => reader.cancel(),
        },
        { highWaterMark: 0 },
      ),
      { status: response.status, headers: response.headers },
    );
  };
  return { fetch: fetchImpl, commandResponse, eventBatch, completionLogResponse };
};
const commandPromptWrite = (
  test: Awaited<ReturnType<typeof sessionFixture>>,
  id = "msg_native_command",
  seq = 101,
  sessionID = session.id,
  logOnly = false,
) =>
  (logOnly ? test.writeLog : test.write)(
    "session.inbox.enqueued",
    {
      sessionID,
      inboxID: id,
      item: { type: "user", delivery: "steer", payload: { text: "Expanded native template" } },
    },
    undefined,
    seq,
  );
const commandTurnWrite = (
  test: Awaited<ReturnType<typeof sessionFixture>>,
  stale = false,
  logOnly = false,
) => {
  const write = logOnly ? test.writeLog : test.write;
  write("session.execution.started", {}, undefined, 102);
  if (stale) {
    write("session.execution.succeeded", {}, undefined, 98);
    write("session.step.started", stepStart("msg_stale_answer"), undefined, 99);
  }
  write("session.step.started", stepStart("msg_native_answer"), undefined, 103);
  write(
    "session.text.started",
    { assistantMessageID: "msg_native_answer", ordinal: 0 },
    undefined,
    104,
  );
  write(
    "session.text.delta",
    { assistantMessageID: "msg_native_answer", ordinal: 0, delta: "Reviewed with loaded skills" },
    undefined,
    105,
  );
  write(
    "session.text.ended",
    { assistantMessageID: "msg_native_answer", ordinal: 0, text: "Reviewed with loaded skills" },
    undefined,
    105,
  );
  write("session.step.ended", stepEnd("msg_native_answer"), undefined, 106);
  write("session.execution.succeeded", {}, "command_receipt", 107);
};
const commandTurnExpect = (test: Awaited<ReturnType<typeof sessionFixture>>, turnID: string) => {
  expect(test.events.filter((event) => event.type.startsWith("turn."))).toEqual([
    { type: "turn.started", turnID },
    { type: "turn.completed", turnID },
  ]);
  expect(test.events.find((event) => event.type === "text.completed")).toMatchObject({
    type: "text.completed",
    turnID,
    sessionID: session.id,
    assistantMessageID: "msg_native_answer",
    text: "Reviewed with loaded skills",
  });
  expect(test.events.find((event) => event.type === "step.completed")).toMatchObject({
    turnID,
    step: { assistantMessageID: "msg_native_answer", finish: "stop", ...usage },
  });
};

describe("native command and skill HTTP admission", () => {
  it.each([
    { inventory: "command", text: "/review rejected" },
    { inventory: "skill", text: "$review rejected" },
  ] as const)(
    "rejects send-time $inventory discovery HTTP failure without invoking a turn and permits a later ordinary prompt",
    async ({ inventory, text }) => {
      const test = await sessionFixture();
      try {
        const inventoryRequestStart = test.inventoryRequests.length;
        test.setInventoryFailure(inventory);
        expect(await test.engine.send(text)).toMatchObject({
          success: false,
          rejected: true,
          error: { operation: "session.prompt", detail: expect.stringContaining("503") },
        });
        expect(
          test.inventoryRequests
            .slice(inventoryRequestStart)
            .map((request) => new URL(request, "http://fixture").pathname),
        ).toContain(`/api/${inventory}`);
        expect(test.commandBodies).toEqual([]);
        expect(test.promptCount()).toBe(0);
        expect(test.promptBodies).toEqual([]);
        expect(test.events.map((event) => event.type)).toEqual(["session.ready"]);

        test.setInventoryFailure();
        const next = await test.engine.send("ordinary after inventory failure");
        expect(next.success).toBe(true);
        if (!next.success) throw new Error("Ordinary admission after inventory failure failed");
        expect(test.promptCount()).toBe(1);
        expect(test.promptBodies).toEqual([
          { id: next.data.turnID, text: "ordinary after inventory failure" },
        ]);
        expect(test.commandBodies).toEqual([]);
        test.write("session.execution.started", {}, undefined, 101);
        test.write("session.execution.succeeded", {}, undefined, 102);
        await test.wait(
          (event) => event.type === "turn.completed" && event.turnID === next.data.turnID,
        );
        expect(test.events.filter((event) => event.type.startsWith("turn."))).toEqual([
          { type: "turn.started", turnID: next.data.turnID },
          { type: "turn.completed", turnID: next.data.turnID },
        ]);
      } finally {
        await test.close();
      }
    },
  );

  it("dispatches registry commands with native name/args and correlates the complete turn when events precede the 204", async () => {
    const receipts = commandTransportReceipts();
    const test = await sessionFixture(receipts.fetch);
    try {
      const command = test.holdNextCommand();
      const sending = test.engine.send('/review "two words" remaining', {
        delivery: "queue",
        files: [{ uri: "data:image/png;base64,cGl4ZWw=", name: "image.png" }],
        agents: [{ name: "build" }],
      });
      await command.requested;
      commandPromptWrite(test);
      commandTurnWrite(test);
      await receipts.eventBatch;
      expect(test.events.map((event) => event.type)).toEqual(["session.ready"]);
      command.release();
      expect(await sending).toEqual({ success: true, data: { turnID: "msg_native_command" } });
      await test.wait((event) => event.type === "turn.completed");
      expect(test.commandBodies).toEqual([
        {
          path: "/api/session/ses_fixture/command",
          body: {
            name: "review",
            text: '"two words" remaining',
            delivery: "queue",
            files: [{ uri: "data:image/png;base64,cGl4ZWw=", name: "image.png" }],
            agents: [{ name: "build" }],
          },
        },
      ]);
      expect(test.promptCount()).toBe(0);
      expect(test.inventoryRequests).toHaveLength(1);
      expect(
        new URL(test.inventoryRequests[0]!, "http://fixture").searchParams.get(
          "location[directory]",
        ),
      ).toBe(directory);
      commandTurnExpect(test, "msg_native_command");
    } finally {
      await test.close();
    }
  });

  it("recovers the native parent enqueue from the completion log when the 204 precedes SSE, deduplicating the late feed", async () => {
    const receipts = commandTransportReceipts();
    const test = await sessionFixture(receipts.fetch);
    try {
      const command = test.holdNextCommand();
      const sending = test.engine.send("/review args");
      await command.requested;
      commandPromptWrite(test, "msg_native_command", 101, session.id, true);
      commandTurnWrite(test, false, true);
      command.release();
      await receipts.commandResponse;
      commandPromptWrite(test, "msg_stale", 99);
      test.write("session.execution.started", {}, undefined, 99);
      commandPromptWrite(test, "msg_unrelated", 101, "ses_unrelated");
      test.write("session.execution.succeeded", { sessionID: "ses_unrelated" }, undefined, 102);
      test.write(
        "session.inbox.enqueued",
        {
          inboxID: "msg_synthetic",
          item: { type: "synthetic", delivery: "steer", payload: { text: "not a user prompt" } },
        },
        undefined,
        101,
      );
      expect(await sending).toEqual({ success: true, data: { turnID: "msg_native_command" } });
      await test.wait((event) => event.type === "turn.completed");
      test.replayLogged();
      test.write("session.usage.updated", { ...usage, cost: 9000 }, undefined, 109);
      await test.wait((event) => event.type === "usage.updated" && event.cost === 9000);
      commandTurnExpect(test, "msg_native_command");
      expect(test.events.filter((event) => event.type === "text.completed")).toHaveLength(1);
      expect(test.logRequests).toEqual([
        { after: -1, follow: "false" },
        { after: 100, follow: "false" },
      ]);
      expect(
        test.events.some(
          (event) =>
            "turnID" in event &&
            ["msg_stale", "msg_unrelated", "msg_synthetic"].includes(event.turnID),
        ),
      ).toBe(false);
    } finally {
      await test.close();
    }
  });

  it("completes a successful command with no parent enqueue and permits a subsequent ordinary turn", async () => {
    const test = await sessionFixture();
    try {
      const command = test.holdNextCommand();
      const sending = test.engine.send("/review noop");
      await command.requested;
      command.release();
      const result = await sending;
      expect(result.success).toBe(true);
      if (!result.success) throw new Error("Command receipt failed");
      expect(result.data.turnID).toMatch(/^command_/);
      expect(test.events.filter((event) => event.type.startsWith("turn."))).toEqual([
        { type: "turn.started", turnID: result.data.turnID },
        { type: "turn.completed", turnID: result.data.turnID },
      ]);
      expect(test.logReads()).toBe(2);
      const next = await test.engine.send("ordinary after noop");
      expect(next.success).toBe(true);
      if (!next.success) throw new Error("Ordinary admission failed");
      test.write("session.execution.started", {}, undefined, 101);
      test.write("session.execution.succeeded", {}, undefined, 102);
      await test.wait(
        (event) => event.type === "turn.completed" && event.turnID === next.data.turnID,
      );
      expect(next.data.turnID).not.toBe(result.data.turnID);
    } finally {
      await test.close();
    }
  });

  it("links and settles child-only command events buffered before the 204 without a parent inbox", async () => {
    const receipts = commandTransportReceipts();
    const test = await sessionFixture(receipts.fetch);
    try {
      const command = test.holdNextCommand();
      const sending = test.engine.send("/review child only");
      await command.requested;
      test.write("session.created", {
        sessionID: "ses_command_child",
        parentID: session.id,
        projectID: "proj_fixture",
        slug: "child",
        location: { directory },
        agent: "review",
        version: "2.0.18",
      });
      test.write("session.execution.started", { sessionID: "ses_command_child" }, undefined, 2);
      test.write(
        "session.execution.succeeded",
        { sessionID: "ses_command_child" },
        "command_receipt",
        3,
      );
      await receipts.eventBatch;
      expect(test.events.map((event) => event.type)).toEqual(["session.ready"]);
      command.release();
      const result = await sending;
      expect(result.success).toBe(true);
      if (!result.success) throw new Error("Child command receipt failed");
      const scope = {
        sessionID: "ses_command_child",
        parentSessionID: session.id,
        turnID: result.data.turnID,
      };
      expect(test.events.filter((event) => event.type.startsWith("child."))).toEqual([
        { type: "child.attached", ...scope, info: { agent: "review", directory } },
        { type: "child.started", ...scope },
        { type: "child.completed", ...scope },
      ]);
      expect(test.events.filter((event) => event.type.startsWith("turn."))).toEqual([
        { type: "turn.started", turnID: result.data.turnID },
        { type: "turn.completed", turnID: result.data.turnID },
      ]);
    } finally {
      await test.close();
    }
  });

  it("attaches a child from the logged command prefix and accepts its lagged SSE completion", async () => {
    const test = await sessionFixture();
    try {
      const command = test.holdNextCommand();
      const sending = test.engine.send("/review logged child");
      await command.requested;
      const tool = { assistantMessageID: "msg_command_tool", id: "tool_command_child" };
      test.writeLog("session.tool.input.started", { ...tool, name: "subagent" }, undefined, 101);
      test.writeLog(
        "session.tool.called",
        { ...tool, input: { agent: "review", prompt: "inspect" }, executed: false },
        undefined,
        102,
      );
      test.writeLog(
        "session.tool.success",
        {
          ...tool,
          executed: true,
          content: [{ type: "text", text: "Child launched" }],
          metadata: { sessionID: "ses_logged_child", status: "running" },
        },
        undefined,
        103,
      );
      command.release();
      const result = await sending;
      expect(result.success).toBe(true);
      if (!result.success) throw new Error("Logged child command failed");
      const scope = {
        sessionID: "ses_logged_child",
        parentSessionID: session.id,
        parentToolKey: "ses_fixture:msg_command_tool:tool:tool_command_child",
        turnID: result.data.turnID,
      };
      expect(test.events.find((event) => event.type === "child.attached")).toMatchObject({
        type: "child.attached",
        ...scope,
      });
      test.write("session.execution.started", { sessionID: "ses_logged_child" }, undefined, 2);
      test.write("session.execution.succeeded", { sessionID: "ses_logged_child" }, undefined, 3);
      await test.wait((event) => event.type === "child.completed");
      expect(test.events.filter((event) => event.type === "child.completed")).toEqual([
        { type: "child.completed", ...scope },
      ]);
      expect(test.events.filter((event) => event.type.startsWith("turn."))).toEqual([
        { type: "turn.started", turnID: result.data.turnID },
        { type: "turn.completed", turnID: result.data.turnID },
      ]);
    } finally {
      await test.close();
    }
  });

  it("keeps an existing turn open when a steering command has no parent enqueue", async () => {
    const test = await sessionFixture();
    try {
      const turnID = await test.admit();
      test.write("session.execution.started");
      await test.wait((event) => event.type === "turn.started");
      const command = test.holdNextCommand();
      const sending = test.engine.send("/review noop steer");
      await command.requested;
      command.release();
      expect(await sending).toEqual({ success: true, data: { turnID } });
      expect(test.events.filter((event) => event.type.startsWith("turn."))).toEqual([
        { type: "turn.started", turnID },
      ]);
      test.write("session.execution.succeeded", {}, undefined, 101);
      await test.wait((event) => event.type === "turn.completed");
      expect(test.events.filter((event) => event.type === "turn.completed")).toEqual([
        { type: "turn.completed", turnID },
      ]);
    } finally {
      await test.close();
    }
  });

  it.each([true, false])(
    "drains a non-retained post-command watermark before deciding parent enqueue presence (%s)",
    async (hasParent) => {
      const receipts = commandTransportReceipts();
      const test = await sessionFixture(receipts.fetch);
      try {
        const command = test.holdNextCommand();
        const sending = test.engine.send("/review SSE behind without persistence");
        let settled = false;
        void sending.then(() => {
          settled = true;
        });
        await command.requested;
        test.setLogRetention(false);
        if (hasParent) {
          commandPromptWrite(test, "msg_native_command", 101, session.id, true);
          commandTurnWrite(test, false, true);
        } else {
          test.writeLog(
            "session.metadata.updated",
            { metadata: { command: "state only" } },
            undefined,
            101,
          );
        }
        command.release();
        await receipts.completionLogResponse;
        // An unrelated live frame drains the consumer without satisfying the parent prefix.
        test.write("session.usage.updated", { ...usage, cost: 9000 }, "command_receipt_prefix");
        await receipts.eventBatch;
        expect(settled).toBe(false);
        expect(test.events.map((event) => event.type)).toEqual(["session.ready"]);
        if (hasParent) {
          commandPromptWrite(test);
          commandTurnWrite(test);
        } else {
          // Every durable sequence counts, even when its type has no UI translation.
          test.write(
            "session.metadata.updated",
            { metadata: { command: "state only" } },
            undefined,
            101,
          );
        }
        const result = await sending;
        expect(result.success).toBe(true);
        if (!result.success) throw new Error("SSE prefix drain failed");
        if (hasParent) {
          expect(result.data.turnID).toBe("msg_native_command");
          commandTurnExpect(test, result.data.turnID);
        } else {
          expect(result.data.turnID).toMatch(/^command_/);
          expect(test.events.filter((event) => event.type.startsWith("turn."))).toEqual([
            { type: "turn.started", turnID: result.data.turnID },
            { type: "turn.completed", turnID: result.data.turnID },
          ]);
        }
        expect(test.logReads()).toBe(2);
      } finally {
        await test.close();
      }
    },
  );

  it.each(["disconnect", "stop"] as const)(
    "unblocks an incomplete non-retained prefix on %s without a ghost turn",
    async (action) => {
      const receipts = commandTransportReceipts();
      const test = await sessionFixture(receipts.fetch);
      try {
        const command = test.holdNextCommand();
        const sending = test.engine.send("/review lost prefix");
        await command.requested;
        test.setLogRetention(false);
        commandPromptWrite(test, "msg_unretained", 101, session.id, true);
        command.release();
        await receipts.completionLogResponse;
        test.write("session.usage.updated", { ...usage, cost: 9000 }, "command_receipt_prefix");
        await receipts.eventBatch;
        if (action === "disconnect") {
          test.disconnect();
          await test.wait((event) => event.type === "stream.lost");
        } else {
          await test.engine.stop();
        }
        expect(await sending).toMatchObject({
          success: false,
          error: { operation: "session.command" },
        });
        expect(test.events.some((event) => event.type.startsWith("turn."))).toBe(false);
      } finally {
        await test.close();
      }
    },
  );

  it("keeps unknown slash commands literal on ordinary /prompt and produces a complete turn", async () => {
    const test = await sessionFixture();
    try {
      const sending = await test.engine.send("/not-registered keep these args");
      expect(sending.success).toBe(true);
      if (!sending.success) throw new Error("Prompt admission failed");
      expect(test.promptBodies).toEqual([
        { id: sending.data.turnID, text: "/not-registered keep these args" },
      ]);
      expect(test.commandBodies).toEqual([]);
      expect(test.logReads()).toBe(0);
      commandTurnWrite(test);
      await test.wait((event) => event.type === "turn.completed");
      commandTurnExpect(test, sending.data.turnID);
    } finally {
      await test.close();
    }
  });

  it("does not leave a ghost turn after a command HTTP failure even if native execution events arrived first", async () => {
    const receipts = commandTransportReceipts();
    const test = await sessionFixture(receipts.fetch);
    try {
      const command = test.holdNextCommand();
      const sending = test.engine.send("/review rejected");
      await command.requested;
      commandPromptWrite(test);
      commandTurnWrite(test);
      await receipts.eventBatch;
      command.release(503);
      expect(await sending).toMatchObject({
        success: false,
        error: { operation: "session.command" },
      });
      expect(test.events.map((event) => event.type)).toEqual(["session.ready"]);
      expect((await test.engine.send("do not replay uncertain work")).success).toBe(false);
      expect(test.promptCount()).toBe(0);
    } finally {
      await test.close();
    }
  });

  it("unblocks command admission on stream loss without inventing a running turn", async () => {
    const receipts = commandTransportReceipts();
    const test = await sessionFixture(receipts.fetch);
    try {
      const command = test.holdNextCommand();
      const sending = test.engine.send("/review lost");
      await command.requested;
      const completion = test.holdNextLog();
      command.release();
      await receipts.commandResponse;
      await completion.requested;
      test.disconnect();
      await test.wait((event) => event.type === "stream.lost");
      completion.release();
      expect(await sending).toMatchObject({
        success: false,
        error: { operation: "session.command" },
      });
      expect(test.events.map((event) => event.type)).toEqual(["session.ready", "stream.lost"]);
    } finally {
      await test.close();
    }
  });

  it("loads real native skill IDs and exact mentions without removing args, multiple skills or unknown/literal variables", async () => {
    const test = await sessionFixture();
    try {
      const text = '$review compare $quality with $UNKNOWN and "$review" ` $literal `';
      const sending = await test.engine.send(text, { files: [{ uri: "file:///tmp/context.txt" }] });
      expect(sending.success).toBe(true);
      if (!sending.success) throw new Error("Skill admission failed");
      expect(test.promptBodies).toEqual([
        {
          id: sending.data.turnID,
          text,
          files: [{ uri: "file:///tmp/context.txt" }],
          skills: [
            { id: "native_skill_7f42", mention: { start: 0, end: 7, text: "$review" } },
            { id: "native_skill_98ab", mention: { start: 16, end: 24, text: "$quality" } },
          ],
        },
      ]);
      expect(test.inventoryRequests).toHaveLength(1);
      expect(test.inventoryRequests[0]).toMatch(/^\/api\/skill\?/);
      expect(
        new URL(test.inventoryRequests[0]!, "http://fixture").searchParams.get(
          "location[directory]",
        ),
      ).toBe(directory);
      commandTurnWrite(test);
      await test.wait((event) => event.type === "turn.completed");
      commandTurnExpect(test, sending.data.turnID);
    } finally {
      await test.close();
    }
  });

  it("reuses cached raw inventory and keeps command and skill namespaces distinct", async () => {
    const test = await sessionFixture(fetch, workspaceInventory);
    try {
      const command = test.holdNextCommand();
      const sending = test.engine.send("/review $review inspect $quality and $MISSING");
      await command.requested;
      commandPromptWrite(test);
      commandTurnWrite(test);
      command.release();
      expect(await sending).toEqual({ success: true, data: { turnID: "msg_native_command" } });
      await test.wait((event) => event.type === "turn.completed");
      expect(test.commandBodies[0]?.body).toEqual({
        name: "review",
        text: "$review inspect $quality and $MISSING",
        skills: [
          { id: "native_skill_7f42", mention: { start: 0, end: 7, text: "$review" } },
          { id: "native_skill_98ab", mention: { start: 16, end: 24, text: "$quality" } },
        ],
      });
      expect(test.inventoryRequests).toEqual([]);
      commandTurnExpect(test, "msg_native_command");
    } finally {
      await test.close();
    }
  });

  it("preserves steer delivery and canonical identity, then admits an ordinary fresh turn after command completion", async () => {
    const test = await sessionFixture();
    try {
      const originalID = await test.admit();
      test.write("session.execution.started");
      await test.wait((event) => event.type === "turn.started");
      const command = test.holdNextCommand();
      const sending = test.engine.send("/review while running");
      await command.requested;
      commandPromptWrite(test);
      commandTurnWrite(test);
      command.release();
      expect(await sending).toEqual({ success: true, data: { turnID: originalID } });
      await test.wait((event) => event.type === "turn.completed");
      expect(test.commandBodies[0]?.body).toEqual({
        name: "review",
        text: "while running",
        delivery: "steer",
      });
      commandTurnExpect(test, originalID);
      const next = await test.engine.send("ordinary after command");
      expect(next.success).toBe(true);
      if (!next.success) throw new Error("Ordinary admission after command failed");
      expect(next.data.turnID).not.toBe(originalID);
      expect(test.promptBodies[1]).toEqual({
        id: next.data.turnID,
        text: "ordinary after command",
      });
      test.write("session.execution.started", {}, undefined, 109);
      test.write("session.execution.succeeded", {}, undefined, 110);
      await test.wait(
        (event) => event.type === "turn.completed" && event.turnID === next.data.turnID,
      );
      expect(test.events.filter((event) => event.type === "turn.completed")).toEqual([
        { type: "turn.completed", turnID: originalID },
        { type: "turn.completed", turnID: next.data.turnID },
      ]);
    } finally {
      await test.close();
    }
  });

  it("does not look up inventory for ordinary prompts without skill references", async () => {
    const test = await sessionFixture();
    try {
      const sending = await test.engine.send("ordinary plain text");
      expect(sending.success).toBe(true);
      if (!sending.success) throw new Error("Ordinary admission failed");
      expect(test.inventoryRequests).toEqual([]);
      expect(test.logReads()).toBe(0);
      commandTurnWrite(test);
      await test.wait((event) => event.type === "turn.completed");
      commandTurnExpect(test, sending.data.turnID);
    } finally {
      await test.close();
    }
  });
});

describe("native v2.0.18 session slice", () => {
  it("bounds stalled session creation and tears down the event subscription", async () => {
    const server = await fixture((req, res) => {
      if (req.url === "/api/event") {
        res.writeHead(200, { "content-type": "text/event-stream" });
        frame(res, "server.connected", {});
        return;
      }
      res.writeHead(404).end();
    });
    const stalled = stalledFetch("/api/session");
    const engine = openCodeNativeSessionEngineCreate({
      url: server.url,
      fetch: stalled.fetch,
      onEvent: () => {},
    });
    try {
      stalled.stall();
      vi.useFakeTimers();
      const starting = engine.start({ directory });
      await stalled.requested;
      await vi.advanceTimersByTimeAsync(15_000);
      expect(await starting).toMatchObject({
        success: false,
        error: { operation: "session.create" },
      });
    } finally {
      vi.useRealTimers();
      await engine.stop();
      await server.close();
    }
  });

  it("bounds stalled prompt admission and keeps its outcome fail-closed without retry", async () => {
    const stalled = stalledFetch("/api/session/ses_fixture/prompt");
    const test = await sessionFixture(stalled.fetch);
    try {
      stalled.stall();
      vi.useFakeTimers();
      const sending = test.engine.send("possibly admitted");
      await vi.advanceTimersByTimeAsync(15_000);
      expect((await sending).success).toBe(false);
      expect((await test.engine.send("never retry")).success).toBe(false);
      expect(test.events.filter((event) => event.type === "turn.started")).toEqual([]);
    } finally {
      vi.useRealTimers();
      await test.close();
    }
  });

  it("bounds stalled pending-request reconciliation and preserves uncertainty", async () => {
    const stalled = stalledFetch("/api/session/ses_fixture/permission");
    const test = await sessionFixture(stalled.fetch);
    try {
      await test.admit();
      stalled.stall();
      vi.useFakeTimers();
      const reconciling = test.engine.reconcilePending();
      await vi.advanceTimersByTimeAsync(15_000);
      expect((await reconciling).success).toBe(false);
      // A steer still has to reconcile pending requests, so it stays fail-closed.
      const steering = test.engine.send("do not retry");
      await vi.advanceTimersByTimeAsync(15_000);
      expect((await steering).success).toBe(false);
    } finally {
      vi.useRealTimers();
      await test.close();
    }
  });

  it("bounds an ambiguous interrupt and never admits another prompt after its turn's terminal SSE", async () => {
    const stalled = stalledFetch("/api/session/ses_fixture/interrupt");
    const test = await sessionFixture(stalled.fetch);
    try {
      await test.admit();
      stalled.stall();
      vi.useFakeTimers();
      let result: Awaited<ReturnType<typeof test.engine.interrupt>> | undefined;
      const interrupting = test.engine.interrupt().then((value) => {
        result = value;
      });
      test.write("session.execution.started");
      test.write("session.execution.interrupted", { reason: "user" });
      await test.wait((event) => event.type === "turn.failed");
      await vi.advanceTimersByTimeAsync(15_000);
      expect(result).toMatchObject({ success: false, error: { operation: "session.interrupt" } });
      await interrupting;
      test.write("session.execution.succeeded");
      expect(await test.engine.send("do not admit after ambiguous interrupt")).toMatchObject({
        success: false,
        error: { operation: "session.prompt" },
      });
      expect(test.promptCount()).toBe(1);
    } finally {
      vi.useRealTimers();
      stalled.resume();
      await test.close();
    }
  });

  it("switches model and agent on an idle session without interrupting", async () => {
    const test = await sessionFixture();
    try {
      const model = { id: "claude-sonnet", providerID: "anthropic", variant: "high" };
      expect(await test.engine.switchSelection({ model, agent: "plan" })).toEqual({
        success: true,
        data: undefined,
      });
      expect(test.switches).toEqual([
        { path: "/api/session/ses_fixture/model", body: { model } },
        { path: "/api/session/ses_fixture/agent", body: { agent: "plan" } },
      ]);
      expect(test.interrupts()).toBe(0);
    } finally {
      await test.close();
    }
  });

  it("interrupts a running turn, waits for its terminal, then switches and starts a new turn", async () => {
    const test = await sessionFixture();
    try {
      const first = await test.admit();
      test.write("session.execution.started");
      const switching = test.engine.switchSelection({ agent: "plan" });
      // Sends are held while the old turn winds down, so nothing steers into it.
      expect(await test.engine.send("too early")).toMatchObject({ success: false, rejected: true });
      test.write("session.execution.interrupted", { reason: "user" });
      expect(await switching).toEqual({ success: true, data: undefined });
      expect(test.interrupts()).toBe(1);
      expect(test.switches).toEqual([
        { path: "/api/session/ses_fixture/agent", body: { agent: "plan" } },
      ]);
      expect(
        test.events.find((event) => event.type === "turn.failed" && event.turnID === first),
      ).toMatchObject({ reason: "interrupted" });
      const next = await test.engine.send("after switch");
      expect(next.success && next.data.turnID).not.toBe(first);
      expect(test.promptCount()).toBe(2);
    } finally {
      await test.close();
    }
  });

  it("fails closed when an interrupt for a switch never confirms", async () => {
    const test = await sessionFixture();
    try {
      await test.admit();
      test.write("session.execution.started");
      test.failInterrupt();
      expect(await test.engine.switchSelection({ agent: "plan" })).toMatchObject({
        success: false,
        error: { operation: "session.interrupt" },
      });
      expect(test.switches).toEqual([]);
      expect(await test.engine.send("blocked")).toMatchObject({ success: false });
    } finally {
      await test.close();
    }
  });

  it("allows the next prompt after a definite interrupt no-op and a settled turn", async () => {
    const test = await sessionFixture();
    try {
      await test.admit();
      test.setInterrupted(false);
      expect(await test.engine.interrupt()).toEqual({ success: true, data: false });
      const turn = test.engine.send("still active");
      // A send during a running turn steers it instead of starting a new turn.
      expect((await turn).success).toBe(true);
      test.write("session.execution.started");
      test.write("session.execution.succeeded");
      await test.wait((event) => event.type === "turn.completed");
      expect((await test.engine.send("next turn")).success).toBe(true);
      expect(test.promptCount()).toBe(3);
    } finally {
      await test.close();
    }
  });

  it("keeps prompt admission closed after an ambiguous interrupt HTTP failure", async () => {
    const test = await sessionFixture();
    try {
      await test.admit();
      test.write("session.execution.started");
      test.write("session.execution.succeeded");
      await test.wait((event) => event.type === "turn.completed");
      test.failInterrupt();
      expect(await test.engine.interrupt()).toMatchObject({
        success: false,
        error: { operation: "session.interrupt" },
      });
      expect((await test.engine.send("no second prompt")).success).toBe(false);
      expect(test.promptCount()).toBe(1);
    } finally {
      await test.close();
    }
  });

  it("does not resolve live requests omitted from an older pending-list snapshot", async () => {
    const test = await sessionFixture();
    try {
      const turnID = await test.admit();
      const pendingPermission = test.holdNextPermissionList();
      const pendingForm = test.holdNextFormList();
      const reconciling = test.engine.reconcilePending();
      await Promise.all([pendingPermission.requested, pendingForm.requested]);
      const request = {
        id: "per_racing",
        sessionID: session.id,
        action: "edit",
        resources: ["src/a.ts"],
      };
      const form = {
        id: "frm_racing",
        sessionID: session.id,
        title: "Choose",
        fields: [{ key: "choice", type: "string", options: [{ label: "Yes", value: "yes" }] }],
      };
      test.write("permission.asked", request);
      test.write("form.created", { form });
      await test.wait(
        (event) => event.type === "permission.asked" && event.request.id === request.id,
      );
      await test.wait((event) => event.type === "form.created" && event.form.id === form.id);
      pendingPermission.release();
      pendingForm.release();
      expect(await reconciling).toEqual({ success: true, data: undefined });
      expect(test.events.filter((event) => event.type === "permission.asked")).toMatchObject([
        { turnID, request },
      ]);
      expect(test.events.filter((event) => event.type === "form.created")).toMatchObject([
        { turnID, form },
      ]);
      expect(test.events.filter((event) => event.type === "permission.replied")).toEqual([]);
      expect(test.events.filter((event) => event.type === "form.resolved")).toEqual([]);
    } finally {
      await test.close();
    }
  });

  it("closes local state after a failed interrupt while reporting uncertain stop", async () => {
    const test = await sessionFixture();
    try {
      await test.admit();
      test.failInterrupt();
      expect(await test.engine.stop()).toMatchObject({
        success: false,
        error: { operation: "session.interrupt", detail: expect.stringContaining("uncertain") },
      });
      expect((await test.engine.send("closed locally")).success).toBe(false);
      expect(test.events.filter((event) => event.type === "stream.lost")).toEqual([]);
    } finally {
      await test.close();
    }
  });

  it("correlates live permissions with the known session and never auto-approves or sends a second uncertain reply", async () => {
    const test = await sessionFixture();
    try {
      const turnID = await test.admit();
      const request = {
        id: "per_one",
        sessionID: session.id,
        action: "edit",
        resources: ["src/a.ts"],
      };
      test.write("permission.asked", { ...request, sessionID: "ses_foreign" });
      test.write("permission.asked", request, "permission-one");
      test.write("permission.asked", request, "permission-one");
      await test.wait((event) => event.type === "permission.asked");
      expect(test.events.filter((event) => event.type === "permission.asked")).toEqual([
        { type: "permission.asked", turnID, request },
      ]);
      expect(test.replies).toEqual([]);
      expect((await test.engine.replyPermission("per_foreign", "once")).success).toBe(false);
      test.setPending([request], []);
      test.failReplies();
      expect((await test.engine.replyPermission(request.id, "reject")).success).toBe(false);
      expect((await test.engine.replyPermission(request.id, "once")).success).toBe(false);
      expect(test.replies).toEqual([
        { path: "/api/session/ses_fixture/permission/per_one/reply", body: { decision: "reject" } },
      ]);
      test.write("permission.replied", { requestID: request.id, reply: "reject" });
      await test.wait((event) => event.type === "permission.replied");
      test.write("permission.asked", request);
      await test.drain();
      expect(test.events.filter((event) => event.type === "permission.replied")).toMatchObject([
        { requestID: request.id, decision: "reject" },
      ]);
      expect(test.events.filter((event) => event.type === "permission.asked")).toHaveLength(1);
    } finally {
      await test.close();
    }
  });

  it("reconciles missing pending permissions and forms, answers and cancels known forms only", async () => {
    const test = await sessionFixture();
    try {
      const turnID = await test.admit();
      test.write("session.execution.started");
      test.write("session.execution.succeeded");
      await test.wait((event) => event.type === "turn.completed");
      const request = {
        id: "per_pending",
        sessionID: session.id,
        action: "bash",
        resources: ["make test"],
      };
      const form = {
        id: "frm_pending",
        sessionID: session.id,
        title: "Choose",
        fields: [{ key: "choice", type: "string", options: [{ label: "Yes", value: "yes" }] }],
      };
      test.setPending([request], [form]);
      expect(await test.engine.reconcilePending()).toEqual({ success: true, data: undefined });
      expect(test.events.filter((event) => event.type === "permission.asked")).toMatchObject([
        { turnID, request },
      ]);
      expect(test.events.filter((event) => event.type === "form.created")).toMatchObject([
        { turnID, form },
      ]);
      expect(await test.engine.reconcilePending()).toEqual({ success: true, data: undefined });
      expect(test.events.filter((event) => event.type === "form.created")).toHaveLength(1);
      expect((await test.engine.replyForm("frm_foreign", { choice: "yes" })).success).toBe(false);
      expect(await test.engine.replyForm(form.id, { choice: "yes" })).toEqual({
        success: true,
        data: undefined,
      });
      expect((await test.engine.replyForm(form.id, undefined)).success).toBe(false);
      test.write("form.replied", { id: form.id, answer: { choice: "yes" } });
      await test.drain();
      expect(test.events.filter((event) => event.type === "form.resolved")).toMatchObject([
        { formID: form.id, answer: { choice: "yes" } },
      ]);
      const cancel = { ...form, id: "frm_cancel" };
      test.write("form.created", { form: cancel });
      await test.wait((event) => event.type === "form.created" && event.form.id === cancel.id);
      expect(await test.engine.replyForm(cancel.id, undefined)).toEqual({
        success: true,
        data: undefined,
      });
      test.write("form.cancelled", { id: cancel.id });
      await test.drain();
      expect(test.events.filter((event) => event.type === "form.resolved")).toMatchObject([
        { formID: form.id },
        { formID: cancel.id, answer: {} },
      ]);
      expect(test.replies).toEqual([
        {
          path: "/api/session/ses_fixture/form/frm_pending/reply",
          body: { answer: { choice: "yes" } },
        },
        { path: "/api/session/ses_fixture/form/frm_cancel", body: {} },
      ]);
      test.setPending([], []);
      expect(await test.engine.reconcilePending()).toEqual({ success: true, data: undefined });
      expect(test.events.filter((event) => event.type === "permission.replied")).toMatchObject([
        { requestID: request.id },
      ]);
      expect(test.replies).toHaveLength(2);
      expect((await test.engine.send("after terminal")).success).toBe(true);
    } finally {
      await test.close();
    }
  });

  it("accepts a permission only on explicit reply, and resolves duplicate native terminal once", async () => {
    const test = await sessionFixture();
    try {
      const turnID = await test.admit();
      const request = {
        id: "per_allow",
        sessionID: session.id,
        action: "bash",
        resources: ["pwd"],
      };
      test.write("permission.asked", request);
      await test.wait((event) => event.type === "permission.asked");
      expect(test.replies).toEqual([]);
      expect(await test.engine.replyPermission(request.id, "once")).toEqual({
        success: true,
        data: undefined,
      });
      test.write("permission.replied", { requestID: request.id, reply: "once" });
      await test.drain();
      expect(test.events.filter((event) => event.type === "permission.replied")).toEqual([
        {
          type: "permission.replied",
          turnID,
          sessionID: session.id,
          requestID: request.id,
          decision: "once",
        },
      ]);
      expect((await test.engine.replyPermission(request.id, "always")).success).toBe(false);
      expect(test.replies).toEqual([
        { path: "/api/session/ses_fixture/permission/per_allow/reply", body: { decision: "once" } },
      ]);
    } finally {
      await test.close();
    }
  });
  it("fails closed on a missed terminal, duplicate replay and unrelated events instead of treating an unpersisted log watermark as proof", async () => {
    const test = await sessionFixture();
    try {
      const turnID = await test.admit();
      test.write("session.execution.started", {}, "started");
      await test.wait((event) => event.type === "turn.started");
      test.disconnect(); // execution.succeeded could have committed without reaching this feed
      await test.wait((event) => event.type === "stream.lost");
      expect(await test.engine.recover()).toMatchObject({
        success: false,
        error: { operation: "session.recover" },
      });
      expect(await test.engine.recover()).toMatchObject({ success: false });
      expect((await test.engine.reconcilePending()).success).toBe(false);
      expect(test.logReads()).toBe(0); // log.synced can advance with zero persisted rows on v2.0.18
      expect((await test.engine.send("do not double-admit")).success).toBe(false);
      expect(
        test.events.filter(
          (event) => event.type === "turn.completed" || event.type === "turn.failed",
        ),
      ).toEqual([]);
      expect(test.events.filter((event) => event.type === "turn.started")).toEqual([
        { type: "turn.started", turnID },
      ]);
      expect(test.events.filter((event) => event.type === "stream.lost")).toHaveLength(1);
    } finally {
      await test.close();
    }
  });

  it("does not replay unrelated or duplicate events into a subsequent turn after a stream loss", async () => {
    const test = await sessionFixture();
    try {
      await test.admit();
      test.write("session.execution.started", {}, "replayed-start");
      test.write("session.execution.started", {}, "replayed-start");
      test.write(
        "session.execution.succeeded",
        { sessionID: "ses_unrelated" },
        "unrelated-terminal",
      );
      await test.wait((event) => event.type === "turn.started");
      test.disconnect();
      await test.wait((event) => event.type === "stream.lost");
      expect((await test.engine.send("next")).success).toBe(false);
      expect((await test.engine.recover()).success).toBe(false);
      expect(test.events.filter((event) => event.type === "turn.started")).toHaveLength(1);
      expect(test.events.filter((event) => event.type === "turn.completed")).toHaveLength(0);
    } finally {
      await test.close();
    }
  });

  it("buffers execution events before admission and drops them if the receipt is uncertain", async () => {
    const capture = captureCreate();
    let stream: NodeHttp.ServerResponse | undefined;
    let pending: NodeHttp.ServerResponse | undefined;
    let received!: () => void;
    const requestReceived = new Promise<void>((resolve) => {
      received = resolve;
    });
    const server = await fixture((req, res) => {
      if (req.url === "/api/event") {
        stream = res;
        res.writeHead(200, { "content-type": "text/event-stream" });
        frame(res, "server.connected", {});
        return;
      }
      if (req.url === "/api/session") {
        send(res, { data: session });
        return;
      }
      if (
        req.url === "/api/session/ses_fixture/permission" ||
        req.url === "/api/session/ses_fixture/form"
      ) {
        send(res, { data: [] });
        return;
      }
      if (req.url?.endsWith("/prompt")) {
        pending = res;
        received();
        return;
      }
      if (req.url?.endsWith("/interrupt")) {
        send(res, { interrupted: false });
        return;
      }
      res.writeHead(404).end();
    });
    const engine = openCodeNativeSessionEngineCreate({ url: server.url, onEvent: capture.receive });
    try {
      expect((await engine.start({ directory })).success).toBe(true);
      const sending = engine.send("early completion");
      await requestReceived;
      frame(stream!, "session.execution.started", { sessionID: session.id });
      frame(stream!, "session.execution.succeeded", { sessionID: session.id });
      frame(stream!, "session.execution.succeeded", { sessionID: "ses_unrelated" });
      expect(capture.events.map((event) => event.type)).toEqual(["session.ready"]);
      send(pending!, { data: { type: "user", id: "msg_wrong", sessionID: session.id } });
      expect((await sending).success).toBe(false);
      expect(capture.events.map((event) => event.type)).toEqual(["session.ready"]);
      expect((await engine.send("never repeat uncertain work")).success).toBe(false);
      expect((await engine.recover()).success).toBe(false);
    } finally {
      await engine.stop();
      await server.close();
    }
  });

  it("releases an event-before-admission terminal only after the matching receipt", async () => {
    const capture = captureCreate();
    let stream: NodeHttp.ServerResponse | undefined;
    let pending: NodeHttp.ServerResponse | undefined;
    let promptID = "";
    let received!: () => void;
    const requestReceived = new Promise<void>((resolve) => {
      received = resolve;
    });
    const server = await fixture((req, res) => {
      if (req.url === "/api/event") {
        stream = res;
        res.writeHead(200, { "content-type": "text/event-stream" });
        frame(res, "server.connected", {});
        return;
      }
      if (req.url === "/api/session") {
        send(res, { data: session });
        return;
      }
      if (
        req.url === "/api/session/ses_fixture/permission" ||
        req.url === "/api/session/ses_fixture/form"
      ) {
        send(res, { data: [] });
        return;
      }
      if (req.url?.endsWith("/prompt")) {
        void bodyRead(req).then((body) => {
          promptID = body.id as string;
          pending = res;
          received();
        });
        return;
      }
      if (req.url?.endsWith("/interrupt")) {
        send(res, { interrupted: false });
        return;
      }
      res.writeHead(404).end();
    });
    const engine = openCodeNativeSessionEngineCreate({ url: server.url, onEvent: capture.receive });
    try {
      expect((await engine.start({ directory })).success).toBe(true);
      const sending = engine.send("fast response");
      await requestReceived;
      frame(stream!, "session.execution.started", { sessionID: session.id });
      frame(stream!, "session.execution.succeeded", { sessionID: "ses_unrelated" });
      frame(stream!, "session.execution.succeeded", { sessionID: session.id });
      expect(capture.events.map((event) => event.type)).toEqual(["session.ready"]);
      send(pending!, { data: { type: "user", id: promptID, sessionID: session.id } });
      expect(await sending).toEqual({ success: true, data: { turnID: promptID } });
      await capture.wait((event) => event.type === "turn.completed");
      expect(capture.events).toEqual([
        { type: "session.ready", sessionID: session.id },
        { type: "turn.started", turnID: promptID },
        { type: "turn.completed", turnID: promptID },
      ]);
    } finally {
      await engine.stop();
      await server.close();
    }
  });

  it("keeps admission uncertain when the SSE stream disconnects before a valid HTTP receipt", async () => {
    const capture = captureCreate();
    let stream: NodeHttp.ServerResponse | undefined;
    let pending: NodeHttp.ServerResponse | undefined;
    let promptID = "";
    let received!: () => void;
    const requestReceived = new Promise<void>((resolve) => {
      received = resolve;
    });
    const server = await fixture((req, res) => {
      if (req.url === "/api/event") {
        stream = res;
        res.writeHead(200, { "content-type": "text/event-stream" });
        frame(res, "server.connected", {});
        return;
      }
      if (req.url === "/api/session") {
        send(res, { data: session });
        return;
      }
      if (
        req.url === "/api/session/ses_fixture/permission" ||
        req.url === "/api/session/ses_fixture/form"
      ) {
        send(res, { data: [] });
        return;
      }
      if (req.url?.endsWith("/prompt")) {
        void bodyRead(req).then((body) => {
          promptID = body.id as string;
          pending = res;
          received();
        });
        return;
      }
      if (req.url?.endsWith("/interrupt")) {
        send(res, { interrupted: true });
        return;
      }
      res.writeHead(404).end();
    });
    const engine = openCodeNativeSessionEngineCreate({ url: server.url, onEvent: capture.receive });
    try {
      expect((await engine.start({ directory })).success).toBe(true);
      const sending = engine.send("uncertain");
      await requestReceived;
      stream!.end();
      await capture.wait((event) => event.type === "stream.lost");
      send(pending!, { data: { type: "user", id: promptID, sessionID: session.id } });
      expect((await sending).success).toBe(false);
      expect((await engine.recover()).success).toBe(false);
      expect((await engine.send("no replay")).success).toBe(false);
      expect(capture.events.map((event) => event.type)).toEqual(["session.ready", "stream.lost"]);
    } finally {
      await engine.stop();
      await server.close();
    }
  });

  it("subscribes before creation, admits a prompt with a durable inbox receipt and handles live text and execution terminal", async () => {
    const capture = captureCreate();
    const { events } = capture;
    let stream: NodeHttp.ServerResponse | undefined;
    let admission: Record<string, unknown> | undefined;
    let steer: Record<string, unknown> | undefined;
    const server = await fixture((req, res) => {
      expect(req.headers.authorization).toBe(
        `Basic ${Buffer.from("opencode:secret").toString("base64")}`,
      );
      if (req.url === "/api/event") {
        stream = res;
        res.writeHead(200, { "content-type": "text/event-stream" });
        frame(res, "server.connected", {});
        return;
      }
      if (req.url === "/api/session" && req.method === "POST") {
        expect(stream).toBeDefined();
        void bodyRead(req).then((body) => {
          expect(body).toEqual({
            location: { directory },
            permissions: [{ action: "*", resource: "*", effect: "allow" }],
            title: "fresh",
            agent: "build",
            model: { providerID: "openai", id: "gpt-5.2", variant: "high" },
          });
          send(res, { data: session });
        });
        return;
      }
      if (req.url === "/api/session/ses_fixture/prompt") {
        // The new client reconciles pending interactions after admission.
        void bodyRead(req).then((body) => {
          if (body.text === "second") steer = body;
          else admission = body;
          expect(body).toMatchObject({ text: steer === body ? "second" : "hello" });
          expect(body.id).toMatch(/^msg_/);
          send(res, {
            data: {
              id: body.id,
              sessionID: session.id,
              type: "user",
              payload: { text: "hello" },
              delivery: "steer",
            },
          });
        });
        return;
      }
      if (req.url === "/api/session/ses_fixture/interrupt") {
        send(res, { interrupted: false });
        return;
      }
      if (
        req.url === "/api/session/ses_fixture/permission" ||
        req.url === "/api/session/ses_fixture/form"
      ) {
        send(res, { data: [] });
        return;
      }
      res.writeHead(404).end();
    });
    try {
      const engine = openCodeNativeSessionEngineCreate({
        url: server.url,
        serverPassword: "secret",
        onEvent: capture.receive,
      });
      expect(
        await engine.start({
          directory,
          title: "fresh",
          agent: "build",
          model: { providerID: "openai", id: "gpt-5.2", variant: "high" },
        }),
      ).toEqual({ success: true, data: session });
      const turn = await engine.send("hello");
      expect(turn.success).toBe(true);
      if (!turn.success) return;
      expect(admission?.id).toBe(turn.data.turnID);
      // A send during the running turn steers it and keeps the same turn id.
      expect(await engine.send("second")).toEqual({
        success: true,
        data: { turnID: turn.data.turnID },
      });
      expect(steer).toMatchObject({ delivery: "steer" });
      frame(stream!, "session.execution.started", { sessionID: session.id });
      frame(stream!, "session.text.delta", {
        sessionID: session.id,
        assistantMessageID: "msg_assistant",
        ordinal: 0,
        delta: "part",
      });
      frame(stream!, "session.text.ended", {
        sessionID: session.id,
        assistantMessageID: "msg_assistant",
        ordinal: 0,
        text: "part complete",
      });
      frame(stream!, "session.execution.succeeded", { sessionID: "ses_other" });
      frame(stream!, "session.execution.succeeded", { sessionID: session.id });
      await capture.wait((event) => event.type === "turn.completed");
      const ref = {
        turnID: turn.data.turnID,
        sessionID: session.id,
        key: "ses_fixture:msg_assistant:text:0",
        assistantMessageID: "msg_assistant",
        ordinal: 0,
      };
      expect(events).toEqual([
        { type: "session.ready", sessionID: session.id },
        { type: "turn.started", turnID: turn.data.turnID },
        { type: "text.started", ...ref },
        { type: "text.delta", ...ref, delta: "part" },
        { type: "text.completed", ...ref, text: "part complete" },
        { type: "turn.completed", turnID: turn.data.turnID },
      ]);
      expect(await engine.interrupt()).toEqual({ success: true, data: false });
      expect(await engine.stop()).toEqual({ success: true, data: undefined });
    } finally {
      await server.close();
    }
  });

  it("adopts an idle existing session and refuses one with running or pending work", async () => {
    let running: Record<string, unknown> = {};
    let prompted: Record<string, unknown> | undefined;
    const server = await fixture((req, res) => {
      if (req.url === "/api/event") {
        res.writeHead(200, { "content-type": "text/event-stream" });
        frame(res, "server.connected", {});
      } else if (req.url === "/api/session/ses_fixture" && req.method === "GET")
        send(res, { data: { ...session, time: { created: 1, updated: 2, idle: 2 } } });
      else if (req.url === "/api/session/active") send(res, { data: running });
      else if (req.url === "/api/session/ses_fixture/prompt")
        void bodyRead(req).then((body) => {
          prompted = body;
          send(res, { data: { id: body.id, sessionID: session.id, type: "user" } });
        });
      else if (
        req.url === "/api/session/ses_fixture/inbox" ||
        req.url === "/api/session/ses_fixture/permission" ||
        req.url === "/api/session/ses_fixture/form"
      )
        send(res, { data: [] });
      else res.writeHead(404).end();
    });
    try {
      const busy = openCodeNativeSessionEngineCreate({ url: server.url, onEvent: () => {} });
      running = { [session.id]: { type: "running" } };
      expect(await busy.start({ directory, resumeSessionId: session.id })).toMatchObject({
        success: false,
        error: { operation: "session.resume" },
      });
      expect((await busy.send("never send")).success).toBe(false);
      await busy.stop();

      running = {};
      const engine = openCodeNativeSessionEngineCreate({ url: server.url, onEvent: () => {} });
      expect(await engine.start({ directory, resumeSessionId: session.id })).toEqual({
        success: true,
        data: session,
      });
      expect((await engine.send("continue")).success).toBe(true);
      expect(prompted).toMatchObject({ text: "continue" });
      await engine.stop();
    } finally {
      await server.close();
    }
  });

  it("fails closed on SSE loss and never retries an uncertain prompt admission", async () => {
    const events: string[] = [];
    const capture = captureCreate();
    let stream: NodeHttp.ServerResponse | undefined;
    let prompts = 0;
    const server = await fixture((req, res) => {
      if (req.url === "/api/event") {
        stream = res;
        res.writeHead(200, { "content-type": "text/event-stream" });
        frame(res, "server.connected", {});
        return;
      }
      if (req.url === "/api/session") {
        send(res, { data: session });
        return;
      }
      if (
        req.url === "/api/session/ses_fixture/permission" ||
        req.url === "/api/session/ses_fixture/form"
      ) {
        send(res, { data: [] });
        return;
      }
      if (req.url?.endsWith("/prompt")) {
        prompts++;
        res
          .writeHead(503, { "content-type": "application/json" })
          .end('{"secret":"do not expose"}');
        return;
      }
      if (req.url?.endsWith("/interrupt")) {
        send(res, { interrupted: true });
        return;
      }
      res.writeHead(404).end();
    });
    try {
      const engine = openCodeNativeSessionEngineCreate({
        url: server.url,
        onEvent: (event) => {
          events.push(event.type);
          capture.receive(event);
        },
      });
      expect((await engine.start({ directory })).success).toBe(true);
      const rejected = await engine.send("one");
      expect(rejected.success).toBe(false);
      expect(JSON.stringify(rejected)).not.toContain("do not expose");
      expect((await engine.send("two")).success).toBe(false);
      expect(prompts).toBe(1);
      stream!.end();
      await capture.wait((event) => event.type === "stream.lost");
      expect((await engine.send("three")).success).toBe(false);
      expect(await engine.stop()).toEqual({ success: true, data: undefined });
    } finally {
      await server.close();
    }
  });

  it("rejects unauthorized SSE before any create request, without exposing its response body", async () => {
    const paths: string[] = [];
    const server = await fixture((req, res) => {
      paths.push(req.url!);
      res.writeHead(401, { "content-type": "application/json" }).end('{"password":"secret-value"}');
    });
    try {
      const engine = openCodeNativeSessionEngineCreate({ url: server.url, onEvent: () => {} });
      const result = await engine.start({ directory });
      expect(result.success).toBe(false);
      expect(JSON.stringify(result)).not.toContain("secret-value");
      expect(paths).toEqual(["/api/event"]);
    } finally {
      await server.close();
    }
  });

  it("does not invent completion on interrupt; waits for the matching terminal event", async () => {
    const events: string[] = [];
    const capture = captureCreate();
    let stream: NodeHttp.ServerResponse | undefined;
    const server = await fixture((req, res) => {
      if (req.url === "/api/event") {
        stream = res;
        res.writeHead(200, { "content-type": "text/event-stream" });
        frame(res, "server.connected", {});
        return;
      }
      if (req.url === "/api/session") {
        send(res, { data: session });
        return;
      }
      if (
        req.url === "/api/session/ses_fixture/permission" ||
        req.url === "/api/session/ses_fixture/form"
      ) {
        send(res, { data: [] });
        return;
      }
      if (req.url?.endsWith("/prompt")) {
        void bodyRead(req).then((body) =>
          send(res, { data: { id: body.id, sessionID: session.id, type: "user" } }),
        );
        return;
      }
      if (req.url?.endsWith("/interrupt")) {
        send(res, { interrupted: true });
        return;
      }
      res.writeHead(404).end();
    });
    try {
      const engine = openCodeNativeSessionEngineCreate({
        url: server.url,
        onEvent: (event) => {
          events.push(event.type);
          capture.receive(event);
        },
      });
      expect((await engine.start({ directory })).success).toBe(true);
      expect((await engine.send("hello")).success).toBe(true);
      expect(await engine.interrupt()).toEqual({ success: true, data: true });
      expect(events).toEqual(["session.ready"]);
      frame(stream!, "session.execution.started", { sessionID: session.id });
      frame(stream!, "session.execution.interrupted", { sessionID: session.id, reason: "user" });
      await capture.wait((event) => event.type === "turn.failed");
      expect(events).toEqual(["session.ready", "turn.started", "turn.failed"]);
      expect(await engine.stop()).toEqual({ success: true, data: undefined });
    } finally {
      await server.close();
    }
  });

  it("keeps text and reasoning ordinals separate, replaces ended snapshots and preserves step versus cumulative usage", async () => {
    const test = await sessionFixture();
    try {
      const turnID = await test.admit();
      const part = { assistantMessageID: "msg_first", ordinal: 0 };
      test.write("session.execution.started");
      test.write("session.step.started", stepStart("msg_first"), "step-start");
      test.write("session.step.started", stepStart("msg_first"), "step-start-again");
      test.write("session.text.started", part);
      test.write("session.text.started", part);
      test.write("session.reasoning.started", { ...part, state: { signature: "initial" } });
      test.write("session.text.delta", { ...part, delta: "draft " }, "text-delta");
      test.write("session.text.delta", { ...part, delta: "draft " }, "text-delta");
      test.write("session.reasoning.delta", { ...part, delta: "think" });
      test.write("session.text.ended", {
        ...part,
        text: "authoritative answer",
        state: { id: "text-state" },
      });
      test.write("session.reasoning.ended", {
        ...part,
        text: "full reasoning",
        state: { signature: "final" },
      });
      test.write("session.text.delta", { ...part, delta: "late" });
      test.write("session.text.ended", { ...part, text: "duplicate must not replace" });
      test.write("session.text.ended", { ...part, ordinal: 1, text: "second block" });
      test.write("session.step.streamed", { assistantMessageID: "msg_first" });
      test.write("session.step.streamed", { assistantMessageID: "msg_first" });
      await test.wait((event) => event.type === "step.streamed");
      expect(await test.engine.send("streamed is not settled")).toEqual({
        success: true,
        data: { turnID },
      });
      test.write("session.step.ended", {
        ...stepEnd("msg_first", "tool-calls"),
        rawFinish: "tool_use",
        providerState: { cursor: "next" },
        snapshot: "snp_1",
        files: ["src/file.ts"],
      });
      test.write("session.usage.updated", usage, "usage-snapshot");
      test.write("session.usage.updated", usage, "usage-snapshot");
      test.write("session.step.started", stepStart("msg_second"));
      test.write("session.text.ended", {
        assistantMessageID: "msg_second",
        ordinal: 0,
        text: "final",
      });
      test.write("session.step.ended", stepEnd("msg_second"));
      test.write("session.execution.succeeded");
      test.write("session.usage.updated", { ...usage, cost: 0.5 });
      await test.drain();

      const fragments = test.events.filter(
        (event) => event.type.startsWith("text.") || event.type.startsWith("reasoning."),
      );
      expect(fragments.map((event) => event.type)).toEqual([
        "text.started",
        "reasoning.started",
        "text.delta",
        "reasoning.delta",
        "text.completed",
        "reasoning.completed",
        "text.started",
        "text.completed",
        "text.started",
        "text.completed",
      ]);
      expect(fragments[0]).toMatchObject({ turnID, key: "ses_fixture:msg_first:text:0" });
      expect(fragments[1]).toMatchObject({
        turnID,
        key: "ses_fixture:msg_first:reasoning:0",
        state: { signature: "initial" },
      });
      expect(fragments[4]).toMatchObject({
        text: "authoritative answer",
        state: { id: "text-state" },
      });
      expect(fragments[5]).toMatchObject({ text: "full reasoning", state: { signature: "final" } });
      const steps = test.events.filter((event) => event.type.startsWith("step."));
      expect(steps.map((event) => event.type)).toEqual([
        "step.started",
        "step.streamed",
        "step.completed",
        "step.started",
        "step.completed",
      ]);
      expect(steps[0]).toMatchObject({
        step: { ...stepStart("msg_first"), sessionID: session.id },
      });
      expect(steps[2]).toMatchObject({
        step: {
          ...stepEnd("msg_first", "tool-calls"),
          rawFinish: "tool_use",
          providerState: { cursor: "next" },
          snapshot: "snp_1",
          files: ["src/file.ts"],
        },
      });
      expect(
        test.events.filter((event) => event.type === "usage.updated" && event.cost < 1000),
      ).toEqual([
        { type: "usage.updated", sessionID: session.id, scope: "session", ...usage },
        { type: "usage.updated", sessionID: session.id, scope: "session", ...usage, cost: 0.5 },
      ]);
      expect(test.events.filter((event) => event.type === "turn.completed")).toEqual([
        { type: "turn.completed", turnID },
      ]);
    } finally {
      await test.close();
    }
  });

  it("translates local and provider-hosted tools with authoritative input, partial failure content and self-contained result metadata", async () => {
    const test = await sessionFixture();
    try {
      const turnID = await test.admit();
      const writeTool = (
        type: string,
        data: Record<string, unknown> = {},
        assistantMessageID = "msg_local",
        id = "call_shared",
      ) => test.write(`session.tool.${type}`, { assistantMessageID, id, ...data });
      test.write("session.step.started", stepStart("msg_local"));
      writeTool("input.started", { name: "bash" });
      writeTool("input.delta", { delta: '{"command":"draft' });
      writeTool("input.ended", { text: '{"command":"pwd"}' });
      writeTool("input.ended", { text: "duplicate" });
      writeTool("called", { input: { command: "pwd" }, executed: false, state: { call: "state" } });
      writeTool("called", { input: { command: "duplicate" }, executed: false });
      writeTool("progress", { metadata: { output: "in progress", stale: true } });
      const result = [
        { type: "text", text: "/workspace" },
        { type: "file", uri: "file:///workspace/log", mime: "text/plain", name: "log" },
      ];
      writeTool("success", { content: result, executed: false, resultState: { result: "state" } });
      writeTool("success", { content: [{ type: "text", text: "duplicate" }], executed: false });
      writeTool("progress", { metadata: { output: "too late" } });
      test.write("session.step.ended", stepEnd("msg_local", "tool-calls"));

      test.write("session.step.started", stepStart("msg_hosted"));
      writeTool("input.started", { name: "search" }, "msg_hosted");
      writeTool("called", { input: { query: "fixture" }, executed: true }, "msg_hosted");
      const error = { type: "tool.error", message: "Search timed out", status: 504 };
      const partial = [{ type: "text", text: "partial search output" }];
      writeTool(
        "failed",
        {
          error,
          content: partial,
          metadata: { partial: true },
          resultState: { token: "result" },
          executed: true,
        },
        "msg_hosted",
      );
      writeTool("failed", { error, executed: true }, "msg_hosted");
      // Errors can settle an input that was never called; orphan calls cannot
      // identify a tool name and must not steal another step's call id.
      writeTool("input.started", { name: "uncalled" }, "msg_hosted", "call_uncalled");
      writeTool(
        "failed",
        { error: { type: "tool.input", message: "Invalid input" }, executed: false },
        "msg_hosted",
        "call_uncalled",
      );
      writeTool("called", { input: {}, executed: true }, "msg_hosted", "call_orphan");
      writeTool(
        "success",
        { content: [{ type: "text", text: "orphan" }], executed: true },
        "msg_hosted",
        "call_orphan",
      );
      test.write("session.step.ended", stepEnd("msg_hosted"));
      test.write("session.execution.succeeded");
      await test.drain();

      const tools = test.events.filter((event) => event.type.startsWith("tool."));
      expect(tools.map((event) => event.type)).toEqual([
        "tool.started",
        "tool.input.delta",
        "tool.input.completed",
        "tool.called",
        "tool.progress",
        "tool.completed",
        "tool.started",
        "tool.input.completed",
        "tool.called",
        "tool.failed",
        "tool.started",
        "tool.input.completed",
        "tool.failed",
      ]);
      expect(tools[3]).toMatchObject({
        turnID,
        key: "ses_fixture:msg_local:tool:call_shared",
        tool: {
          name: "bash",
          inputText: '{"command":"pwd"}',
          input: { command: "pwd" },
          executed: false,
          state: { call: "state" },
        },
      });
      expect(tools[5]).toMatchObject({
        tool: { content: result, resultState: { result: "state" } },
      });
      if (tools[5]?.type !== "tool.completed") throw new Error("missing tool result");
      expect(tools[5].tool).not.toHaveProperty("metadata");
      expect(tools[9]).toMatchObject({
        key: "ses_fixture:msg_hosted:tool:call_shared",
        tool: {
          name: "search",
          executed: true,
          error,
          content: partial,
          metadata: { partial: true },
          resultState: { token: "result" },
        },
      });
      expect(tools[12]).toMatchObject({
        tool: {
          name: "uncalled",
          executed: false,
          error: { type: "tool.input", message: "Invalid input" },
        },
      });
    } finally {
      await test.close();
    }
  });

  it("settles a failed step's open fragments without failing a retrying turn", async () => {
    const test = await sessionFixture();
    try {
      const turnID = await test.admit();
      const error = { type: "provider.rate-limit", message: "Retry this attempt", status: 429 };
      test.write("session.step.started", stepStart("msg_attempt"));
      test.write("session.reasoning.delta", {
        assistantMessageID: "msg_attempt",
        ordinal: 0,
        delta: "partial reasoning",
      });
      test.write("session.step.failed", { assistantMessageID: "msg_attempt", error, ...usage });
      test.write("session.step.failed", { assistantMessageID: "msg_attempt", error });
      test.write("session.retry.scheduled", {
        assistantMessageID: "msg_attempt",
        attempt: 1,
        at: 100,
        error,
      });
      await test.wait((event) => event.type === "step.failed");
      expect(
        test.events.some(
          (event) => event.type === "turn.failed" || event.type === "turn.completed",
        ),
      ).toBe(false);
      expect(await test.engine.send("retry still active")).toEqual({
        success: true,
        data: { turnID },
      });
      test.write("session.reasoning.delta", {
        assistantMessageID: "msg_attempt",
        ordinal: 0,
        delta: "late",
      });
      test.write("session.step.started", stepStart("msg_retry"));
      test.write("session.text.ended", {
        assistantMessageID: "msg_retry",
        ordinal: 0,
        text: "recovered",
      });
      test.write("session.step.ended", stepEnd("msg_retry"));
      test.write("session.execution.succeeded");
      await test.drain();
      expect(test.events.filter((event) => event.type === "reasoning.completed")).toEqual([
        {
          type: "reasoning.completed",
          turnID,
          sessionID: session.id,
          key: "ses_fixture:msg_attempt:reasoning:0",
          assistantMessageID: "msg_attempt",
          ordinal: 0,
          text: "partial reasoning",
        },
      ]);
      expect(test.events.filter((event) => event.type === "step.failed")).toEqual([
        {
          type: "step.failed",
          turnID,
          sessionID: session.id,
          step: { sessionID: session.id, assistantMessageID: "msg_attempt", error, ...usage },
        },
      ]);
      expect(test.events.filter((event) => event.type === "turn.completed")).toEqual([
        { type: "turn.completed", turnID },
      ]);
    } finally {
      await test.close();
    }
  });

  it.each([
    {
      type: "failed",
      data: {
        error: { type: "provider.error", message: "Provider rejected the request", status: 400 },
      },
    },
    ...["user", "shutdown", "superseded", "inactivity"].map((reason) => ({
      type: "interrupted",
      data: { reason },
    })),
  ])(
    "preserves execution $type details and settles open items exactly once ($data)",
    async ({ type, data }) => {
      const test = await sessionFixture();
      try {
        const turnID = await test.admit();
        test.write("session.execution.started");
        test.write("session.step.started", stepStart("msg_unfinished"));
        test.write("session.text.delta", {
          assistantMessageID: "msg_unfinished",
          ordinal: 0,
          delta: "partial",
        });
        test.write("session.tool.input.started", {
          assistantMessageID: "msg_unfinished",
          id: "call_pending",
          name: "bash",
        });
        test.write("session.tool.called", {
          assistantMessageID: "msg_unfinished",
          id: "call_pending",
          input: { command: "wait" },
          executed: false,
        });
        test.write(`session.execution.${type}`, data, "terminal");
        test.write(`session.execution.${type}`, data, "terminal");
        test.write(`session.execution.${type}`, data, "terminal-again");
        test.write("session.tool.success", {
          assistantMessageID: "msg_unfinished",
          id: "call_pending",
          content: [{ type: "text", text: "late success" }],
          executed: false,
        });
        await test.drain();
        const expectedError =
          "error" in data
            ? data.error
            : { type: "execution.interrupted", message: `Execution interrupted: ${data.reason}.` };
        expect(test.events.filter((event) => event.type === "turn.failed")).toEqual([
          {
            type: "turn.failed",
            turnID,
            reason: type,
            ...("error" in data ? { error: data.error } : { interruptionReason: data.reason }),
          },
        ]);
        expect(test.events.filter((event) => event.type === "text.completed")).toHaveLength(1);
        expect(test.events.filter((event) => event.type === "tool.failed")).toMatchObject([
          { tool: { error: expectedError } },
        ]);
        expect(test.events.filter((event) => event.type === "step.failed")).toMatchObject([
          { step: { error: expectedError } },
        ]);
        expect(
          test.events.some(
            (event) => event.type === "tool.completed" || event.type === "turn.completed",
          ),
        ).toBe(false);
        const nextID = await test.admit();
        test.write("session.execution.failed", {
          error: { type: "old", message: "No started boundary" },
        });
        test.write("session.text.delta", {
          assistantMessageID: "msg_unfinished",
          ordinal: 1,
          delta: "previous turn",
        });
        test.write(`session.execution.${type}`, data, "terminal");
        test.write("session.execution.started");
        test.write("session.step.started", stepStart("msg_next"));
        test.write("session.step.ended", stepEnd("msg_next"));
        test.write("session.execution.succeeded");
        await test.drain();
        expect(test.events.filter((event) => event.type === "turn.started")).toEqual([
          { type: "turn.started", turnID },
          { type: "turn.started", turnID: nextID },
        ]);
        expect(test.events.filter((event) => event.type === "turn.completed")).toEqual([
          { type: "turn.completed", turnID: nextID },
        ]);
      } finally {
        await test.close();
      }
    },
  );

  it("attributes concurrent child work to subagent tools without ending the parent, including background failure during a later turn", async () => {
    const test = await sessionFixture();
    try {
      const turnID = await test.admit();
      test.write("session.step.started", stepStart("msg_parent"));
      const attach = (id: string, sessionID: string, background: boolean) => {
        const ref = { assistantMessageID: "msg_parent", id };
        test.write("session.tool.input.started", { ...ref, name: "subagent" });
        test.write("session.tool.called", {
          ...ref,
          input: { agent: "explore", background },
          executed: false,
        });
        test.write("session.tool.progress", { ...ref, metadata: { sessionID, status: "running" } });
      };
      // Creation cannot identify which of the concurrent calls owns a child.
      test.write("session.created", { sessionID: "ses_unrelated", parentID: session.id });
      test.write("session.execution.started", { sessionID: "ses_unrelated" });
      attach("call_foreground", "ses_foreground", false);
      attach("call_background", "ses_background", true);
      for (const sessionID of ["ses_foreground", "ses_background"]) {
        test.write("session.execution.started", { sessionID });
        test.write("session.step.started", { ...stepStart("msg_child"), sessionID });
        test.write("session.text.delta", {
          sessionID,
          assistantMessageID: "msg_child",
          ordinal: 0,
          delta: sessionID,
        });
      }
      test.write("session.text.ended", {
        sessionID: "ses_foreground",
        assistantMessageID: "msg_child",
        ordinal: 0,
        text: "foreground answer",
      });
      test.write("session.step.ended", { ...stepEnd("msg_child"), sessionID: "ses_foreground" });
      test.write("session.execution.succeeded", { sessionID: "ses_foreground" });
      test.write("session.tool.success", {
        assistantMessageID: "msg_parent",
        id: "call_foreground",
        content: [{ type: "text", text: "foreground answer" }],
        metadata: { sessionID: "ses_foreground", status: "completed" },
        executed: false,
      });
      test.write("session.tool.success", {
        assistantMessageID: "msg_parent",
        id: "call_background",
        content: [{ type: "text", text: "running in background" }],
        metadata: { sessionID: "ses_background", status: "running" },
        executed: false,
      });
      await test.wait(
        (event) => event.type === "tool.completed" && event.tool.id === "call_background",
      );
      expect(test.events.filter((event) => event.type === "child.completed")).toHaveLength(1);
      expect(test.events.some((event) => event.type === "turn.completed")).toBe(false);
      test.write("session.usage.updated", { ...usage, sessionID: "ses_background" });
      test.write("session.step.ended", stepEnd("msg_parent"));
      test.write("session.execution.succeeded");
      await test.wait((event) => event.type === "turn.completed");
      const nextID = await test.admit();
      const error = { type: "provider.error", message: "Background child failed", status: 500 };
      test.write("session.step.failed", {
        sessionID: "ses_background",
        assistantMessageID: "msg_child",
        error,
      });
      test.write("session.execution.failed", { sessionID: "ses_background", error });
      test.write("session.execution.failed", { sessionID: "ses_background", error });
      test.write("session.synthetic", {
        text: "duplicate completion notification",
        metadata: { source: "subagent", childID: "ses_background", state: "error" },
      });
      test.write("session.execution.succeeded", { sessionID: "ses_unrelated" });
      await test.drain();

      const foregroundScope = {
        sessionID: "ses_foreground",
        turnID,
        parentSessionID: session.id,
        parentToolKey: "ses_fixture:msg_parent:tool:call_foreground",
      };
      const backgroundScope = {
        sessionID: "ses_background",
        turnID,
        parentSessionID: session.id,
        parentToolKey: "ses_fixture:msg_parent:tool:call_background",
      };
      expect(test.events.filter((event) => event.type.startsWith("child."))).toMatchObject([
        { type: "child.attached", ...foregroundScope },
        { type: "child.attached", ...backgroundScope },
        { type: "child.started", ...foregroundScope },
        { type: "child.started", ...backgroundScope },
        { type: "child.completed", ...foregroundScope },
        { type: "child.failed", ...backgroundScope, error },
      ]);
      expect(test.events.filter((event) => event.type === "text.delta")).toMatchObject([
        { ...foregroundScope, key: "ses_foreground:msg_child:text:0", delta: "ses_foreground" },
        { ...backgroundScope, key: "ses_background:msg_child:text:0", delta: "ses_background" },
      ]);
      expect(
        test.events.filter((event) => event.type === "usage.updated" && event.cost < 1000),
      ).toEqual([
        { type: "usage.updated", sessionID: "ses_background", scope: "session", ...usage },
      ]);
      expect(test.events.filter((event) => event.type === "turn.failed")).toEqual([]);
      expect(await test.engine.send("next turn is still pending")).toEqual({
        success: true,
        data: { turnID: nextID },
      });
      test.write("session.execution.started");
      test.write("session.execution.succeeded");
      await test.wait((event) => event.type === "turn.completed" && event.turnID === nextID);
    } finally {
      await test.close();
    }
  });

  it("uses real session.created parentID for nested ancestry and rejects tool metadata contradicting a foreign parent", async () => {
    const test = await sessionFixture();
    try {
      const turnID = await test.admit();
      test.write("session.execution.started");
      const created = (sessionID: string, parentID: string, title: string) =>
        test.write("session.created", {
          sessionID,
          parentID,
          title,
          projectID: "proj_fixture",
          slug: sessionID,
          location: { directory },
          version: "2.0.18",
          agent: "explore",
          model: { id: "gpt", providerID: "openai" },
        });
      created("ses_foreign", "ses_other", "Foreign");
      created("ses_child", session.id, "Child");
      created("ses_nested", "ses_child", "Nested");
      test.write("session.execution.started", { sessionID: "ses_child" });
      test.write("session.execution.started", { sessionID: "ses_nested" });
      test.write("session.step.started", stepStart("msg_parent"));
      test.write("session.tool.input.started", {
        assistantMessageID: "msg_parent",
        id: "call_foreign",
        name: "subagent",
      });
      test.write("session.tool.called", {
        assistantMessageID: "msg_parent",
        id: "call_foreign",
        input: { agent: "explore" },
        executed: false,
      });
      test.write("session.tool.progress", {
        assistantMessageID: "msg_parent",
        id: "call_foreign",
        metadata: { sessionID: "ses_foreign", status: "running" },
      });
      test.write("session.tool.input.started", {
        assistantMessageID: "msg_parent",
        id: "call_child",
        name: "subagent",
      });
      test.write("session.tool.called", {
        assistantMessageID: "msg_parent",
        id: "call_child",
        input: { agent: "explore", background: true },
        executed: false,
      });
      test.write("session.tool.progress", {
        assistantMessageID: "msg_parent",
        id: "call_child",
        metadata: { sessionID: "ses_child", status: "running" },
      });
      test.write("session.step.ended", stepEnd("msg_parent"));
      test.write("session.execution.succeeded");
      test.write("session.synthetic", {
        sessionID: "ses_child",
        text: "Nested finished",
        metadata: { source: "subagent", childID: "ses_nested", state: "completed" },
      });
      test.write("session.synthetic", {
        text: "Child failed",
        metadata: { source: "subagent", childID: "ses_child", state: "error" },
      });
      await test.drain();
      expect(test.events.filter((event) => event.type.startsWith("child."))).toMatchObject([
        {
          type: "child.attached",
          sessionID: "ses_child",
          parentSessionID: session.id,
          turnID,
          info: { title: "Child", agent: "explore", model: { providerID: "openai", id: "gpt" } },
        },
        {
          type: "child.attached",
          sessionID: "ses_nested",
          parentSessionID: "ses_child",
          turnID,
          info: { title: "Nested" },
        },
        { type: "child.started", sessionID: "ses_child", turnID },
        { type: "child.started", sessionID: "ses_nested", turnID },
        { type: "child.completed", sessionID: "ses_nested", summary: "Nested finished", turnID },
        {
          type: "child.failed",
          sessionID: "ses_child",
          error: { message: "Child failed" },
          turnID,
        },
      ]);
      expect(
        test.events.some((event) => "sessionID" in event && event.sessionID === "ses_foreign"),
      ).toBe(false);
    } finally {
      await test.close();
    }
  });

  it("settles a confirmed child terminal even when no execution.started frame arrived", async () => {
    const test = await sessionFixture();
    try {
      const turnID = await test.admit();
      test.write("session.execution.started");
      test.write("session.created", {
        sessionID: "ses_fast",
        parentID: session.id,
        projectID: "proj_fixture",
        slug: "fast",
        location: { directory },
        version: "2.0.18",
      });
      test.write("session.execution.failed", {
        sessionID: "ses_fast",
        error: { type: "provider.error", message: "Fast failure" },
      });
      await test.drain();
      expect(test.events.filter((event) => event.type.startsWith("child."))).toMatchObject([
        { type: "child.attached", sessionID: "ses_fast", parentSessionID: session.id, turnID },
        { type: "child.failed", sessionID: "ses_fast", error: { message: "Fast failure" }, turnID },
      ]);
    } finally {
      await test.close();
    }
  });

  it.each([
    { state: "completed", expectedType: "child.completed" },
    { state: "error", expectedType: "child.failed" },
    { state: "cancelled", expectedType: "child.interrupted" },
  ])(
    "uses structured background $state notifications after parent settlement, without parsing synthetic text",
    async ({ state, expectedType }) => {
      const test = await sessionFixture();
      try {
        const turnID = await test.admit();
        const ref = { assistantMessageID: "msg_parent", id: "call_background" };
        test.write("session.step.started", stepStart("msg_parent"));
        test.write("session.tool.input.started", { ...ref, name: "subagent" });
        test.write("session.tool.called", {
          ...ref,
          input: { agent: "explore", background: true },
          executed: false,
        });
        test.write("session.tool.progress", {
          ...ref,
          metadata: { sessionID: "ses_background", status: "running" },
        });
        test.write("session.execution.started", { sessionID: "ses_background" });
        test.write("session.tool.success", {
          ...ref,
          content: [{ type: "text", text: "background started" }],
          metadata: { sessionID: "ses_background", status: "running" },
          executed: false,
        });
        test.write("session.step.ended", stepEnd("msg_parent"));
        test.write("session.execution.succeeded");
        const text =
          '<subagent sessionID="ses_background" state="completed">not sufficient by itself</subagent>';
        test.write("session.synthetic", { text });
        test.write("session.synthetic", {
          text,
          metadata: { source: "subagent", childID: "ses_unknown", state },
        });
        test.write("session.synthetic", {
          sessionID: "ses_background",
          text,
          metadata: { source: "subagent", childID: "ses_background", state },
        });
        test.write(
          "session.synthetic",
          {
            text: "structured result",
            metadata: { source: "subagent", childID: "ses_background", agent: "explore", state },
          },
          "notification",
        );
        test.write(
          "session.synthetic",
          {
            text: "structured result",
            metadata: { source: "subagent", childID: "ses_background", agent: "explore", state },
          },
          "notification",
        );
        test.write("session.synthetic", {
          text: "second terminal",
          metadata: { source: "subagent", childID: "ses_background", state },
        });
        await test.drain();
        const scope = {
          sessionID: "ses_background",
          turnID,
          parentSessionID: session.id,
          parentToolKey: "ses_fixture:msg_parent:tool:call_background",
        };
        expect(test.events.filter((event) => event.type.startsWith("child."))).toMatchObject([
          { type: "child.attached", ...scope },
          { type: "child.started", ...scope },
          {
            type: expectedType,
            ...scope,
            ...(state === "completed" ? { summary: "structured result" } : {}),
            ...(state === "error"
              ? { error: { type: "subagent.failed", message: "structured result" } }
              : {}),
            ...(state === "cancelled" ? { reason: "cancelled" } : {}),
          },
        ]);
        expect(test.events.filter((event) => event.type === "turn.completed")).toEqual([
          { type: "turn.completed", turnID },
        ]);
        expect(test.events.some((event) => event.type === "turn.failed")).toBe(false);
      } finally {
        await test.close();
      }
    },
  );

  it("ignores malformed and unrelated payloads without consuming a valid event's identity or changing admission", async () => {
    const test = await sessionFixture();
    try {
      const turnID = await test.admit();
      test.write("session.execution.succeeded"); // no execution start for this admission
      test.write("session.execution.failed", {
        error: { name: "legacy error", data: { message: "wrong protocol" } },
      });
      test.write("session.execution.interrupted", { reason: "unknown" });
      test.write(
        "session.step.started",
        { ...stepStart("msg_valid"), model: "wrong shape" },
        "step-valid",
      );
      test.write(
        "session.step.started",
        { ...stepStart("msg_valid"), sessionID: "ses_other" },
        "step-valid",
      );
      test.write("session.step.started", stepStart("msg_valid"), "step-valid");
      for (const ordinal of [-1, 0.5, "0"]) {
        test.write("session.text.delta", {
          assistantMessageID: "msg_valid",
          ordinal,
          delta: "invalid",
        });
      }
      test.write(
        "session.text.delta",
        { assistantMessageID: "msg_valid", ordinal: 0, delta: 42 },
        "delta-valid",
      );
      test.write(
        "session.text.delta",
        { assistantMessageID: "msg_valid", ordinal: 0, delta: "valid" },
        "delta-valid",
      );
      test.write("session.text.ended", {
        assistantMessageID: "msg_valid",
        ordinal: 0,
        text: "invalid state",
        state: [],
      });
      test.write("session.usage.updated", { cost: "0.25", tokens: usage.tokens });
      test.write("session.usage.updated", { cost: 0.25, tokens: { input: 1 } });
      test.write("session.child.started", { childID: "ses_fake" }); // not in v2.0.18
      test.write("session.tool.input.started", {
        assistantMessageID: "msg_valid",
        id: "call_valid",
        name: "bash",
      });
      test.write("session.tool.called", {
        assistantMessageID: "msg_valid",
        id: "call_valid",
        input: [],
        executed: false,
      });
      test.write("session.tool.called", {
        assistantMessageID: "msg_valid",
        id: "call_valid",
        input: {},
        executed: false,
      });
      test.write("session.tool.success", {
        assistantMessageID: "msg_valid",
        id: "call_valid",
        content: [],
        executed: false,
      });
      test.write("session.tool.success", {
        assistantMessageID: "msg_valid",
        id: "call_valid",
        content: [{ type: "text", text: "valid" }],
      });
      test.write("session.tool.failed", {
        assistantMessageID: "msg_valid",
        id: "call_valid",
        executed: false,
        error: { type: "tool.error", message: "bad status", status: 999 },
      });
      await test.drain();
      expect(await test.engine.send("malformed terminals did not free admission")).toEqual({
        success: true,
        data: { turnID },
      });
      expect(test.events.filter((event) => event.type === "text.delta")).toHaveLength(1);
      expect(
        test.events.some(
          (event) =>
            event.type === "tool.completed" ||
            event.type === "tool.failed" ||
            event.type === "turn.failed" ||
            event.type === "turn.completed",
        ),
      ).toBe(false);
      test.write("session.text.ended", {
        assistantMessageID: "msg_valid",
        ordinal: 0,
        text: "valid final",
      });
      test.write("session.tool.success", {
        assistantMessageID: "msg_valid",
        id: "call_valid",
        content: [{ type: "text", text: "valid" }],
        executed: false,
      });
      test.write("session.step.ended", stepEnd("msg_valid"));
      test.write("session.execution.succeeded");
      await test.wait((event) => event.type === "turn.completed");
      expect(test.events.filter((event) => event.type === "turn.started")).toEqual([
        { type: "turn.started", turnID },
      ]);
      expect(test.events.filter((event) => event.type === "text.completed")).toMatchObject([
        { text: "valid final" },
      ]);
      expect(test.events.filter((event) => event.type === "tool.completed")).toHaveLength(1);
    } finally {
      await test.close();
    }
  });
});
