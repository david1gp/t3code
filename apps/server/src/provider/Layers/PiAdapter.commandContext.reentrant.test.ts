// @effect-diagnostics nodeBuiltinImport:off - isolated pinned-SDK fake-provider fixture.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { AgentSession, VERSION, type ExtensionError } from "@earendil-works/pi-coding-agent";
import { assert, it } from "@effect/vitest";
import { afterAll, beforeAll, vi } from "vite-plus/test";
import { ProviderDriverKind, ThreadId, type ProviderRuntimeEvent } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { ServerConfig } from "../../config.ts";
import { makePiAdapter } from "./PiAdapter.ts";

const agentDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-pi-command-reentrant-"));
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
const controlKey = Symbol.for("t3.pi.command-context.reentrant.test");
const commandName = "wait-idle-active";
const guardError = "Pi command ctx.waitForIdle() is only supported while the agent is idle.";
const testLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "pi-command-reentrant-test-",
}).pipe(Layer.provideMerge(NodeServices.layer));

beforeAll(() => {
  process.env.PI_CODING_AGENT_DIR = agentDir;
  NodeFS.mkdirSync(NodePath.join(agentDir, "extensions"));
  const pinnedSDK = NodeFS.realpathSync("node_modules/@earendil-works/pi-coding-agent");
  NodeFS.symlinkSync(
    NodePath.dirname(NodePath.dirname(pinnedSDK)),
    NodePath.join(agentDir, "node_modules"),
  );
  NodeFS.writeFileSync(
    NodePath.join(agentDir, "settings.json"),
    '{"retry":{"enabled":false},"compaction":{"enabled":false},"cacheWarming":{"enabled":false}}',
  );
  NodeFS.writeFileSync(
    NodePath.join(agentDir, "extensions", "reentrant.js"),
    `import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
     export default function (pi) {
       const control = globalThis[Symbol.for("t3.pi.command-context.reentrant.test")];
       pi.registerProvider("reentrant-fixture", {
         api: "reentrant-fixture", apiKey: "isolated-fake-provider", baseUrl: "https://fixture.invalid",
         models: [{ id: "fixture", name: "Fixture", reasoning: true, input: ["text"],
           cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
           contextWindow: 100000, maxTokens: 1000 }],
         streamSimple: (model) => {
           const stream = createAssistantMessageEventStream();
           control.calls++;
           control.providerEntered.resolve({ provider: model.provider, id: model.id, api: model.api });
           void control.releaseProvider.promise.then(() => {
             const message = { role: "assistant", api: model.api, provider: model.provider, model: model.id,
               content: [{ type: "text", text: "Original turn finished" }],
               usage: { input: 2, output: 3, cacheRead: 0, cacheWrite: 0, totalTokens: 5,
                 cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
               stopReason: "stop", timestamp: 1 };
             stream.push({ type: "done", reason: "stop", message });
           });
           return stream;
         }
       });
       pi.on("session_start", async (_event, ctx) => {
         await pi.setModel(ctx.modelRegistry.find("reentrant-fixture", "fixture"));
       });
       pi.registerCommand("${commandName}", { handler: async (_args, ctx) => {
         control.handlerReached.resolve();
         await ctx.waitForIdle();
         control.waitReturned = true;
       } });
     }`,
  );
});

afterAll(() => {
  Reflect.deleteProperty(globalThis, controlKey);
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  NodeFS.rmSync(agentDir, { recursive: true, force: true });
});

it.effect(
  "rejects active registered-command waitForIdle through real SDK dispatch without deadlocking the original turn",
  () =>
    Effect.gen(function* () {
      assert.equal(VERSION, "0.87.1");
      const control = {
        calls: 0,
        waitReturned: false,
        providerEntered: Promise.withResolvers<{ provider: string; id: string; api: string }>(),
        releaseProvider: Promise.withResolvers<void>(),
        handlerReached: Promise.withResolvers<void>(),
      };
      Reflect.set(globalThis, controlKey, control);
      const adapter = yield* makePiAdapter();
      const events: ProviderRuntimeEvent[] = [];
      const completed = yield* Deferred.make<void>();
      yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.gen(function* () {
          events.push(event);
          if (event.type === "turn.completed") yield* Deferred.succeed(completed, undefined);
        }),
      ).pipe(Effect.forkScoped({ startImmediately: true }));

      let sdk: AgentSession | undefined;
      const commandErrors: ExtensionError[] = [];
      const matchingCommandError = Promise.withResolvers<ExtensionError>();
      let offCommandError = () => {};
      const bind = AgentSession.prototype.bindExtensions;
      const bindSpy = vi
        .spyOn(AgentSession.prototype, "bindExtensions")
        .mockImplementation(async function (this: AgentSession, bindings) {
          // eslint-disable-next-line typescript/no-this-alias -- Capture the real SDK receiver, preserving adapter-bound actions.
          sdk = this;
          offCommandError = this.extensionRunner.onError((error) => {
            if (error.event !== "command" || error.extensionPath !== `command:${commandName}`)
              return;
            commandErrors.push(error);
            matchingCommandError.resolve(error);
          });
          await bind.call(this, bindings);
        });
      const threadId = ThreadId.make("pi-command-context-reentrant");
      try {
        const session = yield* adapter.startSession({
          threadId,
          provider: ProviderDriverKind.make("pi"),
          cwd: agentDir,
          runtimeMode: "full-access",
        });
        assert.equal(session.model, "reentrant-fixture/fixture");
        assert.isDefined(sdk);
        const activeSDK = sdk!;
        assert.equal(activeSDK.model?.provider, "reentrant-fixture");
        assert.equal(activeSDK.model?.id, "fixture");
        assert.isDefined(activeSDK.extensionRunner.getCommand(commandName));

        const sending = yield* adapter
          .sendTurn({ threadId, input: "Original turn" })
          .pipe(Effect.forkScoped({ startImmediately: true }));
        const actualProvider = yield* Effect.promise(() => control.providerEntered.promise).pipe(
          Effect.timeout("5 seconds"),
        );
        assert.deepEqual(actualProvider, {
          provider: "reentrant-fixture",
          id: "fixture",
          api: "reentrant-fixture",
        });
        assert.isTrue(activeSDK.isStreaming);
        assert.isFalse(activeSDK.isIdle);

        // T3 deliberately rejects steering extension commands before SDK dispatch.
        // The real SDK dispatches them before its streaming check; retain T3's bound actions.
        const dispatch = yield* Effect.promise(() => activeSDK.prompt(`/${commandName}`)).pipe(
          Effect.forkScoped({ startImmediately: true }),
        );
        yield* Effect.promise(() => control.handlerReached.promise).pipe(
          Effect.timeout("5 seconds"),
        );
        const error = yield* Effect.promise(() => matchingCommandError.promise).pipe(
          Effect.timeout("5 seconds"),
        );
        assert.deepEqual(error, {
          extensionPath: `command:${commandName}`,
          event: "command",
          error: guardError,
        });
        // SDK prompt swallows command exceptions; the public error receipt proves rejection.
        yield* Fiber.join(dispatch).pipe(Effect.timeout("5 seconds"));
        assert.isFalse(control.waitReturned);
        assert.isTrue(activeSDK.isStreaming);
        assert.equal(events.filter((event) => event.type === "turn.completed").length, 0);

        control.releaseProvider.resolve();
        const result = yield* Fiber.join(sending).pipe(Effect.timeout("5 seconds"));
        yield* Deferred.await(completed).pipe(Effect.timeout("5 seconds"));
        yield* Effect.promise(() => activeSDK.waitForIdle()).pipe(Effect.timeout("5 seconds"));
        assert.isTrue(activeSDK.isIdle);
        assert.equal(activeSDK.pendingMessageCount, 0);
        assert.equal(control.calls, 1);
        assert.equal(commandErrors.length, 1);
        assert.deepEqual(
          events
            .filter((event) => event.type === "turn.completed")
            .map((event) => ({ turnId: event.turnId, state: event.payload.state })),
          [{ turnId: result.turnId, state: "completed" }],
        );
        assert.deepEqual(
          events
            .filter((event) => event.type === "item.completed")
            .map((event) => event.payload.finalText),
          ["Original turn finished"],
        );
      } finally {
        control.releaseProvider.resolve();
        try {
          yield* adapter.stopSession(threadId);
        } finally {
          offCommandError();
          bindSpy.mockRestore();
        }
      }
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  { timeout: 30_000 },
);
