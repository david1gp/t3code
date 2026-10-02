import { describe, expect, it } from "vite-plus/test";
import { EventId, type OrchestrationThreadActivity, TurnId } from "@t3tools/contracts";

import { deriveLatestContextWindowSnapshot, formatContextWindowTokens } from "./contextWindow";

function makeActivity(id: string, kind: string, payload: unknown): OrchestrationThreadActivity {
  return {
    id: EventId.make(id),
    tone: "info",
    kind,
    summary: kind,
    payload,
    turnId: TurnId.make("turn-1"),
    createdAt: "2026-03-23T00:00:00.000Z",
  };
}

describe("contextWindow", () => {
  it("derives the latest valid context window snapshot", () => {
    const snapshot = deriveLatestContextWindowSnapshot([
      makeActivity("activity-1", "context-window.updated", {
        usedTokens: 1000,
      }),
      makeActivity("activity-2", "tool.started", {}),
      makeActivity("activity-3", "context-window.updated", {
        usedTokens: 14_000,
        maxTokens: 258_000,
        compactsAutomatically: true,
        autoCompactThreshold: 200_000,
      }),
    ]);

    expect(snapshot).not.toBeNull();
    expect(snapshot?.usedTokens).toBe(14_000);
    expect(snapshot?.totalProcessedTokens).toBeNull();
    expect(snapshot?.maxTokens).toBe(258_000);
    expect(snapshot?.compactsAutomatically).toBe(true);
    expect(snapshot?.autoCompactThreshold).toBe(200_000);
  });

  it("ignores malformed payloads", () => {
    const snapshot = deriveLatestContextWindowSnapshot([
      makeActivity("activity-1", "context-window.updated", {}),
    ]);

    expect(snapshot).toBeNull();
  });

  it("lets the latest unknown invalidate earlier reported occupancy after compaction", () => {
    const snapshot = deriveLatestContextWindowSnapshot([
      makeActivity("known", "context-window.updated", {
        usedTokens: 81_659,
        maxTokens: 200_000,
        compactsAutomatically: true,
      }),
      makeActivity("compact", "context-compaction", {}),
      makeActivity("unknown", "context-window.updated", { contextUsageStatus: "unknown" }),
    ]);
    expect(snapshot).toMatchObject({
      contextUsageStatus: "unknown",
      usedTokens: null,
      maxTokens: null,
      remainingTokens: null,
      usedPercentage: null,
      remainingPercentage: null,
      compactsAutomatically: null,
    });
  });

  it("preserves estimates, disabled auto-compaction, and recovery to legacy reported occupancy", () => {
    const estimate = makeActivity("estimate", "context-window.updated", {
      contextUsageStatus: "estimated",
      usedTokens: 4_000,
      maxTokens: 100_000,
      compactsAutomatically: false,
    });
    expect(deriveLatestContextWindowSnapshot([estimate])).toMatchObject({
      contextUsageStatus: "estimated",
      usedTokens: 4_000,
      usedPercentage: 4,
      remainingTokens: 96_000,
      compactsAutomatically: false,
    });
    expect(
      deriveLatestContextWindowSnapshot([
        estimate,
        makeActivity("unknown", "context-window.updated", { contextUsageStatus: "unknown" }),
        makeActivity("reported", "context-window.updated", { usedTokens: 5_000 }),
      ]),
    ).toMatchObject({ contextUsageStatus: "reported", usedTokens: 5_000 });
  });

  it("keeps reported limits and settings independently of unavailable occupancy", () => {
    expect(
      deriveLatestContextWindowSnapshot([
        makeActivity("unknown-with-limit", "context-window.updated", {
          contextUsageStatus: "unknown",
          maxTokens: 200_000,
          compactsAutomatically: false,
        }),
      ]),
    ).toMatchObject({
      usedTokens: null,
      maxTokens: 200_000,
      compactsAutomatically: false,
      usedPercentage: null,
      remainingTokens: null,
      remainingPercentage: null,
    });
  });

  it.each([
    {},
    { contextUsageStatus: "estimated" },
    { contextUsageStatus: "unknown", usedTokens: 0 },
    { contextUsageStatus: "invalid", usedTokens: 0 },
  ])("does not confuse malformed rows with explicit invalidation: %j", (payload) => {
    expect(
      deriveLatestContextWindowSnapshot([
        makeActivity("known", "context-window.updated", { usedTokens: 12_000 }),
        makeActivity("malformed", "context-window.updated", payload),
      ]),
    ).toMatchObject({ contextUsageStatus: "reported", usedTokens: 12_000 });
  });

  it("keeps valid zero-usage snapshots", () => {
    const snapshot = deriveLatestContextWindowSnapshot([
      makeActivity("activity-1", "context-window.updated", {
        usedTokens: 0,
        maxTokens: 100_000,
      }),
    ]);

    expect(snapshot).toMatchObject({
      usedTokens: 0,
      maxTokens: 100_000,
      remainingTokens: 100_000,
      usedPercentage: 0,
      remainingPercentage: 100,
    });
  });

  it("formats compact token counts", () => {
    expect(formatContextWindowTokens(null)).toBe("Unknown");
    expect(formatContextWindowTokens(999)).toBe("999");
    expect(formatContextWindowTokens(1400)).toBe("1.4k");
    expect(formatContextWindowTokens(14_000)).toBe("14k");
    expect(formatContextWindowTokens(258_000)).toBe("258k");
  });

  it("includes total processed tokens when available", () => {
    const snapshot = deriveLatestContextWindowSnapshot([
      makeActivity("activity-1", "context-window.updated", {
        usedTokens: 81_659,
        totalProcessedTokens: 748_126,
        maxTokens: 258_400,
        lastUsedTokens: 81_659,
      }),
    ]);

    expect(snapshot?.usedTokens).toBe(81_659);
    expect(snapshot?.totalProcessedTokens).toBe(748_126);
  });
});
