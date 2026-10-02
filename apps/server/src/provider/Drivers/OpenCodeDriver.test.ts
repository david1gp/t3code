// @effect-diagnostics nodeBuiltinImport:off - protocol fixtures use in-process HTTP.
import * as NodeHttp from "node:http";
import type * as NodeNet from "node:net";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { createOpencodeClient } from "@opencode-ai/sdk/v2";
import { expect, it } from "@effect/vitest";
import { ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { providerModelsResolveForCwd } from "../../../../../packages/client-runtime/src/providerModelsResolveForCwd.ts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { HttpClient } from "effect/unstable/http";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { ProviderDriverError } from "../Errors.ts";
import { NoOpProviderEventLoggers, ProviderEventLoggers } from "../Layers/ProviderEventLoggers.ts";
import { upsertProviderWorkspaceSnapshot } from "../Layers/ProviderRegistry.ts";
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

const nativeAgentFixture = (serverCwd: string) =>
  Effect.acquireRelease(
    Effect.promise(async () => {
      const requests: Array<{ path: string; directory: string | null }> = [];
      const switches: string[] = [];
      const promptAgents: string[] = [];
      let stream: NodeHttp.ServerResponse | undefined;
      let directory = "";
      let agent = "";
      let eventId = 0;
      const agents = (cwd: string) =>
        (cwd === serverCwd
          ? ["build", "review", "plan"]
          : ["review", "build", "plan", "project-only"]
        ).map((id) => ({
          id,
          name: id,
          mode: "primary",
          hidden: false,
          request: { settings: {}, headers: {}, body: {} },
          permissions: [],
        }));
      const send = (res: NodeHttp.ServerResponse, body: unknown) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
      };
      const server = NodeHttp.createServer((req, res) => {
        const url = new URL(req.url ?? "/", "http://fixture");
        const cwd = url.searchParams.get("location[directory]");
        requests.push({ path: url.pathname, directory: cwd });
        if (url.pathname === "/api/info") {
          send(res, { version: "2.0.18", pid: 1, urls: [], paths: { tmp: "/tmp" } });
          return;
        }
        if (url.pathname === "/api/event") {
          stream = res;
          res.writeHead(200, { "content-type": "text/event-stream" });
          res.write('data: {"id":"evt_connected","type":"server.connected","data":{}}\n\n');
          return;
        }
        if (cwd !== null) {
          if (url.pathname === "/api/config") {
            send(res, [
              { type: "document", info: { model: { providerID: "openai", model: "gpt-5" } } },
            ]);
            return;
          }
          const data =
            url.pathname === "/api/agent"
              ? agents(cwd)
              : url.pathname === "/api/provider"
                ? [{ id: "openai", name: "OpenAI", activation: "enabled", package: "openai" }]
                : url.pathname === "/api/model"
                  ? [
                      {
                        id: "gpt-5",
                        modelID: "gpt-5",
                        providerID: "openai",
                        name: "GPT-5",
                        enabled: true,
                        status: "active",
                        variants: [],
                        capabilities: { tools: true, input: ["text"], output: ["text"] },
                        time: { released: 0 },
                        cost: [],
                        limit: { context: 128000, output: 16000 },
                      },
                    ]
                  : [];
          send(res, { location: { directory: cwd }, data });
          return;
        }
        if (url.pathname.endsWith("/permission") || url.pathname.endsWith("/form")) {
          send(res, { data: [] });
          return;
        }
        void (async () => {
          const chunks: Buffer[] = [];
          for await (const chunk of req) chunks.push(Buffer.from(chunk));
          const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
            location?: { directory: string };
            agent?: string;
            id?: string;
          };
          if (url.pathname === "/api/session") {
            directory = body.location!.directory;
            agent = body.agent ?? agents(directory)[0]!.id;
            send(res, { data: { id: "ses_agent", location: { directory } } });
            return;
          }
          if (url.pathname.endsWith("/agent")) {
            agent = body.agent!;
            switches.push(agent);
            res.writeHead(204).end();
            return;
          }
          if (url.pathname.endsWith("/prompt")) {
            promptAgents.push(agent);
            for (const type of ["session.execution.started", "session.execution.succeeded"]) {
              const seq = ++eventId;
              stream!.write(
                `data: ${JSON.stringify({
                  id: `evt_${seq}`,
                  created: seq,
                  type,
                  data: { sessionID: "ses_agent" },
                  durable: { aggregateID: "ses_agent", seq, version: 1 },
                })}\n\n`,
              );
            }
            send(res, { data: { id: body.id, sessionID: "ses_agent", type: "user" } });
            return;
          }
          res.writeHead(404).end();
        })();
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      return {
        server,
        requests,
        switches,
        promptAgents,
        url: `http://127.0.0.1:${(server.address() as NodeNet.AddressInfo).port}`,
      };
    }),
    ({ server }) =>
      Effect.promise(
        () =>
          new Promise<void>((resolve) => {
            server.close(() => resolve());
            server.closeAllConnections();
          }),
      ),
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

  for (const inventoryPath of ["full then workspace", "workspace only", "cold session"] as const) {
    it.effect(
      `restores the cwd default agent after plan mode using ${inventoryPath} inventory`,
      () =>
        Effect.gen(function* () {
          const config = yield* ServerConfig;
          // Only the first case uses a full inventory for the session's own cwd.
          const server = yield* nativeAgentFixture(
            inventoryPath === "full then workspace" ? "/another-cwd" : config.cwd,
          );
          const id = `agents-${inventoryPath.replaceAll(" ", "-")}`;
          const instance = yield* OpenCodeDriver.create(input(id, server.url));
          yield* Stream.merge(
            instance.snapshot.streamChanges,
            Stream.fromEffect(instance.snapshot.getSnapshot),
          ).pipe(
            Stream.filter((snapshot) => snapshot.models.length > 0),
            Stream.take(1),
            Stream.runDrain,
          );
          const cwd = inventoryPath === "full then workspace" ? config.cwd : "/tmp/review-project";
          const before = server.requests.length;
          if (inventoryPath !== "cold session") {
            expect(instance.snapshotForCwd).toBeDefined();
            yield* instance.snapshotForCwd!(cwd);
          }
          const threadId = ThreadId.make(id);
          yield* instance.adapter.startSession({ threadId, cwd, runtimeMode: "full-access" });
          for (const interactionMode of ["plan", "default"] as const) {
            const turn = yield* instance.adapter.sendTurn({
              threadId,
              input: interactionMode === "plan" ? "make a plan" : "review it",
              interactionMode,
            });
            yield* instance.adapter.streamEvents.pipe(
              Stream.filter(
                (event) => event.type === "turn.completed" && event.turnId === turn.turnId,
              ),
              Stream.take(1),
              Stream.runDrain,
            );
          }
          expect(server.switches).toEqual(["plan", "review"]);
          expect(server.promptAgents).toEqual(["plan", "review"]);
          // Workspace refresh and cold-session loading must not fetch models/providers,
          // nor repeat inventory requests on turns once the cwd cache is populated.
          expect(
            server.requests
              .slice(before)
              .filter((request) => request.directory === cwd)
              .map((request) => request.path)
              .toSorted(),
          ).toEqual(["/api/agent", "/api/command", "/api/config", "/api/skill"]);
          yield* instance.adapter.stopSession(threadId);
        }).pipe(Effect.scoped),
    );
  }

  it.effect(
    "publishes cwd agents per instance without changing machine model inventory or defaults",
    () =>
      Effect.gen(function* () {
        const config = yield* ServerConfig;
        const firstServer = yield* nativeAgentFixture(config.cwd);
        const secondServer = yield* nativeAgentFixture("/tmp/review-project");
        const first = yield* OpenCodeDriver.create(input("first-catalog", firstServer.url));
        const second = yield* OpenCodeDriver.create(input("second-catalog", secondServer.url));
        for (const instance of [first, second]) {
          yield* Stream.merge(
            instance.snapshot.streamChanges,
            Stream.fromEffect(instance.snapshot.getSnapshot),
          ).pipe(
            Stream.filter((snapshot) => snapshot.models.length > 0),
            Stream.take(1),
            Stream.runDrain,
          );
        }
        const machine = yield* first.snapshot.getSnapshot;
        const before = firstServer.requests.length;
        const workspace = yield* first.snapshotForCwd!("/tmp/review-project");
        const otherInstance = yield* second.snapshotForCwd!("/tmp/review-project");
        const agents = (snapshot: typeof machine) =>
          snapshot.models[0]?.capabilities?.optionDescriptors?.find(
            (entry) => entry.id === "agent",
          );
        expect(agents(machine)?.currentValue).toBe("build");
        expect(agents(workspace)?.currentValue).toBe("review");
        expect(agents(otherInstance)?.currentValue).toBe("build");
        const workspaceAgents = agents(workspace);
        expect(workspaceAgents?.type).toBe("select");
        if (workspaceAgents?.type === "select") {
          expect(workspaceAgents.options.map((option) => option.id)).toContain("project-only");
        }
        const machineAgents = agents(machine);
        if (machineAgents?.type === "select") {
          expect(machineAgents.options.map((option) => option.id)).not.toContain("project-only");
        }
        expect(workspace.models.map(({ capabilities: _capabilities, ...model }) => model)).toEqual(
          machine.models.map(({ capabilities: _capabilities, ...model }) => model),
        );
        expect((yield* first.snapshot.getSnapshot).models).toEqual(machine.models);
        const published = upsertProviderWorkspaceSnapshot(
          machine,
          "/tmp/review-project",
          workspace,
        );
        const resolved = providerModelsResolveForCwd(published, "/tmp/review-project");
        expect(
          resolved[0]?.capabilities?.optionDescriptors?.find((entry) => entry.id === "agent"),
        ).toEqual(workspaceAgents);
        expect(resolved.map(({ capabilities: _capabilities, ...model }) => model)).toEqual(
          machine.models.map(({ capabilities: _capabilities, ...model }) => model),
        );
        expect(published.models).toBe(machine.models);
        expect(published.workspaceSnapshots?.[0]?.modelOptionOverlays).toEqual(
          workspace.models.map((model) => ({
            slug: model.slug,
            optionDescriptors:
              model.capabilities?.optionDescriptors?.filter((entry) => entry.id === "agent") ?? [],
          })),
        );
        expect(providerModelsResolveForCwd(published, config.cwd)).toBe(machine.models);
        const secondPublished = upsertProviderWorkspaceSnapshot(
          yield* second.snapshot.getSnapshot,
          "/tmp/review-project",
          otherInstance,
        );
        expect(
          providerModelsResolveForCwd(
            secondPublished,
            "/tmp/review-project",
          )[0]?.capabilities?.optionDescriptors?.find((entry) => entry.id === "agent")
            ?.currentValue,
        ).toBe("build");
        expect(
          firstServer.requests
            .slice(before)
            .filter((request) => request.directory === "/tmp/review-project")
            .map((request) => request.path)
            .toSorted(),
        ).toEqual(["/api/agent", "/api/command", "/api/config", "/api/skill"]);
        const restored = yield* first.snapshotForCwd!(config.cwd);
        expect(agents(restored)?.currentValue).toBe("build");
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
