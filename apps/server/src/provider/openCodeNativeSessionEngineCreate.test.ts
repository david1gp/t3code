// @effect-diagnostics nodeBuiltinImport:off cryptoRandomUUID:off globalDate:off - isolated HTTP/SSE protocol fixture.
// @effect-diagnostics globalFetch:off - this test wraps native fetch to simulate aborts.
import * as NodeHttp from "node:http";
import * as NodeNet from "node:net";

import { describe, expect, it, vi } from "vite-plus/test";
import { isFormInvalidAnswerError, type FormInvalidAnswerError } from "@opencode/client";
import { Form, Permission, Skill as NativeSkill } from "@opencode/client/effect";
import * as Schema from "effect/Schema";

import { openCodeNativeSessionEngineCreate } from "./openCodeNativeSessionEngineCreate.ts";
import type { OpenCodeNativeInventory } from "./openCodeNativeInventorySchema.ts";
import { openCodeNativeInventorySchema } from "./openCodeNativeInventorySchema.ts";

const directory = "/tmp/native workspace";
const session = { id: "ses_fixture", location: { directory } };
const modelInventoryDecode = Schema.decodeSync(openCodeNativeInventorySchema.model);

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
      : {
          durable: {
            aggregateID: data.sessionID ?? "ses_fixture",
            seq,
            version: [
              "session.tool.success",
              "session.tool.failed",
              "session.deleted",
              "session.forked",
              "session.instructions.updated",
            ].includes(type)
              ? 2
              : 1,
          },
        }),
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
const resolutionSkills: ReadonlyArray<typeof NativeSkill.Info.Encoded> = [
  { id: "opaque_prefix_27", name: "skill", path: "/native/prefix/SKILL.md", content: "Prefix" },
  { id: "opaque_colon_93", name: "skill:review", path: "/native/colon/SKILL.md", content: "Colon" },
  { id: "opaque_close_14", name: "skill)", path: "/native/close/SKILL.md", content: "Close" },
  { id: "opaque_bracket_35", name: "skill]", path: "/native/bracket/SKILL.md", content: "Bracket" },
  { id: "opaque_brace_61", name: "skill}", path: "/native/brace/SKILL.md", content: "Brace" },
  {
    id: "opaque_terminal_colon_08",
    name: "skill:",
    path: "/native/colon-end/SKILL.md",
    content: "Terminal colon",
  },
  { id: "opaque_review_45", name: "review", path: "/native/review/SKILL.md", content: "Review" },
];
const sessionFixture = async (
  fetchImpl: typeof fetch = fetch,
  cachedInventory?: OpenCodeNativeInventory,
  resume = false,
  offeredSkills?: ReadonlyArray<typeof NativeSkill.Info.Encoded>,
) => {
  const capture = captureCreate();
  let stream: NodeHttp.ServerResponse | undefined;
  let logReads = 0;
  const logRequests: Array<{ after: number | null; follow: string | null }> = [];
  const loggedEvents: ReturnType<typeof frame>[] = [];
  let retainLog = true;
  let logWatermark: number | undefined = 100;
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
  let heldPrompt: (() => void) | undefined;
  let promptRequested: (() => void) | undefined;
  const inventoryRequests: string[] = [];
  const inventoryLookups: string[] = [];
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
    if (req.url === "/api/session/ses_fixture") {
      send(res, { data: session });
      return;
    }
    if (req.url === "/api/session/active") {
      send(res, { data: {} });
      return;
    }
    if (req.url === "/api/session/ses_fixture/inbox") {
      send(res, { data: [] });
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
          url.pathname === "/api/command"
            ? workspaceInventory.command
            : (offeredSkills ??
              workspaceInventory.skill.map((skill) => ({ ...skill, content: "Fixture skill" }))),
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
      logRequests.push({
        after: url.searchParams.has("after") ? after : null,
        follow: url.searchParams.get("follow"),
      });
      if (after < 0 && url.searchParams.has("after")) {
        res.writeHead(400).end();
        return;
      }
      const respond = () => {
        const parentEvents = loggedEvents.filter(
          (event) => event.durable?.aggregateID === session.id,
        );
        const seq = Math.max(
          logWatermark ?? -1,
          ...parentEvents.map((event) => event.durable!.seq),
        );
        const prefix = retainLog
          ? parentEvents.filter((event) => event.durable!.seq > after && event.durable!.seq <= seq)
          : [];
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end(
          [...prefix, { type: "log.synced", aggregateID: session.id, ...(seq >= 0 ? { seq } : {}) }]
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
        const respond = () =>
          send(res, { data: { id: body.id, sessionID: session.id, type: "user" } });
        if (promptRequested) {
          heldPrompt = respond;
          promptRequested();
          promptRequested = undefined;
          return;
        }
        if (prompts > 1) {
          const seq = Math.max(0, ...loggedEvents.map((event) => event.durable?.seq ?? 0)) + 1;
          const delivered = frame(
            stream!,
            "session.inbox.delivered",
            { sessionID: session.id, inboxID: body.id },
            undefined,
            seq,
          );
          loggedEvents.push(delivered);
        }
        respond();
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
    ...(cachedInventory
      ? {
          inventory: (cwd: string) => {
            inventoryLookups.push(cwd);
            return cachedInventory;
          },
        }
      : {}),
    onEvent: capture.receive,
  });
  expect(
    (await engine.start({ directory, ...(resume ? { resumeSessionId: session.id } : {}) })).success,
  ).toBe(true);
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
    setLogWatermark: (value: number | undefined) => {
      logWatermark = value;
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
    holdNextPrompt: () => {
      const requested = new Promise<void>((resolve) => {
        promptRequested = resolve;
      });
      return {
        requested,
        release: () => {
          if (!heldPrompt) throw new Error("No prompt request to release");
          heldPrompt();
          heldPrompt = undefined;
        },
      };
    },
    inventoryRequests,
    inventoryLookups,
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

it("translates official compaction attempt provenance and keeps internal usage records session-scoped across log/feed replay", async () => {
  const test = await sessionFixture(fetch, workspaceInventory);
  try {
    test.setLogWatermark(undefined);
    const turnID = await test.admit();
    test.write("session.execution.started", {}, "compaction-execution", 1);
    test.write(
      "session.compaction.started",
      { reason: "manual", recent: "recent", inputID: "msg_manual" },
      "compaction-start",
      2,
    );
    test.write(
      "session.compaction.failed",
      {
        reason: "manual",
        inputID: "msg_manual",
        error: { type: "api", message: "charged" },
        tokens: usage.tokens,
      },
      "compaction-failure",
      3,
    );
    test.write(
      "session.compaction.started",
      { reason: "auto", recent: "recent" },
      "compaction-auto-start",
      4,
    );
    test.write(
      "session.compaction.ended",
      { reason: "auto", text: "summary", recent: "recent", ...usage },
      "compaction-success",
      5,
    );
    await test.drain();
    // A command completion prefix discovers replay-only usage. Those records are
    // not new compaction attempts and have no turn/activation ownership.
    const command = test.holdNextCommand();
    const sending = test.engine.send("/review");
    await command.requested;
    test.writeLog(
      "session.usage.recorded",
      { source: "compaction", ...usage },
      "compaction-record",
      6,
    );
    test.writeLog("session.usage.recorded", { source: "title", ...usage }, "title-record", 7);
    command.release();
    expect((await sending).success).toBe(true);
    test.replayLogged();
    await test.drain();
    expect(test.events.filter((event) => event.type.startsWith("compaction."))).toMatchObject([
      {
        type: "compaction.started",
        turnID,
        key: "evt_compaction-start",
        eventID: "evt_compaction-start",
        inputID: "msg_manual",
        durable: { aggregateID: session.id, seq: 2, version: 1 },
      },
      {
        type: "compaction.failed",
        turnID,
        key: "evt_compaction-start",
        eventID: "evt_compaction-failure",
        inputID: "msg_manual",
        compaction: { tokens: usage.tokens, error: { message: "charged" } },
      },
      { type: "compaction.started", turnID, key: "evt_compaction-auto-start" },
      {
        type: "compaction.completed",
        turnID,
        key: "evt_compaction-auto-start",
        eventID: "evt_compaction-success",
        compaction: usage,
      },
    ]);
    expect(test.events.filter((event) => event.type === "usage.recorded")).toEqual([
      {
        type: "usage.recorded",
        eventID: "evt_compaction-record",
        durable: { aggregateID: session.id, seq: 6, version: 1 },
        scope: "session",
        usage: { sessionID: session.id, source: "compaction", ...usage },
      },
      {
        type: "usage.recorded",
        eventID: "evt_title-record",
        durable: { aggregateID: session.id, seq: 7, version: 1 },
        scope: "session",
        usage: { sessionID: session.id, source: "title", ...usage },
      },
    ]);
  } finally {
    await test.close();
  }
});

const stalledFetch = (stalledPath: string) => {
  const nativeFetch = globalThis.fetch;
  let stalled = false;
  let cancelled = false;
  let requests = 0;
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
    requests++;
    requestReceived();
    return await new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      if (!signal) return;
      const cancel = () => {
        cancelled = true;
        reject(signal.reason);
      };
      signal.addEventListener("abort", cancel, { once: true });
      if (signal.aborted) cancel();
    });
  }) as typeof globalThis.fetch;
  return {
    fetch: fetchImpl,
    requested,
    stall: () => (stalled = true),
    resume: () => (stalled = false),
    cancelled: () => cancelled,
    requests: () => requests,
  };
};

// A buffered response can finish decoding after cancellation. Deliberately allow that
// callback to complete so the engine's request-incarnation fencing is exercised.
const replyTransportCreate = () => {
  const held = new Map<string, (response: Response) => void>();
  const waiting = new Map<string, () => void>();
  const requests: string[] = [];
  const fetchImpl: typeof fetch = async (request, init) => {
    const path = new URL(request instanceof Request ? request.url : String(request)).pathname;
    if (path.endsWith("/reply") || (init?.method === "DELETE" && path.includes("/form/")))
      requests.push(path);
    const requested = waiting.get(path);
    if (!requested) return fetch(request, init);
    waiting.delete(path);
    return new Promise<Response>((resolve) => {
      held.set(path, resolve);
      requested();
    });
  };
  return {
    fetch: fetchImpl,
    requests,
    holdNext: (path: string) => {
      const requested = new Promise<void>((resolve) => waiting.set(path, resolve));
      return {
        requested,
        release: (status = 204, body?: unknown) => {
          const resolve = held.get(path);
          if (!resolve) throw new Error("No reply response to release");
          held.delete(path);
          resolve(
            new Response(body === undefined ? null : JSON.stringify(body), {
              status,
              headers: { "content-type": "application/json" },
            }),
          );
        },
      };
    },
  };
};
const replyFormFixture = Schema.decodeSync(Schema.toEncoded(Form.Info))({
  id: "frm_reply",
  sessionID: session.id,
  title: "Choose",
  fields: [{ key: "choice", type: "string", options: [{ label: "Yes", value: "yes" }] }],
});
const replyPermissionFixture = Schema.decodeSync(Schema.toEncoded(Permission.Request))({
  id: "per_reply",
  sessionID: session.id,
  action: "bash",
  resources: ["pwd"],
});
const invalidAnswer = {
  _tag: "FormInvalidAnswerError",
  id: replyFormFixture.id,
  message: "choice must be one of: yes",
} satisfies FormInvalidAnswerError;
const replyCases = [
  {
    kind: "permission reply",
    path: `/api/session/${session.id}/permission/${replyPermissionFixture.id}/reply`,
    operation: "permission.reply",
    reply: (engine: ReturnType<typeof openCodeNativeSessionEngineCreate>) =>
      engine.replyPermission(replyPermissionFixture.id, "once"),
  },
  {
    kind: "form reply",
    path: `/api/session/${session.id}/form/${replyFormFixture.id}/reply`,
    operation: "session.form.reply",
    reply: (engine: ReturnType<typeof openCodeNativeSessionEngineCreate>) =>
      engine.replyForm(replyFormFixture.id, { choice: "yes" }),
  },
  {
    kind: "form cancel",
    path: `/api/session/${session.id}/form/${replyFormFixture.id}`,
    operation: "session.form.reply",
    reply: (engine: ReturnType<typeof openCodeNativeSessionEngineCreate>) =>
      engine.replyForm(replyFormFixture.id, undefined),
  },
] as const;
const replyRequestsOpen = async (test: Awaited<ReturnType<typeof sessionFixture>>) => {
  await test.admit();
  test.setPending([replyPermissionFixture], [replyFormFixture]);
  test.write("permission.asked", replyPermissionFixture);
  test.write("form.created", { form: replyFormFixture });
  await test.wait((event) => event.type === "form.created");
};

describe("native permission/form reply settlement", () => {
  it.each(replyCases)(
    "settles $kind once when the native terminal precedes HTTP success",
    async (replyCase) => {
      const transport = replyTransportCreate();
      const test = await sessionFixture(transport.fetch);
      try {
        await replyRequestsOpen(test);
        const response = transport.holdNext(replyCase.path);
        const replying = replyCase.reply(test.engine);
        await response.requested;
        expect((await replyCase.reply(test.engine)).success).toBe(false);
        if (replyCase.kind === "permission reply")
          test.write("permission.replied", { requestID: replyPermissionFixture.id, reply: "once" });
        else
          test.write(replyCase.kind === "form reply" ? "form.replied" : "form.cancelled", {
            id: replyFormFixture.id,
            ...(replyCase.kind === "form reply" ? { answer: { choice: "yes" } } : {}),
          });
        await test.drain();
        response.release();
        expect(await replying).toEqual({ success: true, data: undefined });
        expect((await replyCase.reply(test.engine)).success).toBe(false);
        expect(transport.requests).toHaveLength(1);
        expect(
          test.events.filter(
            (event) => event.type === "permission.replied" || event.type === "form.resolved",
          ),
        ).toHaveLength(1);
      } finally {
        await test.close();
      }
    },
  );

  it.each(["correct", "cancel"] as const)(
    "unlocks the still-current form after pinned FormInvalidAnswerError to %s",
    async (action) => {
      const transport = replyTransportCreate();
      const test = await sessionFixture(transport.fetch);
      try {
        await replyRequestsOpen(test);
        expect(isFormInvalidAnswerError(invalidAnswer)).toBe(true);
        const response = transport.holdNext(replyCases[1].path);
        const replying = test.engine.replyForm(replyFormFixture.id, { choice: "invalid" });
        await response.requested;
        expect((await test.engine.replyForm(replyFormFixture.id, undefined)).success).toBe(false);
        response.release(400, invalidAnswer);
        expect(await replying).toMatchObject({
          success: false,
          rejected: true,
          error: { operation: "session.form.reply", detail: invalidAnswer.message },
        });
        expect(test.events.filter((event) => event.type === "form.resolved")).toEqual([]);
        expect(
          await test.engine.replyForm(
            replyFormFixture.id,
            action === "correct" ? { choice: "yes" } : undefined,
          ),
        ).toEqual({ success: true, data: undefined });
        test.write(action === "correct" ? "form.replied" : "form.cancelled", {
          id: replyFormFixture.id,
          ...(action === "correct" ? { answer: { choice: "yes" } } : {}),
        });
        await test.drain();
        expect(test.events.filter((event) => event.type === "form.resolved")).toMatchObject([
          { formID: replyFormFixture.id, answer: action === "correct" ? { choice: "yes" } : {} },
        ]);
        expect(transport.requests).toHaveLength(2);
      } finally {
        await test.close();
      }
    },
  );

  it.each([
    { status: 503, body: undefined, reason: "ambiguous transport" },
    { status: 400, body: { ...invalidAnswer, id: "frm_foreign" }, reason: "foreign rejection" },
  ])(
    "keeps a form locked after $reason without unsafe duplicate mutation",
    async ({ status, body }) => {
      const transport = replyTransportCreate();
      const test = await sessionFixture(transport.fetch);
      try {
        await replyRequestsOpen(test);
        const response = transport.holdNext(replyCases[1].path);
        const replying = replyCases[1].reply(test.engine);
        await response.requested;
        response.release(status, body);
        const result = await replying;
        expect(result.success).toBe(false);
        expect(result).not.toHaveProperty("rejected");
        expect((await replyCases[1].reply(test.engine)).success).toBe(false);
        expect((await replyCases[2].reply(test.engine)).success).toBe(false);
        expect(transport.requests).toHaveLength(1);
        expect(test.events.filter((event) => event.type === "form.resolved")).toEqual([]);
      } finally {
        await test.close();
      }
    },
  );

  it.each(["rejection", "success"] as const)(
    "fences a stale form %s callback from a replaced still-replying form",
    async (outcome) => {
      const transport = replyTransportCreate();
      const test = await sessionFixture(transport.fetch);
      try {
        await replyRequestsOpen(test);
        const response = transport.holdNext(replyCases[1].path);
        const outgoing = replyCases[1].reply(test.engine);
        await response.requested;
        // Keep the buffered response callback, but replace the engine's request incarnation.
        await test.engine.stop({ interrupt: false });
        expect((await test.engine.start({ directory })).success).toBe(true);
        await test.admit();
        test.write("form.created", { form: replyFormFixture });
        await test.drain();
        const replacement = transport.holdNext(replyCases[1].path);
        // Release the old response and start the new reply in the same stack. The new
        // request is already replying before the old response can finish decoding.
        response.release(
          outcome === "rejection" ? 400 : 204,
          outcome === "rejection" ? invalidAnswer : undefined,
        );
        const current = replyCases[1].reply(test.engine);
        await replacement.requested;
        expect((await outgoing).success).toBe(false);
        expect((await replyCases[1].reply(test.engine)).success).toBe(false);
        expect(test.events.filter((event) => event.type === "form.resolved")).toEqual([]);
        replacement.release();
        expect(await current).toEqual({ success: true, data: undefined });
        expect(transport.requests).toHaveLength(2);
        expect(test.events.filter((event) => event.type === "form.resolved")).toHaveLength(1);
      } finally {
        await test.close();
      }
    },
  );

  for (const action of ["deadline", "local stop", "stream loss", "explicit stop"] as const) {
    it.each(replyCases)(
      "bounds $kind on " + action + " and never duplicates an uncertain mutation",
      async (replyCase) => {
        const stalled = stalledFetch(replyCase.path);
        const interrupt = stalledFetch(`/api/session/${session.id}/interrupt`);
        const test = await sessionFixture((request, init) => {
          const path = new URL(request instanceof Request ? request.url : String(request)).pathname;
          return path.endsWith("/interrupt")
            ? interrupt.fetch(request, init)
            : stalled.fetch(request, init);
        });
        try {
          await replyRequestsOpen(test);
          stalled.stall();
          if (action === "deadline" || action === "explicit stop") vi.useFakeTimers();
          const replying = replyCase.reply(test.engine);
          await stalled.requested;
          let stopping: ReturnType<typeof test.engine.stop> | undefined;
          if (action === "deadline") {
            await vi.advanceTimersByTimeAsync(15_000);
          } else if (action === "local stop") stopping = test.engine.stop({ interrupt: false });
          else if (action === "stream loss") {
            test.disconnect();
            await test.wait((event) => event.type === "stream.lost");
          } else {
            interrupt.stall();
            stopping = test.engine.stop();
            await interrupt.requested;
          }
          expect(await replying).toMatchObject({
            success: false,
            error: { operation: replyCase.operation },
          });
          expect(stalled.cancelled()).toBe(true);
          expect((await replyCase.reply(test.engine)).success).toBe(false);
          expect(stalled.requests()).toBe(1);
          expect(
            test.events.filter(
              (event) => event.type === "form.resolved" || event.type === "permission.replied",
            ),
          ).toEqual([]);
          if (action === "explicit stop") {
            expect(interrupt.cancelled()).toBe(false);
            await vi.advanceTimersByTimeAsync(15_000);
            expect(await stopping).toMatchObject({
              success: false,
              error: { operation: "session.interrupt" },
            });
            expect(interrupt.cancelled()).toBe(true);
          } else if (stopping) expect(await stopping).toEqual({ success: true, data: undefined });
        } finally {
          vi.useRealTimers();
          interrupt.resume();
          await test.close();
        }
      },
    );
  }
});

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
  let promptResponseReceived!: () => void;
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
    if (path.endsWith("/prompt")) promptResponseReceived?.();
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
  return {
    fetch: fetchImpl,
    commandResponse,
    nextPromptResponse: () =>
      new Promise<void>((resolve) => {
        promptResponseReceived = resolve;
      }),
    eventBatch,
    completionLogResponse,
  };
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
  coalesced = false,
) => {
  const write = logOnly ? test.writeLog : test.write;
  if (coalesced)
    write("session.inbox.delivered", { inboxID: "msg_native_command" }, undefined, 102);
  else write("session.execution.started", {}, undefined, 102);
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
  it("admits the first resumed command without a selection SSE race or a negative cursor", async () => {
    const test = await sessionFixture(fetch, workspaceInventory, true);
    try {
      const command = test.holdNextCommand();
      const sending = test.engine.send("/review resumed");
      await command.requested;
      commandPromptWrite(test, "msg_native_command", 101, session.id, true);
      commandTurnWrite(test, false, true);
      command.release();
      expect(await sending).toEqual({ success: true, data: { turnID: "msg_native_command" } });
      expect(test.logRequests).toEqual([
        { after: null, follow: "false" },
        { after: 100, follow: "false" },
      ]);
      commandTurnExpect(test, "msg_native_command");
    } finally {
      await test.close();
    }
  });

  it("omits both unknown command cursors when an empty log marker has no sequence", async () => {
    const test = await sessionFixture();
    try {
      test.setLogWatermark(undefined);
      const command = test.holdNextCommand();
      const sending = test.engine.send("/review empty log");
      await command.requested;
      command.release();
      expect((await sending).success).toBe(true);
      expect(test.logRequests).toEqual([
        { after: null, follow: "false" },
        { after: null, follow: "false" },
      ]);
    } finally {
      await test.close();
    }
  });

  it.each(["initial", "completion"] as const)(
    "bounds a stalled %s command fence with uncertainty and no replay",
    async (phase) => {
      const stalled = stalledFetch("/api/experimental/session/ses_fixture/log");
      const test = await sessionFixture(stalled.fetch, workspaceInventory);
      try {
        if (phase === "initial") stalled.stall();
        const command = test.holdNextCommand();
        vi.useFakeTimers();
        const sending = test.engine.send("/review stalled fence");
        if (phase === "completion") {
          await command.requested;
          stalled.stall();
          command.release();
        }
        await stalled.requested;
        await vi.advanceTimersByTimeAsync(15_000);
        const result = await sending;
        expect(result).toMatchObject({
          success: false,
          error: { operation: "session.command", detail: expect.stringContaining("uncertain") },
        });
        expect(result).not.toHaveProperty("rejected");
        expect(stalled.cancelled()).toBe(true);
        expect(await test.engine.send("/review do not replay")).toMatchObject({
          success: false,
          error: { detail: expect.stringContaining("uncertain") },
        });
        expect((await test.engine.recover()).success).toBe(false);
        expect(test.commandBodies).toHaveLength(phase === "initial" ? 0 : 1);
        expect(test.promptCount()).toBe(0);
        expect(test.events.some((event) => event.type.startsWith("turn."))).toBe(false);
      } finally {
        vi.useRealTimers();
        await test.close();
      }
    },
  );

  it.each([
    { phase: "initial", action: "stop" },
    { phase: "initial", action: "loss" },
    { phase: "completion", action: "stop" },
    { phase: "completion", action: "loss" },
  ] as const)(
    "cancels a stalled $phase command fence on $action without replay",
    async ({ phase, action }) => {
      const stalled = stalledFetch("/api/experimental/session/ses_fixture/log");
      const test = await sessionFixture(stalled.fetch, workspaceInventory);
      try {
        if (phase === "initial") stalled.stall();
        const command = test.holdNextCommand();
        const sending = test.engine.send("/review cancelled fence");
        if (phase === "completion") {
          await command.requested;
          stalled.stall();
          command.release();
        }
        await stalled.requested;
        if (action === "stop") await test.engine.stop({ interrupt: false });
        else {
          test.disconnect();
          await test.wait((event) => event.type === "stream.lost");
        }
        const result = await sending;
        expect(result).toMatchObject({ success: false, error: { operation: "session.command" } });
        expect(result).not.toHaveProperty("rejected");
        expect(stalled.cancelled()).toBe(true);
        expect((await test.engine.send("do not replay")).success).toBe(false);
        expect((await test.engine.recover()).success).toBe(false);
        expect(test.commandBodies).toHaveLength(phase === "initial" ? 0 : 1);
        expect(test.promptCount()).toBe(0);
        expect(test.events.some((event) => event.type.startsWith("turn."))).toBe(false);
      } finally {
        await test.close();
      }
    },
  );

  it.each(["retained gap", "marker beyond last row", "public gap", "unretained prefix"] as const)(
    "bounds command coverage with a legitimate %s without fabricating completion or replay",
    async (gap) => {
      const receipts = commandTransportReceipts();
      const test = await sessionFixture(receipts.fetch);
      try {
        const command = test.holdNextCommand();
        const sending = test.engine.send("/review incomplete coverage");
        await command.requested;
        if (gap === "public gap" || gap === "unretained prefix") test.setLogRetention(false);
        commandPromptWrite(test, "msg_native_command", 101, session.id, true);
        if (gap !== "unretained prefix")
          test.writeLog(
            "session.metadata.updated",
            { metadata: {} },
            undefined,
            gap === "retained gap" ? 103 : 102,
          );
        if (gap === "marker beyond last row") test.setLogWatermark(104);
        vi.useFakeTimers();
        command.release();
        await receipts.completionLogResponse;
        if (gap === "public gap") {
          commandPromptWrite(test);
          test.write("session.metadata.updated", { metadata: {} }, undefined, 104);
        }
        test.write("session.usage.updated", { ...usage, cost: 9000 }, "command_receipt_prefix");
        await receipts.eventBatch;
        expect(test.events.map((event) => event.type)).toEqual(["session.ready"]);
        await vi.advanceTimersByTimeAsync(15_000);
        const result = await sending;
        expect(result).toMatchObject({
          success: false,
          error: { operation: "session.command", detail: expect.stringContaining("uncertain") },
        });
        expect(result).not.toHaveProperty("rejected");
        // The admission lock is released, but uncertainty (not "still being admitted") blocks sends.
        expect(await test.engine.send("do not replay")).toMatchObject({
          success: false,
          error: { detail: "Session already has pending or uncertain work." },
        });
        test.replayLogged();
        expect((await test.engine.recover()).success).toBe(false);
        expect(test.commandBodies).toHaveLength(1);
        expect(test.promptCount()).toBe(0);
        expect(test.events.some((event) => event.type.startsWith("turn."))).toBe(false);
      } finally {
        vi.useRealTimers();
        await test.close();
      }
    },
  );

  it("cancels command admission before a stalled explicit-stop interrupt settles", async () => {
    const log = stalledFetch("/api/experimental/session/ses_fixture/log");
    const interrupt = stalledFetch("/api/session/ses_fixture/interrupt");
    const fetchImpl: typeof fetch = (request, init) => {
      const path = new URL(request instanceof Request ? request.url : String(request)).pathname;
      return path.endsWith("/interrupt")
        ? interrupt.fetch(request, init)
        : log.fetch(request, init);
    };
    const test = await sessionFixture(fetchImpl, workspaceInventory);
    try {
      log.stall();
      interrupt.stall();
      vi.useFakeTimers();
      const sending = test.engine.send("/review stop");
      await log.requested;
      const stopping = test.engine.stop();
      await interrupt.requested;
      expect(await sending).toMatchObject({
        success: false,
        error: { operation: "session.command" },
      });
      expect(log.cancelled()).toBe(true);
      expect(interrupt.cancelled()).toBe(false);
      expect(test.commandBodies).toHaveLength(0);
      expect(test.events.some((event) => event.type.startsWith("turn."))).toBe(false);
      await vi.advanceTimersByTimeAsync(15_000);
      expect(await stopping).toMatchObject({
        success: false,
        error: { operation: "session.interrupt" },
      });
      expect(interrupt.cancelled()).toBe(true);
    } finally {
      vi.useRealTimers();
      await test.close();
    }
  });

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
        { after: null, follow: "false" },
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
            {
              id: "native_skill_7f42",
              name: "review",
              mention: { start: 0, end: 7, text: "$review" },
            },
            {
              id: "native_skill_98ab",
              name: "quality",
              mention: { start: 16, end: 24, text: "$quality" },
            },
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

  it.each([
    { name: "skill:review", id: "opaque_colon_93" },
    { name: "skill)", id: "opaque_close_14" },
    { name: "skill]", id: "opaque_bracket_35" },
    { name: "skill}", id: "opaque_brace_61" },
    { name: "skill:", id: "opaque_terminal_colon_08" },
  ])("submits exact offered $name at EOF rather than its skill prefix", async ({ name, id }) => {
    const test = await sessionFixture(fetch, undefined, false, resolutionSkills);
    try {
      const text = `$${name}`;
      const sending = await test.engine.send(text);
      expect(sending.success).toBe(true);
      if (!sending.success) throw new Error("Skill admission failed");
      expect(test.promptBodies).toEqual([
        {
          id: sending.data.turnID,
          text,
          skills: [{ id, name, mention: { start: 0, end: text.length, text } }],
        },
      ]);
      expect(test.inventoryRequests).toHaveLength(1);
      expect(
        new URL(test.inventoryRequests[0]!, "http://fixture").searchParams.get(
          "location[directory]",
        ),
      ).toBe(directory);
    } finally {
      await test.close();
    }
  });

  it("submits raw whitespace and JS skill offsets after astral text with delimiters outside exact mentions", async () => {
    const test = await sessionFixture(fetch, undefined, false, resolutionSkills);
    try {
      const text = " \t😀 ($skill:review), [$skill]], {$skill}}! 𑿝skill)\n ";
      const sending = await test.engine.send(text);
      expect(sending.success).toBe(true);
      if (!sending.success) throw new Error("Skill admission failed");
      const expected = [
        {
          id: "opaque_colon_93",
          name: "skill:review",
          mention: { start: 6, end: 19, text: "$skill:review" },
        },
        {
          id: "opaque_bracket_35",
          name: "skill]",
          mention: { start: 23, end: 30, text: "$skill]" },
        },
        { id: "opaque_brace_61", name: "skill}", mention: { start: 34, end: 41, text: "$skill}" } },
        { id: "opaque_close_14", name: "skill)", mention: { start: 44, end: 52, text: "𑿝skill)" } },
      ];
      expect(test.promptBodies).toEqual([{ id: sending.data.turnID, text, skills: expected }]);
      for (const skill of expected) {
        expect(text.slice(skill.mention.start, skill.mention.end)).toBe(skill.mention.text);
      }
    } finally {
      await test.close();
    }
  });

  it("keeps unknown slash and skill suffixes literal without attaching an offered shorter prefix", async () => {
    const test = await sessionFixture(fetch, undefined, false, resolutionSkills);
    try {
      const text =
        '/skill /unknown $skill:unknown $skill)extra $skill:review)extra $skills $skill/path prefix$skill \\$skill "$skill" `$skill` $unknown';
      const sending = await test.engine.send(text);
      expect(sending.success).toBe(true);
      if (!sending.success) throw new Error("Literal admission failed");
      expect(test.promptBodies).toEqual([{ id: sending.data.turnID, text }]);
      expect(test.commandBodies).toEqual([]);
      expect(test.logReads()).toBe(0);
    } finally {
      await test.close();
    }
  });

  it("resolves command skill mentions against actual native command text and retains caller attachments", async () => {
    const test = await sessionFixture(fetch, { ...workspaceInventory, skill: resolutionSkills });
    try {
      const command = test.holdNextCommand();
      const skills = [{ id: "caller_native_id", name: "caller", text: "Caller text" }];
      const sending = test.engine.send(" \t/review \t😀 ($review), $skill:review  \n", { skills });
      await command.requested;
      command.release();
      expect((await sending).success).toBe(true);
      const text = "😀 ($review), $skill:review  \n";
      expect(test.commandBodies[0]?.body).toEqual({
        name: "review",
        text,
        skills: [
          ...skills,
          {
            id: "opaque_review_45",
            name: "review",
            mention: { start: 4, end: 11, text: "$review" },
          },
          {
            id: "opaque_colon_93",
            name: "skill:review",
            mention: { start: 14, end: 27, text: "$skill:review" },
          },
        ],
      });
      expect(test.promptBodies).toEqual([]);
      expect(test.inventoryRequests).toEqual([]);
      expect(test.inventoryLookups).toEqual([directory]);
    } finally {
      await test.close();
    }
  });

  it("reuses each engine instance cwd catalog without mixing identical skill names across instances", async () => {
    for (const id of ["native_instance_A", "native_instance_B"]) {
      const test = await sessionFixture(fetch, {
        ...workspaceInventory,
        skill: [{ id, name: "review", path: `/native/${id}/SKILL.md`, content: id }],
      });
      try {
        const command = test.holdNextCommand();
        const sending = test.engine.send("/review $review");
        await command.requested;
        command.release();
        expect((await sending).success).toBe(true);
        const next = await test.engine.send(" $review ");
        expect(next.success).toBe(true);
        if (!next.success) throw new Error("Second cached admission failed");
        expect(test.commandBodies[0]?.body).toEqual({
          name: "review",
          text: "$review",
          skills: [{ id, name: "review", mention: { start: 0, end: 7, text: "$review" } }],
        });
        expect(test.promptBodies).toEqual([
          {
            id: next.data.turnID,
            text: " $review ",
            skills: [{ id, name: "review", mention: { start: 1, end: 8, text: "$review" } }],
          },
        ]);
        expect(test.inventoryRequests).toEqual([]);
        expect(test.inventoryLookups).toEqual([directory, directory]);
      } finally {
        await test.close();
      }
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
          {
            id: "native_skill_7f42",
            name: "review",
            mention: { start: 0, end: 7, text: "$review" },
          },
          {
            id: "native_skill_98ab",
            name: "quality",
            mention: { start: 16, end: 24, text: "$quality" },
          },
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
      commandTurnWrite(test, false, false, true);
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
  it.each([
    {
      transport: "prompt",
      receipt: "before boundaries",
      enqueue: "before terminal",
      terminal: "succeeded",
    },
    {
      transport: "prompt",
      receipt: "after boundaries",
      enqueue: "before terminal",
      terminal: "failed",
    },
    {
      transport: "prompt",
      receipt: "after boundaries",
      enqueue: "after terminal",
      terminal: "interrupted",
    },
    {
      transport: "command",
      receipt: "before boundaries",
      enqueue: "before terminal",
      terminal: "interrupted",
    },
    {
      transport: "command",
      receipt: "after boundaries",
      enqueue: "before terminal",
      terminal: "succeeded",
    },
    {
      transport: "command",
      receipt: "after boundaries",
      enqueue: "after terminal",
      terminal: "failed",
    },
  ] as const)(
    "routes a $transport successor exactly once with receipt $receipt, enqueue $enqueue and old $terminal",
    async ({ transport, receipt, enqueue, terminal }) => {
      const receipts = commandTransportReceipts();
      const test = await sessionFixture(receipts.fetch, workspaceInventory);
      try {
        const oldID = await test.admit();
        test.write("session.execution.started", {}, "old-start", 1);
        await test.wait((event) => event.type === "turn.started");
        const request = transport === "command" ? test.holdNextCommand() : test.holdNextPrompt();
        const sending = test.engine.send(
          transport === "command" ? "/review successor" : "successor",
        );
        await request.requested;
        const successorID =
          transport === "command" ? "msg_successor" : String(test.promptBodies[1]!.id);
        const oldTerminal = (seq: number, id = "old-terminal") =>
          test.write(
            `session.execution.${terminal}`,
            terminal === "failed"
              ? { error: { type: "old.failed", message: "Old execution failed" } }
              : terminal === "interrupted"
                ? { reason: "user" }
                : {},
            id,
            seq,
          );
        if (receipt === "before boundaries") {
          // The command's completion log covers its enqueue, while the actual
          // delivery and successor execution still arrive asynchronously via SSE.
          if (transport === "command") commandPromptWrite(test, successorID, 101, session.id, true);
          const completionLog = transport === "command" ? test.holdNextLog() : undefined;
          const promptResponse = transport === "prompt" ? receipts.nextPromptResponse() : undefined;
          const pending = test.holdNextPermissionList();
          request.release();
          if (completionLog) {
            await completionLog.requested;
            completionLog.release();
            await receipts.completionLogResponse;
          } else {
            await promptResponse;
          }
          // Ordinary prompt acknowledgement precedes boundary association; a
          // command completion fence is observed by the next held log instead.
          if (transport === "prompt") {
            // No pending reconciliation is possible until ownership is known.
            expect(test.events.filter((event) => event.type === "turn.completed")).toEqual([]);
          }
          if (enqueue === "before terminal") {
            commandPromptWrite(test, successorID, 101);
            oldTerminal(102);
          } else {
            oldTerminal(101);
            commandPromptWrite(test, successorID, 102);
          }
          test.write("session.execution.started", {}, "successor-start", 103);
          test.write(
            "session.inbox.delivered",
            { inboxID: successorID },
            "successor-delivered",
            104,
          );
          test.write(
            "session.text.ended",
            { assistantMessageID: "msg_successor_answer", ordinal: 0, text: "Successor answer" },
            "successor-answer",
            105,
          );
          oldTerminal(102, "acknowledged-old-terminal");
          test.write("session.execution.succeeded", {}, "successor-terminal", 106);
          await pending.requested;
          pending.release();
        } else {
          if (enqueue === "before terminal") {
            commandPromptWrite(test, successorID, 101);
            oldTerminal(102);
          } else {
            oldTerminal(101);
            commandPromptWrite(test, successorID, 102);
          }
          test.write("session.execution.started", {}, "successor-start", 103);
          test.write(
            "session.inbox.delivered",
            { inboxID: successorID },
            "successor-delivered",
            104,
          );
          test.write(
            "session.text.ended",
            { assistantMessageID: "msg_successor_answer", ordinal: 0, text: "Successor answer" },
            "successor-answer",
            105,
          );
          oldTerminal(102, "acknowledged-old-terminal");
          test.write("session.execution.succeeded", {}, "successor-terminal", 106);
          request.release();
        }
        expect(await sending).toEqual({ success: true, data: { turnID: successorID } });
        test.replayLogged();
        // A separately acknowledged old terminal is still fenced by its durable
        // position, not just by an identical public-feed id.
        test.write(
          `session.execution.${terminal}`,
          terminal === "failed"
            ? { error: { type: "old.failed", message: "late" } }
            : terminal === "interrupted"
              ? { reason: "user" }
              : {},
          "late-old-terminal",
          102,
        );
        await test.drain();
        expect(test.events.filter((event) => event.type.startsWith("turn."))).toMatchObject([
          { type: "turn.started", turnID: oldID },
          { type: terminal === "succeeded" ? "turn.completed" : "turn.failed", turnID: oldID },
          { type: "turn.started", turnID: successorID },
          { type: "turn.completed", turnID: successorID },
        ]);
        expect(test.events.filter((event) => event.type === "text.completed")).toMatchObject([
          {
            turnID: successorID,
            assistantMessageID: "msg_successor_answer",
            text: "Successor answer",
          },
        ]);
      } finally {
        await test.close();
      }
    },
  );

  it.each(["steer", "queue"] as const)(
    "keeps a delivered %s input on its actual coalesced execution",
    async (delivery) => {
      const test = await sessionFixture();
      try {
        const turnID = await test.admit();
        test.write("session.execution.started", {}, undefined, 1);
        await test.wait((event) => event.type === "turn.started");
        const prompt = test.holdNextPrompt();
        const sending = test.engine.send("coalesced input", { delivery });
        await prompt.requested;
        const inboxID = String(test.promptBodies[1]!.id);
        test.write(
          "session.inbox.enqueued",
          { inboxID, item: { type: "user", delivery, payload: { text: "coalesced input" } } },
          undefined,
          2,
        );
        test.write("session.inbox.delivered", { inboxID }, undefined, 3);
        test.write(
          "session.text.ended",
          { assistantMessageID: "msg_coalesced", ordinal: 0, text: "Coalesced answer" },
          undefined,
          4,
        );
        test.write("session.execution.succeeded", {}, undefined, 5);
        prompt.release();
        expect(await sending).toEqual({ success: true, data: { turnID } });
        test.replayLogged();
        await test.drain();
        expect(test.events.filter((event) => event.type.startsWith("turn."))).toEqual([
          { type: "turn.started", turnID },
          { type: "turn.completed", turnID },
        ]);
        expect(test.events.filter((event) => event.type === "text.completed")).toMatchObject([
          { turnID, text: "Coalesced answer" },
        ]);
      } finally {
        await test.close();
      }
    },
  );

  it("routes command admission when the old execution settles inside the initial log fence", async () => {
    const test = await sessionFixture(fetch, workspaceInventory);
    try {
      const oldID = await test.admit();
      test.write("session.execution.started", {}, undefined, 1);
      await test.wait((event) => event.type === "turn.started");
      const fence = test.holdNextLog();
      const command = test.holdNextCommand();
      const sending = test.engine.send("/review settlement fence");
      await fence.requested;
      test.write("session.execution.succeeded", {}, "old-terminal", 2);
      fence.release();
      await command.requested;
      commandPromptWrite(test);
      commandTurnWrite(test);
      command.release();
      expect(await sending).toEqual({ success: true, data: { turnID: "msg_native_command" } });
      test.replayLogged();
      await test.drain();
      expect(test.events.filter((event) => event.type.startsWith("turn."))).toEqual([
        { type: "turn.started", turnID: oldID },
        { type: "turn.completed", turnID: oldID },
        { type: "turn.started", turnID: "msg_native_command" },
        { type: "turn.completed", turnID: "msg_native_command" },
      ]);
    } finally {
      await test.close();
    }
  });

  it("associates a successor failure before inbox promotion with its admitted input", async () => {
    const test = await sessionFixture();
    try {
      const oldID = await test.admit();
      test.write("session.execution.started", {}, undefined, 1);
      await test.wait((event) => event.type === "turn.started");
      const prompt = test.holdNextPrompt();
      const sending = test.engine.send("blocked initialization");
      await prompt.requested;
      const nextID = String(test.promptBodies[1]!.id);
      commandPromptWrite(test, nextID, 2);
      test.write("session.execution.succeeded", {}, undefined, 3);
      test.write("session.execution.started", {}, undefined, 4);
      test.write(
        "session.execution.failed",
        { error: { type: "instructions.blocked", message: "Initialization blocked" } },
        "successor-failed",
        5,
      );
      prompt.release();
      expect(await sending).toEqual({ success: true, data: { turnID: nextID } });
      test.replayLogged();
      await test.drain();
      expect(test.events.filter((event) => event.type.startsWith("turn."))).toMatchObject([
        { type: "turn.started", turnID: oldID },
        { type: "turn.completed", turnID: oldID },
        { type: "turn.started", turnID: nextID },
        { type: "turn.failed", turnID: nextID, reason: "failed" },
      ]);
    } finally {
      await test.close();
    }
  });

  it.each(["deadline", "stop", "loss"] as const)(
    "releases unresolved successor association on %s without replay or fabricated completion",
    async (action) => {
      const test = await sessionFixture();
      try {
        await test.admit();
        test.write("session.execution.started", {}, undefined, 1);
        await test.wait((event) => event.type === "turn.started");
        const prompt = test.holdNextPrompt();
        if (action === "deadline") vi.useFakeTimers();
        const sending = test.engine.send("unresolved successor");
        await prompt.requested;
        commandPromptWrite(test, String(test.promptBodies[1]!.id), 2);
        prompt.release();
        // The usage receipt is ordered after the admitted enqueue and proves
        // the engine has drained admission and is waiting on an actual boundary.
        await test.drain();
        expect(await test.engine.send("cannot overlap association")).toMatchObject({
          success: false,
          rejected: true,
        });
        if (action === "deadline") await vi.advanceTimersByTimeAsync(15_000);
        else if (action === "stop") await test.engine.stop({ interrupt: false });
        else {
          test.disconnect();
          await test.wait((event) => event.type === "stream.lost");
        }
        expect(await sending).toMatchObject({
          success: false,
          error: { operation: "session.prompt" },
        });
        expect(test.promptCount()).toBe(2);
        expect(
          test.events.filter(
            (event) => event.type === "turn.completed" || event.type === "turn.failed",
          ),
        ).toEqual([]);
        expect((await test.engine.send("do not replay")).success).toBe(false);
      } finally {
        vi.useRealTimers();
        await test.close();
      }
    },
  );

  it.each([
    { label: "text and files", text: "Read these attachments" },
    { label: "files only", text: "" },
  ])("admits $label over HTTP and completes the same turn through SSE", async ({ text }) => {
    const test = await sessionFixture();
    try {
      const files = [
        { uri: "data:image/png;base64,cGl4ZWw=", name: "image.png" },
        { uri: "data:text/plain;base64,Y29udGV4dA==", name: "context.txt" },
        { uri: "data:application/pdf;base64,JVBERg==", name: "report.pdf" },
      ];
      const sending = await test.engine.send(text, { files });
      expect(sending.success).toBe(true);
      if (!sending.success) throw new Error("File admission failed");
      expect(test.promptBodies).toEqual([{ id: sending.data.turnID, text, files }]);
      expect(test.inventoryRequests).toEqual([]);
      commandTurnWrite(test);
      await test.wait((event) => event.type === "turn.completed");
      commandTurnExpect(test, sending.data.turnID);
    } finally {
      await test.close();
    }
  });

  it("rejects truly empty native prompts without admitting work or blocking a later explicit continuation", async () => {
    const test = await sessionFixture();
    try {
      for (const text of ["", "  "]) {
        expect(await test.engine.send(text, { files: [] })).toMatchObject({
          success: false,
          rejected: true,
          error: { operation: "session.prompt" },
        });
      }
      expect(test.promptCount()).toBe(0);
      const text = "Continue where you left off";
      const sending = await test.engine.send(text);
      expect(sending.success).toBe(true);
      if (!sending.success) throw new Error("Explicit continuation admission failed");
      expect(test.promptBodies).toEqual([{ id: sending.data.turnID, text }]);
      commandTurnWrite(test);
      await test.wait((event) => event.type === "turn.completed");
      commandTurnExpect(test, sending.data.turnID);
    } finally {
      await test.close();
    }
  });

  it("reverses the sticky plan agent through HTTP before admitting the next native prompt", async () => {
    const test = await sessionFixture();
    try {
      expect((await test.engine.switchSelection({ agent: "plan" })).success).toBe(true);
      const planning = await test.engine.send("make a plan");
      expect(planning.success).toBe(true);
      if (!planning.success) throw new Error("Planning admission failed");
      test.write("session.execution.started");
      test.write("session.execution.succeeded");
      await test.wait(
        (event) => event.type === "turn.completed" && event.turnID === planning.data.turnID,
      );
      expect((await test.engine.switchSelection({ agent: "build" })).success).toBe(true);
      const building = await test.engine.send("implement it");
      expect(building.success).toBe(true);
      if (!building.success) throw new Error("Default-agent admission failed");
      test.write("session.execution.started", {}, undefined, 2);
      test.write("session.execution.succeeded", {}, undefined, 3);
      await test.wait(
        (event) => event.type === "turn.completed" && event.turnID === building.data.turnID,
      );
      expect(test.switches).toEqual([
        { path: "/api/session/ses_fixture/agent", body: { agent: "plan" } },
        { path: "/api/session/ses_fixture/agent", body: { agent: "build" } },
      ]);
      expect(test.promptBodies).toEqual([
        { id: planning.data.turnID, text: "make a plan" },
        { id: building.data.turnID, text: "implement it" },
      ]);
      expect(test.events.filter((event) => event.type.startsWith("turn."))).toEqual([
        { type: "turn.started", turnID: planning.data.turnID },
        { type: "turn.completed", turnID: planning.data.turnID },
        { type: "turn.started", turnID: building.data.turnID },
        { type: "turn.completed", turnID: building.data.turnID },
      ]);
      expect(test.interrupts()).toBe(0);
    } finally {
      await test.close();
    }
  });

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
      expect(test.events.filter((event) => event.type === "stream.lost")).toEqual([
        {
          type: "stream.lost",
          sessionID: session.id,
          detail: "Native session event stream closed.",
        },
      ]);
    } finally {
      await test.close();
    }
  });

  it("emits a connected fetch stream rejection once with its cause, without fabricated terminals or retry", async () => {
    let rejectStream!: (cause: unknown) => void;
    let eventRequests = 0;
    const fetchImpl: typeof fetch = async (request, init) => {
      const response = await fetch(request, init);
      const path = new URL(request instanceof Request ? request.url : String(request)).pathname;
      if (path !== "/api/event") return response;
      eventRequests++;
      const stream = new TransformStream<Uint8Array, Uint8Array>({
        start(controller) {
          rejectStream = (cause) => controller.error(cause);
        },
      });
      return new Response(response.body!.pipeThrough(stream), {
        status: response.status,
        headers: response.headers,
      });
    };
    const test = await sessionFixture(fetchImpl);
    try {
      await test.admit();
      test.write("session.execution.started");
      test.write("session.step.started", stepStart("msg_stream_failure"));
      test.write("session.text.started", { assistantMessageID: "msg_stream_failure", ordinal: 0 });
      test.write("session.tool.input.started", {
        assistantMessageID: "msg_stream_failure",
        id: "tool_unfinished",
        name: "bash",
      });
      await test.drain();
      rejectStream(new Error("fixture event read failed"));
      await test.wait((event) => event.type === "stream.lost");
      expect((await test.engine.send("never retry")).success).toBe(false);
      await test.engine.stop();
      expect(test.events.filter((event) => event.type === "stream.lost")).toEqual([
        {
          type: "stream.lost",
          sessionID: session.id,
          detail: "Transport: fixture event read failed",
        },
      ]);
      expect(
        test.events.filter(
          (event) => event.type.endsWith(".completed") || event.type.endsWith(".failed"),
        ),
      ).toEqual([]);
      expect(test.promptCount()).toBe(1);
      expect(eventRequests).toBe(1);
    } finally {
      await test.close();
    }
  });

  it("retains the 4096-event admission overflow cause instead of generic stream closure", async () => {
    const test = await sessionFixture();
    try {
      const command = test.holdNextCommand();
      const sending = test.engine.send("/review overflow");
      await command.requested;
      for (let cost = 0; cost <= 4096; cost++) {
        test.write("session.usage.updated", { ...usage, cost });
      }
      await test.wait((event) => event.type === "stream.lost");
      command.release();
      expect((await sending).success).toBe(false);
      expect((await test.engine.send("never retry")).success).toBe(false);
      expect(test.events.filter((event) => event.type === "stream.lost")).toEqual([
        {
          type: "stream.lost",
          sessionID: session.id,
          detail: "Native session event stream admission buffer exceeded its 4096-event capacity.",
        },
      ]);
      expect(test.events.some((event) => event.type.startsWith("turn."))).toBe(false);
      expect(test.commandBodies).toHaveLength(1);
      expect(test.promptCount()).toBe(0);
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
          if (steer === body)
            frame(stream!, "session.inbox.delivered", { sessionID: session.id, inboxID: body.id });
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

  it("looks up context limits from deterministic official native model payloads without credentials", async () => {
    const requested: string[] = [];
    const payload = modelInventoryDecode({
      location: { directory },
      data: [
        {
          id: "route/model",
          modelID: "underlying",
          providerID: "other",
          name: "Other",
          enabled: true,
          status: "active",
          variants: [],
          capabilities: { tools: true, input: ["text"], output: ["text"] },
          time: { released: 0 },
          cost: [],
          limit: { context: 1_000, output: 100 },
        },
        {
          id: "route/model",
          modelID: "underlying",
          providerID: "native",
          name: "Actual",
          enabled: true,
          status: "active",
          variants: [],
          capabilities: { tools: true, input: ["text"], output: ["text"] },
          time: { released: 0 },
          cost: [],
          limit: { context: 200_000, output: 10_000 },
        },
      ],
    });
    const test = await sessionFixture(async (request, init) => {
      const url = new URL(request instanceof Request ? request.url : String(request));
      if (url.pathname !== "/api/model") return fetch(request, init);
      expect(url.searchParams.get("location[directory]")).toBe(directory);
      expect(new Headers(init?.headers).has("Authorization")).toBe(false);
      requested.push(url.pathname);
      return Response.json(payload);
    });
    try {
      expect(await test.engine.contextLimit({ providerID: "native", id: "route/model" })).toBe(
        200_000,
      );
      expect(await test.engine.contextLimit({ providerID: "native", id: "underlying" })).toBe(
        200_000,
      );
      expect(
        await test.engine.contextLimit({ providerID: "absent", id: "route/model" }),
      ).toBeUndefined();
      expect(requested).toHaveLength(3);
    } finally {
      await test.close();
    }
  });

  it("translates native model selections while idle and preserves effective step model identity", async () => {
    const test = await sessionFixture();
    try {
      test.write("session.model.selected", { model: { providerID: "native", id: "selected" } });
      await test.wait((event) => event.type === "model.selected");
      const turnID = await test.admit();
      test.write("session.step.started", {
        ...stepStart("msg_actual"),
        model: { providerID: "native", id: "actual", variant: "high" },
      });
      test.write("session.step.ended", stepEnd("msg_actual"));
      test.write("session.execution.succeeded");
      await test.drain();
      expect(test.events.find((event) => event.type === "model.selected")).toMatchObject({
        type: "model.selected",
        sessionID: session.id,
        model: { providerID: "native", id: "selected" },
      });
      expect(test.events.find((event) => event.type === "step.started")).toMatchObject({
        turnID,
        step: { model: { providerID: "native", id: "actual", variant: "high" } },
      });
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

  it("reactivates a settled native child through a new launch key across two turns without moving original step usage", async () => {
    const test = await sessionFixture();
    try {
      const firstTurn = await test.admit();
      const childID = "ses_reused";
      const launch = (assistantMessageID: string, id: string, reused: boolean) => {
        const ref = { assistantMessageID, id };
        test.write("session.tool.input.started", { ...ref, name: "subagent" });
        test.write("session.tool.called", {
          ...ref,
          input: {
            agent: reused ? "review" : "explore",
            ...(reused ? { sessionID: childID } : {}),
          },
          executed: false,
        });
        test.write("session.tool.progress", {
          ...ref,
          metadata: { sessionID: childID, status: "running" },
        });
        return ref;
      };
      const firstRef = launch("msg_parent_first", "call_first", false);
      test.write("session.execution.started", { sessionID: childID }, undefined, 10);
      test.write(
        "session.step.started",
        { ...stepStart("msg_child_first"), sessionID: childID },
        undefined,
        11,
      );
      test.write(
        "session.step.ended",
        { ...stepEnd("msg_child_first"), sessionID: childID },
        undefined,
        12,
      );
      test.write("session.execution.succeeded", { sessionID: childID }, undefined, 13);
      test.write("session.tool.success", {
        ...firstRef,
        content: [{ type: "text", text: "first answer" }],
        metadata: { sessionID: childID, status: "completed" },
        executed: false,
      });
      test.write("session.execution.succeeded");
      await test.wait((event) => event.type === "turn.completed" && event.turnID === firstTurn);
      const originalSteps = test.events.filter(
        (event) => event.type === "step.completed" && event.sessionID === childID,
      );

      const secondTurn = await test.admit();
      const secondRef = launch("msg_parent_second", "call_second", true);
      // Progress is emitted before child prompt admission. A delayed terminal in
      // this window cannot settle the pending new activation, even with a higher
      // sequence than the last observed outgoing frame.
      test.write(
        "session.execution.failed",
        {
          sessionID: childID,
          error: { type: "provider.error", message: "old activation" },
        },
        undefined,
        14,
      );
      await test.drain();
      expect(test.events.filter((event) => event.type === "child.failed")).toEqual([]);
      expect(test.events.filter((event) => event.type === "child.started")).toHaveLength(1);

      test.write("session.execution.started", { sessionID: childID }, undefined, 20);
      const secondKey = "ses_fixture:msg_parent_second:tool:call_second";
      await test.wait(
        (event) => event.type === "child.started" && event.parentToolKey === secondKey,
      );
      // Native execution has sessionID only. Durable order fences every old
      // terminal shape, including a distinct event ID, rather than guessing IDs.
      test.write("session.execution.succeeded", { sessionID: childID }, undefined, 13);
      test.write(
        "session.execution.failed",
        {
          sessionID: childID,
          error: { type: "provider.error", message: "late failure" },
        },
        undefined,
        14,
      );
      test.write(
        "session.execution.interrupted",
        { sessionID: childID, reason: "user" },
        undefined,
        15,
      );
      test.write("session.execution.started", { sessionID: childID }, undefined, 10);
      test.write(
        "session.step.ended",
        { ...stepEnd("msg_child_first"), sessionID: childID },
        undefined,
        12,
      );
      test.write(
        "session.created",
        {
          sessionID: childID,
          parentID: session.id,
          projectID: "proj_fixture",
          slug: "old-child",
          location: { directory },
          version: "2.0.18",
          agent: "old-agent",
          title: "stale title",
        },
        undefined,
        1,
      );
      test.write("session.text.delta", {
        sessionID: childID,
        assistantMessageID: "msg_child_first",
        ordinal: 0,
        delta: "stale output",
      });
      test.write(
        "session.synthetic",
        {
          text: "old notification has no launch identity",
          metadata: { source: "subagent", childID, state: "completed" },
        },
        undefined,
        250,
      );
      test.write(
        "session.step.started",
        { ...stepStart("msg_child_second"), sessionID: childID },
        undefined,
        21,
      );
      test.write(
        "session.text.ended",
        {
          sessionID: childID,
          assistantMessageID: "msg_child_second",
          ordinal: 0,
          text: "second answer",
        },
        undefined,
        22,
      );
      test.write(
        "session.step.ended",
        {
          ...stepEnd("msg_child_second"),
          sessionID: childID,
          cost: 0.75,
        },
        undefined,
        23,
      );
      test.write("session.usage.updated", { ...usage, sessionID: childID, cost: 1 });
      await test.drain();
      expect(test.events.filter((event) => event.type === "child.completed")).toHaveLength(1);
      expect(
        test.events.filter(
          (event) => event.type === "child.failed" || event.type === "child.interrupted",
        ),
      ).toEqual([]);
      expect(
        test.events.some(
          (event) => event.type === "child.updated" && event.info.agent === "old-agent",
        ),
      ).toBe(false);
      expect(
        test.events.some((event) => event.type === "text.delta" && event.delta === "stale output"),
      ).toBe(false);
      expect(
        test.events.filter(
          (event) => event.type === "step.completed" && event.sessionID === childID,
        ),
      ).toEqual([
        ...originalSteps,
        expect.objectContaining({
          turnID: secondTurn,
          parentToolKey: secondKey,
          step: expect.objectContaining({ cost: 0.75 }),
        }),
      ]);
      expect(originalSteps).toEqual([
        expect.objectContaining({
          turnID: firstTurn,
          parentToolKey: "ses_fixture:msg_parent_first:tool:call_first",
          step: expect.objectContaining({ cost: usage.cost }),
        }),
      ]);
      expect(
        test.events.find((event) => event.type === "usage.updated" && event.sessionID === childID),
      ).toEqual({
        type: "usage.updated",
        sessionID: childID,
        scope: "session",
        ...usage,
        cost: 1,
      });
      test.write("session.execution.succeeded", { sessionID: childID }, undefined, 24);
      test.write(
        "session.tool.success",
        {
          ...secondRef,
          content: [{ type: "text", text: "second answer" }],
          metadata: { sessionID: childID, status: "completed" },
          executed: false,
        },
        undefined,
        251,
      );
      // Older launch progress/results cannot move the active task's linkage.
      test.write("session.tool.progress", {
        ...firstRef,
        metadata: { sessionID: childID, status: "running" },
      });
      test.write("session.execution.succeeded", {}, undefined, 252);
      await test.drain();
      expect(test.events.filter((event) => event.type === "child.started")).toEqual([
        {
          type: "child.started",
          sessionID: childID,
          turnID: firstTurn,
          parentSessionID: session.id,
          parentToolKey: "ses_fixture:msg_parent_first:tool:call_first",
        },
        {
          type: "child.started",
          sessionID: childID,
          turnID: secondTurn,
          parentSessionID: session.id,
          parentToolKey: secondKey,
          reactivation: { key: secondKey },
        },
      ]);
      expect(test.events.filter((event) => event.type === "child.completed")).toEqual([
        {
          type: "child.completed",
          sessionID: childID,
          turnID: firstTurn,
          parentSessionID: session.id,
          parentToolKey: "ses_fixture:msg_parent_first:tool:call_first",
        },
        {
          type: "child.completed",
          sessionID: childID,
          turnID: secondTurn,
          parentSessionID: session.id,
          parentToolKey: secondKey,
        },
      ]);
    } finally {
      await test.close();
    }
  });

  it("requires a new reuse launch's running progress and does not let an older tool result terminate same-turn reactivation", async () => {
    const test = await sessionFixture();
    try {
      const turnID = await test.admit();
      const childID = "ses_same_turn";
      const call = (id: string, reuseID?: string) => {
        const ref = { assistantMessageID: "msg_same_parent", id };
        test.write("session.tool.input.started", { ...ref, name: "subagent" });
        test.write("session.tool.called", {
          ...ref,
          input: { agent: "explore", ...(reuseID ? { sessionID: reuseID } : {}) },
          executed: false,
        });
        return ref;
      };
      const progress = (ref: ReturnType<typeof call>) =>
        test.write("session.tool.progress", {
          ...ref,
          metadata: { sessionID: childID, status: "running" },
        });
      const result = (ref: ReturnType<typeof call>) =>
        test.write("session.tool.success", {
          ...ref,
          executed: false,
          content: [{ type: "text", text: "tool result" }],
          metadata: { sessionID: childID, status: "completed" },
        });
      const first = call("call_original");
      progress(first);
      test.write("session.execution.started", { sessionID: childID }, undefined, 5);
      // A different tool can steer an already-running native child. It is not a
      // new execution and must not relabel it, now or in a delayed replay.
      const steering = call("call_steering", childID);
      progress(steering);
      test.write("session.execution.succeeded", { sessionID: childID }, undefined, 8);
      // Identity-only starts, terminal-only results, a mismatched requested child,
      // and a repeat of the original launch are not reactivation evidence.
      progress(call("call_no_reuse"));
      progress(call("call_wrong_child", "ses_foreign"));
      result(call("call_terminal_only", childID));
      progress(first);
      progress(steering);
      await test.drain();
      expect(test.events.filter((event) => event.type === "child.attached")).toHaveLength(1);
      const next = call("call_new", childID);
      progress(next);
      progress(next);
      test.write("session.execution.started", { sessionID: childID }, undefined, 15);
      // The parent is still on the same assistant step, so these old tool frames
      // reach childAttach rather than being rejected by the parent turn fence.
      result(first);
      progress(first);
      test.write(
        "session.execution.failed",
        {
          sessionID: childID,
          error: { type: "provider.error", message: "older failure" },
        },
        undefined,
        8,
      );
      test.write(
        "session.text.ended",
        {
          sessionID: childID,
          assistantMessageID: "msg_same_child_new",
          ordinal: 0,
          text: "current result",
        },
        undefined,
        16,
      );
      await test.drain();
      expect(test.events.filter((event) => event.type === "child.completed")).toHaveLength(1);
      expect(test.events.filter((event) => event.type === "child.failed")).toEqual([]);
      expect(test.events.filter((event) => event.type === "child.started")).toMatchObject([
        { turnID, parentToolKey: "ses_fixture:msg_same_parent:tool:call_original" },
        {
          turnID,
          parentToolKey: "ses_fixture:msg_same_parent:tool:call_new",
          reactivation: { key: "ses_fixture:msg_same_parent:tool:call_new" },
        },
      ]);
      test.write("session.execution.succeeded", { sessionID: childID }, undefined, 17);
      result(next);
      // General late duplicates, including a fresh event ID under the settled
      // launch, still cannot reopen this activation.
      progress(next);
      test.write("session.execution.started", { sessionID: childID }, undefined, 18);
      await test.drain();
      expect(test.events.filter((event) => event.type === "child.started")).toHaveLength(2);
      expect(test.events.filter((event) => event.type === "child.completed")).toHaveLength(2);
      expect(test.events.filter((event) => event.type === "text.completed")).toMatchObject([
        {
          turnID,
          sessionID: childID,
          parentToolKey: "ses_fixture:msg_same_parent:tool:call_new",
          text: "current result",
        },
      ]);
    } finally {
      await test.close();
    }
  });

  it("preserves nested background origins on child reuse and fences old launch terminals and unkeyed notifications", async () => {
    const test = await sessionFixture();
    try {
      const firstTurn = await test.admit();
      const launch = (
        sessionID: string,
        assistantMessageID: string,
        childID: string,
        reused: boolean,
      ) => {
        const ref = { sessionID, assistantMessageID, id: "call_shared" };
        test.write(
          "session.tool.input.started",
          { ...ref, name: "subagent" },
          undefined,
          reused ? 21 : sessionID === session.id ? 1 : 11,
        );
        test.write(
          "session.tool.called",
          {
            ...ref,
            input: {
              agent: "explore",
              background: true,
              ...(reused ? { sessionID: childID } : {}),
            },
            executed: false,
          },
          undefined,
          reused ? 22 : sessionID === session.id ? 2 : 12,
        );
        test.write("session.tool.progress", {
          ...ref,
          metadata: { sessionID: childID, status: "running" },
        });
        return ref;
      };
      const oldLaunch = launch(session.id, "msg_parent_old", "ses_outer", false);
      test.write("session.execution.started", { sessionID: "ses_outer" }, undefined, 10);
      launch("ses_outer", "msg_outer_old", "ses_nested_reuse", false);
      test.write("session.execution.started", { sessionID: "ses_nested_reuse" }, undefined, 10);
      test.write("session.execution.succeeded", { sessionID: "ses_nested_reuse" }, undefined, 12);
      test.write("session.execution.succeeded", { sessionID: "ses_outer" }, undefined, 13);
      test.write("session.execution.succeeded");
      await test.wait((event) => event.type === "turn.completed" && event.turnID === firstTurn);
      const secondTurn = await test.admit();
      launch(session.id, "msg_parent_new", "ses_outer", true);
      test.write("session.execution.started", { sessionID: "ses_outer" }, undefined, 20);
      launch("ses_outer", "msg_outer_new", "ses_nested_reuse", true);
      test.write("session.execution.started", { sessionID: "ses_nested_reuse" }, undefined, 20);
      test.write(
        "session.tool.success",
        {
          ...oldLaunch,
          content: [{ type: "text", text: "old foreground result" }],
          metadata: { sessionID: "ses_outer", status: "completed" },
          executed: false,
        },
        undefined,
        201,
      );
      test.write("session.execution.succeeded", { sessionID: "ses_outer" }, undefined, 12);
      test.write("session.execution.succeeded", { sessionID: "ses_nested_reuse" }, undefined, 12);
      test.write(
        "session.inbox.enqueued",
        {
          sessionID: "ses_outer",
          inboxID: "msg_late_notification",
          item: {
            type: "synthetic",
            payload: {
              text: "late nested result",
              metadata: { source: "subagent", childID: "ses_nested_reuse", state: "completed" },
            },
          },
        },
        undefined,
        23,
      );
      // Background tools may finish while their children continue, and the
      // spawning parent can settle before either child's current terminal.
      test.write(
        "session.tool.success",
        {
          assistantMessageID: "msg_parent_new",
          id: "call_shared",
          executed: false,
          content: [{ type: "text", text: "running in background" }],
          metadata: { sessionID: "ses_outer", status: "running" },
        },
        undefined,
        202,
      );
      test.write("session.execution.succeeded", {}, undefined, 203);
      await test.drain();
      const thirdTurn = await test.admit();
      test.write(
        "session.execution.failed",
        {
          sessionID: "ses_nested_reuse",
          error: { type: "provider.error", message: "new nested failure" },
        },
        undefined,
        22,
      );
      test.write(
        "session.execution.interrupted",
        { sessionID: "ses_outer", reason: "user" },
        undefined,
        24,
      );
      await test.drain();
      const current = test.events.filter(
        (event) =>
          event.type.startsWith("child.") && "turnID" in event && event.turnID === secondTurn,
      );
      expect(current.filter((event) => event.type === "child.started")).toMatchObject([
        {
          sessionID: "ses_outer",
          parentSessionID: session.id,
          reactivation: { key: "ses_fixture:msg_parent_new:tool:call_shared" },
        },
        {
          sessionID: "ses_nested_reuse",
          parentSessionID: "ses_outer",
          reactivation: { key: "ses_outer:msg_outer_new:tool:call_shared" },
        },
      ]);
      expect(current.filter((event) => event.type === "child.completed")).toEqual([]);
      expect(
        current.filter(
          (event) => event.type === "child.failed" || event.type === "child.interrupted",
        ),
      ).toMatchObject([
        {
          type: "child.failed",
          sessionID: "ses_nested_reuse",
          turnID: secondTurn,
          parentToolKey: "ses_outer:msg_outer_new:tool:call_shared",
          error: { message: "new nested failure" },
        },
        {
          type: "child.interrupted",
          sessionID: "ses_outer",
          turnID: secondTurn,
          parentToolKey: "ses_fixture:msg_parent_new:tool:call_shared",
          reason: "user",
        },
      ]);
      expect(
        test.events.some(
          (event) =>
            event.type.startsWith("child.") && "turnID" in event && event.turnID === thirdTurn,
        ),
      ).toBe(false);
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
      test.write("session.step.started", stepStart("msg_valid"), "step-valid", -1);
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

for (const state of ["active", "uncertain-admission"] as const) {
  it(`local recovery disposal of ${state} work never sends a remote interrupt`, async () => {
    const test = await sessionFixture(
      state === "uncertain-admission"
        ? async (...args) => {
            const response = await fetch(...args);
            const url = args[0] instanceof Request ? args[0].url : String(args[0]);
            return url.endsWith("/prompt") ? new Response("{}", { status: 200 }) : response;
          }
        : fetch,
    );
    try {
      const admitted = await test.engine.send("one original prompt");
      if (state === "active") {
        expect(admitted.success).toBe(true);
        test.write("session.execution.started");
        await test.wait((event) => event.type === "turn.started");
        test.disconnect();
        await test.wait((event) => event.type === "stream.lost");
      } else expect(admitted.success).toBe(false);
      expect(await test.engine.stop({ interrupt: false })).toEqual({
        success: true,
        data: undefined,
      });
      expect(test.interrupts()).toBe(0);
      expect(test.promptCount()).toBe(1);
      expect((await test.engine.send("do not replay")).success).toBe(false);
    } finally {
      await test.close();
    }
  });
}

it("explicit stop still interrupts active native work exactly once", async () => {
  const test = await sessionFixture();
  try {
    await test.admit();
    test.write("session.execution.started");
    await test.wait((event) => event.type === "turn.started");
    expect(await test.engine.stop()).toEqual({ success: true, data: undefined });
    expect(test.interrupts()).toBe(1);
  } finally {
    await test.close();
  }
});

it("local disposal cancels a start awaiting SSE readiness without creating or interrupting a native session", async () => {
  const subscribed = Promise.withResolvers<void>();
  const requests: string[] = [];
  const server = await fixture((req, res) => {
    requests.push(req.url!);
    if (req.url === "/api/event") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.flushHeaders();
      subscribed.resolve();
    } else res.writeHead(500).end();
  });
  const engine = openCodeNativeSessionEngineCreate({ url: server.url, onEvent: () => {} });
  try {
    const started = engine.start({ directory, resumeSessionId: session.id });
    await subscribed.promise;
    expect(await engine.stop({ interrupt: false })).toEqual({ success: true, data: undefined });
    expect(await started).toMatchObject({ success: false, error: { operation: "session.start" } });
    expect(requests).toEqual(["/api/event"]);
  } finally {
    await engine.stop({ interrupt: false });
    await server.close();
  }
});

for (const blocker of ["inbox", "permission", "form"] as const) {
  it(`quiescent adoption refuses a native ${blocker} without answering, cancelling, prompting, or interrupting it`, async () => {
    let pending = true;
    const writes: string[] = [];
    const server = await fixture((req, res) => {
      if (req.method !== "GET") writes.push(req.url!);
      if (req.url === "/api/event") {
        res.writeHead(200, { "content-type": "text/event-stream" });
        frame(res, "server.connected", {});
      } else if (req.url === "/api/session/ses_fixture") send(res, { data: session });
      else if (req.url === "/api/session/active") send(res, { data: {} });
      else if (req.url === `/api/session/ses_fixture/${blocker}`)
        send(res, { data: pending ? [{ id: "pending_native" }] : [] });
      else if (
        ["inbox", "permission", "form"].some(
          (path) => req.url === `/api/session/ses_fixture/${path}`,
        )
      )
        send(res, { data: [] });
      else res.writeHead(404).end();
    });
    let engine = openCodeNativeSessionEngineCreate({ url: server.url, onEvent: () => {} });
    try {
      expect(await engine.start({ directory, resumeSessionId: session.id })).toMatchObject({
        success: false,
        error: { operation: "session.resume" },
      });
      await engine.stop({ interrupt: false });
      pending = false;
      engine = openCodeNativeSessionEngineCreate({ url: server.url, onEvent: () => {} });
      expect(await engine.start({ directory, resumeSessionId: session.id })).toEqual({
        success: true,
        data: session,
      });
      expect(writes).toEqual([]);
    } finally {
      await engine.stop({ interrupt: false });
      await server.close();
    }
  });
}
