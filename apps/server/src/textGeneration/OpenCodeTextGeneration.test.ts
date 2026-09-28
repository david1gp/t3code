// @effect-diagnostics nodeBuiltinImport:off - native protocol fixture uses in-process HTTP.
import * as NodeHttp from "node:http";
import type * as NodeNet from "node:net";

import { OpenCodeSettings, ProviderInstanceId, TextGenerationError } from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import * as NetService from "@t3tools/shared/Net";
import { beforeEach, expect } from "vite-plus/test";

import * as ServerConfig from "../config.ts";
import * as OpenCodeRuntime from "../provider/opencodeRuntime.ts";
import * as OpenCodeServerOwner from "../provider/OpenCodeServerOwner.ts";
import * as OpenCodeTextGeneration from "./OpenCodeTextGeneration.ts";
import * as TextGeneration from "./TextGeneration.ts";

const runtimeMock = {
  state: {
    startCalls: [] as string[],
    promptUrls: [] as string[],
    promptParts: [] as ReadonlyArray<unknown>[],
    authHeaders: [] as Array<string | null>,
    closeCalls: [] as string[],
    sessionCreateCalls: 0,
    connectionError: undefined as Error | undefined,
    sessionCreateError: undefined as unknown,
    sessionResult: undefined as { data?: { id: string } } | undefined,
    promptRequestError: undefined as unknown,
    promptResult: undefined as
      | { data?: { info?: { error?: unknown }; parts?: Array<unknown> } }
      | undefined,
  },
  reset() {
    this.state.startCalls.length = 0;
    this.state.promptUrls.length = 0;
    this.state.promptParts.length = 0;
    this.state.authHeaders.length = 0;
    this.state.closeCalls.length = 0;
    this.state.sessionCreateCalls = 0;
    this.state.connectionError = undefined;
    this.state.sessionCreateError = undefined;
    this.state.sessionResult = undefined;
    this.state.promptRequestError = undefined;
    this.state.promptResult = undefined;
  },
};

const OpenCodeRuntimeTestDouble: OpenCodeRuntime.OpenCodeRuntimeShape = {
  startOpenCodeServerProcess: ({ binaryPath, serverPassword, environment }) =>
    Effect.gen(function* () {
      const index = runtimeMock.state.startCalls.length + 1;
      const url = `http://127.0.0.1:${4_300 + index}`;
      runtimeMock.state.startCalls.push(binaryPath);
      // The production runtime binds server lifetime to the caller's scope.
      // Mirror that here so the closeCalls probe observes scope close.
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          runtimeMock.state.closeCalls.push(url);
        }),
      );
      const effectiveServerPassword = OpenCodeRuntime.resolveOpenCodeServerPassword({
        external: false,
        ...(serverPassword !== undefined ? { serverPassword } : {}),
        ...(environment !== undefined ? { environment } : {}),
      });
      return {
        url,
        ...(effectiveServerPassword !== undefined
          ? { serverPassword: effectiveServerPassword }
          : {}),
        version: "1.14.19",
        isRunning: Effect.succeed(true),
        exitCode: Effect.never,
      };
    }),
  connectToOpenCodeServer: ({ serverUrl, serverPassword }) =>
    runtimeMock.state.connectionError
      ? Effect.fail(
          new OpenCodeRuntime.OpenCodeRuntimeError({
            operation: "global.health",
            detail: runtimeMock.state.connectionError.message,
            cause: runtimeMock.state.connectionError,
          }),
        )
      : Effect.succeed({
          url: serverUrl ?? "http://127.0.0.1:4301",
          ...(serverPassword ? { serverPassword } : {}),
          version: "1.14.19",
          exitCode: null,
          external: Boolean(serverUrl),
        }),
  runOpenCodeCommand: () => Effect.succeed({ stdout: "", stderr: "", code: 0 }),
  createOpenCodeSdkClient: ({ baseUrl, serverPassword }) =>
    ({
      session: {
        create: async () => {
          runtimeMock.state.sessionCreateCalls += 1;
          if (runtimeMock.state.sessionCreateError !== undefined) {
            throw runtimeMock.state.sessionCreateError;
          }
          return runtimeMock.state.sessionResult ?? { data: { id: `${baseUrl}/session` } };
        },
        prompt: async (input: { readonly parts: ReadonlyArray<unknown> }) => {
          runtimeMock.state.promptUrls.push(baseUrl);
          runtimeMock.state.promptParts.push(input.parts);
          runtimeMock.state.authHeaders.push(
            serverPassword ? `Basic ${btoa(`opencode:${serverPassword}`)}` : null,
          );
          if (runtimeMock.state.promptRequestError !== undefined) {
            throw runtimeMock.state.promptRequestError;
          }
          return (
            runtimeMock.state.promptResult ?? {
              data: {
                parts: [
                  {
                    type: "text",
                    text: JSON.stringify({
                      subject: "Improve OpenCode reuse",
                      body: "Reuse one server for the full action.",
                    }),
                  },
                ],
              },
            }
          );
        },
      },
    }) as unknown as ReturnType<OpenCodeRuntime.OpenCodeRuntimeShape["createOpenCodeSdkClient"]>,
  loadOpenCodeInventory: () =>
    Effect.fail(
      new OpenCodeRuntime.OpenCodeRuntimeError({
        operation: "loadOpenCodeInventory",
        detail: "OpenCodeRuntimeTestDouble.loadOpenCodeInventory not used in this test",
        cause: null,
      }),
    ),
  loadOpenCodeSkills: () => Effect.succeed([]),
  loadInventoryFromCli: () =>
    Effect.fail(
      new OpenCodeRuntime.OpenCodeRuntimeError({
        operation: "loadInventoryFromCli",
        detail: "OpenCodeRuntimeTestDouble.loadInventoryFromCli not used in this test",
        cause: null,
      }),
    ),
  loadSkillsFromCli: () => Effect.succeed([]),
};

const DEFAULT_TEST_MODEL_SELECTION = {
  instanceId: ProviderInstanceId.make("opencode"),
  model: "openai/gpt-5",
};
const DEFAULT_COMMIT_MESSAGE_INPUT = {
  cwd: process.cwd(),
  branch: "feature/opencode-reuse",
  stagedSummary: "M README.md",
  stagedPatch: "diff --git a/README.md b/README.md",
  modelSelection: DEFAULT_TEST_MODEL_SELECTION,
};

const OPENCODE_TEXT_GENERATION_IDLE_TTL_MS = 30_000;

const OpenCodeTextGenerationTestLayer = Layer.succeed(
  OpenCodeRuntime.OpenCodeRuntime,
  OpenCodeRuntimeTestDouble,
).pipe(
  Layer.provideMerge(
    ServerConfig.ServerConfig.layerTest(process.cwd(), {
      prefix: "t3code-opencode-text-generation-test-",
    }),
  ),
  Layer.provideMerge(NetService.layer),
  Layer.provideMerge(NodeServices.layer),
);

const OpenCodeTextGenerationExistingServerTestLayer = Layer.succeed(
  OpenCodeRuntime.OpenCodeRuntime,
  OpenCodeRuntimeTestDouble,
).pipe(
  Layer.provideMerge(
    ServerConfig.ServerConfig.layerTest(process.cwd(), {
      prefix: "t3code-opencode-text-generation-existing-server-test-",
    }),
  ),
  Layer.provideMerge(NetService.layer),
  Layer.provideMerge(NodeServices.layer),
);

const DEFAULT_OPENCODE_SETTINGS = Schema.decodeSync(OpenCodeSettings)({
  binaryPath: "fake-opencode",
});
const LOCAL_AUTH_OPENCODE_SETTINGS = Schema.decodeSync(OpenCodeSettings)({
  binaryPath: "fake-opencode",
  serverPassword: "secret-password",
});
const EXISTING_SERVER_OPENCODE_SETTINGS = Schema.decodeSync(OpenCodeSettings)({
  binaryPath: "fake-opencode",
  serverUrl: "http://127.0.0.1:9999",
  serverPassword: "secret-password",
});
const EXTERNAL_SERVER_WITHOUT_AUTH_OPENCODE_SETTINGS = Schema.decodeSync(OpenCodeSettings)({
  binaryPath: "fake-opencode",
  serverUrl: "http://127.0.0.1:9999",
});
const decodeOpenCodeSettings = Schema.decodeSync(OpenCodeSettings);

function withOpenCodeTextGeneration<A, E, R>(
  settings: OpenCodeSettings,
  effectFn: (textGeneration: TextGeneration.TextGeneration["Service"]) => Effect.Effect<A, E, R>,
  environment?: NodeJS.ProcessEnv,
  protocol: "legacy" | "native" = "legacy",
) {
  return Effect.gen(function* () {
    const serverOwner = yield* OpenCodeServerOwner.make({
      binaryPath: settings.binaryPath,
      directory: process.cwd(),
      ...(settings.serverPassword ? { serverPassword: settings.serverPassword } : {}),
      ...(environment ? { environment } : {}),
    });
    const textGeneration = yield* OpenCodeTextGeneration.makeOpenCodeTextGeneration(
      settings,
      protocol,
    ).pipe(Effect.provideService(OpenCodeServerOwner.OpenCodeServerOwner, serverOwner));
    return yield* effectFn(textGeneration);
  }).pipe(Effect.scoped);
}

const nativeFixture = Effect.acquireRelease(
  Effect.promise(async () => {
    const requests: Array<{
      path: string;
      body: Record<string, unknown>;
      authorization: string | undefined;
    }> = [];
    let releaseWait!: () => void;
    let notifyWait!: () => void;
    const waitGate = new Promise<void>((resolve) => {
      releaseWait = resolve;
    });
    const waitStarted = new Promise<void>((resolve) => {
      notifyWait = resolve;
    });
    let outcome: "succeeded" | "failed" = "succeeded";
    let assistantText = '{"title":"Native title"}';
    let waitStatus = 204;
    let removeStatus = 204;
    let sessionDirectory = process.cwd();
    let promptStatus = 200;
    const server = NodeHttp.createServer(async (req, res) => {
      const path = req.url ?? "";
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
      requests.push({ path, body, authorization: req.headers.authorization });
      const send = (value: unknown, status = 200) => {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(value));
      };
      if (path === "/api/session" && req.method === "POST") {
        send({ data: { id: "ses_title", location: { directory: sessionDirectory } } });
      } else if (path === "/api/session/ses_title/prompt") {
        send({ data: { id: "msg_title", sessionID: "ses_title", type: "user" } }, promptStatus);
      } else if (path === "/api/session/ses_title" && req.method === "DELETE") {
        res.writeHead(removeStatus);
        res.end();
      } else if (path === "/api/experimental/session/ses_title/wait") {
        notifyWait();
        await waitGate;
        res.writeHead(waitStatus);
        res.end();
      } else if (path === "/api/session/ses_title") {
        send({ data: { outcome } });
      } else if (path.startsWith("/api/session/ses_title/message")) {
        send({
          data: [
            {
              id: "msg_assistant",
              type: "assistant",
              time: { completed: 1 },
              content: [{ type: "text", text: assistantText }],
            },
          ],
          cursor: {},
        });
      } else send({ error: "Unexpected route" }, 404);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    return {
      server,
      requests,
      waitStarted,
      releaseWait,
      setOutcome: (value: "succeeded" | "failed") => {
        outcome = value;
      },
      setText: (value: string) => {
        assistantText = value;
      },
      setWaitStatus: (value: number) => {
        waitStatus = value;
      },
      setRemoveStatus: (value: number) => {
        removeStatus = value;
      },
      setSessionDirectory: (value: string) => {
        sessionDirectory = value;
      },
      setPromptStatus: (value: number) => {
        promptStatus = value;
      },
      url: `http://127.0.0.1:${(server.address() as NodeNet.AddressInfo).port}`,
    };
  }),
  ({ server, releaseWait }) =>
    Effect.promise(async () => {
      releaseWait();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }),
);

beforeEach(() => {
  runtimeMock.reset();
});

const advanceIdleClock = Effect.gen(function* () {
  yield* Effect.yieldNow;
  yield* TestClock.adjust(Duration.millis(OPENCODE_TEXT_GENERATION_IDLE_TTL_MS + 1));
  yield* Effect.yieldNow;
});

it.layer(OpenCodeTextGenerationTestLayer)("OpenCodeTextGeneration", (it) => {
  it.effect("excludes generic files from thread title generation", () =>
    withOpenCodeTextGeneration(DEFAULT_OPENCODE_SETTINGS, (textGeneration) =>
      Effect.gen(function* () {
        runtimeMock.state.promptResult = {
          data: {
            parts: [{ type: "text", text: '{"title":"Review uploaded report"}' }],
          },
        };

        yield* textGeneration.generateThreadTitle({
          cwd: process.cwd(),
          message: "Review these attachments.",
          modelSelection: DEFAULT_TEST_MODEL_SELECTION,
          attachments: [
            {
              type: "image",
              id: "thread-image-attachment",
              name: "screenshot.png",
              mimeType: "image/png",
              sizeBytes: 3,
            },
            {
              type: "file",
              id: "thread-report-attachment-pdf",
              name: "report.pdf",
              mimeType: "application/pdf",
              sizeBytes: 42,
            },
          ],
        });

        expect(runtimeMock.state.promptParts[0]).toEqual([
          expect.objectContaining({ type: "text" }),
          expect.objectContaining({ type: "file", filename: "screenshot.png" }),
        ]);
      }),
    ),
  );

  it.effect("passes configured authentication to a locally spawned server", () =>
    withOpenCodeTextGeneration(LOCAL_AUTH_OPENCODE_SETTINGS, (textGeneration) =>
      Effect.gen(function* () {
        yield* textGeneration.generateCommitMessage(DEFAULT_COMMIT_MESSAGE_INPUT);

        expect(runtimeMock.state.startCalls).toEqual(["fake-opencode"]);
        expect(runtimeMock.state.authHeaders).toEqual([
          `Basic ${btoa("opencode:secret-password")}`,
        ]);
      }),
    ),
  );

  it.effect("uses an environment-only password for a locally spawned server", () =>
    withOpenCodeTextGeneration(
      DEFAULT_OPENCODE_SETTINGS,
      (textGeneration) =>
        Effect.gen(function* () {
          yield* textGeneration.generateCommitMessage(DEFAULT_COMMIT_MESSAGE_INPUT);

          expect(runtimeMock.state.authHeaders).toEqual([
            `Basic ${btoa("opencode:environment-password")}`,
          ]);
        }),
      { OPENCODE_SERVER_PASSWORD: "environment-password" },
    ),
  );

  it.effect("uses settings auth when the local environment password differs", () =>
    withOpenCodeTextGeneration(
      LOCAL_AUTH_OPENCODE_SETTINGS,
      (textGeneration) =>
        Effect.gen(function* () {
          yield* textGeneration.generateCommitMessage(DEFAULT_COMMIT_MESSAGE_INPUT);

          expect(runtimeMock.state.authHeaders).toEqual([
            `Basic ${btoa("opencode:secret-password")}`,
          ]);
        }),
      { OPENCODE_SERVER_PASSWORD: "environment-password" },
    ),
  );

  it.effect("reuses a warm server across back-to-back requests and closes it after idling", () =>
    withOpenCodeTextGeneration(DEFAULT_OPENCODE_SETTINGS, (textGeneration) =>
      Effect.gen(function* () {
        yield* textGeneration.generateCommitMessage({
          cwd: process.cwd(),
          branch: "feature/opencode-reuse",
          stagedSummary: "M README.md",
          stagedPatch: "diff --git a/README.md b/README.md",
          modelSelection: DEFAULT_TEST_MODEL_SELECTION,
        });
        yield* textGeneration.generateCommitMessage({
          cwd: process.cwd(),
          branch: "feature/opencode-reuse",
          stagedSummary: "M README.md",
          stagedPatch: "diff --git a/README.md b/README.md",
          modelSelection: DEFAULT_TEST_MODEL_SELECTION,
        });

        expect(runtimeMock.state.startCalls).toEqual(["fake-opencode"]);
        expect(runtimeMock.state.promptUrls).toEqual([
          "http://127.0.0.1:4301",
          "http://127.0.0.1:4301",
        ]);
        expect(runtimeMock.state.closeCalls).toEqual([]);

        yield* advanceIdleClock;

        expect(runtimeMock.state.closeCalls).toEqual(["http://127.0.0.1:4301"]);
      }),
    ).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("starts a new server after the warm server idles out", () =>
    withOpenCodeTextGeneration(DEFAULT_OPENCODE_SETTINGS, (textGeneration) =>
      Effect.gen(function* () {
        yield* textGeneration.generateCommitMessage({
          cwd: process.cwd(),
          branch: "feature/opencode-reuse",
          stagedSummary: "M README.md",
          stagedPatch: "diff --git a/README.md b/README.md",
          modelSelection: DEFAULT_TEST_MODEL_SELECTION,
        });

        yield* advanceIdleClock;

        yield* textGeneration.generateCommitMessage({
          cwd: process.cwd(),
          branch: "feature/opencode-reuse",
          stagedSummary: "M README.md",
          stagedPatch: "diff --git a/README.md b/README.md",
          modelSelection: DEFAULT_TEST_MODEL_SELECTION,
        });

        expect(runtimeMock.state.startCalls).toEqual(["fake-opencode", "fake-opencode"]);
        expect(runtimeMock.state.promptUrls).toEqual([
          "http://127.0.0.1:4301",
          "http://127.0.0.1:4302",
        ]);
        expect(runtimeMock.state.closeCalls).toEqual(["http://127.0.0.1:4301"]);
      }),
    ).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("preserves the SDK cause when session creation fails", () =>
    withOpenCodeTextGeneration(DEFAULT_OPENCODE_SETTINGS, (textGeneration) =>
      Effect.gen(function* () {
        const sdkCause = new Error("session endpoint unavailable");
        runtimeMock.state.sessionCreateError = sdkCause;

        const error = yield* textGeneration
          .generateCommitMessage(DEFAULT_COMMIT_MESSAGE_INPUT)
          .pipe(Effect.flip);

        expect(error).toBeInstanceOf(TextGenerationError);
        expect(error.message).toContain("OpenCode session.create request failed.");
        expect(error.cause).toMatchObject({
          _tag: "OpenCodeTextGenerationSessionRequestError",
          operation: "generateCommitMessage",
          cwd: process.cwd(),
          cause: sdkCause,
        });
        expect((error.cause as { cause: unknown }).cause).toBe(sdkCause);
      }),
    ),
  );

  it.effect("reports a missing session payload without manufacturing a cause", () =>
    withOpenCodeTextGeneration(DEFAULT_OPENCODE_SETTINGS, (textGeneration) =>
      Effect.gen(function* () {
        runtimeMock.state.sessionResult = {};

        const error = yield* textGeneration
          .generateCommitMessage(DEFAULT_COMMIT_MESSAGE_INPUT)
          .pipe(Effect.flip);

        expect(error.message).toContain("OpenCode session.create returned no session payload.");
        expect(error.cause).toMatchObject({
          _tag: "OpenCodeTextGenerationSessionPayloadError",
          operation: "generateCommitMessage",
          cwd: process.cwd(),
        });
        expect(error.cause).not.toHaveProperty("cause");
      }),
    ),
  );

  it.effect("preserves the SDK cause and request context when prompting fails", () =>
    withOpenCodeTextGeneration(DEFAULT_OPENCODE_SETTINGS, (textGeneration) =>
      Effect.gen(function* () {
        const sdkCause = new Error("prompt endpoint unavailable");
        runtimeMock.state.promptRequestError = sdkCause;

        const error = yield* textGeneration
          .generateCommitMessage(DEFAULT_COMMIT_MESSAGE_INPUT)
          .pipe(Effect.flip);

        expect(error.message).toContain("OpenCode session.prompt request failed.");
        expect(error.cause).toMatchObject({
          _tag: "OpenCodeTextGenerationPromptRequestError",
          operation: "generateCommitMessage",
          cwd: process.cwd(),
          sessionId: "http://127.0.0.1:4301/session",
          providerId: "openai",
          modelId: "gpt-5",
          cause: sdkCause,
        });
        expect((error.cause as { cause: unknown }).cause).toBe(sdkCause);
      }),
    ),
  );

  it.effect("returns a typed empty-output error for malformed and blank response parts", () =>
    withOpenCodeTextGeneration(DEFAULT_OPENCODE_SETTINGS, (textGeneration) =>
      Effect.gen(function* () {
        runtimeMock.state.promptResult = {
          data: {
            parts: [null, { type: "tool" }, { type: "text", text: "   " }],
          },
        };

        const error = yield* textGeneration
          .generateCommitMessage(DEFAULT_COMMIT_MESSAGE_INPUT)
          .pipe(Effect.flip);

        expect(error.message).toContain("OpenCode returned empty output.");
        expect(error.cause).toMatchObject({
          _tag: "OpenCodeTextGenerationEmptyOutputError",
          operation: "generateCommitMessage",
          cwd: process.cwd(),
          sessionId: "http://127.0.0.1:4301/session",
          providerId: "openai",
          modelId: "gpt-5",
          responsePartCount: 3,
          textPartCount: 1,
        });
        expect(error.cause).not.toHaveProperty("cause");
      }),
    ),
  );

  it.effect("parses JSON returned as plain text output", () =>
    withOpenCodeTextGeneration(DEFAULT_OPENCODE_SETTINGS, (textGeneration) =>
      Effect.gen(function* () {
        runtimeMock.state.promptResult = {
          data: {
            parts: [
              {
                type: "text",
                text: 'Here is the result:\n{"subject":"Tighten OpenCode parsing","body":"Handle JSON text output locally."}',
              },
            ],
          },
        };

        const result = yield* textGeneration.generateCommitMessage({
          cwd: process.cwd(),
          branch: "feature/opencode-reuse",
          stagedSummary: "M README.md",
          stagedPatch: "diff --git a/README.md b/README.md",
          modelSelection: DEFAULT_TEST_MODEL_SELECTION,
        });

        expect(result).toEqual({
          subject: "Tighten OpenCode parsing",
          body: "Handle JSON text output locally.",
        });
      }),
    ),
  );

  it.effect("surfaces the upstream OpenCode structured-output error message", () =>
    withOpenCodeTextGeneration(DEFAULT_OPENCODE_SETTINGS, (textGeneration) =>
      Effect.gen(function* () {
        runtimeMock.state.promptResult = {
          data: {
            info: {
              error: {
                name: "StructuredOutputError",
                data: {
                  message: "Model did not produce structured output",
                  retries: 2,
                },
              },
            },
          },
        };

        const error = yield* textGeneration
          .generateCommitMessage(DEFAULT_COMMIT_MESSAGE_INPUT)
          .pipe(Effect.flip);

        expect(error.message).toContain("Model did not produce structured output");
        expect(error.cause).toMatchObject({
          _tag: "OpenCodeTextGenerationPromptResponseError",
          operation: "generateCommitMessage",
          cwd: process.cwd(),
          sessionId: "http://127.0.0.1:4301/session",
          providerId: "openai",
          modelId: "gpt-5",
          providerErrorName: "StructuredOutputError",
          providerMessage: "Model did not produce structured output",
        });
        expect(error.cause).not.toHaveProperty("cause");
      }),
    ),
  );
});

it.layer(OpenCodeTextGenerationExistingServerTestLayer)(
  "OpenCodeTextGeneration with configured server URL",
  (it) => {
    it.effect("does not send a local environment password to a configured server", () =>
      withOpenCodeTextGeneration(
        EXTERNAL_SERVER_WITHOUT_AUTH_OPENCODE_SETTINGS,
        (textGeneration) =>
          Effect.gen(function* () {
            yield* textGeneration.generateCommitMessage(DEFAULT_COMMIT_MESSAGE_INPUT);
            expect(runtimeMock.state.authHeaders).toEqual([null]);
          }),
        { OPENCODE_SERVER_PASSWORD: "local-secret" },
      ),
    );

    it.effect("does not create a session when the server version is unsupported", () =>
      withOpenCodeTextGeneration(EXISTING_SERVER_OPENCODE_SETTINGS, (textGeneration) =>
        Effect.gen(function* () {
          runtimeMock.state.connectionError = new Error(
            "OpenCode v1.14.18 is too old. Upgrade to v1.14.19 or newer.",
          );

          const error = yield* textGeneration
            .generateCommitMessage(DEFAULT_COMMIT_MESSAGE_INPUT)
            .pipe(Effect.flip);

          expect(error).toBeInstanceOf(TextGenerationError);
          expect(error.message).toContain("v1.14.18 is too old");
          expect(runtimeMock.state.sessionCreateCalls).toBe(0);
        }),
      ),
    );

    it.effect("reuses a configured OpenCode server URL without spawning or applying idle TTL", () =>
      withOpenCodeTextGeneration(EXISTING_SERVER_OPENCODE_SETTINGS, (textGeneration) =>
        Effect.gen(function* () {
          yield* textGeneration.generateCommitMessage({
            cwd: process.cwd(),
            branch: "feature/opencode-reuse",
            stagedSummary: "M README.md",
            stagedPatch: "diff --git a/README.md b/README.md",
            modelSelection: DEFAULT_TEST_MODEL_SELECTION,
          });
          yield* textGeneration.generateCommitMessage({
            cwd: process.cwd(),
            branch: "feature/opencode-reuse",
            stagedSummary: "M README.md",
            stagedPatch: "diff --git a/README.md b/README.md",
            modelSelection: DEFAULT_TEST_MODEL_SELECTION,
          });

          expect(runtimeMock.state.startCalls).toEqual([]);
          expect(runtimeMock.state.promptUrls).toEqual([
            "http://127.0.0.1:9999",
            "http://127.0.0.1:9999",
          ]);
          expect(runtimeMock.state.authHeaders).toEqual([
            `Basic ${btoa("opencode:secret-password")}`,
            `Basic ${btoa("opencode:secret-password")}`,
          ]);

          yield* advanceIdleClock;

          expect(runtimeMock.state.closeCalls).toEqual([]);
        }),
      ).pipe(Effect.provide(TestClock.layer())),
    );

    it.effect(
      "waits for a native 2.x completion before reading the title without using the legacy SDK",
      () =>
        Effect.gen(function* () {
          const fixture = yield* nativeFixture;
          const settings = decodeOpenCodeSettings({
            serverUrl: fixture.url,
            serverPassword: "native-secret",
          });
          yield* withOpenCodeTextGeneration(
            settings,
            (textGeneration) =>
              Effect.gen(function* () {
                const fiber = yield* Effect.forkChild(
                  textGeneration.generateThreadTitle({
                    cwd: process.cwd(),
                    message: "Create a title",
                    modelSelection: {
                      ...DEFAULT_TEST_MODEL_SELECTION,
                      options: [
                        { id: "agent", value: "build" },
                        { id: "variant", value: "fast" },
                      ],
                    },
                  }),
                );
                yield* Effect.promise(() => fixture.waitStarted);
                expect(fixture.requests.map((request) => request.path)).toEqual([
                  "/api/session",
                  "/api/session/ses_title/prompt",
                  "/api/experimental/session/ses_title/wait",
                ]);
                expect(fixture.requests[0]?.body).toMatchObject({
                  location: { directory: process.cwd() },
                  permissions: [{ action: "*", resource: "*", effect: "deny" }],
                  model: { id: "gpt-5", providerID: "openai", variant: "fast" },
                  agent: "build",
                });
                expect(fixture.requests[1]?.body).toMatchObject({ text: expect.any(String) });
                fixture.releaseWait();
                expect(yield* Fiber.join(fiber)).toEqual({ title: "Native title" });
                expect(fixture.requests.map((request) => request.path)).toEqual([
                  "/api/session",
                  "/api/session/ses_title/prompt",
                  "/api/experimental/session/ses_title/wait",
                  "/api/session/ses_title",
                  expect.stringContaining("/api/session/ses_title/message"),
                  "/api/session/ses_title",
                ]);
                expect(fixture.requests.at(-1)?.body).toEqual({});
                expect(
                  fixture.requests.every(
                    (request) =>
                      request.authorization === `Basic ${btoa("opencode:native-secret")}`,
                  ),
                ).toBe(true);
                expect(runtimeMock.state.promptUrls).toEqual([]);
              }),
            undefined,
            "native",
          );
        }).pipe(Effect.scoped),
    );

    it.effect(
      "fails native text generation on a failed session instead of returning stale assistant text",
      () =>
        Effect.gen(function* () {
          const fixture = yield* nativeFixture;
          fixture.setOutcome("failed");
          fixture.setText('{"title":"Stale response"}');
          fixture.releaseWait();
          const settings = decodeOpenCodeSettings({ serverUrl: fixture.url });
          const error = yield* withOpenCodeTextGeneration(
            settings,
            (textGeneration) =>
              Effect.flip(
                textGeneration.generateThreadTitle({
                  cwd: process.cwd(),
                  message: "Create a title",
                  modelSelection: DEFAULT_TEST_MODEL_SELECTION,
                }),
              ),
            undefined,
            "native",
          );
          expect(error).toBeInstanceOf(TextGenerationError);
          expect(error.cause).toMatchObject({ _tag: "OpenCodeTextGenerationPromptResponseError" });
          expect(fixture.requests.at(-1)?.path).toBe("/api/session/ses_title");
          expect(runtimeMock.state.promptUrls).toEqual([]);
        }).pipe(Effect.scoped),
    );
    it.effect("reports a native completion wait failure without reading an incomplete title", () =>
      Effect.gen(function* () {
        const fixture = yield* nativeFixture;
        fixture.setWaitStatus(503);
        fixture.releaseWait();
        const settings = decodeOpenCodeSettings({ serverUrl: fixture.url });
        const error = yield* withOpenCodeTextGeneration(
          settings,
          (textGeneration) =>
            Effect.flip(
              textGeneration.generateThreadTitle({
                cwd: process.cwd(),
                message: "Create a title",
                modelSelection: DEFAULT_TEST_MODEL_SELECTION,
              }),
            ),
          undefined,
          "native",
        );
        expect(error).toBeInstanceOf(TextGenerationError);
        expect(error.cause).toMatchObject({ _tag: "OpenCodeTextGenerationCompletionRequestError" });
        expect(fixture.requests.map((request) => request.path)).toEqual([
          "/api/session",
          "/api/session/ses_title/prompt",
          "/api/experimental/session/ses_title/wait",
          "/api/session/ses_title",
        ]);
      }).pipe(Effect.scoped),
    );
    it.effect("preserves a native prompt failure when temporary session removal fails", () =>
      Effect.gen(function* () {
        const fixture = yield* nativeFixture;
        fixture.setPromptStatus(503);
        fixture.setRemoveStatus(503);
        const error = yield* withOpenCodeTextGeneration(
          decodeOpenCodeSettings({ serverUrl: fixture.url }),
          (textGeneration) =>
            Effect.flip(
              textGeneration.generateThreadTitle({
                cwd: process.cwd(),
                message: "Create a title",
                modelSelection: DEFAULT_TEST_MODEL_SELECTION,
              }),
            ),
          undefined,
          "native",
        );
        expect(error.cause).toMatchObject({ _tag: "OpenCodeTextGenerationPromptRequestError" });
        expect(fixture.requests.map((request) => request.path)).toEqual([
          "/api/session",
          "/api/session/ses_title/prompt",
          "/api/session/ses_title",
        ]);
      }).pipe(Effect.scoped),
    );

    it.effect("does not remove a session whose location does not match the temporary request", () =>
      Effect.gen(function* () {
        const fixture = yield* nativeFixture;
        fixture.setSessionDirectory("/someone-else/workspace");
        const error = yield* withOpenCodeTextGeneration(
          decodeOpenCodeSettings({ serverUrl: fixture.url }),
          (textGeneration) =>
            Effect.flip(
              textGeneration.generateThreadTitle({
                cwd: process.cwd(),
                message: "Create a title",
                modelSelection: DEFAULT_TEST_MODEL_SELECTION,
              }),
            ),
          undefined,
          "native",
        );
        expect(error.cause).toMatchObject({ _tag: "OpenCodeTextGenerationSessionPayloadError" });
        expect(fixture.requests.map((request) => request.path)).toEqual(["/api/session"]);
      }).pipe(Effect.scoped),
    );
  },
);
