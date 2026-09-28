// @effect-diagnostics nodeBuiltinImport:off - Pi SDK uses the standard Pi credential directory.
import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSession,
} from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { TextGenerationError } from "@t3tools/contracts";
import { extractJsonObject } from "@t3tools/shared/schemaJson";
import * as TextGeneration from "./TextGeneration.ts";
import {
  buildBranchNamePrompt,
  buildCommitMessagePrompt,
  buildPrContentPrompt,
  buildThreadTitlePrompt,
} from "./TextGenerationPrompts.ts";
import { sanitizeBranchFragment, sanitizeFeatureBranchName } from "@t3tools/shared/git";
import {
  sanitizeCommitSubject,
  sanitizePrTitle,
  sanitizeThreadTitle,
} from "./TextGenerationUtils.ts";

const TIMEOUT_MS = 180_000;

export const makePiTextGeneration = (options: { readonly timeoutMs?: number } = {}) => {
  const generate = <S extends Schema.Codec<unknown, unknown, never>>(input: {
    readonly operation:
      | "generateCommitMessage"
      | "generatePrContent"
      | "generateBranchName"
      | "generateThreadTitle";
    readonly cwd: string;
    readonly prompt: string;
    readonly schema: S;
    readonly model: string;
  }): Effect.Effect<S["Type"], TextGenerationError> =>
    Effect.acquireUseRelease(
      Effect.tryPromise({
        try: async () => {
          const slash = input.model.indexOf("/");
          if (slash < 1 || slash === input.model.length - 1)
            throw new Error("Invalid Pi model id.");
          const runtime = await ModelRuntime.create({
            refreshOnCreate: false,
            allowModelNetwork: false,
          });
          const model = runtime.getModel(input.model.slice(0, slash), input.model.slice(slash + 1));
          if (!model) throw new Error(`Pi model ${input.model} was not found.`);
          const agentDir = getAgentDir();
          const settingsManager = SettingsManager.create(input.cwd, agentDir);
          const loader = new DefaultResourceLoader({
            cwd: input.cwd,
            agentDir,
            settingsManager,
            noExtensions: true,
            noSkills: true,
            noPromptTemplates: true,
            noContextFiles: true,
          });
          await loader.reload();
          const { session } = await createAgentSession({
            cwd: input.cwd,
            modelRuntime: runtime,
            model,
            settingsManager,
            resourceLoader: loader,
            sessionManager: SessionManager.inMemory(input.cwd),
            noTools: "all",
          });
          return session;
        },
        catch: (cause) =>
          new TextGenerationError({
            operation: input.operation,
            detail: "Pi text generation failed.",
            cause,
          }),
      }),
      (session: AgentSession) =>
        Effect.tryPromise({
          try: async () => {
            let output = "";
            let finalOutput: string | undefined;
            let failure: string | undefined;
            const unsubscribe = session.subscribe((event) => {
              if (
                event.type === "message_update" &&
                event.assistantMessageEvent.type === "text_delta"
              )
                output += event.assistantMessageEvent.delta;
              if (event.type === "message_end" && event.message.role === "assistant") {
                if (event.message.stopReason === "error" || event.message.stopReason === "aborted")
                  failure =
                    event.message.errorMessage || `Pi generation ${event.message.stopReason}.`;
                else {
                  failure = undefined;
                  finalOutput = event.message.content
                    .filter((part) => part.type === "text")
                    .map((part) => part.text)
                    .join("");
                }
              }
            });
            try {
              await session.prompt(input.prompt, { expandPromptTemplates: false });
              if (failure) throw new Error(failure);
              return extractJsonObject((finalOutput || output).trim());
            } finally {
              unsubscribe();
            }
          },
          catch: (cause) =>
            new TextGenerationError({
              operation: input.operation,
              detail: "Pi text generation failed.",
              cause,
            }),
        }),
      (session) =>
        Effect.sync(() => {
          if (!session.isIdle) void session.abort().catch(() => {});
          session.dispose();
        }),
    ).pipe(
      Effect.timeoutOrElse({
        duration: options.timeoutMs ?? TIMEOUT_MS,
        orElse: () =>
          Effect.fail(
            new TextGenerationError({
              operation: input.operation,
              detail: "Pi text generation timed out.",
            }),
          ),
      }),
      Effect.flatMap((json) =>
        Schema.decodeEffect(Schema.fromJsonString(input.schema))(json).pipe(
          Effect.mapError(
            (cause) =>
              new TextGenerationError({
                operation: input.operation,
                detail: "Pi returned invalid structured text.",
                cause,
              }),
          ),
        ),
      ),
    );

  const generateCommitMessage: TextGeneration.TextGeneration["Service"]["generateCommitMessage"] =
    Effect.fn("PiTextGeneration.generateCommitMessage")(function* (input) {
      const { prompt, outputSchema } = buildCommitMessagePrompt(input);
      const result = yield* generate({
        operation: "generateCommitMessage",
        cwd: input.cwd,
        prompt,
        schema: outputSchema,
        model: input.modelSelection.model,
      });
      return {
        subject: sanitizeCommitSubject(result.subject),
        body: result.body.trim(),
        ...("branch" in result && typeof result.branch === "string"
          ? { branch: sanitizeFeatureBranchName(result.branch) }
          : {}),
      };
    });
  const generatePrContent: TextGeneration.TextGeneration["Service"]["generatePrContent"] =
    Effect.fn("PiTextGeneration.generatePrContent")(function* (input) {
      const { prompt, outputSchema } = buildPrContentPrompt(input);
      const result = yield* generate({
        operation: "generatePrContent",
        cwd: input.cwd,
        prompt,
        schema: outputSchema,
        model: input.modelSelection.model,
      });
      return { title: sanitizePrTitle(result.title), body: result.body.trim() };
    });
  const generateBranchName: TextGeneration.TextGeneration["Service"]["generateBranchName"] =
    Effect.fn("PiTextGeneration.generateBranchName")(function* (input) {
      const { prompt, outputSchema } = buildBranchNamePrompt(input);
      const result = yield* generate({
        operation: "generateBranchName",
        cwd: input.cwd,
        prompt,
        schema: outputSchema,
        model: input.modelSelection.model,
      });
      return { branch: sanitizeBranchFragment(result.branch) };
    });
  const generateThreadTitle: TextGeneration.TextGeneration["Service"]["generateThreadTitle"] =
    Effect.fn("PiTextGeneration.generateThreadTitle")(function* (input) {
      const { prompt, outputSchema } = buildThreadTitlePrompt(input);
      const result = yield* generate({
        operation: "generateThreadTitle",
        cwd: input.cwd,
        prompt,
        schema: outputSchema,
        model: input.modelSelection.model,
      });
      return {
        title: sanitizeThreadTitle(result.title),
        ...(result.needsRefinement ? { needsRefinement: true } : {}),
      };
    });
  return {
    generateCommitMessage,
    generatePrContent,
    generateBranchName,
    generateThreadTitle,
  } satisfies TextGeneration.TextGeneration["Service"];
};
