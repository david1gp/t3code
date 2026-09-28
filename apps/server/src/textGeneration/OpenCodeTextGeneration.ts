import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  NonNegativeInt,
  TextGenerationError,
  type ChatAttachment,
  type ModelSelection,
  type OpenCodeSettings,
} from "@t3tools/contracts";
import { sanitizeBranchFragment, sanitizeFeatureBranchName } from "@t3tools/shared/git";
import { getModelSelectionStringOptionValue } from "@t3tools/shared/model";
import { extractJsonObject } from "@t3tools/shared/schemaJson";

import * as ServerConfig from "../config.ts";
import { resolveAttachmentPath } from "../attachmentStore.ts";
import {
  buildBranchNamePrompt,
  buildCommitMessagePrompt,
  buildPrContentPrompt,
  buildThreadTitlePrompt,
} from "./TextGenerationPrompts.ts";
import * as TextGeneration from "./TextGeneration.ts";
import {
  sanitizeCommitSubject,
  sanitizePrTitle,
  sanitizeThreadTitle,
} from "./TextGenerationUtils.ts";
import * as OpenCodeRuntime from "../provider/opencodeRuntime.ts";
import * as OpenCodeServerOwner from "../provider/OpenCodeServerOwner.ts";
import { openCodeNativeClientCreate } from "../provider/openCodeNativeClientCreate.ts";

const OpenCodeTextGenerationOperation = Schema.Literals([
  "generateCommitMessage",
  "generatePrContent",
  "generateBranchName",
  "generateThreadTitle",
]);

type OpenCodeTextGenerationOperation = typeof OpenCodeTextGenerationOperation.Type;

const openCodeTextGenerationErrorContext = {
  operation: OpenCodeTextGenerationOperation,
  cwd: Schema.String,
};

export class OpenCodeTextGenerationSessionRequestError extends Schema.TaggedError<OpenCodeTextGenerationSessionRequestError>()(
  "OpenCodeTextGenerationSessionRequestError",
  {
    ...openCodeTextGenerationErrorContext,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `OpenCode session creation request failed for ${this.operation} in ${this.cwd}.`;
  }
}

export class OpenCodeTextGenerationSessionPayloadError extends Schema.TaggedError<OpenCodeTextGenerationSessionPayloadError>()(
  "OpenCodeTextGenerationSessionPayloadError",
  openCodeTextGenerationErrorContext,
) {
  override get message(): string {
    return `OpenCode session.create returned no session payload for ${this.operation} in ${this.cwd}.`;
  }
}

const openCodePromptErrorContext = {
  ...openCodeTextGenerationErrorContext,
  sessionId: Schema.String,
  providerId: Schema.String,
  modelId: Schema.String,
};

export class OpenCodeTextGenerationPromptRequestError extends Schema.TaggedError<OpenCodeTextGenerationPromptRequestError>()(
  "OpenCodeTextGenerationPromptRequestError",
  {
    ...openCodePromptErrorContext,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `OpenCode prompt request failed for ${this.operation} in ${this.cwd} using ${this.providerId}/${this.modelId} (session ${this.sessionId}).`;
  }
}

export class OpenCodeTextGenerationCompletionRequestError extends Schema.TaggedError<OpenCodeTextGenerationCompletionRequestError>()(
  "OpenCodeTextGenerationCompletionRequestError",
  { ...openCodePromptErrorContext, cause: Schema.Defect() },
) {
  override get message(): string {
    return `OpenCode completion wait/read failed for ${this.operation} in ${this.cwd} (session ${this.sessionId}).`;
  }
}

export class OpenCodeTextGenerationPromptResponseError extends Schema.TaggedError<OpenCodeTextGenerationPromptResponseError>()(
  "OpenCodeTextGenerationPromptResponseError",
  {
    ...openCodePromptErrorContext,
    providerErrorName: Schema.optional(Schema.String),
    providerMessage: Schema.String,
  },
) {
  override get message(): string {
    const providerError = this.providerErrorName ? ` ${this.providerErrorName}` : "";
    return `OpenCode prompt${providerError} failed for ${this.operation} in ${this.cwd} using ${this.providerId}/${this.modelId} (session ${this.sessionId}): ${this.providerMessage}`;
  }
}

export class OpenCodeTextGenerationEmptyOutputError extends Schema.TaggedError<OpenCodeTextGenerationEmptyOutputError>()(
  "OpenCodeTextGenerationEmptyOutputError",
  {
    ...openCodePromptErrorContext,
    responsePartCount: NonNegativeInt,
    textPartCount: NonNegativeInt,
  },
) {
  override get message(): string {
    return `OpenCode returned empty output for ${this.operation} in ${this.cwd} using ${this.providerId}/${this.modelId} (session ${this.sessionId}, ${this.responsePartCount} response parts, ${this.textPartCount} text parts).`;
  }
}

interface OpenCodePromptFailure {
  readonly name?: string;
  readonly message: string;
}

interface OpenCodeTextPart {
  readonly type: "text";
  readonly text: string;
}

function getOpenCodePromptFailure(error: unknown): OpenCodePromptFailure | null {
  if (!error || typeof error !== "object") {
    return null;
  }

  const name =
    "name" in error && typeof error.name === "string" && error.name.trim().length > 0
      ? error.name.trim()
      : undefined;
  const message =
    "data" in error &&
    error.data &&
    typeof error.data === "object" &&
    "message" in error.data &&
    typeof error.data.message === "string"
      ? error.data.message.trim()
      : "";
  if (message.length > 0) {
    return {
      ...(name ? { name } : {}),
      message,
    };
  }

  if (name) {
    return { name, message: name };
  }

  return null;
}

function isOpenCodeTextPart(part: unknown): part is OpenCodeTextPart {
  return (
    part !== null &&
    typeof part === "object" &&
    "type" in part &&
    part.type === "text" &&
    "text" in part &&
    typeof part.text === "string"
  );
}

function getOpenCodeTextResponse(parts: ReadonlyArray<unknown> | undefined): string {
  return (parts ?? [])
    .filter(isOpenCodeTextPart)
    .map((part) => part.text)
    .join("")
    .trim();
}

export const makeOpenCodeTextGeneration = Effect.fn("makeOpenCodeTextGeneration")(function* (
  openCodeSettings: OpenCodeSettings,
  protocol: "legacy" | "native" = "legacy",
) {
  const serverConfig = yield* ServerConfig.ServerConfig;
  const openCodeRuntime = yield* OpenCodeRuntime.OpenCodeRuntime;
  const serverOwner = yield* OpenCodeServerOwner.OpenCodeServerOwner;

  const runOpenCodeJson = Effect.fn("runOpenCodeJson")(function* <S extends Schema.Top>(input: {
    readonly operation: OpenCodeTextGenerationOperation;
    readonly cwd: string;
    readonly prompt: string;
    readonly outputSchemaJson: S;
    readonly modelSelection: ModelSelection;
    readonly attachments?: ReadonlyArray<ChatAttachment> | undefined;
  }) {
    const parsedModel = OpenCodeRuntime.parseOpenCodeModelSlug(input.modelSelection.model);
    if (!parsedModel) {
      return yield* new TextGenerationError({
        operation: input.operation,
        detail: "OpenCode model selection must use the 'provider/model' format.",
      });
    }

    const fileParts = OpenCodeRuntime.toOpenCodeFileParts({
      attachments: input.attachments?.filter((attachment) => attachment.type === "image"),
      resolveAttachmentPath: (attachment) =>
        resolveAttachmentPath({ attachmentsDir: serverConfig.attachmentsDir, attachment }),
    });

    const promptContext = (sessionId: string) => ({
      operation: input.operation,
      cwd: input.cwd,
      sessionId,
      providerId: parsedModel.providerID,
      modelId: parsedModel.modelID,
    });
    const selectedAgent = getModelSelectionStringOptionValue(input.modelSelection, "agent");
    const selectedVariant = getModelSelectionStringOptionValue(input.modelSelection, "variant");

    const runAgainstNative = Effect.gen(function* () {
      const client = openCodeNativeClientCreate({
        url: openCodeSettings.serverUrl,
        ...(openCodeSettings.serverPassword
          ? { serverPassword: openCodeSettings.serverPassword }
          : {}),
      });
      const session = yield* Effect.acquireRelease(
        Effect.gen(function* () {
          const created = yield* Effect.tryPromise({
            try: (signal) =>
              client.session.create(
                {
                  location: { directory: input.cwd },
                  title: `T3 Code ${input.operation}`,
                  permissions: [{ action: "*", resource: "*", effect: "deny" }],
                  model: {
                    id: parsedModel.modelID,
                    providerID: parsedModel.providerID,
                    ...(selectedVariant ? { variant: selectedVariant } : {}),
                  },
                  ...(selectedAgent ? { agent: selectedAgent } : {}),
                },
                { signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]) },
              ),
            catch: (cause) =>
              new OpenCodeTextGenerationSessionRequestError({
                operation: input.operation,
                cwd: input.cwd,
                cause,
              }),
          });
          // Only a confirmed temporary session belongs to this request.
          if (!created?.id || created.location?.directory !== input.cwd) {
            return yield* new OpenCodeTextGenerationSessionPayloadError({
              operation: input.operation,
              cwd: input.cwd,
            });
          }
          return created;
        }),
        (created) =>
          Effect.promise(() =>
            client.session.remove(
              { sessionID: created.id },
              { signal: AbortSignal.timeout(15_000) },
            ),
          ).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("Failed to remove temporary OpenCode text generation session", {
                sessionId: created.id,
                cause,
              }),
            ),
          ),
      );
      const context = promptContext(session.id);
      const receipt = yield* Effect.tryPromise({
        try: (signal) =>
          client.session.prompt(
            {
              sessionID: session.id,
              text: input.prompt,
              ...(fileParts.length
                ? {
                    files: fileParts.map((part) => ({
                      uri: part.url,
                      ...(part.filename === undefined ? {} : { name: part.filename }),
                    })),
                  }
                : {}),
            },
            { signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]) },
          ),
        catch: (cause) => new OpenCodeTextGenerationPromptRequestError({ ...context, cause }),
      });
      if (receipt?.type !== "user" || receipt.sessionID !== session.id || !receipt.id) {
        return yield* new OpenCodeTextGenerationPromptResponseError({
          ...context,
          providerMessage: "OpenCode returned an invalid prompt admission receipt.",
        });
      }
      // Native prompt acknowledges admission, not completion. Wait for this fresh
      // session to become idle before reading its persisted assistant message.
      const result = yield* Effect.tryPromise({
        try: async (signal) => {
          const deadline = AbortSignal.any([signal, AbortSignal.timeout(120_000)]);
          await client.session.wait({ sessionID: session.id }, { signal: deadline });
          const state = await client.session.get({ sessionID: session.id }, { signal: deadline });
          const messages = await client.message.list(
            { sessionID: session.id, type: "assistant", order: "desc", limit: 1 },
            { signal: deadline },
          );
          return { state, messages };
        },
        catch: (cause) => new OpenCodeTextGenerationCompletionRequestError({ ...context, cause }),
      });
      const assistant = result.messages?.data?.[0];
      const failure =
        result.state?.outcome !== "succeeded" ||
        assistant?.type !== "assistant" ||
        assistant.error ||
        assistant.finish === "error" ||
        !assistant.time.completed;
      if (failure) {
        return yield* new OpenCodeTextGenerationPromptResponseError({
          ...context,
          providerMessage:
            (assistant?.type === "assistant" && assistant.error?.message) ||
            `OpenCode session did not produce a completed response (${result.state?.outcome ?? "unknown"}).`,
        });
      }
      const parts = assistant.content;
      const text = getOpenCodeTextResponse(parts);
      if (!text) {
        return yield* new OpenCodeTextGenerationEmptyOutputError({
          ...context,
          responsePartCount: parts.length,
          textPartCount: parts.filter(isOpenCodeTextPart).length,
        });
      }
      return text;
    }).pipe(Effect.scoped);

    const runAgainstServer = Effect.fn("runOpenCodeJson.runAgainstServer")(function* (
      server: Pick<OpenCodeRuntime.OpenCodeServerConnection, "url" | "serverPassword" | "version">,
    ) {
      const client = openCodeRuntime.createOpenCodeSdkClient({
        baseUrl: server.url,
        directory: input.cwd,
        ...(server.serverPassword !== undefined ? { serverPassword: server.serverPassword } : {}),
      });
      const session = yield* Effect.tryPromise({
        try: () =>
          client.session.create({
            title: `T3 Code ${input.operation}`,
            permission: [{ permission: "*", pattern: "*", action: "deny" }],
          }),
        catch: (cause) =>
          new OpenCodeTextGenerationSessionRequestError({
            operation: input.operation,
            cwd: input.cwd,
            cause,
          }),
      });
      if (!session.data) {
        return yield* new OpenCodeTextGenerationSessionPayloadError({
          operation: input.operation,
          cwd: input.cwd,
        });
      }
      const context = promptContext(session.data.id);

      const result = yield* Effect.tryPromise({
        try: () =>
          client.session.prompt({
            sessionID: session.data.id,
            model: parsedModel,
            ...(selectedAgent ? { agent: selectedAgent } : {}),
            ...(selectedVariant ? { variant: selectedVariant } : {}),
            parts: [{ type: "text", text: input.prompt }, ...fileParts],
          }),
        catch: (cause) =>
          new OpenCodeTextGenerationPromptRequestError({
            ...context,
            cause,
          }),
      });
      const promptFailure = getOpenCodePromptFailure(result.data?.info?.error);
      if (promptFailure) {
        return yield* new OpenCodeTextGenerationPromptResponseError({
          ...context,
          ...(promptFailure.name ? { providerErrorName: promptFailure.name } : {}),
          providerMessage: promptFailure.message,
        });
      }
      const responseParts = result.data?.parts ?? [];
      const rawText = getOpenCodeTextResponse(responseParts);
      if (rawText.length === 0) {
        return yield* new OpenCodeTextGenerationEmptyOutputError({
          ...context,
          responsePartCount: responseParts.length,
          textPartCount: responseParts.filter(isOpenCodeTextPart).length,
        });
      }
      return rawText;
    });

    const runAgainstLegacy = Effect.suspend(() =>
      openCodeSettings.serverUrl.length > 0
        ? openCodeRuntime
            .connectToOpenCodeServer({
              binaryPath: openCodeSettings.binaryPath,
              directory: input.cwd,
              serverUrl: openCodeSettings.serverUrl,
              ...(openCodeSettings.serverPassword
                ? { serverPassword: openCodeSettings.serverPassword }
                : {}),
            })
            .pipe(Effect.flatMap(runAgainstServer), Effect.scoped)
        : serverOwner.withServer(runAgainstServer),
    );
    const serverOutput: Effect.Effect<
      string,
      Effect.Error<typeof runAgainstNative> | Effect.Error<typeof runAgainstLegacy>
    > = protocol === "native" ? runAgainstNative : runAgainstLegacy;
    const rawOutput = yield* serverOutput.pipe(
      Effect.catchTags({
        OpenCodeTextGenerationSessionRequestError: (cause) =>
          Effect.fail(
            new TextGenerationError({
              operation: cause.operation,
              detail: "OpenCode session.create request failed.",
              cause,
            }),
          ),
        OpenCodeTextGenerationSessionPayloadError: (cause) =>
          Effect.fail(
            new TextGenerationError({
              operation: cause.operation,
              detail: "OpenCode session.create returned no session payload.",
              cause,
            }),
          ),
        OpenCodeTextGenerationPromptRequestError: (cause) =>
          Effect.fail(
            new TextGenerationError({
              operation: cause.operation,
              detail: "OpenCode session.prompt request failed.",
              cause,
            }),
          ),
        OpenCodeTextGenerationCompletionRequestError: (cause) =>
          Effect.fail(
            new TextGenerationError({
              operation: cause.operation,
              detail: "OpenCode session completion wait/read failed.",
              cause,
            }),
          ),
        OpenCodeTextGenerationPromptResponseError: (cause) =>
          Effect.fail(
            new TextGenerationError({
              operation: cause.operation,
              detail: cause.providerMessage,
              cause,
            }),
          ),
        OpenCodeTextGenerationEmptyOutputError: (cause) =>
          Effect.fail(
            new TextGenerationError({
              operation: cause.operation,
              detail: "OpenCode returned empty output.",
              cause,
            }),
          ),
        OpenCodeRuntimeError: (cause) =>
          Effect.fail(
            new TextGenerationError({
              operation: input.operation,
              detail: OpenCodeRuntime.openCodeRuntimeErrorDetail(cause),
              cause,
            }),
          ),
      }),
    );

    const decodeOutput = Schema.decodeEffect(Schema.fromJsonString(input.outputSchemaJson));
    return yield* decodeOutput(extractJsonObject(rawOutput)).pipe(
      Effect.catchTags({
        SchemaError: (cause) =>
          Effect.fail(
            new TextGenerationError({
              operation: input.operation,
              detail: "OpenCode returned invalid structured output.",
              cause,
            }),
          ),
      }),
    );
  });

  const generateCommitMessage: TextGeneration.TextGeneration["Service"]["generateCommitMessage"] =
    Effect.fn("OpenCodeTextGeneration.generateCommitMessage")(function* (input) {
      const { prompt, outputSchema } = buildCommitMessagePrompt({
        branch: input.branch,
        stagedSummary: input.stagedSummary,
        stagedPatch: input.stagedPatch,
        includeBranch: input.includeBranch === true,
        policy: input.policy,
      });
      const generated = yield* runOpenCodeJson({
        operation: "generateCommitMessage",
        cwd: input.cwd,
        prompt,
        outputSchemaJson: outputSchema,
        modelSelection: input.modelSelection,
      });

      return {
        subject: sanitizeCommitSubject(generated.subject),
        body: generated.body.trim(),
        ...("branch" in generated && typeof generated.branch === "string"
          ? { branch: sanitizeFeatureBranchName(generated.branch) }
          : {}),
      };
    });

  const generatePrContent: TextGeneration.TextGeneration["Service"]["generatePrContent"] =
    Effect.fn("OpenCodeTextGeneration.generatePrContent")(function* (input) {
      const { prompt, outputSchema } = buildPrContentPrompt({
        baseBranch: input.baseBranch,
        headBranch: input.headBranch,
        commitSummary: input.commitSummary,
        diffSummary: input.diffSummary,
        diffPatch: input.diffPatch,
        policy: input.policy,
        changeRequestTemplate: input.changeRequestTemplate,
      });
      const generated = yield* runOpenCodeJson({
        operation: "generatePrContent",
        cwd: input.cwd,
        prompt,
        outputSchemaJson: outputSchema,
        modelSelection: input.modelSelection,
      });

      return {
        title: sanitizePrTitle(generated.title),
        body: generated.body.trim(),
      };
    });

  const generateBranchName: TextGeneration.TextGeneration["Service"]["generateBranchName"] =
    Effect.fn("OpenCodeTextGeneration.generateBranchName")(function* (input) {
      const { prompt, outputSchema } = buildBranchNamePrompt({
        message: input.message,
        attachments: input.attachments,
      });
      const generated = yield* runOpenCodeJson({
        operation: "generateBranchName",
        cwd: input.cwd,
        prompt,
        outputSchemaJson: outputSchema,
        modelSelection: input.modelSelection,
        attachments: input.attachments,
      });

      return {
        branch: sanitizeBranchFragment(generated.branch),
      };
    });

  const generateThreadTitle: TextGeneration.TextGeneration["Service"]["generateThreadTitle"] =
    Effect.fn("OpenCodeTextGeneration.generateThreadTitle")(function* (input) {
      const { prompt, outputSchema } = buildThreadTitlePrompt({
        message: input.message,
        previousTitle: input.previousTitle,
        linkedContext: input.linkedContext,
        attachments: input.attachments,
      });
      const generated = yield* runOpenCodeJson({
        operation: "generateThreadTitle",
        cwd: input.cwd,
        prompt,
        outputSchemaJson: outputSchema,
        modelSelection: input.modelSelection,
        attachments: input.attachments,
      });

      return {
        title: sanitizeThreadTitle(generated.title),
        ...(generated.needsRefinement ? { needsRefinement: true } : {}),
      };
    });

  return {
    generateCommitMessage,
    generatePrContent,
    generateBranchName,
    generateThreadTitle,
  } satisfies TextGeneration.TextGeneration["Service"];
});
