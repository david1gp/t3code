import { EventId, ProviderDriverKind, ThreadId, TurnId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { ProjectionThreadActivityRepository } from "../Services/ProjectionThreadActivities.ts";
import { ProjectionThreadActivityRepositoryLive } from "./ProjectionThreadActivities.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";
import { runtimeEventToActivities } from "../../orchestration/Layers/ProviderRuntimeIngestion.ts";

const layer = it.layer(
  ProjectionThreadActivityRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
);

const encodeHistoricalSession = Schema.encodeEffect(
  Schema.fromJsonString(
    Schema.Struct({
      threadId: ThreadId,
      session: Schema.Struct({ activeTurnId: Schema.String, providerName: Schema.String }),
    }),
  ),
);

layer("ProjectionThreadActivityRepository", (it) => {
  it.effect("includes user-input expiration in lifecycle reads without unrelated payloads", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectionThreadActivityRepository;
      const sql = yield* SqlClient.SqlClient;
      const threadId = ThreadId.make("thread-expiration-lifecycle");
      const expired = {
        activityId: EventId.make("input-expiration"),
        threadId,
        turnId: null,
        tone: "info" as const,
        kind: "user-input.expired",
        summary: "User input expired; no answer submitted",
        payload: { requestId: "input-1", requestType: "tool_user_input", reason: "Input absent" },
        sequence: 1,
        createdAt: "2026-03-01T00:00:00.000Z",
      };
      const requested = {
        ...expired,
        activityId: EventId.make("input-unrelated-request"),
        kind: "user-input.requested",
        payload: { requestId: "input-2", requestType: "tool_user_input", reason: "" },
        sequence: 2,
      };
      yield* repository.upsert(expired);
      yield* repository.upsert(requested);
      yield* repository.upsert({
        ...expired,
        activityId: EventId.make("other-thread-expiry"),
        threadId: ThreadId.make("other-thread"),
      });
      yield* sql`
        INSERT INTO projection_thread_activities (
          activity_id, thread_id, turn_id, tone, kind, summary, payload_json, sequence, created_at
        ) VALUES ('expiry-malformed-tool', ${threadId}, NULL, 'info', 'tool.completed', 'tool',
          'not-json', 3, ${expired.createdAt}),
          ('approval-expiration', ${threadId}, NULL, 'info', 'approval.expired', 'approval',
          'not-json', 4, ${expired.createdAt})
      `;
      assert.deepEqual(yield* repository.listUserInputLifecycleByThreadId({ threadId }), [
        expired,
        requested,
      ]);
    }),
  );

  it.effect("keeps a final usage cost when late provisional observations repeat", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectionThreadActivityRepository;
      const threadId = ThreadId.make("thread-final-cost-wins");
      const finalActivity = {
        activityId: EventId.make("usage-cost:thread-final-cost-wins:turn-1"),
        threadId,
        turnId: TurnId.make("turn-1"),
        tone: "info" as const,
        kind: "usage.cost" as const,
        summary: "Provider reported turn cost",
        payload: { providerName: "pi", model: "pi-model", totalCostUsd: 0.3, status: "final" },
        createdAt: "2026-07-01T00:00:02.000Z",
      };
      const provisionalActivity = {
        ...finalActivity,
        payload: {
          providerName: "pi",
          model: "pi-model",
          totalCostUsd: 0.12,
          status: "provisional",
        },
        createdAt: "2026-07-01T00:00:01.000Z",
      };

      yield* repository.upsert(finalActivity);
      yield* repository.upsert(provisionalActivity);
      yield* repository.upsert(provisionalActivity);

      const activities = yield* repository.listByThreadId({ threadId });
      assert.deepEqual(activities, [finalActivity]);
      const costs = yield* repository.listUsageCostActivities({
        since: "2026-07-01T00:00:00.000Z",
        until: "2026-07-02T00:00:00.000Z",
      });
      assert.deepEqual(costs, [
        {
          threadId,
          turnId: finalActivity.turnId,
          providerName: "pi",
          providerSessionId: null,
          model: "pi-model",
          createdAt: finalActivity.createdAt,
          totalCostUsd: 0.3,
          status: "final",
        },
      ]);
    }),
  );

  it.effect("reads only the latest matching task activity", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectionThreadActivityRepository;
      const sql = yield* SqlClient.SqlClient;
      const threadId = ThreadId.make("thread-latest-task-activity");

      yield* sql`
        INSERT INTO projection_thread_activities (
          activity_id, thread_id, turn_id, tone, kind, summary, payload_json, sequence, created_at
        )
        VALUES
          (
            'activity-task-unrelated-tool', ${threadId}, NULL, 'tool', 'tool.completed',
            'large tool output', 'not-json', 1, '2026-03-01T00:00:00.000Z'
          ),
          (
            'activity-task-started', ${threadId}, NULL, 'info', 'task.started',
            'started', '{"taskId":"task-1","title":"Initial title"}', 2,
            '2026-03-01T00:00:01.000Z'
          ),
          (
            'activity-task-progress', ${threadId}, NULL, 'info', 'task.progress',
            'progress', '{"taskId":"task-1","title":"Updated title"}', 3,
            '2026-03-01T00:00:02.000Z'
          ),
          (
            'activity-task-other', ${threadId}, NULL, 'info', 'task.progress',
            'other', '{"taskId":"task-2","title":"Other title"}', 4,
            '2026-03-01T00:00:03.000Z'
          )
      `;

      yield* repository.upsert({
        activityId: EventId.make("activity-task-untitled"),
        threadId,
        turnId: null,
        tone: "info",
        kind: "task.progress",
        summary: "Still running",
        payload: { taskId: "task-1" },
        sequence: 5,
        createdAt: "2026-03-01T00:00:04.000Z",
      });
      yield* repository.upsert({
        activityId: EventId.make("activity-task-blank-title"),
        threadId,
        turnId: null,
        tone: "info",
        kind: "task.progress",
        summary: "Still running",
        payload: { taskId: "task-1", title: " \t\n\u00a0" },
        sequence: 6,
        createdAt: "2026-03-01T00:00:05.000Z",
      });

      const recent = yield* repository.listByThreadId({
        threadId,
        activityKinds: ["task.progress"],
        limit: 2,
      });
      assert.deepEqual(
        recent.map((entry) => entry.activityId),
        ["activity-task-untitled", "activity-task-blank-title"],
      );

      const activity = yield* repository.getLatestTaskActivity({
        threadId,
        taskId: "task-1",
      });
      assert.equal(activity._tag, "Some");
      if (activity._tag === "Some") {
        assert.equal(activity.value.activityId, EventId.make("activity-task-progress"));
        assert.deepEqual(activity.value.payload, {
          taskId: "task-1",
          title: "Updated title",
        });
      }

      assert.equal(
        (yield* repository.getLatestTaskActivity({ threadId, taskId: "missing" }))._tag,
        "None",
      );
    }),
  );

  it.effect("returns only the latest valid OpenCode reported cost for each turn", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectionThreadActivityRepository;
      const sql = yield* SqlClient.SqlClient;
      const now = "2026-03-01T00:00:00.000Z";
      yield* sql`
        INSERT INTO projection_threads (
          thread_id, project_id, title, model_selection_json, runtime_mode, created_at, updated_at
        ) VALUES ('thread-cost', 'project-cost', 'Cost', '{"instanceId":"opencode","model":"open-code-model"}', 'full-access', ${now}, ${now})
      `;
      yield* sql`
        INSERT INTO projection_thread_sessions (
          thread_id, status, provider_name, provider_session_id, runtime_mode, updated_at
        ) VALUES ('thread-cost', 'idle', 'opencode', 'session-cost', 'full-access', ${now})
      `;
      yield* sql`
        INSERT INTO projection_thread_activities (
          activity_id, thread_id, turn_id, tone, kind, summary, payload_json, sequence, created_at
        ) VALUES
          ('cost-old', 'thread-cost', 'turn-cost', 'info', 'usage.cost', 'old', '{"providerName":"opencode","totalCostUsd":0.2,"model":"old-model","providerSessionId":"old-session"}', 1, ${now}),
          ('cost-latest', 'thread-cost', 'turn-cost', 'info', 'usage.cost', 'latest', '{"providerName":"opencode","totalCostUsd":0,"model":"open-code-model","providerSessionId":"session-cost"}', 2, ${now}),
          ('cost-invalid', 'thread-cost', 'turn-invalid', 'info', 'usage.cost', 'bad', '{"totalCostUsd":-1,"model":"open-code-model"}', 3, ${now}),
          ('cost-overflow', 'thread-cost', 'turn-overflow', 'info', 'usage.cost', 'overflow', '{"totalCostUsd":1e999,"model":"open-code-model"}', 3, ${now}),
          ('cost-string', 'thread-cost', 'turn-string', 'info', 'usage.cost', 'string', '{"totalCostUsd":"1","model":"open-code-model"}', 3, ${now}),
          ('cost-malformed', 'thread-cost', 'turn-malformed', 'info', 'usage.cost', 'malformed', '{bad json', 3, ${now})
      `;
      yield* sql`
        INSERT INTO projection_threads (
          thread_id, project_id, title, model_selection_json, runtime_mode, created_at, updated_at
        ) VALUES ('thread-other', 'project-other', 'Other', '{"instanceId":"codex","model":"gpt"}', 'full-access', ${now}, ${now})
      `;
      yield* sql`
        INSERT INTO projection_thread_sessions (
          thread_id, status, provider_name, provider_session_id, runtime_mode, updated_at
        ) VALUES ('thread-other', 'idle', 'codex', 'session-other', 'full-access', ${now})
      `;
      yield* sql`
        INSERT INTO projection_thread_activities (
          activity_id, thread_id, turn_id, tone, kind, summary, payload_json, sequence, created_at
        ) VALUES ('cost-other-provider', 'thread-other', 'turn-other', 'info', 'usage.cost', 'other', '{"totalCostUsd":9}', 1, ${now})
      `;

      const activities = yield* repository.listUsageCostActivities({
        since: "2026-02-28T00:00:00.000Z",
        until: "2026-03-02T00:00:00.000Z",
      });
      assert.deepEqual(activities, [
        {
          threadId: ThreadId.make("thread-cost"),
          turnId: TurnId.make("turn-cost"),
          providerName: "opencode",
          providerSessionId: "session-cost",
          model: "open-code-model",
          createdAt: now,
          totalCostUsd: 0,
          status: "provisional",
        },
      ]);
      yield* sql`
        UPDATE projection_threads
        SET model_selection_json = '{"instanceId":"claude","model":"changed-model"}'
        WHERE thread_id = 'thread-cost'
      `;
      yield* sql`
        UPDATE projection_thread_sessions
        SET provider_name = 'claude', provider_session_id = 'changed-session'
        WHERE thread_id = 'thread-cost'
      `;
      const historical = yield* repository.listUsageCostActivities({
        since: "2026-02-28T00:00:00.000Z",
        until: "2026-03-02T00:00:00.000Z",
      });
      assert.deepEqual(historical, activities);

      yield* sql`
        INSERT INTO projection_thread_activities (
          activity_id, thread_id, turn_id, tone, kind, summary, payload_json, sequence, created_at
        ) VALUES ('cost-correction', 'thread-cost', 'turn-cost', 'info', 'usage.cost', 'corrected',
          '{"providerName":"opencode","totalCostUsd":0.3,"model":"open-code-model","providerSessionId":"session-cost"}',
          4, '2026-03-03T00:00:00.000Z')
      `;
      const superseded = yield* repository.listUsageCostActivities({
        since: "2026-02-28T00:00:00.000Z",
        until: "2026-03-02T00:00:00.000Z",
      });
      assert.deepEqual(superseded, []);
    }),
  );

  it.effect(
    "persists runtime Pi and OpenCode costs across provider changes within one thread",
    () =>
      Effect.gen(function* () {
        const repository = yield* ProjectionThreadActivityRepository;
        const sql = yield* SqlClient.SqlClient;
        const threadId = ThreadId.make("cost-runtime-provider-changes");
        const createdAt = "2026-04-01T00:00:00.000Z";
        for (const [provider, turn, amount] of [
          ["pi", "pi-turn", 0.37],
          ["opencode", "opencode-turn", 0.62],
        ] as const) {
          const activities = runtimeEventToActivities({
            type: "turn.cost.updated",
            provider: ProviderDriverKind.make(provider),
            threadId,
            turnId: TurnId.make(turn),
            eventId: EventId.make(`runtime-cost-${turn}`),
            createdAt,
            payload: {
              totalCostUsd: amount,
              status: "final",
              costModel: "shared/model",
              costSessionId: "same-session-string",
            },
          });
          for (const activity of activities) {
            const { id, ...row } = activity;
            yield* repository.upsert({ ...row, activityId: id, threadId });
          }
        }
        yield* sql`
        INSERT INTO projection_threads (
          thread_id, project_id, title, model_selection_json, runtime_mode, created_at, updated_at
        ) VALUES (${threadId}, 'project-provenance', 'Changed', '{"instanceId":"claude","model":"now"}',
          'full-access', ${createdAt}, ${createdAt})
      `;
        yield* sql`
        INSERT INTO projection_thread_sessions (thread_id, status, provider_name, runtime_mode, updated_at)
        VALUES (${threadId}, 'idle', 'claude', 'full-access', ${createdAt})
      `;
        const costs = yield* repository.listUsageCostActivities({
          since: createdAt,
          until: "2026-04-02T00:00:00.000Z",
        });
        assert.deepEqual(costs, [
          {
            threadId,
            turnId: TurnId.make("opencode-turn"),
            providerName: "opencode",
            providerSessionId: "same-session-string",
            model: "shared/model",
            createdAt,
            totalCostUsd: 0.62,
            status: "final",
          },
          {
            threadId,
            turnId: TurnId.make("pi-turn"),
            providerName: "pi",
            providerSessionId: "same-session-string",
            model: "shared/model",
            createdAt,
            totalCostUsd: 0.37,
            status: "final",
          },
        ]);
      }),
  );

  it.effect("keeps cost provider identity through final upserts and legacy supersession", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectionThreadActivityRepository;
      const threadId = ThreadId.make("cost-immutable-provider");
      const createdAt = "2026-05-01T00:00:00.000Z";
      const row = {
        activityId: EventId.make("cost-immutable-provider-activity"),
        threadId,
        turnId: TurnId.make("immutable-turn"),
        tone: "info" as const,
        kind: "usage.cost",
        summary: "Cost",
        payload: { providerName: "pi", totalCostUsd: 0.1, status: "provisional", model: "model" },
        sequence: 1,
        createdAt,
      };
      yield* repository.upsert(row);
      yield* repository.upsert({
        ...row,
        payload: { providerName: "opencode", totalCostUsd: 8, status: "final", model: "wrong" },
        sequence: 2,
      });
      assert.deepEqual(yield* repository.listByThreadId({ threadId }), [row]);
      yield* repository.upsert({
        ...row,
        payload: { totalCostUsd: 0.4, status: "final", model: "model" },
        sequence: 3,
      });
      yield* repository.upsert({ ...row, sequence: 4 });
      const persisted = yield* repository.listByThreadId({ threadId });
      assert.deepEqual(persisted[0]?.payload, {
        providerName: "pi",
        totalCostUsd: 0.4,
        status: "final",
        model: "model",
      });
      // Older releases can have multiple IDs per turn. A newer unstamped cost
      // must not erase the immutable provider already recorded for that turn.
      yield* repository.upsert({
        ...row,
        activityId: EventId.make("cost-immutable-provider-correction"),
        payload: { totalCostUsd: 0.6, status: "final", model: "model" },
        sequence: 5,
      });
      const costs = yield* repository.listUsageCostActivities({
        since: createdAt,
        until: "2026-05-02T00:00:00.000Z",
      });
      assert.equal(costs.length, 1);
      assert.equal(costs[0]?.providerName, "pi");
      assert.equal(costs[0]?.totalCostUsd, 0.6);
      yield* repository.upsert({
        ...row,
        activityId: EventId.make("cost-immutable-provider-conflict"),
        payload: { providerName: "opencode", totalCostUsd: 0.8, model: "model" },
        sequence: 6,
      });
      const conflicted = yield* repository.listUsageCostActivities({
        since: createdAt,
        until: "2026-05-02T00:00:00.000Z",
      });
      assert.equal(conflicted[0]?.providerName, null);
      assert.equal(conflicted[0]?.totalCostUsd, 0.8);
    }),
  );

  it.effect(
    "recovers historical cost provenance only from immutable runtime turn associations",
    () =>
      Effect.gen(function* () {
        const repository = yield* ProjectionThreadActivityRepository;
        const sql = yield* SqlClient.SqlClient;
        const threadId = ThreadId.make("cost-history-provenance");
        const createdAt = "2026-06-01T00:00:00.000Z";
        for (const [turn, amount] of [
          ["historical-pi", 0.21],
          ["historical-opencode", 0.32],
          ["unresolved", 0.43],
          ["ambiguous", 0.54],
          ["client-only", 0.65],
        ] as const) {
          yield* repository.upsert({
            activityId: EventId.make(`cost-history-${turn}`),
            threadId,
            turnId: TurnId.make(turn),
            tone: "info",
            kind: "usage.cost",
            summary: "Legacy cost",
            payload: {
              totalCostUsd: amount,
              model: "historical-model",
              providerSessionId: "shared-session",
            },
            createdAt,
          });
        }
        let streamVersion = 0;
        for (const [turn, provider, actor] of [
          ["historical-pi", "pi", "provider"],
          ["historical-opencode", "opencode", "provider"],
          ["ambiguous", "pi", "provider"],
          ["ambiguous", "opencode", "provider"],
          ["client-only", "pi", "client"],
        ] as const) {
          streamVersion += 1;
          const payload = yield* encodeHistoricalSession({
            threadId,
            session: { activeTurnId: turn, providerName: provider },
          });
          yield* sql`
          INSERT INTO orchestration_events (
            event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at,
            actor_kind, payload_json, metadata_json
          ) VALUES (${`history-session-${streamVersion}`}, 'thread', ${threadId}, ${streamVersion},
            'thread.session-set', ${createdAt}, ${actor},
            ${payload}, '{}')
        `;
        }
        yield* sql`
        INSERT INTO orchestration_events (
          event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at,
          actor_kind, payload_json, metadata_json
        ) VALUES ('history-unrelated-thread', 'thread', 'other-cost-history-thread', 1,
          'thread.session-set', ${createdAt}, 'provider',
          '{"session":{"activeTurnId":"unresolved","providerName":"pi"}}', '{}'),
          ('history-idle-session', 'thread', ${threadId}, ${streamVersion + 1},
          'thread.session-set', ${createdAt}, 'provider',
          '{"session":{"activeTurnId":null,"providerName":"opencode"}}', '{}'),
          ('history-malformed-session', 'thread', ${threadId}, ${streamVersion + 2},
          'thread.session-set', ${createdAt}, 'provider', 'not-json', '{}')
      `;
        // Mutable current selection and same provider-session string prove nothing.
        yield* sql`
        INSERT INTO projection_thread_sessions (thread_id, status, provider_name, provider_session_id, runtime_mode, updated_at)
        VALUES (${threadId}, 'idle', 'opencode', 'shared-session', 'full-access', ${createdAt})
      `;
        const costs = yield* repository.listUsageCostActivities({
          since: createdAt,
          until: "2026-06-02T00:00:00.000Z",
        });
        assert.deepEqual(
          costs.map(({ turnId, providerName, totalCostUsd }) => ({
            turnId,
            providerName,
            totalCostUsd,
          })),
          [
            { turnId: "ambiguous", providerName: null, totalCostUsd: 0.54 },
            { turnId: "client-only", providerName: null, totalCostUsd: 0.65 },
            { turnId: "historical-opencode", providerName: "opencode", totalCostUsd: 0.32 },
            { turnId: "historical-pi", providerName: "pi", totalCostUsd: 0.21 },
            { turnId: "unresolved", providerName: null, totalCostUsd: 0.43 },
          ],
        );
      }),
  );
});
