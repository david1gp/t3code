import {
  EnvironmentId,
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationThreadDetailSnapshot,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { MobileDatabase } from "../persistence/mobile-database";
import { make } from "./environment-cache-store";

describe("mobile thread context snapshot pass-through", () => {
  it.effect("round trips unknown occupancy without restoring stale known tokens", () =>
    Effect.gen(function* () {
      const values = new Map<string, string>();
      const database = MobileDatabase.of({
        loadCache: (environmentId, kind, cacheKey) =>
          Effect.succeed(
            Option.fromUndefinedOr(values.get(`${environmentId}:${kind}:${cacheKey}`)),
          ),
        listCache: () => Effect.succeed([]),
        saveCache: (environmentId, kind, cacheKey, _version, payload) =>
          Effect.sync(() => values.set(`${environmentId}:${kind}:${cacheKey}`, payload)),
        removeCache: (environmentId, kind, cacheKey) =>
          Effect.sync(() => void values.delete(`${environmentId}:${kind}:${cacheKey}`)),
        clearCacheKind: () => Effect.void,
        clearEnvironmentCache: () => Effect.void,
        clearAllCaches: Effect.sync(() => values.clear()),
        inspectCaches: Effect.succeed([]),
        loadPreferencesJson: Effect.succeed(Option.none()),
        savePreferencesJson: () => Effect.void,
      });
      const store = yield* make().pipe(Effect.provideService(MobileDatabase, database));
      const environmentId = EnvironmentId.make("environment-context");
      const threadId = ThreadId.make("thread-context");
      const now = "2026-10-01T00:00:00.000Z";
      const snapshot: OrchestrationThreadDetailSnapshot = {
        snapshotSequence: 3,
        thread: {
          id: threadId,
          projectId: ProjectId.make("project-context"),
          title: "Context",
          modelSelection: { instanceId: ProviderInstanceId.make("pi"), model: "fixture" },
          runtimeMode: "approval-required",
          interactionMode: "default",
          branch: null,
          pullRequests: [],
          worktreePath: null,
          latestTurn: null,
          createdAt: now,
          updatedAt: now,
          archivedAt: null,
          settledOverride: null,
          settledAt: null,
          deletedAt: null,
          messages: [
            {
              id: MessageId.make("message-context"),
              role: "assistant",
              text: "",
              turnId: null,
              streaming: false,
              createdAt: now,
              updatedAt: now,
            },
          ],
          proposedPlans: [],
          activities: [
            {
              id: EventId.make("known-context"),
              tone: "info",
              kind: "context-window.updated",
              summary: "Context updated",
              payload: { usedTokens: 81_659, maxTokens: 200_000 },
              turnId: TurnId.make("turn-context"),
              createdAt: now,
            },
            {
              id: EventId.make("unknown-context"),
              tone: "info",
              kind: "context-window.updated",
              summary: "Context unavailable",
              payload: { contextUsageStatus: "unknown" },
              turnId: TurnId.make("turn-context"),
              createdAt: now,
            },
          ],
          checkpoints: [],
          session: null,
        },
        page: { beforeCursor: null, hasMore: false, snapshotSequence: 3, threadSequence: 3 },
      };

      yield* store.saveThread(environmentId, snapshot);
      const loaded = yield* store.loadThread(environmentId, threadId);
      expect(
        Option.getOrThrow(loaded).thread.activities.map((activity) => activity.payload),
      ).toEqual([{ usedTokens: 81_659, maxTokens: 200_000 }, { contextUsageStatus: "unknown" }]);
    }),
  );
});
