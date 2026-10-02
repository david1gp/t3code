import { describe, expect, it } from "vite-plus/test";
import { Agent, Model, Provider, Session } from "@opencode/client/effect";
import type { SessionLogOutput, V2Event } from "@opencode/client";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";

import { openCodeNativeClientCreate } from "./openCodeNativeClientCreate.ts";
import { openCodeNativeEventDisposition } from "./openCodeNativeEventDisposition.ts";
import { openCodeNativeInventorySchema } from "./openCodeNativeInventorySchema.ts";
import { openCodeNativeWireSchema } from "./openCodeNativeWireSchema.ts";

const feedDecode = Schema.decodeUnknownSync(openCodeNativeWireSchema.feed);
const feedDecodeExit = Schema.decodeUnknownExit(openCodeNativeWireSchema.feed);
const logDecode = Schema.decodeUnknownSync(openCodeNativeWireSchema.log);
const logDecodeExit = Schema.decodeUnknownExit(openCodeNativeWireSchema.log);
const inventoryDecode = {
  provider: Schema.decodeUnknownSync(openCodeNativeInventorySchema.provider),
  model: Schema.decodeUnknownSync(openCodeNativeInventorySchema.model),
  agent: Schema.decodeUnknownSync(openCodeNativeInventorySchema.agent),
  skill: Schema.decodeUnknownSync(openCodeNativeInventorySchema.skill),
  command: Schema.decodeUnknownSync(openCodeNativeInventorySchema.command),
};
const modelDecodeExit = Schema.decodeUnknownExit(openCodeNativeInventorySchema.model);
const skillDecodeExit = Schema.decodeUnknownExit(openCodeNativeInventorySchema.skill);

const sessionID = "ses_wire";
const usage = {
  cost: 0.25,
  tokens: { input: 10, output: 7, reasoning: 2, cache: { read: 3, write: 4 } },
};
const envelope = {
  id: "evt_wire",
  created: 1,
  durable: { aggregateID: sessionID, seq: 4, version: 1 as const },
  location: { directory: "/workspace", workspaceID: "wrk_wire" },
  metadata: { trace: "wire" },
};
const model = { id: "model", providerID: "provider", variant: "high" };

const publicFrames = [
  {
    ...envelope,
    type: "session.model.selected",
    data: { sessionID, model, previous: { id: "old", providerID: "provider" } },
  },
  {
    ...envelope,
    type: "session.agent.selected",
    data: { sessionID, agent: "build", previous: "plan" },
  },
  {
    ...envelope,
    type: "session.retry.scheduled",
    data: {
      sessionID,
      assistantMessageID: "msg_wire",
      attempt: 2,
      at: 42,
      error: { type: "api", message: "retry", status: 429 },
    },
  },
  {
    ...envelope,
    type: "session.skill.activated",
    data: { sessionID, id: "skill_native", name: "review:code", text: "Instructions" },
  },
  {
    ...envelope,
    type: "session.shell.ended",
    data: {
      sessionID,
      shell: {
        id: "sh_wire",
        status: "exited",
        command: "pwd",
        cwd: "/workspace",
        shell: "/bin/sh",
        file: "/output",
        exit: 0,
        metadata: { source: "user" },
        time: { started: 1, completed: 2 },
      },
      output: { output: "/workspace", cursor: 10, size: 10, truncated: false },
    },
  },
  {
    ...envelope,
    type: "session.compaction.ended",
    data: {
      sessionID,
      reason: "manual",
      model,
      providerState: { native: true },
      providerContext: {
        version: 1,
        provenance: {
          providerID: "provider",
          provider: "api",
          modelID: "model",
          route: "route",
          protocol: "protocol",
          endpoint: "endpoint",
        },
        messages: [],
      },
      text: "Summary",
      recent: "Recent",
      ...usage,
    },
  },
  {
    ...envelope,
    type: "session.compaction.failed",
    data: {
      sessionID,
      reason: "auto",
      inputID: "msg_wire",
      error: { type: "api", message: "failed" },
      ...usage,
    },
  },
  ...["user", "synthetic", "compaction", "move"].map((type) => ({
    ...envelope,
    type: "session.inbox.enqueued" as const,
    data: {
      sessionID,
      inboxID: "msg_inbox",
      item:
        type === "user"
          ? {
              type: "user" as const,
              delivery: "steer" as const,
              payload: {
                text: "Prompt",
                skills: [
                  {
                    id: "skill_native",
                    name: "code",
                    mention: { start: 0, end: 5, text: "$code" },
                  },
                ],
              },
            }
          : type === "synthetic"
            ? {
                type: "synthetic" as const,
                delivery: "queue" as const,
                payload: { text: "Child finished", metadata: { childID: "ses_child" } },
              }
            : type === "compaction"
              ? { type: "compaction" as const, delivery: "queue" as const, payload: {} }
              : {
                  type: "move" as const,
                  delivery: "queue" as const,
                  payload: {
                    location: { directory: "/moved", workspaceID: "wrk_moved" },
                    projectID: "prj_moved",
                    subpath: "src",
                  },
                },
    },
  })),
] satisfies V2Event[];

describe("openCodeNativeClientCreate", () => {
  it("creates the official typed client with the configured URL and Basic auth", async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const client = openCodeNativeClientCreate({
      url: "https://opencode.example/base",
      serverPassword: "päss:🔒",
      fetch: async (input, init) => {
        calls.push({ url: String(input), init });
        return Response.json({ version: "2.0.18", pid: 123, urls: [], paths: { tmp: "/tmp" } });
      },
    });

    await expect(client.server.info()).resolves.toEqual({
      version: "2.0.18",
      pid: 123,
      urls: [],
      paths: { tmp: "/tmp" },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://opencode.example/base/api/info");
    expect(new Headers(calls[0]?.init?.headers).get("Authorization")).toBe(
      `Basic ${Buffer.from("opencode:päss:🔒", "utf8").toString("base64")}`,
    );
  });

  it("does not add authorization when no password is configured", async () => {
    let authorization: string | null = null;
    const client = openCodeNativeClientCreate({
      url: "https://opencode.example",
      fetch: async (_input, init) => {
        authorization = new Headers(init?.headers).get("Authorization");
        return Response.json({ version: "2.0.18", pid: 123, urls: [], paths: { tmp: "/tmp" } });
      },
    });

    await client.server.info();
    expect(authorization).toBeNull();
  });

  it("decodes official selection, retry, skill, shell, compaction and inbox variants without dropping native fields", () => {
    for (const frame of publicFrames) {
      expect(feedDecode(frame)).toEqual(frame);
      expect(logDecode(frame)).toEqual(frame);
      expect(openCodeNativeEventDisposition[frame.type]).not.toBe("ignored");
    }
    for (const definition of Session.Event.Definitions) {
      expect(openCodeNativeEventDisposition[definition.type]).toBeDefined();
    }
    for (const definition of Session.Event.DurableDefinitions) {
      expect(openCodeNativeEventDisposition[definition.type]).toBeDefined();
    }
  });

  it("keeps real native client SSE and internal durable log contracts distinct", async () => {
    const internal = [
      {
        ...envelope,
        type: "session.usage.recorded",
        data: { sessionID, source: "compaction", ...usage },
      },
      {
        ...envelope,
        type: "session.message.content.updated",
        data: {
          sessionID,
          messageID: "msg_wire",
          content: [{ type: "reasoning", text: "Replay", time: { created: 1, completed: 2 } }],
        },
      },
      { type: "log.synced", aggregateID: sessionID, seq: 4 },
    ] satisfies SessionLogOutput[];
    const client = openCodeNativeClientCreate({
      url: "https://opencode.example",
      fetch: async (input) =>
        new Response(
          (String(input).includes("/log") ? internal : publicFrames)
            .map((frame) => `data: ${JSON.stringify(frame)}\n\n`)
            .join(""),
          { headers: { "content-type": "text/event-stream" } },
        ),
    });
    const logged: unknown[] = [];
    for await (const frame of client.session.log({ sessionID, follow: false })) {
      logged.push(logDecode(frame));
      expect(Exit.isFailure(feedDecodeExit(frame))).toBe(true);
    }
    expect(logged).toEqual(internal);
    const streamed: unknown[] = [];
    for await (const frame of client.event.subscribe()) streamed.push(feedDecode(frame));
    expect(streamed).toEqual(publicFrames);
    const delta = {
      id: "evt_delta",
      created: 1,
      type: "session.text.delta",
      data: { sessionID, assistantMessageID: "msg_wire", ordinal: 0, delta: "Live" },
    } satisfies V2Event;
    expect(feedDecode(delta)).toEqual(delta);
    expect(Exit.isFailure(logDecodeExit(delta))).toBe(true);
  });

  it("rejects malformed native envelope, retry, tool metadata and compaction fields", () => {
    const retry = publicFrames[2]!;
    for (const invalid of [
      { ...retry, id: "not_an_event" },
      { ...retry, durable: { ...envelope.durable, seq: -1 } },
      { ...retry, durable: { ...envelope.durable, version: 2 } },
      { ...retry, data: { ...retry.data, attempt: 0 } },
      { ...publicFrames[5], data: { ...publicFrames[5]!.data, tokens: { input: 1 } } },
      {
        ...envelope,
        type: "session.tool.success",
        durable: { ...envelope.durable, version: 2 },
        data: {
          sessionID,
          assistantMessageID: "msg_wire",
          id: "call_wire",
          executed: false,
          content: [{ type: "text", text: "Done" }],
          metadata: { invalid: undefined },
        },
      },
    ])
      expect(Exit.isFailure(feedDecodeExit(invalid))).toBe(true);
  });

  it("decodes pinned compaction starts and independently optional terminal cost/tokens and session-only recorded sources", () => {
    const start = {
      ...envelope,
      type: "session.compaction.started" as const,
      data: { sessionID, reason: "manual" as const, recent: "recent", inputID: "msg_compaction" },
    } satisfies V2Event;
    expect(feedDecode(start)).toEqual(start);
    for (const failure of [false, true]) {
      for (const reported of [{}, { cost: usage.cost }, { tokens: usage.tokens }, usage]) {
        const frame = failure
          ? ({
              ...envelope,
              type: "session.compaction.failed" as const,
              data: {
                sessionID,
                reason: "manual" as const,
                inputID: "msg_compaction",
                error: { type: "api", message: "charged failure" },
                ...reported,
              },
            } satisfies V2Event)
          : ({
              ...envelope,
              type: "session.compaction.ended" as const,
              data: {
                sessionID,
                reason: "auto" as const,
                text: "summary",
                recent: "recent",
                model,
                ...reported,
              },
            } satisfies V2Event);
        expect(feedDecode(frame)).toEqual(frame);
        expect(logDecode(frame)).toEqual(frame);
      }
    }
    for (const source of ["compaction", "title"] as const) {
      const frame = {
        ...envelope,
        type: "session.usage.recorded" as const,
        data: { sessionID, source, ...usage },
      } satisfies SessionLogOutput;
      expect(logDecode(frame)).toEqual(frame);
      expect(Exit.isFailure(feedDecodeExit(frame))).toBe(true);
    }
  });

  it("accepts v2.0.21 additive structured-error response data without changing the pinned v2.0.18 contract", () => {
    const error = {
      type: "api",
      message: "Retry",
      status: 429,
      response: { body: "Rate limited" },
    };
    const frame = { ...publicFrames[2], data: { ...publicFrames[2]!.data, error } };
    expect(feedDecode(frame)).toMatchObject({
      type: "session.retry.scheduled",
      data: { error: { type: "api", message: "Retry", status: 429 } },
    });
  });

  it("validates complete official inventory records while preserving metadata outside T3's projection", () => {
    const location = { directory: "/workspace" };
    const provider = Provider.ID.make("provider");
    const model = {
      ...Model.Info.default(provider, Model.ID.make("model")),
      limit: { context: 100000, input: 90000, output: 10000 },
      cost: [{ input: 1, output: 2, cache: { read: 0.1, write: 0.2 } }],
    };
    const records = {
      provider: { ...Provider.Info.empty(provider), settings: { custom: true } },
      model,
      agent: Agent.Info.default(Agent.ID.make("build")),
      skill: {
        id: "skill_wire",
        name: "review:code",
        path: "/skill/SKILL.md",
        content: "Instructions",
        description: "Review",
        autoinvoke: true,
      },
      command: { name: "review", description: "Review" },
    };
    for (const key of ["provider", "model", "agent", "skill", "command"] as const) {
      const body = { location, data: [records[key]] };
      expect(inventoryDecode[key](body)).toEqual(body);
    }
    const { capabilities: _capabilities, ...incompleteModel } = model;
    expect(
      Exit.isFailure(
        modelDecodeExit({
          location,
          data: [incompleteModel],
        }),
      ),
    ).toBe(true);
    expect(
      Exit.isFailure(
        skillDecodeExit({
          location,
          data: [{ id: "skill", name: "review", path: "/skill" }],
        }),
      ),
    ).toBe(true);
  });
});
