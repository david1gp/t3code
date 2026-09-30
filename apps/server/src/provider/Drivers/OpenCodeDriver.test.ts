// @effect-diagnostics nodeBuiltinImport:off - protocol fixtures use in-process HTTP.
import * as NodeHttp from "node:http";
import type * as NodeNet from "node:net";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { createOpencodeClient } from "@opencode-ai/sdk/v2";
import { expect, it } from "@effect/vitest";
import { ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpClient } from "effect/unstable/http";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { ProviderDriverError } from "../Errors.ts";
import { NoOpProviderEventLoggers, ProviderEventLoggers } from "../Layers/ProviderEventLoggers.ts";
import {
  OpenCodeRuntime,
  OpenCodeRuntimeError,
  type OpenCodeRuntimeShape,
} from "../opencodeRuntime.ts";
import { OpenCodeDriver } from "./OpenCodeDriver.ts";

const connections: Array<{ url: string; directory: string }> = [];
const runtime: OpenCodeRuntimeShape = {
  connectToOpenCodeServer: ({ serverUrl, directory }) => {
    connections.push({ url: serverUrl ?? "local", directory });
    return Effect.fail(
      new OpenCodeRuntimeError({ operation: "connect", detail: "Legacy chat reached" }),
    );
  },
  startOpenCodeServerProcess: () => Effect.die("Local server must not start"),
  runOpenCodeCommand: () => Effect.die("CLI must not run"),
  createOpenCodeSdkClient: () => {
    throw new Error("SDK must not be used during creation");
  },
  loadOpenCodeInventory: () => Effect.die("Inventory must not load"),
  loadInventoryFromCli: () => Effect.die("Inventory must not load"),
  loadOpenCodeSkills: () => Effect.die("Skills must not load"),
  loadSkillsFromCli: () => Effect.die("Skills must not load"),
};

const testLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-opencode-driver-route-",
}).pipe(
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(ServerSettingsService.layerTest()),
  Layer.provideMerge(Layer.succeed(OpenCodeRuntime, runtime)),
  Layer.provideMerge(Layer.succeed(ProviderEventLoggers, NoOpProviderEventLoggers)),
  Layer.provideMerge(
    Layer.mock(BackgroundPolicy.BackgroundPolicy)({
      shouldRunScopeWork: () => Effect.succeed(false),
    }),
  ),
  Layer.provideMerge(
    Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make(() => Effect.die("No HTTP usage request")),
    ),
  ),
  Layer.provideMerge(
    Layer.succeed(
      ChildProcessSpawner.ChildProcessSpawner,
      ChildProcessSpawner.make(() => Effect.die("No CLI spawn")),
    ),
  ),
);

const input = (id: string, url: string, password = "secret") => ({
  instanceId: ProviderInstanceId.make(id),
  displayName: id,
  enabled: true,
  environment: [],
  config: {
    ...OpenCodeDriver.defaultConfig(),
    enabled: true,
    serverUrl: url,
    serverPassword: password,
  },
});

const chat = (id: string) => ({
  threadId: ThreadId.make(id),
  cwd: `/tmp/${id}`,
  runtimeMode: "approval-required" as const,
});

const fixture = (status: number, version = "2.0.18") =>
  Effect.acquireRelease(
    Effect.promise(async () => {
      const requests: Array<{ path: string; authorization: string | undefined }> = [];
      const server = NodeHttp.createServer((req, res) => {
        requests.push({ path: req.url ?? "", authorization: req.headers.authorization });
        if (req.url === "/api/info") {
          res.writeHead(status, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ version, pid: 1, urls: [], paths: { tmp: "/tmp" } }));
          return;
        }
        const nativeResponse =
          req.url === "/api/session" && req.method === "POST"
            ? { data: { id: "ses_title", location: { directory: "/tmp/native-thread" } } }
            : req.url === "/api/session/ses_title/prompt"
              ? { data: { id: "msg_title", sessionID: "ses_title", type: "user" } }
              : req.url === "/api/session/ses_title"
                ? { data: { outcome: "succeeded" } }
                : req.url?.startsWith("/api/session/ses_title/message")
                  ? {
                      data: [
                        {
                          type: "assistant",
                          time: { completed: 1 },
                          content: [{ type: "text", text: '{"title":"Native title"}' }],
                        },
                      ],
                      cursor: {},
                    }
                  : undefined;
        if (req.url === "/api/experimental/session/ses_title/wait") {
          res.writeHead(204);
          res.end();
          return;
        }
        if (nativeResponse) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(nativeResponse));
          return;
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ healthy: true, version: "1.18.32" }));
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      return {
        server,
        requests,
        url: `http://127.0.0.1:${(server.address() as NodeNet.AddressInfo).port}`,
      };
    }),
    ({ server }) =>
      Effect.promise(() => new Promise<void>((resolve) => server.close(() => resolve()))),
  );

it.layer(testLayer)("OpenCodeDriver chat protocol routing", (it) => {
  it.effect("binds native and verified legacy chat to separate cached adapters", () =>
    Effect.gen(function* () {
      connections.length = 0;
      const nativeServer = yield* fixture(200);
      const legacyServer = yield* fixture(404);
      const native = yield* OpenCodeDriver.create(
        input("native", nativeServer.url, "native-secret"),
      );
      const legacy = yield* OpenCodeDriver.create(
        input("legacy", legacyServer.url, "legacy-secret"),
      );

      expect(native.adapter).not.toBe(legacy.adapter);
      const nativeError = yield* Effect.flip(native.adapter.startSession(chat("native-thread")));
      expect(nativeError).toMatchObject({
        _tag: "ProviderAdapterValidationError",
        operation: "startSession",
      });
      expect(connections.filter((entry) => entry.directory === "/tmp/native-thread")).toEqual([]);
      expect(
        yield* native.textGeneration.generateThreadTitle({
          cwd: "/tmp/native-thread",
          message: "Name this thread",
          modelSelection: { instanceId: ProviderInstanceId.make("native"), model: "openai/gpt-5" },
        }),
      ).toEqual({ title: "Native title" });
      expect(connections.filter((entry) => entry.directory === "/tmp/native-thread")).toEqual([]);
      expect(nativeServer.requests.map((request) => request.path)).toContain(
        "/api/session/ses_title/prompt",
      );
      const legacyError = yield* Effect.flip(legacy.adapter.startSession(chat("legacy-thread")));
      expect(legacyError).toMatchObject({ _tag: "ProviderAdapterProcessError" });
      expect(connections.filter((entry) => entry.directory === "/tmp/legacy-thread")).toEqual([
        { url: legacyServer.url, directory: "/tmp/legacy-thread" },
      ]);
      expect(
        nativeServer.requests.some(
          (request) =>
            request.path === "/api/info" &&
            request.authorization ===
              `Basic ${Buffer.from("opencode:native-secret").toString("base64")}`,
        ),
      ).toBe(true);
      expect(
        legacyServer.requests.some(
          (request) =>
            request.path === "/global/health?directory=" + encodeURIComponent(process.cwd()),
        ),
      ).toBe(true);
    }).pipe(Effect.scoped),
  );

  it.effect(
    "fails closed with typed authorization and version errors before creating a chat adapter",
    () =>
      Effect.gen(function* () {
        connections.length = 0;
        for (const [status, version] of [
          [401, "2.0.18"],
          [503, "2.0.18"],
          [200, "2.0.17"],
        ] as const) {
          const server = yield* fixture(status, version);
          const error = yield* Effect.flip(
            OpenCodeDriver.create(input(`bad-${status}`, server.url)),
          );
          expect(error).toBeInstanceOf(ProviderDriverError);
          expect(error.cause).toBeInstanceOf(OpenCodeRuntimeError);
          expect(error.detail).toMatch(
            status === 200 ? /requires v2\.0\.18/ : new RegExp(`HTTP ${status}`),
          );
          expect(server.requests.map((request) => request.path)).toEqual(["/api/info"]);
        }
        expect(connections).toEqual([]);
      }).pipe(Effect.scoped),
  );

  it.effect("keeps a blank URL on the local legacy chat path without probing", () =>
    Effect.gen(function* () {
      connections.length = 0;
      const local = yield* OpenCodeDriver.create(input("local", ""));
      const error = yield* Effect.flip(local.adapter.startSession(chat("local-thread")));
      expect(error).toMatchObject({ _tag: "ProviderAdapterProcessError" });
      expect(connections.filter((entry) => entry.directory === "/tmp/local-thread")).toEqual([
        { url: "", directory: "/tmp/local-thread" },
      ]);
    }).pipe(Effect.scoped),
  );

  it.effect(
    "does not turn a failed legacy cwd command request into a cached compact-only snapshot",
    () =>
      Effect.gen(function* () {
        const server = yield* fixture(404);
        const instance = yield* OpenCodeDriver.create(input("legacy-cwd", server.url)).pipe(
          Effect.provideService(OpenCodeRuntime, {
            ...runtime,
            connectToOpenCodeServer: () =>
              Effect.succeed({
                url: server.url,
                version: "1.18.32",
                external: true,
                exitCode: null,
              }),
            createOpenCodeSdkClient: ({ baseUrl, directory }) =>
              createOpencodeClient({
                baseUrl,
                directory,
                fetch: Object.assign(
                  async (request: string | Request | URL) => {
                    const route = new URL(
                      request instanceof Request ? request.url : request.toString(),
                    ).pathname;
                    return route === "/command"
                      ? new Response("Unavailable", { status: 503 })
                      : Response.json([]);
                  },
                  { preconnect: () => undefined },
                ),
              }),
            loadOpenCodeSkills: () => Effect.succeed([]),
          }),
        );
        const probe = instance.snapshotForCwd;
        expect(probe).toBeDefined();
        if (!probe) return;
        const result = yield* Effect.exit(probe("/workspace"));
        expect(result._tag).toBe("Failure");
      }).pipe(Effect.scoped),
  );
});
