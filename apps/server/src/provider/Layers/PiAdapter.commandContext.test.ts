// @effect-diagnostics nodeBuiltinImport:off - isolated pinned-SDK fixture.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { AgentSession, VERSION } from "@earendil-works/pi-coding-agent";
import { assert, it } from "@effect/vitest";
import { afterEach, vi } from "vite-plus/test";
import { ProviderDriverKind, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { ServerConfig } from "../../config.ts";
import { ProviderAdapterRequestError } from "../Errors.ts";
import { makePiAdapter } from "./PiAdapter.ts";

const roots: string[] = [];
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
const originalPrompt = AgentSession.prototype.prompt;
const layer = ServerConfig.layerTest(process.cwd(), { prefix: "pi-command-context-test-" }).pipe(
  Layer.provideMerge(NodeServices.layer),
);

afterEach(() => {
  vi.restoreAllMocks();
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  for (const root of roots.splice(0)) NodeFS.rmSync(root, { recursive: true, force: true });
});

function fixture() {
  assert.equal(VERSION, "0.87.1");
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "pi-command-context-"));
  roots.push(root);
  const agentDir = NodePath.join(root, "agent");
  NodeFS.mkdirSync(NodePath.join(agentDir, "extensions"), { recursive: true });
  NodeFS.symlinkSync(
    NodePath.dirname(
      NodePath.dirname(NodeFS.realpathSync("node_modules/@earendil-works/pi-coding-agent")),
    ),
    NodePath.join(agentDir, "node_modules"),
  );
  NodeFS.writeFileSync(
    NodePath.join(agentDir, "extensions", "commands.js"),
    `export default (pi) => {
      pi.registerCommand("wait-idle", { handler: async (_args, ctx) => {
        await ctx.waitForIdle();
        pi.appendEntry("command-context-result", { action: "waitForIdle" });
      } });
      for (const action of ["newSession", "fork", "navigateTree", "switchSession", "reload"]) {
        pi.registerCommand("reject-" + action, { handler: async (_args, ctx) => {
          await ctx[action](...(action === "fork" ? ["entry"] : action === "navigateTree" ? ["entry"] : action === "switchSession" ? ["session.jsonl"] : []));
        } });
      }
    }`,
  );
  process.env.PI_CODING_AGENT_DIR = agentDir;
  vi.spyOn(AgentSession.prototype, "prompt").mockImplementation(async function (
    this: AgentSession,
    text,
    options,
  ) {
    if (text.startsWith("/")) return originalPrompt.call(this, text, options);
    options?.preflightResult?.(true);
    const emit = Reflect.get(this, "_emit") as (event: { type: "agent_settled" }) => void;
    emit.call(this, { type: "agent_settled" });
  });
  const threadId = ThreadId.make(`pi-command-context-${NodePath.basename(root)}`);
  return {
    threadId,
    start: {
      threadId,
      cwd: root,
      provider: ProviderDriverKind.make("pi"),
      runtimeMode: "full-access" as const,
    },
  };
}

it.effect("waitForIdle resolves through the pinned SDK for an idle registered command", () =>
  Effect.gen(function* () {
    const f = fixture();
    const adapter = yield* makePiAdapter();
    yield* adapter.startSession(f.start);
    yield* adapter.sendTurn({ threadId: f.threadId, input: "/wait-idle" });
  }).pipe(Effect.scoped, Effect.provide(layer)),
);

it.effect(
  "rejects unsupported registered-command session actions instead of completing successfully",
  () =>
    Effect.gen(function* () {
      const f = fixture();
      const adapter = yield* makePiAdapter();
      yield* adapter.startSession(f.start);
      for (const action of [
        "newSession",
        "fork",
        "navigateTree",
        "switchSession",
        "reload",
      ] as const) {
        const failure = yield* adapter
          .sendTurn({
            threadId: f.threadId,
            input: `/reject-${action}`,
          })
          .pipe(Effect.flip);
        assert.instanceOf(failure, ProviderAdapterRequestError);
        assert.include(failure.detail, `Pi /reject-${action} failed`);
        assert.include(failure.detail, `command context action ${action} is unsupported`);
      }
    }).pipe(Effect.scoped, Effect.provide(layer)),
);
