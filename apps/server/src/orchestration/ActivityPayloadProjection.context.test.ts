import {
  OrchestrationThreadDetailSnapshot,
  TurnId,
  type OrchestrationThreadActivity,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { projectThreadDetailSnapshot } from "./ActivityPayloadProjection.ts";

const createdAt = "2026-10-01T00:00:00.000Z";
const snapshotDecode = Schema.decodeUnknownSync(OrchestrationThreadDetailSnapshot);
const snapshotJsonDecode = Schema.decodeUnknownSync(
  Schema.fromJsonString(OrchestrationThreadDetailSnapshot),
);
const snapshotJsonEncode = Schema.encodeSync(
  Schema.fromJsonString(OrchestrationThreadDetailSnapshot),
);

function snapshotCreate(payloads: ReadonlyArray<unknown>) {
  return snapshotDecode({
    snapshotSequence: 10,
    thread: {
      id: "thread-1",
      projectId: "project-1",
      title: "Context availability",
      modelSelection: { instanceId: "pi", model: "fixture-model" },
      runtimeMode: "approval-required",
      branch: null,
      worktreePath: null,
      latestTurn: null,
      createdAt,
      updatedAt: createdAt,
      deletedAt: null,
      messages: [],
      checkpoints: [],
      session: null,
      activities: payloads.map((payload, index) => ({
        id: `usage-${index}`,
        tone: "info",
        kind: "context-window.updated",
        summary: "Context updated",
        payload,
        turnId: "turn-1",
        createdAt,
      })),
    },
  });
}

describe("context availability activity projection", () => {
  it.each([
    { contextUsageStatus: "unknown" },
    { contextUsageStatus: "estimated", usedTokens: 4_000 },
    { contextUsageStatus: "reported", usedTokens: 5_000 },
    { usedTokens: 0 },
  ])("retains the latest availability snapshot rather than old occupancy: %j", (latest) => {
    const projected = projectThreadDetailSnapshot(
      snapshotCreate([{ usedTokens: 80_000, maxTokens: 200_000 }, latest]),
    );
    expect(projected.thread.activities.map((activity) => activity.payload)).toEqual([latest]);
    expect(snapshotJsonDecode(snapshotJsonEncode(projected))).toEqual(projected);
  });

  it("preserves invalidation per turn, allowing revert to restore the surviving turn", () => {
    const snapshot = snapshotCreate([
      { usedTokens: 80_000 },
      { usedTokens: 81_000 },
      { contextUsageStatus: "unknown" },
    ]);
    const activities: ReadonlyArray<OrchestrationThreadActivity> = snapshot.thread.activities.map(
      (activity, index) => ({
        ...activity,
        turnId: TurnId.make(index === 0 ? "older-turn" : "compaction-turn"),
      }),
    );
    const projected = projectThreadDetailSnapshot({
      ...snapshot,
      thread: { ...snapshot.thread, activities },
    });
    expect(projected.thread.activities.map((activity) => activity.payload)).toEqual([
      { usedTokens: 80_000 },
      { contextUsageStatus: "unknown" },
    ]);
  });

  it.each([
    {},
    { contextUsageStatus: "estimated" },
    { contextUsageStatus: "unknown", usedTokens: 0 },
    { contextUsageStatus: "invalid", usedTokens: 0 },
  ])("does not let malformed rows discard resolvable occupancy: %j", (malformed) => {
    const projected = projectThreadDetailSnapshot(
      snapshotCreate([{ usedTokens: 80_000 }, malformed]),
    );
    expect(projected.thread.activities.map((activity) => activity.payload)).toEqual([
      { usedTokens: 80_000 },
      malformed,
    ]);
  });
});
