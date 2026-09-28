import { createAgentSession } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import { ModelSelection } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { makePiTextGeneration } from "./PiTextGeneration.ts";

vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@earendil-works/pi-coding-agent")>()),
  createAgentSession: vi.fn(),
}));

const decodeModelSelection = Schema.decodeSync(ModelSelection);
const selection = decodeModelSelection({ instanceId: "pi", model: "anthropic/claude-sonnet-4-5" });

function mockSession(result: string | Error | "pending" | "model-error") {
  let listener: (event: unknown) => void = () => {};
  let idle = true;
  const unsubscribe = vi.fn();
  const session = {
    get isIdle() {
      return idle;
    },
    subscribe: vi.fn((next: (event: unknown) => void) => {
      listener = next;
      return unsubscribe;
    }),
    prompt: vi.fn(async () => {
      if (result === "pending") {
        idle = false;
        await new Promise<void>(() => {});
      }
      if (result instanceof Error) throw result;
      if (result === "model-error") {
        listener({
          type: "message_end",
          message: {
            role: "assistant",
            stopReason: "error",
            errorMessage: "provider failed",
            content: [],
          },
        });
      } else if (result !== "pending") {
        listener({
          type: "message_update",
          assistantMessageEvent: { type: "text_delta", delta: result },
        });
        listener({
          type: "message_end",
          message: {
            role: "assistant",
            stopReason: "stop",
            content: [{ type: "text", text: result }],
          },
        });
      }
    }),
    abort: vi.fn(async () => {
      idle = true;
    }),
    dispose: vi.fn(),
  };
  vi.mocked(createAgentSession).mockResolvedValue({ session } as unknown as Awaited<
    ReturnType<typeof createAgentSession>
  >);
  return { session, unsubscribe };
}

describe("Pi SDK background generation", () => {
  it.effect(
    "generates all four structured outputs using disposable no-tools in-memory sessions",
    () =>
      Effect.gen(function* () {
        const sdk = mockSession(
          '{"subject":" Fix test ","body":"Details","branch":"feature/test"}',
        );
        const generator = makePiTextGeneration();
        const commit = yield* generator.generateCommitMessage({
          cwd: process.cwd(),
          branch: null,
          stagedSummary: "test",
          stagedPatch: "patch",
          includeBranch: true,
          modelSelection: selection,
        });
        expect(commit.subject).toBe("Fix test");
        expect(commit.branch).toBe("feature/test");

        mockSession('{"title":" A change ","body":"Explanation"}');
        expect(
          (yield* generator.generatePrContent({
            cwd: process.cwd(),
            baseBranch: "main",
            headBranch: "topic",
            commitSummary: "test",
            diffSummary: "test",
            diffPatch: "patch",
            modelSelection: selection,
          })).title,
        ).toBe("A change");

        mockSession('{"branch":"feature/test"}');
        expect(
          (yield* generator.generateBranchName({
            cwd: process.cwd(),
            message: "test",
            modelSelection: selection,
          })).branch,
        ).toBe("feature/test");

        mockSession('{"title":" Test title ","needsRefinement":true}');
        expect(
          yield* generator.generateThreadTitle({
            cwd: process.cwd(),
            message: "test",
            modelSelection: selection,
          }),
        ).toEqual({ title: "Test title", needsRefinement: true });

        expect(createAgentSession).toHaveBeenCalledTimes(4);
        for (const [options] of vi.mocked(createAgentSession).mock.calls) {
          expect(options?.model?.provider).toBe("anthropic");
          expect(options?.model?.id).toBe("claude-sonnet-4-5");
          expect(options?.sessionManager?.getSessionFile()).toBeUndefined();
          expect(options?.noTools).toBe("all");
          expect(options?.resourceLoader?.getExtensions().extensions).toEqual([]);
        }
        expect(sdk.session.prompt).toHaveBeenCalledWith(expect.any(String), {
          expandPromptTemplates: false,
        });
        expect(sdk.unsubscribe).toHaveBeenCalledOnce();
        expect(sdk.session.dispose).toHaveBeenCalledOnce();
      }),
  );

  it.effect("rejects unknown models and authentication errors without leaving sessions open", () =>
    Effect.gen(function* () {
      const generator = makePiTextGeneration();
      vi.mocked(createAgentSession).mockClear();
      const invalid = yield* Effect.flip(
        generator.generateBranchName({
          cwd: process.cwd(),
          message: "test",
          modelSelection: decodeModelSelection({ instanceId: "pi", model: "missing/missing" }),
        }),
      );
      expect(invalid.detail).toBe("Pi text generation failed.");
      expect(String(invalid.cause)).toContain("was not found");
      expect(createAgentSession).not.toHaveBeenCalled();

      const sdk = mockSession(new Error("No API key for anthropic"));
      const unauthenticated = yield* Effect.flip(
        generator.generateBranchName({
          cwd: process.cwd(),
          message: "test",
          modelSelection: selection,
        }),
      );
      expect(String(unauthenticated.cause)).toContain("No API key");
      expect(sdk.session.dispose).toHaveBeenCalledOnce();
      expect(sdk.unsubscribe).toHaveBeenCalledOnce();
    }),
  );

  it.effect("reports SDK model failures and malformed structured output", () =>
    Effect.gen(function* () {
      const generator = makePiTextGeneration();
      const failed = mockSession("model-error");
      const modelError = yield* Effect.flip(
        generator.generateThreadTitle({
          cwd: process.cwd(),
          message: "test",
          modelSelection: selection,
        }),
      );
      expect(String(modelError.cause)).toContain("provider failed");
      expect(failed.session.dispose).toHaveBeenCalledOnce();

      const invalid = mockSession("not json");
      const invalidOutput = yield* Effect.flip(
        generator.generateBranchName({
          cwd: process.cwd(),
          message: "test",
          modelSelection: selection,
        }),
      );
      expect(invalidOutput.detail).toBe("Pi returned invalid structured text.");
      expect(invalid.session.dispose).toHaveBeenCalledOnce();
    }),
  );

  it.live("aborts and disposes a timed-out generation", () =>
    Effect.gen(function* () {
      const sdk = mockSession("pending");
      const timeout = yield* Effect.flip(
        makePiTextGeneration({ timeoutMs: 10 }).generateBranchName({
          cwd: process.cwd(),
          message: "test",
          modelSelection: selection,
        }),
      );
      expect(timeout.detail).toBe("Pi text generation timed out.");
      expect(sdk.session.abort).toHaveBeenCalledOnce();
      expect(sdk.session.dispose).toHaveBeenCalledOnce();
    }),
  );
});
