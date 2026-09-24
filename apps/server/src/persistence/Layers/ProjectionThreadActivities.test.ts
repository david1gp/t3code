import { EventId, ThreadId, TurnId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { ProjectionThreadActivityRepository } from "../Services/ProjectionThreadActivities.ts";
import { ProjectionThreadActivityRepositoryLive } from "./ProjectionThreadActivities.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";

const layer = it.layer(
  ProjectionThreadActivityRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
);

layer("ProjectionThreadActivityRepository", (it) => {
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
          ('cost-old', 'thread-cost', 'turn-cost', 'info', 'usage.cost', 'old', '{"totalCostUsd":0.2,"model":"old-model","providerSessionId":"old-session"}', 1, ${now}),
          ('cost-latest', 'thread-cost', 'turn-cost', 'info', 'usage.cost', 'latest', '{"totalCostUsd":0,"model":"open-code-model","providerSessionId":"session-cost"}', 2, ${now}),
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
          '{"totalCostUsd":0.3,"model":"open-code-model","providerSessionId":"session-cost"}',
          4, '2026-03-03T00:00:00.000Z')
      `;
      const superseded = yield* repository.listUsageCostActivities({
        since: "2026-02-28T00:00:00.000Z",
        until: "2026-03-02T00:00:00.000Z",
      });
      assert.deepEqual(superseded, []);
    }),
  );
});
