// @effect-diagnostics nodeBuiltinImport:off - the suite seeds and grows real
// transcript trees on disk, outside the service's Effect FileSystem.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { HostProcessEnvironment } from "@t3tools/shared/hostProcess";
import { mergeUsage } from "@t3tools/shared/usageMerge";
import {
  EnvironmentId,
  EventId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  UsageDay,
  type UsageSummaryInput,
} from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Scheduler from "effect/Scheduler";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import {
  ProjectionThreadActivityRepository,
  type ProjectionUsageCostActivity,
} from "../persistence/Services/ProjectionThreadActivities.ts";
import { ProjectionThreadActivityRepositoryLive } from "../persistence/Layers/ProjectionThreadActivities.ts";
import { layerConfig as SqlitePersistenceConfig } from "../persistence/Layers/Sqlite.ts";
import * as UsageService from "./UsageService.ts";

const encodeUnknownJsonString = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

function claudeLine(id: number, outputTokens: number, model = "claude-fable-5"): string {
  return `${JSON.stringify({
    type: "assistant",
    timestamp: "2026-08-01T10:00:00Z",
    requestId: `req_${id}`,
    sessionId: "session-1",
    message: {
      id: `msg_${id}`,
      model,
      usage: { input_tokens: 10, output_tokens: outputTokens },
    },
  })}\n`;
}

const WINDOW: UsageSummaryInput = {
  timeZone: "UTC",
  sinceDay: UsageDay.make("2026-07-31"),
  untilDay: UsageDay.make("2026-08-02"),
};

const setup = Effect.gen(function* () {
  const home = yield* Effect.promise(() =>
    NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "usage-service-test-")),
  );
  yield* Effect.addFinalizer(() =>
    Effect.promise(() => NodeFSP.rm(home, { recursive: true, force: true })),
  );
  const transcriptDir = NodePath.join(home, "claude", "projects", "proj");
  yield* Effect.promise(() => NodeFSP.mkdir(transcriptDir, { recursive: true }));
  return {
    home,
    transcript: NodePath.join(transcriptDir, "session.jsonl"),
    settings: {
      providers: {
        claudeAgent: { homePath: NodePath.join(home, "claude") },
        codex: { homePath: NodePath.join(home, "codex") },
      },
    },
  };
});

const serviceLayers = (input: {
  readonly prefix: string;
  readonly home: string;
  readonly settings: Parameters<typeof ServerSettings.layerTest>[0];
  readonly onRatesFetch?: () => void;
  /** Defaults to an unparsable document so every scan retries the fetch. */
  readonly ratesDocument?: unknown;
  readonly environment?: NodeJS.ProcessEnv;
  readonly usageCostActivities?: readonly ProjectionUsageCostActivity[];
}) => {
  const base = ServerConfig.layerTest(process.cwd(), { prefix: input.prefix }).pipe(
    Layer.provideMerge(NodeServices.layer),
    Layer.provideMerge(ServerSettings.layerTest(input.settings)),
    Layer.provideMerge(
      Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request) =>
          Effect.sync(() => {
            input.onRatesFetch?.();
            // Unparsable rates: every scan retries the fetch, which makes the
            // fetch count a boundary-level observation of how many scans ran.
            return HttpClientResponse.fromWeb(request, Response.json(input.ratesDocument ?? {}));
          }),
        ),
      ),
    ),
    Layer.provideMerge(
      Layer.succeed(HostProcessEnvironment, {
        GROK_HOME: NodePath.join(input.home, "grok"),
        ...input.environment,
      }),
    ),
  );
  const activities = Layer.succeed(
    ProjectionThreadActivityRepository,
    ProjectionThreadActivityRepository.of({
      upsert: () => Effect.void,
      listByThreadId: () => Effect.succeed([]),
      listUsageCostActivities: () => Effect.succeed(input.usageCostActivities ?? []),
      listUserInputLifecycleByThreadId: () => Effect.succeed([]),
      getLatestTaskActivity: () => Effect.succeed(Option.none()),
      deleteByThreadId: () => Effect.void,
    }),
  );
  return activities.pipe(Layer.provideMerge(base));
};

const persistedServiceLayers = (input: Parameters<typeof serviceLayers>[0]) =>
  ProjectionThreadActivityRepositoryLive.pipe(
    Layer.provideMerge(SqlitePersistenceConfig),
    Layer.provideMerge(serviceLayers(input)),
  );

function totalOutputTokens(summary: { buckets: readonly { totals: { outputTokens: number } }[] }) {
  return summary.buckets.reduce((sum, bucket) => sum + bucket.totals.outputTokens, 0);
}

describe("UsageService", () => {
  it.live(
    "merges persisted Pi and OpenCode costs across provider switches into timezone buckets with authoritative zero-token amounts",
    () =>
      Effect.gen(function* () {
        const { settings, home } = yield* setup;
        yield* Effect.gen(function* () {
          const repository = yield* ProjectionThreadActivityRepository;
          const sql = yield* SqlClient.SqlClient;
          const config = yield* ServerConfig.ServerConfig;
          const threadId = ThreadId.make("thread-provider-switch");
          const createdAt = "2026-08-07T04:05:00.000Z";
          for (const [provider, turnId, amount] of [
            ["opencode", "turn-opencode", 0],
            ["pi", "turn-pi", 1.25],
            ["pi", "turn-pi-free", 0],
          ] as const) {
            yield* repository.upsert({
              activityId: EventId.make(`usage-cost-${turnId}`),
              threadId,
              turnId: TurnId.make(turnId),
              tone: "info",
              kind: "usage.cost",
              summary: "Reported cost",
              payload: {
                providerName: provider,
                providerSessionId: "same-session-string",
                model: "shared-model",
                totalCostUsd: amount,
                status: "final",
              },
              createdAt,
            });
          }
          // Mutable selection has already switched to an unrelated provider.
          yield* sql`
            INSERT INTO projection_thread_sessions
              (thread_id, status, provider_name, provider_session_id, runtime_mode, updated_at)
            VALUES (${threadId}, 'idle', 'claude', 'current-session', 'full-access', ${createdAt})
          `;
          const service = yield* UsageService.make;
          const summary = yield* service.readSummary({
            ...WINDOW,
            timeZone: "America/Los_Angeles",
            sinceDay: UsageDay.make("2026-08-06"),
            untilDay: UsageDay.make("2026-08-06"),
          });
          assert.deepStrictEqual(summary.buckets, [
            {
              day: UsageDay.make("2026-08-06"),
              provider: "opencode",
              model: "shared-model",
              totals: {
                uncachedInputTokens: 0,
                cachedInputTokens: 0,
                cacheCreationTokens: 0,
                outputTokens: 0,
                reasoningTokens: 0,
              },
              costUsd: 0,
              cacheSavingsUsd: 0,
              costSource: "providerReported",
              records: 1,
              unpricedRecords: 0,
              sessions: 1,
            },
            {
              day: UsageDay.make("2026-08-06"),
              provider: "pi",
              model: "shared-model",
              totals: {
                uncachedInputTokens: 0,
                cachedInputTokens: 0,
                cacheCreationTokens: 0,
                outputTokens: 0,
                reasoningTokens: 0,
              },
              costUsd: 1.25,
              cacheSavingsUsd: 0,
              costSource: "providerReported",
              records: 2,
              unpricedRecords: 0,
              sessions: 1,
            },
          ]);
          const merged = mergeUsage(
            [
              {
                environmentId: EnvironmentId.make("persisted-provider-switch"),
                label: "persisted provider usage",
                summary,
              },
            ],
            summary.contractVersion,
          );
          assert.strictEqual(merged.costUsd, 1.25);
          assert.strictEqual(merged.totalTokens, 0);
          assert.deepStrictEqual(
            merged.providers
              .map(({ provider, costUsd, totalTokens, records }) => ({
                provider,
                costUsd,
                totalTokens,
                records,
              }))
              .sort((left, right) => left.provider.localeCompare(right.provider)),
            [
              { provider: "opencode", costUsd: 0, totalTokens: 0, records: 1 },
              { provider: "pi", costUsd: 1.25, totalTokens: 0, records: 2 },
            ],
          );
          const stat = yield* Effect.promise(() => NodeFSP.stat(config.dbPath));
          for (const provider of ["opencode", "pi"] as const) {
            const source = summary.sources.find(
              (candidate) => candidate.fingerprint.provider === provider,
            );
            assert.deepStrictEqual(source?.fingerprint, {
              hostId: NodeOS.hostname(),
              provider,
              resolvedHomePath: yield* Effect.promise(() => NodeFSP.realpath(config.dbPath)),
              volumeId: `${stat.dev}:${stat.ino}`,
            });
            assert.strictEqual(source?.distinctSessions, 1);
            assert.strictEqual(source?.scannedFiles, 0);
            assert.strictEqual(source?.status, "ok");
            assert.strictEqual(source?.message, null);
            assert.include(
              source?.description ?? "",
              `${provider === "pi" ? 2 : 1} final and 0 provisional`,
            );
            assert.include(source?.description ?? "", "No external transcript scanner");
          }
          yield* sql`
            UPDATE projection_thread_sessions SET provider_name = 'pi'
            WHERE thread_id = ${threadId}
          `;
          assert.deepStrictEqual(
            (yield* service.readSummary({
              ...WINDOW,
              timeZone: "America/Los_Angeles",
              sinceDay: UsageDay.make("2026-08-06"),
              untilDay: UsageDay.make("2026-08-06"),
            })).buckets,
            summary.buckets,
          );
        }).pipe(
          Effect.provide(
            persistedServiceLayers({
              prefix: "usage-service-projection-switch-test",
              home,
              settings: {
                ...settings,
                usagePriceOverrides: {
                  "shared-model": { inputCostPerMillionTokens: 2, outputCostPerMillionTokens: 8 },
                },
              },
            }),
          ),
        );
      }).pipe(Effect.scoped),
  );

  it.live(
    "keeps historical unresolved money unattributed and reports provisional projection coverage in the actual timezone window",
    () =>
      Effect.gen(function* () {
        const { settings, home } = yield* setup;
        yield* Effect.gen(function* () {
          const repository = yield* ProjectionThreadActivityRepository;
          const sql = yield* SqlClient.SqlClient;
          const threadId = ThreadId.make("thread-historical-costs");
          const createdAt = "2026-08-07T04:05:00.000Z";
          for (const [turn, amount, status] of [
            ["historical-pi", 0.21, "final"],
            ["historical-opencode", 0.32, undefined],
            ["unresolved", 0.9, "final"],
          ] as const) {
            yield* repository.upsert({
              activityId: EventId.make(`historical-cost-${turn}`),
              threadId,
              turnId: TurnId.make(turn),
              tone: "info",
              kind: "usage.cost",
              summary: "Historical cost",
              payload: { totalCostUsd: amount, model: "historical-model", status },
              createdAt,
            });
          }
          for (const [index, provider] of ["pi", "opencode"].entries()) {
            const payload = encodeUnknownJsonString({
              session: { activeTurnId: `historical-${provider}`, providerName: provider },
            });
            yield* sql`
            INSERT INTO orchestration_events (
              event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at,
              actor_kind, payload_json, metadata_json
            ) VALUES (${`historical-${provider}-association`}, 'thread', ${threadId}, ${index + 1},
              'thread.session-set', ${createdAt}, 'provider', ${payload}, '{}')
          `;
          }
          yield* sql`
          INSERT INTO projection_thread_sessions
            (thread_id, status, provider_name, runtime_mode, updated_at)
          VALUES (${threadId}, 'idle', 'pi', 'full-access', ${createdAt})
        `;
          // Query prefilter slack must not count this as partial coverage of the local day.
          yield* repository.upsert({
            activityId: EventId.make("outside-window-provisional"),
            threadId,
            turnId: TurnId.make("outside-window"),
            tone: "info",
            kind: "usage.cost",
            summary: "Outside window",
            payload: {
              providerName: "pi",
              model: "historical-model",
              totalCostUsd: 4,
              status: "provisional",
            },
            createdAt: "2026-08-06T04:05:00.000Z",
          });
          const queried = yield* repository.listUsageCostActivities({
            since: "2026-08-06T00:00:00.000Z",
            until: "2026-08-08T00:00:00.000Z",
          });
          const unresolved = queried.find((record) => record.turnId === "unresolved");
          assert.strictEqual(unresolved?.providerName, null);
          assert.strictEqual(unresolved?.totalCostUsd, 0.9);
          assert.strictEqual(unresolved?.status, "final");
          const service = yield* UsageService.make;
          const summary = yield* service.readSummary({
            ...WINDOW,
            timeZone: "America/Los_Angeles",
            sinceDay: UsageDay.make("2026-08-06"),
            untilDay: UsageDay.make("2026-08-06"),
          });
          assert.deepStrictEqual(
            summary.buckets.map(({ provider, costUsd, records, day }) => ({
              provider,
              costUsd,
              records,
              day,
            })),
            [
              { provider: "opencode", costUsd: 0.32, records: 1, day: "2026-08-06" },
              { provider: "pi", costUsd: 0.21, records: 1, day: "2026-08-06" },
            ],
          );
          for (const provider of ["pi", "opencode"] as const) {
            const source = summary.sources.find(
              (source) => source.fingerprint.provider === provider,
            );
            assert.strictEqual(source?.status, "partial");
            assert.include(
              source?.message ?? "",
              "1 projection turn-cost records have unresolved provider provenance",
            );
            assert.include(
              source?.description ?? "",
              provider === "pi" ? "1 final and 0 provisional" : "0 final and 1 provisional",
            );
            assert.strictEqual(source?.distinctSessions, 1);
          }
          // No amount is rewritten or dropped from persistence during summary construction.
          assert.deepStrictEqual(
            yield* repository.listUsageCostActivities({
              since: "2026-08-06T00:00:00.000Z",
              until: "2026-08-08T00:00:00.000Z",
            }),
            queried,
          );
        }).pipe(
          Effect.provide(
            persistedServiceLayers({
              prefix: "usage-service-historical-projection-test",
              home,
              settings,
            }),
          ),
        );
      }).pipe(Effect.scoped),
  );

  it.live(
    "replaces provisional projected costs with final snapshots and bounds source counts to the hourly window",
    () =>
      Effect.gen(function* () {
        const { settings, home } = yield* setup;
        yield* Effect.gen(function* () {
          const repository = yield* ProjectionThreadActivityRepository;
          const row = {
            activityId: EventId.make("hourly-pi-cost"),
            threadId: ThreadId.make("hourly-cost-thread"),
            turnId: TurnId.make("hourly-cost-turn"),
            tone: "info" as const,
            kind: "usage.cost",
            summary: "Hourly cost",
            createdAt: "2026-08-07T04:05:00.000Z",
          };
          yield* repository.upsert({
            ...row,
            payload: {
              providerName: "pi",
              model: "pi-model",
              totalCostUsd: 0.12,
              status: "provisional",
            },
          });
          for (const providerName of ["opencode", null] as const) {
            yield* repository.upsert({
              ...row,
              activityId: EventId.make(`hourly-outside-${providerName}`),
              turnId: TurnId.make(`hourly-outside-${providerName}`),
              payload: { providerName, model: "pi-model", totalCostUsd: 5, status: "provisional" },
              createdAt: "2026-08-07T05:00:00.000Z",
            });
          }
          const input: UsageSummaryInput = {
            ...WINDOW,
            resolution: "hour",
            timeZone: "America/Los_Angeles",
            sinceTime: "2026-08-07T04:00:00.000Z",
            untilTime: "2026-08-07T05:00:00.000Z",
          };
          const service = yield* UsageService.make;
          const first = yield* service.readSummary(input);
          assert.strictEqual(first.buckets.length, 1);
          assert.strictEqual(first.buckets[0]?.costUsd, 0.12);
          assert.strictEqual(first.buckets[0]?.day, "2026-08-06");
          assert.strictEqual(first.buckets[0]?.hourStart, input.sinceTime);
          const firstPi = first.sources.find((source) => source.fingerprint.provider === "pi");
          assert.strictEqual(firstPi?.status, "partial");
          assert.include(firstPi?.description ?? "", "0 final and 1 provisional");
          assert.include(firstPi?.message ?? "", "may change");
          assert.notInclude(firstPi?.message ?? "", "unresolved");
          const openCode = first.sources.find(
            (source) => source.fingerprint.provider === "opencode",
          );
          assert.strictEqual(openCode?.status, "ok");
          assert.strictEqual(openCode?.distinctSessions, 0);
          assert.include(openCode?.description ?? "", "0 final and 0 provisional");
          yield* repository.upsert({
            ...row,
            payload: { providerName: "pi", model: "pi-model", totalCostUsd: 0.3, status: "final" },
          });
          const final = yield* service.readSummary(input);
          assert.strictEqual(final.buckets[0]?.costUsd, 0.3);
          assert.strictEqual(final.buckets[0]?.records, 1);
          const finalPi = final.sources.find((source) => source.fingerprint.provider === "pi");
          assert.strictEqual(finalPi?.status, "ok");
          assert.strictEqual(finalPi?.message, null);
          assert.include(finalPi?.description ?? "", "1 final and 0 provisional");
          assert.deepStrictEqual(finalPi?.fingerprint, firstPi?.fingerprint);
        }).pipe(
          Effect.provide(
            persistedServiceLayers({
              prefix: "usage-service-hourly-projection-test",
              home,
              settings,
            }),
          ),
        );
      }).pipe(Effect.scoped),
  );

  it.live("reads configured and disabled accounts once across shared and aliased homes", () =>
    Effect.gen(function* () {
      const { transcript, settings, home } = yield* setup;
      const codexHome = NodePath.join(home, "codex-account");
      const alias = NodePath.join(home, "codex-alias");
      const claudeHome = NodePath.join(home, "claude-account");
      const grokHome = NodePath.join(home, "grok-account");
      yield* Effect.promise(async () => {
        await NodeFSP.writeFile(transcript, claudeLine(1, 5));
        await NodeFSP.mkdir(NodePath.join(claudeHome, "projects"), { recursive: true });
        await NodeFSP.writeFile(
          NodePath.join(claudeHome, "projects", "session.jsonl"),
          claudeLine(2, 7),
        );
        await NodeFSP.mkdir(NodePath.join(codexHome, "sessions"), { recursive: true });
        await NodeFSP.symlink(codexHome, alias, "junction");
        await NodeFSP.writeFile(
          NodePath.join(codexHome, "sessions", "rollout.jsonl"),
          [
            { type: "session_meta", payload: { id: "codex-account-session" } },
            { type: "turn_context", payload: { model: "gpt-5.6-sol" } },
            // A-B-A at one timestamp must preserve both equal A events.
            ...[11, 12, 11].map((outputTokens) => ({
              type: "event_msg",
              timestamp: "2026-08-01T10:00:00Z",
              payload: {
                type: "token_count",
                info: { last_token_usage: { input_tokens: 10, output_tokens: outputTokens } },
              },
            })),
          ]
            .map((line) => encodeUnknownJsonString(line))
            .join("\n") + "\n",
        );
        await NodeFSP.mkdir(NodePath.join(grokHome, "sessions", "session"), { recursive: true });
        await NodeFSP.writeFile(
          NodePath.join(grokHome, "sessions", "session", "updates.jsonl"),
          encodeUnknownJsonString({
            timestamp: Date.parse("2026-08-01T10:00:00Z") / 1000,
            method: "_x.ai/session/update",
            params: {
              sessionId: "grok-account-session",
              update: {
                sessionUpdate: "turn_completed",
                prompt_id: "prompt-1",
                usage: { inputTokens: 10, outputTokens: 13 },
              },
            },
          }) + "\n",
        );
      });
      const service = yield* UsageService.make.pipe(
        Effect.provide(
          serviceLayers({
            prefix: "usage-service-accounts-test",
            home,
            settings: {
              ...settings,
              providerInstances: {
                [ProviderInstanceId.make("claude-work")]: {
                  driver: ProviderDriverKind.make("claudeAgent"),
                  enabled: false,
                  environment: [{ name: "CLAUDE_CONFIG_DIR", value: claudeHome, sensitive: false }],
                },
                [ProviderInstanceId.make("codex-work")]: {
                  driver: ProviderDriverKind.make("codex"),
                  environment: [{ name: "CODEX_HOME", value: codexHome, sensitive: false }],
                },
                [ProviderInstanceId.make("codex-alias")]: {
                  driver: ProviderDriverKind.make("codex"),
                  config: { homePath: alias },
                },
                [ProviderInstanceId.make("codex-shadow")]: {
                  driver: ProviderDriverKind.make("codex"),
                  config: { homePath: codexHome, shadowHomePath: NodePath.join(home, "shadow") },
                  environment: [
                    { name: "CODEX_HOME", value: NodePath.join(home, "ignored"), sensitive: false },
                  ],
                },
                [ProviderInstanceId.make("grok-work")]: {
                  driver: ProviderDriverKind.make("grok"),
                  environment: [{ name: "GROK_HOME", value: grokHome, sensitive: false }],
                },
              },
            },
          }),
        ),
      );
      const summary = yield* service.readSummary(WINDOW);
      assert.strictEqual(totalOutputTokens(summary), 59);
      yield* Effect.promise(() =>
        NodeFSP.rename(
          NodePath.join(codexHome, "sessions", "rollout.jsonl"),
          NodePath.join(codexHome, "sessions", "moved.jsonl"),
        ),
      );
      const moved = yield* service.readSummary(WINDOW);
      assert.deepStrictEqual(moved.buckets, summary.buckets);
      yield* Effect.promise(() =>
        NodeFSP.rm(NodePath.join(codexHome, "sessions"), { recursive: true }),
      );
      const removed = yield* service.readSummary(WINDOW);
      assert.deepStrictEqual(removed.buckets, summary.buckets);

      const sources = summary.sources.filter((source) => source.status === "ok");
      assert.strictEqual(sources.length, 6);
      assert.strictEqual(
        sources.reduce((sum, source) => sum + source.scannedFiles, 0),
        4,
      );
      assert.strictEqual(
        sources.filter((source) => source.fingerprint.provider === "codex").length,
        1,
      );
    }).pipe(Effect.scoped),
  );

  it.live(
    "uses explicit account settings before environment and legacy homes, then refreshes them",
    () =>
      Effect.gen(function* () {
        const { transcript, settings, home } = yield* setup;
        const configured = NodePath.join(home, "configured");
        const environmentHome = NodePath.join(home, "environment");
        yield* Effect.promise(async () => {
          await NodeFSP.writeFile(transcript, claudeLine(1, 100));
          for (const [index, root] of [configured, environmentHome].entries()) {
            await NodeFSP.mkdir(NodePath.join(root, "projects"), { recursive: true });
            await NodeFSP.writeFile(
              NodePath.join(root, "projects", "session.jsonl"),
              claudeLine(index + 2, index + 7),
            );
          }
          await NodeFSP.mkdir(NodePath.join(configured, ".claude", "projects"), {
            recursive: true,
          });
          await NodeFSP.writeFile(
            NodePath.join(configured, ".claude", "projects", "wrong.jsonl"),
            claudeLine(4, 1000),
          );
        });
        yield* Effect.gen(function* () {
          const settingsService = yield* ServerSettings.ServerSettingsService;
          const service = yield* UsageService.make;
          const first = yield* service.readSummary(WINDOW);
          assert.strictEqual(totalOutputTokens(first), 7);
          assert.include(
            first.sources.map((source) => source.fingerprint.resolvedHomePath),
            NodePath.join(configured, "projects"),
          );
          yield* settingsService.updateSettings({
            providerInstances: {
              [ProviderInstanceId.make("claudeAgent")]: {
                driver: ProviderDriverKind.make("claudeAgent"),
                config: { homePath: "" },
                environment: [
                  { name: "CLAUDE_CONFIG_DIR", value: environmentHome, sensitive: false },
                ],
              },
            },
          });
          const second = yield* service.readSummary(WINDOW);
          assert.strictEqual(totalOutputTokens(second), 8);
          assert.include(
            second.sources.map((source) => source.fingerprint.resolvedHomePath),
            NodePath.join(environmentHome, "projects"),
          );
        }).pipe(
          Effect.provide(
            serviceLayers({
              prefix: "usage-service-home-refresh-test",
              home,
              environment: { CLAUDE_CONFIG_DIR: NodePath.join(home, "host-ignored") },
              settings: {
                ...settings,
                providerInstances: {
                  [ProviderInstanceId.make("claudeAgent")]: {
                    driver: ProviderDriverKind.make("claudeAgent"),
                    config: { homePath: configured },
                    environment: [
                      { name: "CLAUDE_CONFIG_DIR", value: environmentHome, sensitive: false },
                    ],
                  },
                },
              },
            }),
          ),
        );
      }).pipe(Effect.scoped),
  );

  it.live(
    "uses inherited home variables when explicit default accounts have no home settings",
    () =>
      Effect.gen(function* () {
        const { transcript, settings, home } = yield* setup;
        yield* Effect.promise(() => NodeFSP.writeFile(transcript, claudeLine(1, 5)));
        const service = yield* UsageService.make.pipe(
          Effect.provide(
            serviceLayers({
              prefix: "usage-service-inherited-homes-test",
              home,
              environment: {
                CODEX_HOME: NodePath.join(home, "inherited-codex"),
                CLAUDE_CONFIG_DIR: NodePath.join(home, "claude"),
              },
              settings: {
                ...settings,
                providerInstances: {
                  [ProviderInstanceId.make("codex")]: {
                    driver: ProviderDriverKind.make("codex"),
                    config: {},
                  },
                  [ProviderInstanceId.make("claudeAgent")]: {
                    driver: ProviderDriverKind.make("claudeAgent"),
                    config: {},
                  },
                },
              },
            }),
          ),
        );
        const summary = yield* service.readSummary(WINDOW);
        assert.strictEqual(totalOutputTokens(summary), 5);
        assert.strictEqual(
          summary.sources.find((source) => source.fingerprint.provider === "codex")?.fingerprint
            .resolvedHomePath,
          NodePath.join(home, "inherited-codex", "sessions"),
        );
        assert.strictEqual(
          summary.sources.find((source) => source.fingerprint.provider === "grok")?.fingerprint
            .resolvedHomePath,
          NodePath.join(home, "grok", "sessions"),
        );
      }).pipe(Effect.scoped),
  );

  it.live("reprices unchanged transcripts when custom prices are added, edited, or removed", () =>
    Effect.gen(function* () {
      const { transcript, settings, home } = yield* setup;
      yield* Effect.promise(() => NodeFSP.writeFile(transcript, claudeLine(1, 5, "example-model")));

      yield* Effect.gen(function* () {
        const settingsService = yield* ServerSettings.ServerSettingsService;
        const service = yield* UsageService.make;

        const original = yield* service.readSummary(WINDOW);
        assert.strictEqual(original.buckets[0]?.costUsd, 0);
        assert.strictEqual(original.buckets[0]?.unpricedRecords, 1);

        yield* settingsService.updateSettings({
          usagePriceOverrides: {
            "example-model": { inputCostPerMillionTokens: 2, outputCostPerMillionTokens: 8 },
          },
        });
        const overridden = yield* service.readSummary(WINDOW);
        assert.closeTo(overridden.buckets[0]?.costUsd ?? -1, 0.00006, 1e-12);
        assert.strictEqual(overridden.buckets[0]?.costSource, "modelPriced");
        assert.strictEqual(overridden.buckets[0]?.unpricedRecords, 0);
        assert.deepStrictEqual(overridden.buckets[0]?.totals, original.buckets[0]?.totals);

        yield* settingsService.updateSettings({
          usagePriceOverrides: {
            "example-model": { inputCostPerMillionTokens: 4, outputCostPerMillionTokens: 16 },
          },
        });
        const edited = yield* service.readSummary(WINDOW);
        assert.closeTo(edited.buckets[0]?.costUsd ?? -1, 0.00012, 1e-12);

        yield* settingsService.updateSettings({ usagePriceOverrides: { "example-model": null } });
        const restored = yield* service.readSummary(WINDOW);
        assert.deepStrictEqual(restored.buckets, original.buckets);
      }).pipe(
        Effect.provide(
          serviceLayers({ prefix: "usage-service-price-overrides-test", home, settings }),
        ),
      );
    }).pipe(Effect.scoped),
  );

  it.live("counts appended usage on a rescan of a grown transcript", () =>
    Effect.gen(function* () {
      const { transcript, settings, home } = yield* setup;
      yield* Effect.promise(() => NodeFSP.writeFile(transcript, claudeLine(1, 5)));

      const service = yield* UsageService.make.pipe(
        Effect.provide(serviceLayers({ prefix: "usage-service-grow-test", home, settings })),
      );

      const first = yield* service.readSummary(WINDOW);
      assert.strictEqual(totalOutputTokens(first), 5);

      yield* Effect.promise(() => NodeFSP.appendFile(transcript, claudeLine(2, 7)));
      const second = yield* service.readSummary(WINDOW);
      assert.strictEqual(totalOutputTokens(second), 12);
    }).pipe(Effect.scoped),
  );

  it.live("preserves saved tokens, costs and sessions after transcript cleanup and restart", () =>
    Effect.gen(function* () {
      const { transcript, settings, home } = yield* setup;
      const alias = NodePath.join(home, "claude-alias");
      yield* Effect.promise(() =>
        NodeFSP.symlink(NodePath.join(home, "claude"), alias, "junction"),
      );
      const content = claudeLine(1, 5);
      yield* Effect.promise(() => NodeFSP.writeFile(transcript, content));
      yield* Effect.gen(function* () {
        const service = yield* UsageService.make;
        const first = yield* service.readSummary(WINDOW);
        assert.strictEqual(totalOutputTokens(first), 5);
        assert.isAbove(first.buckets[0]?.costUsd ?? 0, 0);

        yield* Effect.promise(() => NodeFSP.rm(transcript));
        const deleted = yield* service.readSummary(WINDOW);
        assert.deepStrictEqual(deleted.buckets, first.buckets);
        assert.deepStrictEqual(deleted.sources, first.sources);

        const restarted = yield* UsageService.make;
        const restored = yield* restarted.readSummary(WINDOW);
        assert.deepStrictEqual(restored.buckets, first.buckets);
        assert.deepStrictEqual(restored.sources, first.sources);

        // A moved transcript must not count the saved usage twice.
        yield* Effect.promise(() => NodeFSP.writeFile(transcript + ".jsonl", content));
        const moved = yield* restarted.readSummary(WINDOW);
        assert.deepStrictEqual(moved.buckets, first.buckets);
        assert.strictEqual(moved.sources[0]?.distinctSessions, 1);

        const replacementProjects = NodePath.join(home, "replacement-projects");
        yield* Effect.promise(() => NodeFSP.mkdir(replacementProjects));
        yield* Effect.promise(() =>
          NodeFSP.rm(NodePath.join(home, "claude", "projects"), { recursive: true }),
        );
        const afterRootCleanup = yield* UsageService.make;
        const missingRoot = yield* afterRootCleanup.readSummary(WINDOW);
        assert.deepStrictEqual(missingRoot.buckets, first.buckets);
        assert.strictEqual(missingRoot.sources[0]?.distinctSessions, 1);
        assert.strictEqual(missingRoot.sources[0]?.status, "ok");
        assert.deepStrictEqual(missingRoot.sources[0]?.fingerprint, first.sources[0]?.fingerprint);
        yield* Effect.promise(async () => {
          const projects = NodePath.join(home, "claude", "projects");
          await NodeFSP.rename(replacementProjects, projects);
          await NodeFSP.writeFile(NodePath.join(projects, "new.jsonl"), claudeLine(2, 7));
        });
        const recreated = yield* afterRootCleanup.readSummary(WINDOW);
        assert.strictEqual(totalOutputTokens(recreated), 12);
        assert.deepStrictEqual(recreated.sources[0]?.fingerprint, first.sources[0]?.fingerprint);

        const merged = mergeUsage(
          [
            {
              environmentId: EnvironmentId.make("cleanup-test"),
              label: "test",
              summary: recreated,
            },
            {
              environmentId: EnvironmentId.make("other-environment"),
              label: "before cleanup",
              summary: first,
            },
          ],
          missingRoot.contractVersion,
        );
        assert.strictEqual(merged.outputTokens, 12);
        assert.strictEqual(merged.sessions, 1);
        assert.strictEqual(merged.costUsd, recreated.buckets[0]?.costUsd);

        const outsideWindow = yield* restarted.readSummary({
          ...WINDOW,
          sinceDay: UsageDay.make("2026-08-02"),
        });
        assert.deepStrictEqual(outsideWindow.buckets, []);
        assert.strictEqual(outsideWindow.sources[0]?.distinctSessions, 0);
      }).pipe(
        Effect.provide(
          serviceLayers({
            prefix: "usage-service-cleanup-test",
            home,
            settings: { providers: { ...settings.providers, claudeAgent: { homePath: alias } } },
            ratesDocument: {
              "claude-fable-5": { input_cost_per_token: 1e-5, output_cost_per_token: 5e-5 },
            },
          }),
        ),
      );
    }).pipe(Effect.scoped),
  );

  it.live("does not share an in-flight scan after custom prices change", () =>
    Effect.gen(function* () {
      const { transcript, settings, home } = yield* setup;
      yield* Effect.promise(() => NodeFSP.writeFile(transcript, claudeLine(1, 5, "example-model")));

      yield* Effect.gen(function* () {
        const settingsService = yield* ServerSettings.ServerSettingsService;
        const fileSystem = yield* FileSystem.FileSystem;
        const firstScanStarted = yield* Deferred.make<void>();
        const secondScanStarted = yield* Deferred.make<void>();
        const releaseRates = yield* Deferred.make<void>();
        let homeProbes = 0;
        const service = yield* UsageService.make.pipe(
          Effect.provideService(FileSystem.FileSystem, {
            ...fileSystem,
            exists: (path) =>
              fileSystem.exists(path).pipe(
                Effect.tap(() => {
                  if (path !== NodePath.join(home, "claude", "projects")) return Effect.void;
                  homeProbes += 1;
                  return Deferred.succeed(
                    homeProbes === 1 ? firstScanStarted : secondScanStarted,
                    undefined,
                  );
                }),
              ),
          }),
          Effect.provideService(
            HttpClient.HttpClient,
            HttpClient.make((request) =>
              Deferred.await(releaseRates).pipe(
                Effect.as(HttpClientResponse.fromWeb(request, Response.json({}))),
              ),
            ),
          ),
        );

        const first = yield* service.readSummary(WINDOW).pipe(Effect.forkChild);
        yield* Deferred.await(firstScanStarted);
        yield* settingsService.updateSettings({
          usagePriceOverrides: {
            "example-model": { inputCostPerMillionTokens: 2, outputCostPerMillionTokens: 8 },
          },
        });
        const second = yield* service.readSummary(WINDOW).pipe(Effect.forkChild);
        yield* Deferred.await(secondScanStarted);
        yield* Deferred.succeed(releaseRates, undefined);

        const original = yield* Fiber.join(first);
        const updated = yield* Fiber.join(second);
        assert.strictEqual(original.buckets[0]?.costUsd, 0);
        assert.closeTo(updated.buckets[0]?.costUsd ?? -1, 0.00006, 1e-12);
      }).pipe(
        Effect.provide(serviceLayers({ prefix: "usage-service-price-race-test", home, settings })),
      );
    }).pipe(Effect.scoped),
  );

  it.live("shares one scan between concurrent identical requests", () =>
    Effect.gen(function* () {
      const { transcript, settings, home } = yield* setup;
      yield* Effect.promise(() => NodeFSP.writeFile(transcript, claudeLine(1, 5)));

      let ratesFetches = 0;
      const service = yield* UsageService.make.pipe(
        Effect.provide(
          serviceLayers({
            prefix: "usage-service-flight-test",
            home,
            settings,
            onRatesFetch: () => {
              ratesFetches += 1;
            },
          }),
        ),
      );

      const [first, second] = yield* Effect.all(
        [service.readSummary(WINDOW), service.readSummary(WINDOW)],
        { concurrency: 2 },
      );
      assert.deepStrictEqual(first, second);
      assert.strictEqual(ratesFetches, 1);

      // A later request is fresh work again, not a stale cached answer.
      yield* service.readSummary(WINDOW);
      assert.strictEqual(ratesFetches, 2);
    }).pipe(Effect.scoped),
  );

  it.live("refetches a rate table inside its TTL only when the client asks", () =>
    Effect.gen(function* () {
      const { transcript, settings, home } = yield* setup;
      yield* Effect.promise(() => NodeFSP.writeFile(transcript, claudeLine(1, 5)));

      let ratesFetches = 0;
      const service = yield* UsageService.make.pipe(
        Effect.provide(
          serviceLayers({
            prefix: "usage-service-rates-refresh-test",
            home,
            settings,
            ratesDocument: {
              "claude-fable-5": { input_cost_per_token: 1e-5, output_cost_per_token: 5e-5 },
            },
            onRatesFetch: () => {
              ratesFetches += 1;
            },
          }),
        ),
      );

      const first = yield* service.readSummary(WINDOW);
      assert.strictEqual(ratesFetches, 1);
      assert.strictEqual(first.pricing.status, "fresh");

      // Inside the daily TTL a plain rescan keeps the cached table.
      yield* TestClock.adjust(Duration.minutes(2));
      yield* service.readSummary(WINDOW);
      assert.strictEqual(ratesFetches, 1);

      // An explicit refresh fetches again so a newly listed model gets priced.
      // A burst of refreshes shares that one fetch.
      const [refreshed] = yield* Effect.all([service.refreshRates, service.refreshRates], {
        concurrency: 2,
      });
      assert.strictEqual(ratesFetches, 2);
      assert.strictEqual(refreshed.status, "fresh");
      assert.strictEqual(refreshed.knownModels, 1);
    }).pipe(Effect.scoped, Effect.provide(TestClock.layer())),
  );

  it.live("does not orphan an in-flight scan when its first caller is interrupted", () =>
    Effect.gen(function* () {
      const { settings, home } = yield* setup;
      const service = yield* UsageService.make.pipe(
        Effect.provide(
          serviceLayers({ prefix: "usage-service-interruption-test", home, settings }),
        ),
      );

      let orphanedAt: number | undefined;
      for (let interruptAt = 1; interruptAt <= 31; interruptAt += 1) {
        const tasks: Array<() => void> = [];
        const dispatcher: Scheduler.SchedulerDispatcher = {
          scheduleTask: (task) => tasks.push(task),
          flush: () => {
            let task: (() => void) | undefined;
            while ((task = tasks.shift()) !== undefined) task();
          },
        };

        let requestFiber: Fiber.Fiber<unknown, unknown> | undefined;
        let requestChecks = 0;
        const scheduler: Scheduler.Scheduler = {
          executionMode: "async",
          makeDispatcher: () => dispatcher,
          shouldYield: (fiber) => {
            if (fiber !== requestFiber) return false;
            requestChecks += 1;
            if (requestChecks !== interruptAt) return false;
            fiber.interruptUnsafe();
            return true;
          },
        };

        // Each candidate needs a distinct key because the broken case leaves
        // its entry in the service's private in-flight map. The invalid window
        // keeps the real scan synchronous once its detached fiber starts.
        const input: UsageSummaryInput = {
          ...WINDOW,
          sinceDay: UsageDay.make("2026-09-01"),
          untilDay: UsageDay.make(`2026-08-${String(interruptAt).padStart(2, "0")}`),
        };
        const first = yield* service
          .readSummary(input)
          .pipe(
            Effect.exit,
            Effect.provideService(Scheduler.Scheduler, scheduler),
            Effect.forkChild,
          );
        requestFiber = first;
        yield* Effect.yieldNow;
        dispatcher.flush();

        const second = yield* service.readSummary(input).pipe(
          Effect.match({
            onFailure: (error) => error.reason,
            onSuccess: () => "success" as const,
          }),
          Effect.provideService(Scheduler.Scheduler, scheduler),
          Effect.forkChild,
        );
        yield* Effect.yieldNow;
        dispatcher.flush();
        const secondExit = second.pollUnsafe();
        if (secondExit === undefined) {
          second.interruptUnsafe();
          orphanedAt = interruptAt;
          break;
        }
        if (Exit.isFailure(secondExit)) {
          assert.fail("the matching request fiber was interrupted");
        }
        assert.strictEqual(secondExit.value, "invalidWindow");
      }

      assert.isUndefined(
        orphanedAt,
        `interruption left the next matching request pending at scheduler check ${orphanedAt}`,
      );
    }).pipe(Effect.scoped),
  );
});
