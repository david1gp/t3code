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
  TurnId,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
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
const jsonEncode = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
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
      pi.on("input", async (event) => {
        if (event.text.startsWith("handled ")) return { action: "handled" };
        return { action: "continue" };
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

for (const replacement of [false, true]) {
  it.effect(
    `drains real SDK aborted tools before ${replacement ? "opening a same-file replacement" : "shutdown and disposal"}`,
    () =>
      Effect.gen(function* () {
        const adapter = yield* makePiAdapter();
        const toolEntered = Promise.withResolvers<AgentSession>();
        const toolAborted = Promise.withResolvers<void>();
        const toolRelease = Promise.withResolvers<void>();
        const settling = Promise.withResolvers<void>();
        const settleRelease = Promise.withResolvers<void>();
        const events: ProviderRuntimeEvent[] = [];
        const order: string[] = [];
        const baselinePrompt = vi.mocked(AgentSession.prototype.prompt).getMockImplementation()!;
        const promptSpy = vi.mocked(AgentSession.prototype.prompt);
        const authSpy = vi.spyOn(ModelRuntime.prototype, "getAuth").mockResolvedValue({
          auth: { apiKey: "isolated-fake-provider" },
        });
        let disposeSpy: ReturnType<typeof vi.spyOn> | undefined;
        let emitSpy: ReturnType<typeof vi.spyOn> | undefined;
        let handlersSpy: ReturnType<typeof vi.spyOn> | undefined;
        const openSpy = vi.spyOn(SessionManager, "open");
        let publicResultBeforePersistence = false;
        promptSpy.mockImplementation(async function (this: AgentSession, text, options) {
          if (text.startsWith("/preset ")) return baselinePrompt.call(this, text, options);
          // eslint-disable-next-line typescript/no-this-alias -- SDK prototype fixture captures its receiver.
          const sdk = this;
          const dispose = sdk.dispose.bind(sdk);
          disposeSpy = vi.spyOn(sdk, "dispose").mockImplementation(() => {
            order.push("dispose");
            dispose();
          });
          const hasHandlers = sdk.extensionRunner.hasHandlers.bind(sdk.extensionRunner);
          handlersSpy = vi
            .spyOn(sdk.extensionRunner, "hasHandlers")
            .mockImplementation((type) => type === "session_shutdown" || hasHandlers(type));
          const emit = sdk.extensionRunner.emit.bind(sdk.extensionRunner);
          emitSpy = vi.spyOn(sdk.extensionRunner, "emit").mockImplementation(async (...args) => {
            if (args[0].type === "agent_settled") {
              settling.resolve();
              await settleRelease.promise;
              order.push("settled");
            }
            if (args[0].type === "session_shutdown") order.push("shutdown");
            return emit(...args);
          });
          sdk.subscribe((event) => {
            if (event.type === "message_end" && event.message.role === "toolResult") {
              publicResultBeforePersistence = !sdk.sessionManager
                .getBranch()
                .some((entry) => entry.type === "message" && entry.message.role === "toolResult");
              order.push("tool-result-listener");
            }
          });
          let calls = 0;
          sdk.agent.streamFunction = (model) => {
            const tool = sdk.agent.state.tools.find((tool) => tool.name === "bash")!;
            // The request projection has selected the real executable tool. Keep
            // its schema and SDK hooks, replacing only external execution.
            tool.execute = async (_id, _args, signal) => {
              signal?.addEventListener("abort", () => toolAborted.resolve(), { once: true });
              toolEntered.resolve(sdk);
              await toolRelease.promise;
              return {
                content: [{ type: "text", text: "persisted aborted tool result" }],
                details: {},
              };
            };
            calls++;
            const message = {
              role: "assistant" as const,
              api: model.api,
              provider: model.provider,
              model: model.id,
              content:
                calls === 1
                  ? [
                      {
                        type: "toolCall" as const,
                        id: "abort-tool",
                        name: "bash",
                        arguments: { command: "fixture" },
                      },
                    ]
                  : [],
              usage: {
                input: 1,
                output: 1,
                cacheRead: 0,
                cacheWrite: 0,
                totalTokens: 2,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
              },
              stopReason: calls === 1 ? ("toolUse" as const) : ("stop" as const),
              timestamp: 1,
            };
            return {
              async *[Symbol.asyncIterator]() {
                yield { type: "done", reason: "toolUse", message };
              },
              result: async () => message,
            } as unknown as ReturnType<AgentSession["agent"]["streamFunction"]>;
          };
          return originalPrompt.call(sdk, text, options);
        });
        yield* adapter.streamEvents.pipe(
          Stream.runForEach((event) => Effect.sync(() => events.push(event))),
          Effect.forkScoped({ startImmediately: true }),
        );
        try {
          const session = yield* adapter.startSession(start);
          const send = yield* adapter
            .sendTurn({ threadId, input: "abort a real tool" })
            .pipe(Effect.result, Effect.forkScoped({ startImmediately: true }));
          const sdk = yield* Effect.promise(() => toolEntered.promise);
          const path = sdk.sessionManager.getSessionFile()!;
          const outgoingTurnId = (yield* adapter.listSessions())[0]!.activeTurnId;
          const teardown = yield* (
            replacement
              ? adapter.startSession({ ...start, resumeCursor: session.resumeCursor })
              : adapter.stopSession(threadId)
          ).pipe(Effect.forkScoped({ startImmediately: true }));
          yield* Effect.promise(() => toolAborted.promise);
          assert.deepEqual(order, []);
          assert.equal(openSpy.mock.calls.length, 0);
          toolRelease.resolve();
          yield* Effect.promise(() => settling.promise);
          assert.isTrue(publicResultBeforePersistence);
          assert.deepEqual(order, ["tool-result-listener"]);
          assert.equal(openSpy.mock.calls.length, 0);
          assert.isTrue(
            sdk.sessionManager
              .getBranch()
              .some((entry) => entry.type === "message" && entry.message.role === "toolResult"),
          );
          settleRelease.resolve();
          yield* Fiber.join(teardown);
          yield* Fiber.join(send);
          assert.deepEqual(order, ["tool-result-listener", "settled", "shutdown", "dispose"]);
          if (!replacement)
            yield* adapter.startSession({ ...start, resumeCursor: session.resumeCursor });
          assert.equal(openSpy.mock.calls.length, 1);
          assert.equal(openSpy.mock.calls[0]![0], path);
          const history = yield* adapter.readThread(threadId);
          assert.equal(history.turns[0]!.id, outgoingTurnId);
          assert.isTrue(
            history.turns[0]!.items.some(
              (item) => (item as { role: string }).role === "toolResult",
            ),
          );
          assert.include(yield* jsonEncode(history), "persisted aborted tool result");
          assert.deepEqual(
            events
              .filter((event) => event.type === "turn.completed")
              .map((event) => ({ turnId: event.turnId, state: event.payload.state })),
            [{ turnId: outgoingTurnId, state: "cancelled" }],
          );
          assert.equal(events.filter((event) => event.type === "session.exited").length, 1);
          yield* adapter.stopSession(threadId);
        } finally {
          toolRelease.resolve();
          settleRelease.resolve();
          promptSpy.mockImplementation(baselinePrompt);
          disposeSpy?.mockRestore();
          emitSpy?.mockRestore();
          handlersSpy?.mockRestore();
          authSpy.mockRestore();
          openSpy.mockRestore();
        }
      }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );
}

it.effect(
  "rejects invalid replacements without destroying the usable Pi session or opening a manager",
  () =>
    Effect.gen(function* () {
      const adapter = yield* makePiAdapter();
      const previous = yield* adapter.startSession(start);
      const dispose = vi.spyOn(AgentSession.prototype, "dispose");
      const open = vi.spyOn(SessionManager, "open");
      try {
        const config = yield* ServerConfig;
        const fs = yield* FileSystem.FileSystem;
        const invalidId = "00000000-0000-0000-0000-000000000098";
        const directory = NodePath.join(config.stateDir, "pi-sessions", "pi", threadId);
        yield* fs.writeFileString(
          NodePath.join(directory, `fixture_${invalidId}.jsonl`),
          yield* jsonEncode({ type: "session", id: "00000000-0000-0000-0000-000000000097" }),
        );
        for (const replacement of [
          { ...start, resumeCursor: { schemaVersion: 1, sessionId: invalidId } },
          {
            ...start,
            resumeCursor: { schemaVersion: 1, sessionId: "00000000-0000-0000-0000-000000000099" },
          },
          { ...start, resumeCursor: { sessionId: "bad-cursor" } },
          {
            ...start,
            modelSelection: { ...presetSelection("none", undefined, true), model: "absent/absent" },
          },
          { ...start, modelSelection: presetSelection("none", "high", true) },
        ]) {
          yield* adapter.startSession(replacement).pipe(Effect.flip);
          assert.deepEqual((yield* adapter.listSessions())[0], previous);
        }
        assert.equal(dispose.mock.calls.length, 0);
        assert.equal(open.mock.calls.length, 0);
        yield* adapter.sendTurn({ threadId, input: "still usable" });
        yield* adapter.stopSession(threadId);
      } finally {
        dispose.mockRestore();
        open.mockRestore();
      }
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
);

it.effect("stops before real SDK idle input preflight resolves and fences late inference", () =>
  Effect.gen(function* () {
    const adapter = yield* makePiAdapter();
    const entered = Promise.withResolvers<AgentSession>();
    const release = Promise.withResolvers<void>();
    const abortEntered = Promise.withResolvers<void>();
    const abortRelease = Promise.withResolvers<void>();
    const baselinePrompt = vi.mocked(AgentSession.prototype.prompt).getMockImplementation()!;
    const promptSpy = vi.mocked(AgentSession.prototype.prompt);
    const events: ProviderRuntimeEvent[] = [];
    let inputSpy: ReturnType<typeof vi.spyOn> | undefined;
    let abortSpy: ReturnType<typeof vi.spyOn> | undefined;
    let agentPrompt: ReturnType<typeof vi.spyOn> | undefined;
    let disposeSpy: ReturnType<typeof vi.spyOn> | undefined;
    let inputReleased = false;
    promptSpy.mockImplementation(async function (this: AgentSession, text, options) {
      agentPrompt = vi.spyOn(this.agent, "prompt").mockImplementation(async () => {
        throw new Error("Stopped input must not reach inference");
      });
      disposeSpy = vi.spyOn(this, "dispose");
      const emitInput = this.extensionRunner.emitInput.bind(this.extensionRunner);
      inputSpy = vi.spyOn(this.extensionRunner, "emitInput").mockImplementation(async (...args) => {
        entered.resolve(this);
        await release.promise;
        inputReleased = true;
        return emitInput(...args);
      });
      const abort = this.abort.bind(this);
      abortSpy = vi.spyOn(this, "abort").mockImplementation(async () => {
        abortEntered.resolve();
        await abortRelease.promise;
        await abort();
      });
      return originalPrompt.call(this, text, options);
    });
    yield* adapter.streamEvents.pipe(
      Stream.runForEach((event) => Effect.sync(() => events.push(event))),
      Effect.forkScoped({ startImmediately: true }),
    );
    try {
      yield* adapter.startSession(start);
      const send = yield* adapter
        .sendTurn({ threadId, input: "pending ordinary input" })
        .pipe(Effect.result, Effect.forkScoped({ startImmediately: true }));
      const sdk = yield* Effect.promise(() => entered.promise);
      assert.isTrue(sdk.isIdle);
      const stop = yield* adapter
        .stopSession(threadId)
        .pipe(Effect.forkScoped({ startImmediately: true }));
      yield* Effect.promise(() => abortEntered.promise);
      const concurrentStop = yield* adapter
        .stopAll()
        .pipe(Effect.forkScoped({ startImmediately: true }));
      abortRelease.resolve();
      yield* Fiber.join(stop);
      yield* Fiber.join(concurrentStop);
      assert.isFalse(inputReleased);
      assert.isTrue(sdk.isIdle);
      assert.equal(disposeSpy!.mock.calls.length, 1);
      assert.isFalse(yield* adapter.hasSession(threadId));
      assert.equal(agentPrompt!.mock.calls.length, 0);
      release.resolve();
      yield* Fiber.join(send);
      assert.isTrue(inputReleased);
      assert.equal(agentPrompt!.mock.calls.length, 0);
      assert.equal(events.filter((event) => event.type === "turn.started").length, 1);
      assert.deepEqual(
        events
          .filter((event) => event.type === "turn.completed")
          .map((event) => event.payload.state),
        ["cancelled"],
      );
      assert.equal(events.filter((event) => event.type === "session.exited").length, 1);
      assert.isFalse(yield* adapter.hasSession(threadId));
    } finally {
      abortRelease.resolve();
      release.resolve();
      inputSpy?.mockRestore();
      abortSpy?.mockRestore();
      agentPrompt?.mockRestore();
      disposeSpy?.mockRestore();
      promptSpy.mockImplementation(baselinePrompt);
    }
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
    assert.equal(history.turns[0]!.id, TurnId.make(`pi:${id}:0`));
    assert.equal((history.turns[0]!.items[0] as { role: string }).role, "user");
    const command = yield* adapter.sendTurn({ threadId, input: "/fixture-command resumed" });
    const ordinary = yield* adapter.sendTurn({ threadId, input: "after legacy history" });
    const associatedHistory = yield* adapter.readThread(threadId);
    assert.deepEqual(associatedHistory.turns[0], history.turns[0]);
    assert.deepEqual(
      associatedHistory.turns.map((turn) => turn.id),
      [history.turns[0]!.id, command.turnId, ordinary.turnId],
    );
    assert.equal(new Set(associatedHistory.turns.map((turn) => turn.id)).size, 3);
    yield* adapter.stopSession(threadId);
    yield* adapter.startSession({ ...start, resumeCursor: session.resumeCursor });
    assert.deepEqual(yield* adapter.readThread(threadId), associatedHistory);
    assert.equal(
      (yield* fs.readDirectory(directory)).filter((name) => name.endsWith(".jsonl")).length,
      1,
    );
    yield* adapter.stopSession(threadId);
    assert.equal(
      (yield* adapter.readThread(threadId).pipe(Effect.flip))._tag,
      "ProviderAdapterSessionNotFoundError",
    );
  }).pipe(Effect.scoped, Effect.provide(testLayer)),
);

it.effect("keeps unique Pi attempts and their SDK history associated across resume", () =>
  Effect.gen(function* () {
    const adapter = yield* makePiAdapter();
    const events: ProviderRuntimeEvent[] = [];
    const extensionSettled = yield* Deferred.make<void>();
    yield* adapter.streamEvents.pipe(
      Stream.runForEach((event) =>
        Effect.gen(function* () {
          events.push(event);
          if (
            event.type === "turn.completed" &&
            events.filter((e) => e.type === "turn.started").length === 5
          )
            yield* Deferred.succeed(extensionSettled, undefined);
        }),
      ),
      Effect.forkScoped({ startImmediately: true }),
    );
    // Run the pinned SDK's preflight, message persistence and settlement. Only
    // its provider stream is replaced: no credentials or network are used.
    const sdkSessions: AgentSession[] = [];
    const baselinePrompt = vi.mocked(AgentSession.prototype.prompt).getMockImplementation()!;
    const promptSpy = vi.spyOn(AgentSession.prototype, "prompt").mockImplementation(async function (
      this: AgentSession,
      text,
      options,
    ) {
      if (!sdkSessions.includes(this)) sdkSessions.push(this);
      if (text === "fail before a user message") {
        const modelSpy = vi.spyOn(this, "model", "get").mockReturnValue(undefined);
        try {
          return await originalPrompt.call(this, text, options);
        } finally {
          modelSpy.mockRestore();
        }
      }
      this.agent.streamFunction = (model) => {
        const message = {
          role: "assistant" as const,
          api: model.api,
          provider: model.provider,
          model: model.id,
          content: [{ type: "text" as const, text: "answer" }],
          usage: {
            input: 2,
            output: 1,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 3,
            cost: { input: 0.01, output: 0.01, cacheRead: 0, cacheWrite: 0, total: 0.02 },
          },
          stopReason: "stop" as const,
          timestamp: 1,
        };
        // A finite fake provider stream; Agent/AgentSession still own every
        // lifecycle event and the SDK's append-after-listener persistence.
        return {
          async *[Symbol.asyncIterator]() {
            yield { type: "start", partial: message };
            yield { type: "text_delta", contentIndex: 0, delta: "answer", partial: message };
            yield { type: "done", reason: "stop", message };
          },
          result: async () => message,
        } as unknown as ReturnType<AgentSession["agent"]["streamFunction"]>;
      };
      return originalPrompt.call(this, text, options);
    });
    try {
      const session = yield* adapter.startSession(start);
      const id = (session.resumeCursor as { sessionId: string }).sessionId;
      const command = yield* adapter.sendTurn({ threadId, input: "/fixture-command state" });
      const failed = yield* adapter
        .sendTurn({ threadId, input: "fail before a user message" })
        .pipe(Effect.flip);
      assert.equal(failed._tag, "ProviderAdapterRequestError");
      const earlyHistory = yield* adapter.readThread(threadId);
      assert.equal(earlyHistory.turns.length, 2);
      assert.equal(earlyHistory.turns[0]!.id, command.turnId);
      assert.deepEqual(
        earlyHistory.turns.map((turn) => turn.items),
        [[], []],
      );
      const firstSdk = sdkSessions[0]!;
      const path = firstSdk.sessionManager.getSessionFile()!;
      const persistedEarly = SessionManager.open(path);
      assert.equal(persistedEarly.getSessionId(), id);
      assert.equal(
        persistedEarly
          .getBranch()
          .filter((entry) => entry.type === "custom" && entry.customType === "t3.turn").length,
        2,
      );
      yield* adapter.stopSession(threadId);
      const resumed = yield* adapter.startSession({ ...start, resumeCursor: session.resumeCursor });
      assert.deepEqual(resumed.resumeCursor, session.resumeCursor);
      assert.deepEqual(yield* adapter.readThread(threadId), earlyHistory);
      const ordinary = yield* adapter.sendTurn({ threadId, input: "ordinary" });
      const second = yield* adapter.sendTurn({ threadId, input: "another ordinary" });
      const sdk = sdkSessions.at(-1)!;
      assert.equal(sdk.sessionManager.getSessionFile(), path);
      yield* Effect.promise(() =>
        sdk.sendCustomMessage(
          { customType: "fixture-background", content: "background", display: false },
          { triggerTurn: true },
        ),
      );
      yield* Deferred.await(extensionSettled);
      const history = yield* adapter.readThread(threadId);
      const turnIds = events
        .filter((event) => event.type === "turn.started")
        .map((event) => event.turnId);
      assert.equal(new Set(turnIds).size, 5);
      assert.deepEqual(
        history.turns.map((turn) => turn.id),
        turnIds,
      );
      assert.deepEqual(
        history.turns.map((turn) => turn.items.map((item) => (item as { role: string }).role)),
        [[], [], ["system", "user", "assistant"], ["user", "assistant"], ["custom", "assistant"]],
      );
      assert.equal(history.turns[2]!.id, ordinary.turnId);
      assert.equal(history.turns[3]!.id, second.turnId);
      const costs = events.filter(
        (event) => event.type === "turn.completed" && event.payload.totalCostUsd !== undefined,
      );
      assert.deepEqual(
        costs.map((event) => event.turnId),
        turnIds.slice(2),
      );
      assert.deepEqual(
        costs.map((event) =>
          event.type === "turn.completed" ? event.payload.totalCostUsd : undefined,
        ),
        [0.02, 0.02, 0.02],
      );
      const assistantItems = events.filter(
        (event) => event.type === "item.started" && event.payload.itemType === "assistant_message",
      );
      assert.equal(new Set(assistantItems.map((event) => event.itemId)).size, 3);
      assert.deepEqual(
        assistantItems.map((event) => event.turnId),
        turnIds.slice(2),
      );
      yield* adapter.stopSession(threadId);
      yield* adapter.startSession({ ...start, resumeCursor: session.resumeCursor });
      assert.deepEqual(yield* adapter.readThread(threadId), history);
      const afterExtension = yield* adapter.sendTurn({
        threadId,
        input: "after resumed extension",
      });
      assert.notInclude(turnIds, afterExtension.turnId);
      const finalHistory = yield* adapter.readThread(threadId);
      assert.deepEqual(finalHistory.turns.slice(0, 5), history.turns);
      assert.equal(finalHistory.turns[5]!.id, afterExtension.turnId);
      assert.equal(sdkSessions.at(-1)!.sessionManager.getSessionFile(), path);
      yield* adapter.stopSession(threadId);
    } finally {
      // The file's baseline prompt fixture applies to its other named cases.
      promptSpy.mockImplementation(baselinePrompt);
    }
  }).pipe(Effect.scoped, Effect.provide(testLayer)),
);

for (const interrupted of [false, true]) {
  it.effect(
    `settles real SDK handled ordinary input without inference${interrupted ? " after interruption" : ""}`,
    () =>
      Effect.gen(function* () {
        const adapter = yield* makePiAdapter();
        const entered = Promise.withResolvers<AgentSession>();
        const release = Promise.withResolvers<void>();
        const baselinePrompt = vi.mocked(AgentSession.prototype.prompt).getMockImplementation()!;
        const promptSpy = vi.mocked(AgentSession.prototype.prompt);
        let inputSpy: ReturnType<typeof vi.spyOn> | undefined;
        let agentPrompt: ReturnType<typeof vi.spyOn> | undefined;
        promptSpy.mockImplementation(async function (this: AgentSession, text, options) {
          if (text.startsWith("/preset ")) return baselinePrompt.call(this, text, options);
          const emitInput = this.extensionRunner.emitInput.bind(this.extensionRunner);
          inputSpy = vi
            .spyOn(this.extensionRunner, "emitInput")
            .mockImplementation(async (...args) => {
              entered.resolve(this);
              await release.promise;
              return emitInput(...args);
            });
          agentPrompt = vi.spyOn(this.agent, "prompt");
          return originalPrompt.call(this, text, options);
        });
        const events: ProviderRuntimeEvent[] = [];
        yield* adapter.streamEvents.pipe(
          Stream.runForEach((event) => Effect.sync(() => events.push(event))),
          Effect.forkScoped({ startImmediately: true }),
        );
        try {
          yield* adapter.startSession(start);
          const pending = yield* adapter
            .sendTurn({ threadId, input: "handled ordinary" })
            .pipe(Effect.forkScoped({ startImmediately: true }));
          const sdk = yield* Effect.promise(() => entered.promise);
          assert.isTrue(sdk.isIdle);
          assert.equal(events.filter((event) => event.type === "turn.completed").length, 0);
          if (interrupted) yield* adapter.interruptTurn(threadId);
          release.resolve();
          const result = yield* Fiber.join(pending);
          assert.equal(agentPrompt!.mock.calls.length, 0);
          assert.equal(sdk.pendingMessageCount, 0);
          assert.equal((yield* adapter.listSessions())[0]?.status, "ready");
          assert.deepEqual(
            events
              .filter((event) => event.type === "turn.completed")
              .map((event) => ({
                turnId: event.turnId,
                state: event.payload.state,
              })),
            [{ turnId: result.turnId, state: interrupted ? "cancelled" : "completed" }],
          );
          assert.equal((yield* adapter.readThread(threadId)).turns[0]?.id, result.turnId);
          yield* adapter.stopSession(threadId);
        } finally {
          release.resolve();
          inputSpy?.mockRestore();
          agentPrompt?.mockRestore();
          promptSpy.mockImplementation(baselinePrompt);
        }
      }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );
}

for (const outcome of ["running", "settled", "new work", "interrupted"] as const) {
  it.effect(`reconciles real SDK delayed steering input when the original turn is ${outcome}`, () =>
    Effect.gen(function* () {
      const adapter = yield* makePiAdapter();
      const providerEntered = Promise.withResolvers<AgentSession>();
      const providerRelease = Promise.withResolvers<void>();
      const nextProviderEntered = Promise.withResolvers<void>();
      const nextProviderRelease = Promise.withResolvers<void>();
      const inputEntered = Promise.withResolvers<void>();
      const inputRelease = Promise.withResolvers<void>();
      const baselinePrompt = vi.mocked(AgentSession.prototype.prompt).getMockImplementation()!;
      const promptSpy = vi.mocked(AgentSession.prototype.prompt);
      let calls = 0;
      promptSpy.mockImplementation(async function (this: AgentSession, text, options) {
        if (text.startsWith("/preset ")) return baselinePrompt.call(this, text, options);
        this.agent.streamFunction = (model) => {
          const nextRun = calls++ > 0 && outcome === "new work";
          const release = nextRun ? nextProviderRelease : providerRelease;
          const message = {
            role: "assistant" as const,
            api: model.api,
            provider: model.provider,
            model: model.id,
            content: [],
            usage: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 0,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
            stopReason: "stop" as const,
            timestamp: 1,
          };
          providerEntered.resolve(this);
          if (nextRun) nextProviderEntered.resolve();
          return {
            async *[Symbol.asyncIterator]() {
              await release.promise;
              yield { type: "done", reason: "stop", message };
            },
            result: async () => {
              await release.promise;
              return message;
            },
          } as unknown as ReturnType<AgentSession["agent"]["streamFunction"]>;
        };
        return originalPrompt.call(this, text, options);
      });
      let inputSpy: ReturnType<typeof vi.spyOn> | undefined;
      const events: ProviderRuntimeEvent[] = [];
      const successorSettled = yield* Deferred.make<void>();
      yield* adapter.streamEvents.pipe(
        Stream.runForEach((event) =>
          Effect.gen(function* () {
            events.push(event);
            if (events.filter((event) => event.type === "turn.completed").length === 2)
              yield* Deferred.succeed(successorSettled, undefined);
          }),
        ),
        Effect.forkScoped({ startImmediately: true }),
      );
      try {
        yield* adapter.startSession(start);
        const first = yield* adapter
          .sendTurn({ threadId, input: "first" })
          .pipe(Effect.forkScoped({ startImmediately: true }));
        const sdk = yield* Effect.promise(() => providerEntered.promise);
        const command = yield* adapter
          .sendTurn({ threadId, input: "/fixture-command cannot-steer" })
          .pipe(Effect.flip);
        assert.include(command.message, "cannot be queued");
        assert.equal(
          sdk.sessionManager
            .getBranch()
            .filter((entry) => entry.type === "custom" && entry.customType === "test-command")
            .length,
          0,
        );
        const emitInput = sdk.extensionRunner.emitInput.bind(sdk.extensionRunner);
        inputSpy = vi
          .spyOn(sdk.extensionRunner, "emitInput")
          .mockImplementation(async (...args) => {
            if (args[0] === "delayed steering") {
              inputEntered.resolve();
              await inputRelease.promise;
            }
            return emitInput(...args);
          });
        const activeId = (yield* adapter.listSessions())[0]!.activeTurnId;
        const steering = yield* adapter
          .sendTurn({ threadId, input: "delayed steering" })
          .pipe(Effect.result, Effect.forkScoped({ startImmediately: true }));
        yield* Effect.promise(() => inputEntered.promise);
        const concurrent = yield* adapter
          .sendTurn({ threadId, input: "overtaking input" })
          .pipe(Effect.flip);
        assert.include(concurrent.message, "processing steering input");
        if (outcome === "interrupted") {
          const abort = yield* adapter
            .interruptTurn(threadId)
            .pipe(Effect.forkScoped({ startImmediately: true }));
          providerRelease.resolve();
          yield* Fiber.join(abort);
        } else if (outcome !== "running") providerRelease.resolve();
        if (outcome !== "running") yield* Fiber.join(first);
        const newWork =
          outcome === "new work"
            ? yield* Effect.promise(() =>
                sdk.sendCustomMessage(
                  { customType: "fixture-new-work", content: "new work", display: false },
                  { triggerTurn: true },
                ),
              ).pipe(Effect.forkScoped({ startImmediately: true }))
            : undefined;
        if (newWork) yield* Effect.promise(() => nextProviderEntered.promise);
        inputRelease.resolve();
        const delivery = yield* Fiber.join(steering);
        if (outcome === "running") {
          assert.equal(delivery._tag, "Success");
          if (delivery._tag === "Success") assert.equal(delivery.success.turnId, activeId);
          providerRelease.resolve();
          yield* Fiber.join(first);
          assert.equal(sdk.state.messages.filter((message) => message.role === "user").length, 2);
        } else if (outcome === "settled" || outcome === "new work") {
          assert.equal(delivery._tag, "Success");
          if (delivery._tag === "Success") assert.notEqual(delivery.success.turnId, activeId);
          if (newWork) {
            assert.equal(
              delivery._tag === "Success" ? delivery.success.turnId : undefined,
              (yield* adapter.listSessions())[0]?.activeTurnId,
            );
            nextProviderRelease.resolve();
            yield* Fiber.join(newWork);
            yield* Deferred.await(successorSettled);
          }
          assert.equal(sdk.state.messages.filter((message) => message.role === "user").length, 2);
        } else {
          assert.equal(delivery._tag, "Failure");
          assert.equal(sdk.state.messages.filter((message) => message.role === "user").length, 1);
        }
        assert.equal(sdk.pendingMessageCount, 0);
        assert.equal(
          events.filter((event) => event.type === "turn.started").length,
          outcome === "settled" || outcome === "new work" ? 2 : 1,
        );
        assert.equal(
          events.filter((event) => event.type === "turn.completed").length,
          outcome === "settled" || outcome === "new work" ? 2 : 1,
        );
        if (delivery._tag === "Success") {
          const history = yield* adapter.readThread(threadId);
          const delivered = history.turns.find((turn) => turn.id === delivery.success.turnId)!;
          assert.isTrue(
            delivered.items.some((item) => (item as { role?: string }).role === "user"),
          );
        }
        const next = yield* adapter.sendTurn({ threadId, input: "handled next" });
        assert.notEqual(next.turnId, activeId);
        assert.equal((yield* adapter.listSessions())[0]?.status, "ready");
        yield* adapter.stopSession(threadId);
      } finally {
        providerRelease.resolve();
        nextProviderRelease.resolve();
        inputRelease.resolve();
        inputSpy?.mockRestore();
        promptSpy.mockImplementation(baselinePrompt);
      }
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );
}

for (const admission of ["rejected", "accepted", "interrupted"] as const) {
  it.effect(`preserves real SDK unrelated follow-ups when delayed steering is ${admission}`, () =>
    Effect.gen(function* () {
      const adapter = yield* makePiAdapter();
      const providerEntered = Promise.withResolvers<AgentSession>();
      const providerRelease = Promise.withResolvers<void>();
      const inputEntered = Promise.withResolvers<void>();
      const inputRelease = Promise.withResolvers<void>();
      const enqueued = Promise.withResolvers<void>();
      const firstReturned = Promise.withResolvers<void>();
      const acknowledgementRelease = Promise.withResolvers<void>();
      const agentEndEntered = Promise.withResolvers<void>();
      const agentEndRelease = Promise.withResolvers<void>();
      const baselinePrompt = vi.mocked(AgentSession.prototype.prompt).getMockImplementation()!;
      const promptSpy = vi.mocked(AgentSession.prototype.prompt);
      let calls = 0;
      promptSpy.mockImplementation(async function (this: AgentSession, text, options) {
        if (text.startsWith("/preset ")) return baselinePrompt.call(this, text, options);
        this.agent.streamFunction = (model) => {
          const message = {
            role: "assistant" as const,
            api: model.api,
            provider: model.provider,
            model: model.id,
            content: [],
            usage: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 0,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
            stopReason: "stop" as const,
            timestamp: 1,
          };
          const firstCall = calls++ === 0;
          providerEntered.resolve(this);
          return {
            async *[Symbol.asyncIterator]() {
              if (firstCall) await providerRelease.promise;
              yield { type: "done", reason: "stop", message };
            },
            result: async () => message,
          } as unknown as ReturnType<AgentSession["agent"]["streamFunction"]>;
        };
        if (text === "delayed steering" && admission !== "rejected") {
          // Observe the real SDK's acceptance, then deliver its receipt only after
          // native settlement. No private queue/lifecycle methods are replaced.
          let accepted = false;
          await originalPrompt.call(this, text, {
            ...options,
            preflightResult: (success) => {
              accepted = success;
              enqueued.resolve();
            },
          });
          await acknowledgementRelease.promise;
          options?.preflightResult?.(accepted);
          return;
        }
        try {
          return await originalPrompt.call(this, text, options);
        } finally {
          if (text === "first") firstReturned.resolve();
        }
      });
      let inputSpy: ReturnType<typeof vi.spyOn> | undefined;
      let modelSpy: ReturnType<typeof vi.spyOn> | undefined;
      let clearQueueSpy: ReturnType<typeof vi.spyOn> | undefined;
      let abortSpy: ReturnType<typeof vi.spyOn> | undefined;
      let unsubscribeAgent = () => {};
      const events: ProviderRuntimeEvent[] = [];
      yield* adapter.streamEvents.pipe(
        Stream.runForEach((event) => Effect.sync(() => events.push(event))),
        Effect.forkScoped({ startImmediately: true }),
      );
      try {
        yield* adapter.startSession(start);
        const first = yield* adapter
          .sendTurn({ threadId, input: "first" })
          .pipe(Effect.forkScoped({ startImmediately: true }));
        const sdk = yield* Effect.promise(() => providerEntered.promise);
        const emitInput = sdk.extensionRunner.emitInput.bind(sdk.extensionRunner);
        inputSpy = vi
          .spyOn(sdk.extensionRunner, "emitInput")
          .mockImplementation(async (...args) => {
            if (args[0] === "delayed steering") {
              inputEntered.resolve();
              await inputRelease.promise;
            }
            return emitInput(...args);
          });
        clearQueueSpy = vi.spyOn(sdk, "clearQueue");
        const activeId = (yield* adapter.listSessions())[0]!.activeTurnId;
        const steering = yield* adapter
          .sendTurn({ threadId, input: "delayed steering" })
          .pipe(Effect.result, Effect.forkScoped({ startImmediately: true }));
        yield* Effect.promise(() => inputEntered.promise);
        if (admission === "rejected") {
          providerRelease.resolve();
          yield* Fiber.join(first);
          // The extension owns this idle follow-up; steering has not enqueued.
          yield* Effect.promise(() =>
            sdk.followUp("unrelated extension follow-up", undefined, { source: "extension" }),
          );
          modelSpy = vi.spyOn(sdk, "model", "get").mockReturnValue(undefined);
          inputRelease.resolve();
        } else {
          if (admission === "interrupted")
            yield* Effect.promise(() =>
              sdk.followUp("unrelated extension follow-up", undefined, { source: "extension" }),
            );
          // Public SDK abort stops the old run's queue draining but does not own or
          // discard queued inputs. T3 interrupt intentionally has a different policy.
          const abortEntered = Promise.withResolvers<void>();
          const sdkAbort = sdk.abort.bind(sdk);
          abortSpy = vi.spyOn(sdk, "abort").mockImplementation(() => {
            const result = sdkAbort();
            abortEntered.resolve();
            return result;
          });
          unsubscribeAgent = sdk.agent.subscribe(async (event) => {
            if (event.type !== "agent_end") return;
            agentEndEntered.resolve();
            await agentEndRelease.promise;
          });
          const abort = yield* (
            admission === "interrupted"
              ? adapter.interruptTurn(threadId)
              : Effect.promise(() => sdk.abort())
          ).pipe(Effect.forkScoped({ startImmediately: true }));
          yield* Effect.promise(() => abortEntered.promise);
          providerRelease.resolve();
          yield* Effect.promise(() => agentEndEntered.promise);
          if (admission === "accepted")
            yield* Effect.promise(() =>
              sdk.followUp("unrelated extension follow-up", undefined, { source: "extension" }),
            );
          inputRelease.resolve();
          yield* Effect.promise(() => enqueued.promise);
          if (admission === "accepted") {
            assert.deepEqual(sdk.getSteeringMessages(), ["delayed steering"]);
            assert.deepEqual(sdk.getFollowUpMessages(), ["unrelated extension follow-up"]);
          }
          agentEndRelease.resolve();
          yield* Fiber.join(abort);
          yield* Fiber.join(first);
          yield* Effect.promise(() => firstReturned.promise);
          assert.isTrue(sdk.isIdle);
          acknowledgementRelease.resolve();
        }
        const delivery = yield* Fiber.join(steering);
        if (admission === "rejected") {
          assert.equal(delivery._tag, "Failure");
          assert.equal(clearQueueSpy.mock.calls.length, 0);
          assert.deepEqual(sdk.getFollowUpMessages(), ["unrelated extension follow-up"]);
          modelSpy!.mockRestore();
          yield* Effect.promise(() =>
            sdk.sendCustomMessage(
              { customType: "fixture-resume", content: "", display: false },
              { triggerTurn: true },
            ),
          );
        } else if (admission === "accepted") {
          assert.equal(delivery._tag, "Success");
          if (delivery._tag === "Success") assert.notEqual(delivery.success.turnId, activeId);
          assert.equal(clearQueueSpy.mock.calls.length, 0);
          const history = yield* adapter.readThread(threadId);
          assert.equal(history.turns.length, 2);
          if (delivery._tag === "Success")
            assert.equal(history.turns[1]!.id, delivery.success.turnId);
          assert.deepEqual(
            history.turns[1]!.items.filter(
              (item) => (item as { role?: string }).role === "user",
            ).map((item) =>
              (item as { content: Array<{ text: string }> }).content
                .map((part) => part.text)
                .join(""),
            ),
            ["delayed steering", "unrelated extension follow-up"],
          );
          assert.equal(events.filter((event) => event.type === "turn.completed").length, 2);
        } else {
          assert.equal(delivery._tag, "Failure");
          assert.equal(events.filter((event) => event.type === "turn.started").length, 1);
        }
        const users = sdk.state.messages
          .filter((message) => message.role === "user")
          .map((message) =>
            typeof message.content === "string"
              ? message.content
              : message.content
                  .flatMap((part) => (part.type === "text" ? [part.text] : []))
                  .join(""),
          );
        assert.deepEqual(
          users,
          admission === "accepted"
            ? ["first", "delayed steering", "unrelated extension follow-up"]
            : admission === "rejected"
              ? ["first", "unrelated extension follow-up"]
              : ["first"],
        );
        assert.equal(sdk.pendingMessageCount, 0);
        yield* adapter.stopSession(threadId);
      } finally {
        providerRelease.resolve();
        inputRelease.resolve();
        acknowledgementRelease.resolve();
        agentEndRelease.resolve();
        unsubscribeAgent();
        inputSpy?.mockRestore();
        modelSpy?.mockRestore();
        clearQueueSpy?.mockRestore();
        abortSpy?.mockRestore();
        promptSpy.mockImplementation(baselinePrompt);
      }
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );
}

it.effect("waits for real SDK agent_settled when a handled input triggers inference", () =>
  Effect.gen(function* () {
    const adapter = yield* makePiAdapter();
    const settling = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const promptReturned = Promise.withResolvers<void>();
    const captured = Promise.withResolvers<AgentSession>();
    const baselinePrompt = vi.mocked(AgentSession.prototype.prompt).getMockImplementation()!;
    const promptSpy = vi.mocked(AgentSession.prototype.prompt);
    let inputSpy: ReturnType<typeof vi.spyOn> | undefined;
    let emitSpy: ReturnType<typeof vi.spyOn> | undefined;
    let nativeSettledReleased = false;
    const completions: boolean[] = [];
    yield* adapter.streamEvents.pipe(
      Stream.runForEach((event) =>
        Effect.sync(() => {
          if (event.type === "turn.completed") completions.push(nativeSettledReleased);
        }),
      ),
      Effect.forkScoped({ startImmediately: true }),
    );
    promptSpy.mockImplementation(async function (this: AgentSession, text, options) {
      if (text.startsWith("/preset ")) return baselinePrompt.call(this, text, options);
      captured.resolve(this);
      this.agent.streamFunction = (model) => {
        const message = {
          role: "assistant" as const,
          api: model.api,
          provider: model.provider,
          model: model.id,
          content: [],
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: "stop" as const,
          timestamp: 1,
        };
        return {
          async *[Symbol.asyncIterator]() {
            yield { type: "done", reason: "stop", message };
          },
          result: async () => message,
        } as unknown as ReturnType<AgentSession["agent"]["streamFunction"]>;
      };
      const emit = this.extensionRunner.emit.bind(this.extensionRunner);
      emitSpy = vi.spyOn(this.extensionRunner, "emit").mockImplementation(async (...args) => {
        if (args[0].type === "agent_settled") {
          settling.resolve();
          await release.promise;
          nativeSettledReleased = true;
        }
        return emit(...args);
      });
      inputSpy = vi.spyOn(this.extensionRunner, "emitInput").mockImplementation(async () => {
        void this.sendCustomMessage(
          { customType: "fixture-input-run", content: "infer", display: false },
          { triggerTurn: true },
        );
        await settling.promise;
        return { action: "handled" };
      });
      await originalPrompt.call(this, text, options);
      promptReturned.resolve();
    });
    try {
      yield* adapter.startSession(start);
      const send = yield* adapter
        .sendTurn({ threadId, input: "handled inference" })
        .pipe(Effect.forkScoped({ startImmediately: true }));
      yield* Effect.promise(() => promptReturned.promise);
      const sdk = yield* Effect.promise(() => captured.promise);
      assert.isTrue(sdk.isIdle);
      assert.deepEqual(completions, []);
      release.resolve();
      yield* Fiber.join(send);
      assert.deepEqual(completions, [true]);
      assert.equal((yield* adapter.readThread(threadId)).turns.length, 1);
      yield* adapter.stopSession(threadId);
    } finally {
      release.resolve();
      inputSpy?.mockRestore();
      emitSpy?.mockRestore();
      promptSpy.mockImplementation(baselinePrompt);
    }
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
      const isIdle = vi.spyOn(sdk, "isIdle", "get").mockReturnValue(false);
      const agentSteer = vi.spyOn(sdk.agent, "steer");
      const baselinePrompt = vi.mocked(AgentSession.prototype.prompt).getMockImplementation()!;
      vi.mocked(AgentSession.prototype.prompt).mockImplementation(function (
        this: AgentSession,
        text,
        options,
      ) {
        if (options?.streamingBehavior === "steer") return originalPrompt.call(this, text, options);
        return baselinePrompt.call(this, text, options);
      });
      try {
        const active = (yield* adapter.listSessions())[0]!;
        assert.isDefined(active.activeTurnId);
        assert.equal(active.status, "running");
        const accepted = yield* adapter.sendTurn({ threadId, input: "$fixture-skill one two" });
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
        isIdle.mockRestore();
        const emit = Reflect.get(sdk, "_emit") as (event: { type: "agent_settled" }) => void;
        emit.call(sdk, { type: "agent_settled" });
        assert.equal((yield* Fiber.join(originalTurn)).turnId, active.activeTurnId);
        assert.deepEqual(started, [active.activeTurnId]);
        assert.deepEqual(completed, [active.activeTurnId]);
        assert.equal((yield* adapter.listSessions())[0]?.status, "ready");
      } finally {
        isStreaming.mockRestore();
        isIdle.mockRestore();
        agentSteer.mockRestore();
        vi.mocked(AgentSession.prototype.prompt).mockImplementation(baselinePrompt);
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
