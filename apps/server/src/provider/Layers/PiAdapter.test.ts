// @effect-diagnostics nodeBuiltinImport:off - SDK persistence fixture uses Node paths.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { AgentSession, ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import { assert, it } from "@effect/vitest";
import { afterAll, beforeAll, beforeEach, vi } from "vite-plus/test";
import {
  ApprovalRequestId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
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

// The real SDK loads and binds this extension, but ordinary prompts are intercepted
// before the provider can be called. Nothing here reads or writes the user's Pi home.
const agentDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-pi-preset-test-"));
const reviewCwd = NodePath.join(agentDir, "review-workspace");
const reviewPrompts: string[] = [];
const emptyAgentDir = NodePath.join(agentDir, "without-command");
const noPresetAgentDir = NodePath.join(agentDir, "without-presets-or-extension");
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
const prompts: string[] = [];
const promptModels: Array<string | undefined> = [];
const promptThinkingLevels: string[] = [];
const commandEntries: unknown[] = [];
const originalPrompt = AgentSession.prototype.prompt;
let fixtureModel: string;
let presetModel: string;

beforeAll(async () => {
  NodeFS.mkdirSync(NodePath.join(agentDir, "extensions"));
  NodeFS.mkdirSync(NodePath.join(agentDir, "prompts"));
  const skillDirectory = NodePath.join(agentDir, "skills", "fixture-skill");
  NodeFS.mkdirSync(skillDirectory, { recursive: true });
  NodeFS.writeFileSync(
    NodePath.join(skillDirectory, "SKILL.md"),
    "---\nname: fixture-skill\ndescription: Harmless invocation fixture\n---\nNative skill instruction.",
  );
  NodeFS.mkdirSync(reviewCwd);
  NodeFS.mkdirSync(emptyAgentDir);
  NodeFS.mkdirSync(noPresetAgentDir);
  NodeFS.writeFileSync(
    NodePath.join(agentDir, "prompts", "review.md"),
    "---\ndescription: Review fixture\n---\nReview $1 against $2",
  );
  NodeFS.writeFileSync(
    NodePath.join(agentDir, "presets.json"),
    '{"build":{"model":"test/build"},"delegate":{"model":"test/delegate"},"broken":{},"noisy":{}}',
  );
  const models = (await ModelRuntime.create()).getModels();
  const model = models.find((candidate) => !candidate.reasoning);
  assert.isDefined(model);
  fixtureModel = `${model.provider}/${model.id}`;
  const preset = models.find(
    (candidate) => candidate.reasoning && candidate.thinkingLevelMap?.max === undefined,
  );
  assert.isDefined(preset);
  presetModel = `${preset.provider}/${preset.id}`;
  // The extension SDK requires configured auth before accepting a model switch.
  // These isolated prompts never contact a provider or load real credentials.
  vi.spyOn(ModelRuntime.prototype, "hasConfiguredAuth").mockReturnValue(true);
  NodeFS.writeFileSync(
    NodePath.join(agentDir, "extensions", "preset.js"),
    `export default function (pi) {
      pi.on("session_start", async (_event, ctx) => {
        const model = ctx.modelRegistry.find(${JSON.stringify(preset.provider)}, ${JSON.stringify(preset.id)});
        if (!model) throw new Error("Delegate fixture model unavailable");
        await pi.setModel(model);
        pi.setThinkingLevel("low");
      });
      pi.registerCommand("fixture-command", {
        handler: async (args) => pi.appendEntry("test-command", { args }),
      });
      pi.registerCommand("fixture-fail", {
        handler: async () => { throw new Error("Fixture command failed"); },
      });
       pi.registerCommand("preset", {
         handler: async (name) => {
           if (name === "broken") throw new Error("Fixture preset failed");
           pi.appendEntry("test-preset", { name });
          pi.setThinkingLevel(name === "none" ? "off" : "low");
        },
      });
    }`,
  );
  process.env.PI_CODING_AGENT_DIR = agentDir;
  vi.spyOn(AgentSession.prototype, "setModel").mockImplementation(async function (
    this: AgentSession,
    selected,
  ) {
    this.state.model = selected;
    this.sessionManager.appendModelChange(selected.provider, selected.id);
    this.setThinkingLevel("off");
  });
  vi.spyOn(AgentSession.prototype, "prompt").mockImplementation(async function (
    this: AgentSession,
    text,
    options,
  ) {
    prompts.push(text);
    if (text.startsWith("/preset ")) {
      if (!this.extensionRunner.getCommand("preset")) throw new Error("Preset command not bound");
      if (text === "/preset noisy")
        this.extensionRunner.emitError({
          extensionPath: "command:other",
          event: "command",
          error: "Unrelated command failure",
        });
      await originalPrompt.call(this, text, options);
      if (text !== "/preset none") {
        const [provider, ...id] = presetModel.split("/");
        const selected = this.modelRuntime.getModel(provider!, id.join("/"));
        assert.isDefined(selected);
        // Simulate the configured preset switching the SDK model, without auth or an LLM.
        this.state.model = selected;
        this.setThinkingLevel("low");
      }
      commandEntries.push(
        ...this.sessionManager
          .getEntries()
          .filter((entry) => entry.type === "custom" && entry.customType === "test-preset")
          .slice(commandEntries.length)
          .map((entry) => (entry.type === "custom" ? entry.data : undefined)),
      );
      return;
    }
    if (text.startsWith("/fixture-")) {
      await originalPrompt.call(this, text, options);
      commandEntries.push(
        ...this.sessionManager
          .getEntries()
          .flatMap((entry) =>
            entry.type === "custom" && entry.customType === "test-command" ? [entry.data] : [],
          ),
      );
      return;
    }
    if (text.startsWith("/review ") || text.startsWith("/skill:")) {
      const agentPrompt = vi
        .spyOn(this.agent, "prompt")
        .mockImplementation(
          async (messages: string | AgentSession["agent"]["state"]["messages"]) => {
            const userMessage =
              typeof messages === "string"
                ? undefined
                : messages.find((message) => message.role === "user");
            if (userMessage?.role === "user") {
              const content = userMessage.content;
              reviewPrompts.push(
                typeof content === "string"
                  ? content
                  : content
                      .filter((block) => block.type === "text")
                      .map((block) => (block.type === "text" ? block.text : ""))
                      .join("\n"),
              );
            }
            // Stop at the model boundary after recording the SDK-expanded user message.
            throw new Error("Review fixture stopped before provider call");
          },
        );
      try {
        await originalPrompt.call(this, text, options);
      } finally {
        agentPrompt.mockRestore();
      }
      return;
    }
    if (text.startsWith("/")) throw new Error(`Unexpected SDK command: ${text}`);
    promptModels.push(this.model ? `${this.model.provider}/${this.model.id}` : undefined);
    promptThinkingLevels.push(this.thinkingLevel);
    options?.preflightResult?.(true);
    // Exercise the adapter's turn lifecycle without starting an agent/model run.
    const emit = Reflect.get(this, "_emit") as (event: { type: "agent_settled" }) => void;
    emit.call(this, { type: "agent_settled" });
  });
});

beforeEach(() => {
  prompts.length = 0;
  promptModels.length = 0;
  promptThinkingLevels.length = 0;
  commandEntries.length = 0;
  reviewPrompts.length = 0;
  process.env.PI_CODING_AGENT_DIR = agentDir;
});

afterAll(() => {
  vi.restoreAllMocks();
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  NodeFS.rmSync(agentDir, { recursive: true, force: true });
});

const presetSelection = (preset: string, thinkingLevel?: string, modelOverride?: boolean) => ({
  instanceId: ProviderInstanceId.make("pi"),
  model: fixtureModel,
  options: [
    { id: "preset", value: preset },
    ...(thinkingLevel ? [{ id: "thinkingLevel", value: thinkingLevel }] : []),
    ...(modelOverride !== undefined ? [{ id: "modelOverride", value: modelOverride }] : []),
  ],
});

it.effect("keeps the session_start delegate model and thinking for an implicit T3 default", () =>
  Effect.gen(function* () {
    const adapter = yield* makePiAdapter();
    const implicit = { instanceId: ProviderInstanceId.make("pi"), model: fixtureModel };
    const session = yield* adapter.startSession({ ...start, modelSelection: implicit });
    assert.equal(session.model, presetModel);
    yield* adapter.sendTurn({ threadId, input: "first", modelSelection: implicit });
    yield* adapter.sendTurn({ threadId, input: "second", modelSelection: implicit });
    yield* adapter.sendTurn({
      threadId,
      input: "explicit thinking only",
      modelSelection: {
        ...implicit,
        options: [{ id: "thinkingLevel", value: "off" }],
      },
    });
    assert.deepEqual(prompts, ["first", "second", "explicit thinking only"]);
    assert.deepEqual(promptModels, [presetModel, presetModel, presetModel]);
    assert.deepEqual(promptThinkingLevels, ["low", "low", "off"]);
    assert.equal((yield* adapter.listSessions())[0]?.model, presetModel);
  }).pipe(Effect.scoped, Effect.provide(testLayer)),
);

it.effect("lets an explicit T3 model override win at start and on send without a preset", () =>
  Effect.gen(function* () {
    const adapter = yield* makePiAdapter();
    const implicit = { instanceId: ProviderInstanceId.make("pi"), model: fixtureModel };
    const explicit = {
      ...implicit,
      options: [{ id: "modelOverride", value: true }],
    };
    const session = yield* adapter.startSession({ ...start, modelSelection: explicit });
    assert.equal(session.model, fixtureModel);
    yield* adapter.sendTurn({ threadId, input: "explicit", modelSelection: explicit });
    assert.deepEqual(promptModels, [fixtureModel]);
    assert.deepEqual(promptThinkingLevels, ["off"]);
    assert.deepEqual(prompts, ["explicit"]);
  }).pipe(Effect.scoped, Effect.provide(testLayer)),
);

it.effect(
  "honors a newly marked model and explicit thinking after an implicit delegate start",
  () =>
    Effect.gen(function* () {
      const adapter = yield* makePiAdapter();
      const implicit = { instanceId: ProviderInstanceId.make("pi"), model: fixtureModel };
      const explicit = {
        ...implicit,
        options: [
          { id: "modelOverride", value: true },
          { id: "thinkingLevel", value: "off" },
        ],
      };
      yield* adapter.startSession({ ...start, modelSelection: implicit });
      yield* adapter.sendTurn({ threadId, input: "delegate", modelSelection: implicit });
      yield* adapter.sendTurn({ threadId, input: "selected", modelSelection: explicit });
      assert.deepEqual(promptModels, [presetModel, fixtureModel]);
      assert.deepEqual(promptThinkingLevels, ["low", "off"]);
      assert.equal((yield* adapter.listSessions())[0]?.model, fixtureModel);
      assert.deepEqual(prompts, ["delegate", "selected"]);
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
);

it.effect("keeps the session_start delegate on resume with an implicit T3 default", () =>
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    const adapter = yield* makePiAdapter();
    const id = "00000000-0000-0000-0000-000000000003";
    const directory = NodePath.join(config.stateDir, "pi-sessions", "pi", threadId);
    const manager = SessionManager.create(process.cwd(), directory, { id });
    manager.appendModelChange(...(fixtureModel.split("/") as [string, string]));
    manager.appendMessage({
      role: "user",
      content: [{ type: "text", text: "prior" }],
      timestamp: 1,
    });
    manager.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "ready" }],
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
    const implicit = { instanceId: ProviderInstanceId.make("pi"), model: fixtureModel };
    const session = yield* adapter.startSession({
      ...start,
      resumeCursor: { schemaVersion: 1, sessionId: id },
      modelSelection: implicit,
    });
    assert.equal(session.model, presetModel);
    yield* adapter.sendTurn({ threadId, input: "resumed", modelSelection: implicit });
    assert.deepEqual(promptModels, [presetModel]);
    assert.deepEqual(promptThinkingLevels, ["low"]);
  }).pipe(Effect.scoped, Effect.provide(testLayer)),
);

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
          modelSelection: {
            instanceId: ProviderInstanceId.make("pi"),
            model: "absent/absent",
            options: [{ id: "modelOverride", value: true }],
          },
        })
        .pipe(Effect.flip))._tag,
      "ProviderAdapterRequestError",
    );
    assert.equal((yield* adapter.listSessions())[0]?.model, previousModel);
    assert.deepStrictEqual(yield* adapter.readThread(threadId), { threadId, turns: [] });
  }).pipe(Effect.scoped, Effect.provide(testLayer)),
);

it.effect(
  "rejects unknown and invalid Pi thinking options at start without opening a session",
  () =>
    Effect.gen(function* () {
      const adapter = yield* makePiAdapter();
      for (const options of [
        [{ id: "unknown", value: "high" }],
        [{ id: "preset", value: "missing-preset-for-test" }],
        [{ id: "preset", value: "../build" }],
        [{ id: "preset", value: "build extra" }],
        [{ id: "thinkingLevel", value: "ultra" }],
        [{ id: "thinkingLevel", value: true }],
        [{ id: "modelOverride", value: "true" }],
        [
          { id: "modelOverride", value: true },
          { id: "modelOverride", value: false },
        ],
        [
          { id: "preset", value: "build" },
          { id: "preset", value: "delegate" },
        ],
        [
          { id: "thinkingLevel", value: "low" },
          { id: "thinkingLevel", value: "off" },
        ],
      ]) {
        const error = yield* adapter
          .startSession({
            ...start,
            modelSelection: {
              instanceId: ProviderInstanceId.make("pi"),
              model: "test/model",
              options,
            },
          })
          .pipe(Effect.flip);
        assert.equal(error._tag, "ProviderAdapterValidationError");
        assert.isFalse(yield* adapter.hasSession(threadId));
      }
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
);

it.effect("rejects unknown and invalid Pi thinking options on send without prompting", () =>
  Effect.gen(function* () {
    const adapter = yield* makePiAdapter();
    yield* adapter.startSession(start);
    for (const options of [
      [{ id: "unknown", value: "high" }],
      [{ id: "preset", value: "missing-preset-for-test" }],
      [{ id: "preset", value: "/build" }],
      [{ id: "preset", value: "build extra" }],
      [{ id: "thinkingLevel", value: "ultra" }],
      [{ id: "thinkingLevel", value: true }],
      [{ id: "modelOverride", value: "true" }],
      [
        { id: "modelOverride", value: true },
        { id: "modelOverride", value: false },
      ],
    ]) {
      const error = yield* adapter
        .sendTurn({
          threadId,
          input: "hello",
          modelSelection: {
            instanceId: ProviderInstanceId.make("pi"),
            model: "test/model",
            options,
          },
        })
        .pipe(Effect.flip);
      assert.equal(error._tag, "ProviderAdapterValidationError");
    }
    assert.deepStrictEqual(yield* adapter.readThread(threadId), { threadId, turns: [] });
    assert.equal((yield* adapter.listSessions())[0]?.status, "ready");
  }).pipe(Effect.scoped, Effect.provide(testLayer)),
);

it.effect("dispatches the bound preset command before exactly one real user turn", () =>
  Effect.gen(function* () {
    const adapter = yield* makePiAdapter();
    const started: string[] = [];
    const efforts: Array<string | undefined> = [];
    yield* adapter.streamEvents.pipe(
      Stream.runForEach((event) =>
        Effect.sync(() => {
          if (event.type === "turn.started") {
            if (event.turnId) started.push(event.turnId);
            efforts.push(event.payload.effort);
          }
        }),
      ),
      Effect.forkScoped({ startImmediately: true }),
    );
    yield* adapter.startSession({
      ...start,
      modelSelection: presetSelection("build", "off", true),
    });
    assert.deepEqual(prompts, ["/preset build"]);
    assert.deepEqual(commandEntries, [{ name: "build" }]);
    assert.deepStrictEqual(yield* adapter.readThread(threadId), { threadId, turns: [] });
    yield* adapter.sendTurn({
      threadId,
      input: "first",
      modelSelection: presetSelection("build", "off", true),
    });
    assert.deepEqual(prompts, ["/preset build", "first"]);
    assert.equal(started.length, 1);
    assert.deepEqual(efforts, ["off"]);
    assert.deepEqual(promptModels, [fixtureModel]);
    assert.equal((yield* adapter.listSessions())[0]?.model, fixtureModel);
    assert.equal((yield* adapter.listSessions())[0]?.status, "ready");
  }).pipe(Effect.scoped, Effect.provide(testLayer)),
);

it.effect("lets a named preset own its SDK model unless modelOverride is true", () =>
  Effect.gen(function* () {
    const adapter = yield* makePiAdapter();
    const selected = {
      ...presetSelection("build", "off", false),
      model: "absent/absent",
    };
    const session = yield* adapter.startSession({ ...start, modelSelection: selected });
    assert.equal(session.model, presetModel);
    yield* adapter.sendTurn({ threadId, input: "implicit", modelSelection: selected });
    assert.deepEqual(promptModels, [presetModel]);
    assert.equal((yield* adapter.listSessions())[0]?.model, presetModel);

    const explicit = presetSelection("build", "off", true);
    yield* adapter.sendTurn({ threadId, input: "explicit", modelSelection: explicit });
    assert.deepEqual(prompts, ["/preset build", "implicit", "/preset build", "explicit"]);
    assert.deepEqual(promptModels, [presetModel, fixtureModel]);
    assert.equal((yield* adapter.listSessions())[0]?.model, fixtureModel);
    yield* adapter.sendTurn({ threadId, input: "back to preset", modelSelection: selected });
    assert.deepEqual(promptModels, [presetModel, fixtureModel, presetModel]);
    assert.equal((yield* adapter.listSessions())[0]?.model, presetModel);
    yield* adapter.sendTurn({
      threadId,
      input: "changed preset",
      modelSelection: presetSelection("delegate", "off"),
    });
    assert.equal((yield* adapter.listSessions())[0]?.model, presetModel);
    assert.equal(promptModels.at(-1), presetModel);
  }).pipe(Effect.scoped, Effect.provide(testLayer)),
);

it.effect("validates an explicitly overridden preset model through the SDK", () =>
  Effect.gen(function* () {
    const adapter = yield* makePiAdapter();
    const error = yield* adapter
      .startSession({
        ...start,
        modelSelection: { ...presetSelection("build", undefined, true), model: "absent/absent" },
      })
      .pipe(Effect.flip);
    assert.equal(error._tag, "ProviderAdapterProcessError");
    assert.isFalse(yield* adapter.hasSession(threadId));
    assert.deepEqual(prompts, []);
  }).pipe(Effect.scoped, Effect.provide(testLayer)),
);

it.effect("uses explicit thinking after the preset and validates against its resulting model", () =>
  Effect.gen(function* () {
    const adapter = yield* makePiAdapter();
    const efforts: Array<string | undefined> = [];
    yield* adapter.streamEvents.pipe(
      Stream.runForEach((event) =>
        Effect.sync(() => {
          if (event.type === "turn.started") efforts.push(event.payload.effort);
        }),
      ),
      Effect.forkScoped({ startImmediately: true }),
    );
    const selection = presetSelection("build");
    yield* adapter.startSession({ ...start, modelSelection: selection });
    yield* adapter.sendTurn({ threadId, input: "preset thinking", modelSelection: selection });
    yield* adapter.sendTurn({
      threadId,
      input: "explicit thinking",
      modelSelection: presetSelection("build", "off"),
    });
    assert.deepEqual(efforts, ["low", "off"]);
    const error = yield* adapter
      .sendTurn({
        threadId,
        input: "unsupported thinking",
        modelSelection: presetSelection("delegate", "max"),
      })
      .pipe(Effect.flip);
    assert.equal(error._tag, "ProviderAdapterValidationError");
    assert.equal((yield* adapter.listSessions())[0]?.model, presetModel);
    assert.deepEqual(promptModels, [presetModel, presetModel]);
  }).pipe(Effect.scoped, Effect.provide(testLayer)),
);

it.effect("applies changed presets once per SDK session and clears with none", () =>
  Effect.gen(function* () {
    const adapter = yield* makePiAdapter();
    yield* adapter.startSession({
      ...start,
      modelSelection: { instanceId: ProviderInstanceId.make("pi"), model: fixtureModel },
    });
    assert.deepEqual(prompts, []);
    yield* adapter.sendTurn({ threadId, input: "one", modelSelection: presetSelection("build") });
    yield* adapter.sendTurn({ threadId, input: "two", modelSelection: presetSelection("build") });
    yield* adapter.sendTurn({
      threadId,
      input: "three",
      modelSelection: presetSelection("delegate"),
    });
    yield* adapter.sendTurn({ threadId, input: "four", modelSelection: presetSelection("none") });
    yield* adapter.sendTurn({ threadId, input: "five", modelSelection: presetSelection("none") });
    assert.deepEqual(prompts, [
      "/preset build",
      "one",
      "two",
      "/preset delegate",
      "three",
      "/preset none",
      "four",
      "five",
    ]);
    assert.deepEqual(commandEntries, [{ name: "build" }, { name: "delegate" }, { name: "none" }]);
  }).pipe(Effect.scoped, Effect.provide(testLayer)),
);

it.effect("keeps Pi's restored model for none unless the T3 model was explicitly selected", () =>
  Effect.gen(function* () {
    const adapter = yield* makePiAdapter();
    const implicitNone = presetSelection("none");
    const session = yield* adapter.startSession({ ...start, modelSelection: implicitNone });
    assert.equal(session.model, presetModel);

    yield* adapter.sendTurn({ threadId, input: "none implicit", modelSelection: implicitNone });
    assert.deepEqual(promptModels, [presetModel]);
    assert.equal((yield* adapter.listSessions())[0]?.model, presetModel);

    const explicitNone = presetSelection("none", undefined, true);
    yield* adapter.sendTurn({ threadId, input: "none explicit", modelSelection: explicitNone });
    assert.deepEqual(promptModels, [presetModel, fixtureModel]);
    assert.equal((yield* adapter.listSessions())[0]?.model, fixtureModel);
  }).pipe(Effect.scoped, Effect.provide(testLayer)),
);

it.effect("rejects a configured preset when the extension command is missing", () =>
  Effect.gen(function* () {
    process.env.PI_CODING_AGENT_DIR = emptyAgentDir;
    const fs = yield* FileSystem.FileSystem;
    yield* fs.writeFileString(
      NodePath.join(emptyAgentDir, "presets.json"),
      '{"build":{"model":"test/build"}}',
    );
    const adapter = yield* makePiAdapter();
    const error = yield* adapter
      .startSession({
        ...start,
        modelSelection: presetSelection("build"),
      })
      .pipe(Effect.flip);
    assert.equal(error._tag, "ProviderAdapterRequestError");
    assert.isFalse(yield* adapter.hasSession(threadId));
    assert.deepEqual(prompts, []);
  }).pipe(Effect.scoped, Effect.provide(testLayer)),
);

it.effect("sends one ordinary user turn with no preset config or extension", () =>
  Effect.gen(function* () {
    process.env.PI_CODING_AGENT_DIR = noPresetAgentDir;
    const fs = yield* FileSystem.FileSystem;
    assert.deepEqual(yield* fs.readDirectory(noPresetAgentDir), []);

    const adapter = yield* makePiAdapter();
    const completed: string[] = [];
    yield* adapter.streamEvents.pipe(
      Stream.runForEach((event) =>
        Effect.sync(() => {
          if (event.type === "turn.completed" && event.turnId) completed.push(event.turnId);
        }),
      ),
      Effect.forkScoped({ startImmediately: true }),
    );

    const session = yield* adapter.startSession(start);
    assert.equal(session.status, "ready");
    yield* adapter.sendTurn({ threadId, input: "ordinary user message" });

    assert.deepEqual(prompts, ["ordinary user message"]);
    assert.deepEqual(commandEntries, []);
    assert.equal(completed.length, 1);
    assert.equal((yield* adapter.listSessions())[0]?.status, "ready");
  }).pipe(Effect.scoped, Effect.provide(testLayer)),
);

it.effect("expands a Pi prompt template with slash-command arguments through the SDK", () =>
  Effect.gen(function* () {
    const adapter = yield* makePiAdapter();
    yield* adapter.startSession({ ...start, cwd: reviewCwd });

    const error = yield* adapter.sendTurn({ threadId, input: "/review one two" }).pipe(Effect.flip);

    assert.equal(error._tag, "ProviderAdapterRequestError");
    assert.deepEqual(prompts, ["/review one two"]);
    assert.deepEqual(reviewPrompts, ["Review one against two"]);
  }).pipe(Effect.scoped, Effect.provide(testLayer)),
);

it.effect(
  "settles a native Pi extension command that changes state without starting a model run",
  () =>
    Effect.gen(function* () {
      const adapter = yield* makePiAdapter();
      const completed: unknown[] = [];
      yield* adapter.streamEvents.pipe(
        Stream.runForEach((event) =>
          Effect.sync(() => {
            if (event.type === "turn.completed") completed.push(event.payload.state);
          }),
        ),
        Effect.forkScoped({ startImmediately: true }),
      );
      yield* adapter.startSession(start);
      yield* adapter.sendTurn({ threadId, input: "/fixture-command one two" });
      assert.deepEqual(commandEntries, [{ args: "one two" }]);
      assert.deepEqual(completed, ["completed"]);
      assert.equal((yield* adapter.listSessions())[0]?.status, "ready");
      assert.deepEqual(promptModels, []);
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
);

it.effect("reports swallowed native Pi extension command errors and clears the active turn", () =>
  Effect.gen(function* () {
    const adapter = yield* makePiAdapter();
    const completed: unknown[] = [];
    yield* adapter.streamEvents.pipe(
      Stream.runForEach((event) =>
        Effect.sync(() => {
          if (event.type === "turn.completed") completed.push(event.payload.state);
        }),
      ),
      Effect.forkScoped({ startImmediately: true }),
    );
    yield* adapter.startSession(start);
    const error = yield* adapter.sendTurn({ threadId, input: "/fixture-fail" }).pipe(Effect.flip);
    assert.equal(error._tag, "ProviderAdapterRequestError");
    assert.include(error.message, "Fixture command failed");
    assert.deepEqual(completed, ["failed"]);
    assert.equal((yield* adapter.listSessions())[0]?.status, "ready");
    yield* adapter.sendTurn({ threadId, input: "after the failed command" });
    assert.deepEqual(promptModels, [presetModel]);
  }).pipe(Effect.scoped, Effect.provide(testLayer)),
);

for (const input of ["$fixture-skill one two", "/skill:fixture-skill one two"]) {
  it.effect(`expands the native Pi skill body and location for ${input}`, () =>
    Effect.gen(function* () {
      const adapter = yield* makePiAdapter();
      yield* adapter.startSession({ ...start, cwd: reviewCwd });
      const error = yield* adapter.sendTurn({ threadId, input }).pipe(Effect.flip);
      assert.equal(error._tag, "ProviderAdapterRequestError");
      const directory = NodePath.join(agentDir, "skills", "fixture-skill");
      assert.deepEqual(reviewPrompts, [
        `<skill name="fixture-skill" location="${NodePath.join(directory, "SKILL.md")}">\nReferences are relative to ${directory}.\n\nNative skill instruction.\n</skill>\n\none two`,
      ]);
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );
}

it.effect(
  "steers a leading T3 skill chip through native Pi expansion without replacing the active turn",
  () =>
    Effect.gen(function* () {
      const adapter = yield* makePiAdapter();
      const streaming = Promise.withResolvers<AgentSession>();
      const started: string[] = [];
      const completed: string[] = [];
      yield* adapter.streamEvents.pipe(
        Stream.runForEach((event) =>
          Effect.sync(() => {
            if (event.type === "turn.started" && event.turnId) started.push(event.turnId);
            if (event.type === "turn.completed" && event.turnId) completed.push(event.turnId);
          }),
        ),
        Effect.forkScoped({ startImmediately: true }),
      );
      yield* adapter.startSession({ ...start, cwd: reviewCwd });
      vi.mocked(AgentSession.prototype.prompt).mockImplementationOnce(async function (
        this: AgentSession,
        text,
        options,
      ) {
        prompts.push(text);
        options?.preflightResult?.(true);
        // Hold native settlement until after steering, without starting a model run.
        streaming.resolve(this);
      });
      const originalTurn = yield* adapter
        .sendTurn({ threadId, input: "active native turn" })
        .pipe(Effect.forkScoped({ startImmediately: true }));
      const sdk = yield* Effect.promise(() => streaming.promise);
      const isStreaming = vi.spyOn(sdk, "isStreaming", "get").mockReturnValue(true);
      const steer = vi.spyOn(sdk, "steer");
      const agentSteer = vi.spyOn(sdk.agent, "steer");
      try {
        const active = (yield* adapter.listSessions())[0]!;
        assert.isDefined(active.activeTurnId);
        assert.equal(active.status, "running");
        const accepted = yield* adapter.sendTurn({ threadId, input: "$fixture-skill one two" });
        assert.deepEqual(steer.mock.calls, [["/skill:fixture-skill one two", undefined]]);
        const directory = NodePath.join(agentDir, "skills", "fixture-skill");
        assert.equal(agentSteer.mock.calls.length, 1);
        assert.deepInclude(agentSteer.mock.calls[0]![0], {
          role: "user",
          content: [
            {
              type: "text",
              text: `<skill name="fixture-skill" location="${NodePath.join(directory, "SKILL.md")}">\nReferences are relative to ${directory}.\n\nNative skill instruction.\n</skill>\n\none two`,
            },
          ],
        });
        assert.equal(accepted.turnId, active.activeTurnId);
        assert.equal((yield* adapter.listSessions())[0]?.activeTurnId, active.activeTurnId);
        assert.equal((yield* adapter.listSessions())[0]?.status, "running");
        assert.deepEqual(prompts, ["active native turn"]);
        assert.deepEqual(started, [active.activeTurnId]);
        assert.deepEqual(completed, []);

        isStreaming.mockRestore();
        const emit = Reflect.get(sdk, "_emit") as (event: { type: "agent_settled" }) => void;
        emit.call(sdk, { type: "agent_settled" });
        assert.equal((yield* Fiber.join(originalTurn)).turnId, active.activeTurnId);
        assert.deepEqual(started, [active.activeTurnId]);
        assert.deepEqual(completed, [active.activeTurnId]);
        assert.equal((yield* adapter.listSessions())[0]?.status, "ready");
      } finally {
        isStreaming.mockRestore();
        steer.mockRestore();
        agentSteer.mockRestore();
      }
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
);

it.effect("leaves unknown, quoted, and nonleading Pi skill-like tokens as ordinary text", () =>
  Effect.gen(function* () {
    const adapter = yield* makePiAdapter();
    yield* adapter.startSession({ ...start, cwd: reviewCwd });
    const inputs = ["$unknown one", '"$fixture-skill" one', "Explain $fixture-skill"];
    for (const input of inputs) yield* adapter.sendTurn({ threadId, input });
    assert.deepEqual(prompts, inputs);
    assert.deepEqual(reviewPrompts, []);
    assert.equal((yield* adapter.listSessions())[0]?.status, "ready");
  }).pipe(Effect.scoped, Effect.provide(testLayer)),
);

it.effect("rejects a swallowed preset command failure before starting or sending a real turn", () =>
  Effect.gen(function* () {
    const adapter = yield* makePiAdapter();
    const failedStart = yield* adapter
      .startSession({ ...start, modelSelection: presetSelection("broken") })
      .pipe(Effect.flip);
    assert.equal(failedStart._tag, "ProviderAdapterRequestError");
    assert.isFalse(yield* adapter.hasSession(threadId));
    assert.deepEqual(prompts, ["/preset broken"]);

    yield* adapter.startSession(start);
    const failedSend = yield* adapter
      .sendTurn({ threadId, input: "never sent", modelSelection: presetSelection("broken") })
      .pipe(Effect.flip);
    assert.equal(failedSend._tag, "ProviderAdapterRequestError");
    assert.deepEqual(prompts, ["/preset broken", "/preset broken"]);
    assert.deepEqual(promptModels, []);

    // Failed commands are not cached as successfully applied.
    const retried = yield* adapter
      .sendTurn({ threadId, input: "still not sent", modelSelection: presetSelection("broken") })
      .pipe(Effect.flip);
    assert.equal(retried._tag, "ProviderAdapterRequestError");
    assert.deepEqual(prompts, ["/preset broken", "/preset broken", "/preset broken"]);
  }).pipe(Effect.scoped, Effect.provide(testLayer)),
);

it.effect("ignores unrelated extension errors during a successful preset command", () =>
  Effect.gen(function* () {
    const adapter = yield* makePiAdapter();
    yield* adapter.startSession({ ...start, modelSelection: presetSelection("noisy") });
    yield* adapter.sendTurn({
      threadId,
      input: "real turn",
      modelSelection: presetSelection("noisy"),
    });
    assert.deepEqual(prompts, ["/preset noisy", "real turn"]);
    assert.deepEqual(commandEntries, [{ name: "noisy" }]);
  }).pipe(Effect.scoped, Effect.provide(testLayer)),
);

it.effect("preflights image attachments before applying a newly selected preset", () =>
  Effect.gen(function* () {
    const adapter = yield* makePiAdapter();
    yield* adapter.startSession(start);
    const error = yield* adapter
      .sendTurn({
        threadId,
        input: "hello",
        attachments: [
          {
            type: "image",
            id: `${threadId}-00000000-0000-0000-0000-000000000001.png`,
            name: "missing.png",
            mimeType: "image/png",
            sizeBytes: 1,
          },
        ],
        modelSelection: presetSelection("build"),
      })
      .pipe(Effect.flip);
    assert.equal(error._tag, "ProviderAdapterRequestError");
    assert.deepEqual(prompts, []);
    assert.deepStrictEqual(yield* adapter.readThread(threadId), { threadId, turns: [] });
    assert.equal((yield* adapter.listSessions())[0]?.status, "ready");
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
