import { describe, expect, it } from "vite-plus/test";
import { EventId, type OrchestrationThreadActivity, TurnId } from "@t3tools/contracts";

import { deriveReportedThreadCosts, formatReportedCostUsd } from "./reportedThreadCosts";

function makeActivity(
  id: string,
  turnId: string,
  payload: unknown,
  kind = "usage.cost",
): OrchestrationThreadActivity {
  return {
    id: EventId.make(id),
    tone: "info",
    kind,
    summary: kind,
    payload,
    turnId: TurnId.make(turnId),
    createdAt: `2026-03-23T00:00:0${id.slice(-1)}.000Z`,
  };
}

describe("reported thread costs", () => {
  it("keeps the label provisional for any latest counted turn, until its final report replaces it", () => {
    const completedTurn = makeActivity("activity-1", "turn-completed", {
      totalCostUsd: 0.2,
      status: "provisional",
    });
    const currentTurn = makeActivity("activity-2", "turn-current", {
      totalCostUsd: 0.2,
      status: "provisional",
    });

    expect(deriveReportedThreadCosts([completedTurn, currentTurn]).hasProvisionalCost).toBe(true);
    expect(
      deriveReportedThreadCosts([
        completedTurn,
        currentTurn,
        makeActivity("activity-3", "turn-completed", { totalCostUsd: 0.25, status: "final" }),
        makeActivity("activity-4", "turn-current", { totalCostUsd: 0.3, status: "final" }),
      ]).hasProvisionalCost,
    ).toBe(false);
    // Older payloads without status are final reports.
    expect(
      deriveReportedThreadCosts([makeActivity("activity-5", "legacy", { totalCostUsd: 0.1 })])
        .hasProvisionalCost,
    ).toBe(false);
  });

  it("uses the latest valid report per turn and totals turns once", () => {
    const result = deriveReportedThreadCosts([
      makeActivity("activity-1", "turn-1", { totalCostUsd: 0.2 }),
      makeActivity("activity-2", "turn-2", { totalCostUsd: 0.35 }),
      makeActivity("activity-3", "turn-1", { totalCostUsd: 0.4 }),
    ]);

    expect(result.byTurnId.get(TurnId.make("turn-1"))).toBe(0.4);
    expect(result.byTurnId.get(TurnId.make("turn-2"))).toBe(0.35);
    expect(result.totalUsd).toBeCloseTo(0.75);
  });

  it("preserves reported zero and leaves missing or malformed costs absent", () => {
    const result = deriveReportedThreadCosts([
      makeActivity("activity-1", "turn-zero", { totalCostUsd: 0 }),
      makeActivity("activity-2", "turn-bad", { totalCostUsd: -1 }),
      makeActivity("activity-3", "turn-bad", { totalCostUsd: "0.3" }),
      makeActivity("activity-4", "turn-other", { totalCostUsd: 1 }, "tool.started"),
    ]);

    expect(result.byTurnId.get(TurnId.make("turn-zero"))).toBe(0);
    expect(result.byTurnId.has(TurnId.make("turn-bad"))).toBe(false);
    expect(result.totalUsd).toBe(0);
    expect(deriveReportedThreadCosts([]).totalUsd).toBeNull();
  });

  it("keeps the newest timestamp when activities arrive out of order", () => {
    const newer = makeActivity("activity-2", "turn-1", { totalCostUsd: 0.4 });
    const older = makeActivity("activity-1", "turn-1", { totalCostUsd: 0.2 });
    expect(deriveReportedThreadCosts([newer, older]).totalUsd).toBe(0.4);
  });

  it("prefers cumulative summaries over a windowed activity list and uses live updates", () => {
    const oldTurn = TurnId.make("old-turn");
    const recentTurn = TurnId.make("recent-turn");
    const activityWindow = [makeActivity("activity-1", "recent-turn", { totalCostUsd: 0.3 })];
    const summary = [
      { turnId: oldTurn, totalCostUsd: 0.7, status: "final" as const },
      { turnId: recentTurn, totalCostUsd: 0.4, status: "provisional" as const },
    ];

    expect(deriveReportedThreadCosts(activityWindow, summary)).toMatchObject({
      totalUsd: 1.1,
      hasProvisionalCost: true,
    });
    expect(deriveReportedThreadCosts(activityWindow, summary).byTurnId.get(oldTurn)).toBe(0.7);
    expect(
      deriveReportedThreadCosts(activityWindow, [
        { turnId: oldTurn, totalCostUsd: 0.8, status: "final" },
        { turnId: recentTurn, totalCostUsd: 0.4, status: "provisional" },
      ]).totalUsd,
    ).toBeCloseTo(1.2);
  });

  it("falls back to activity history when the server has no summary", () => {
    expect(
      deriveReportedThreadCosts([makeActivity("activity-1", "legacy", { totalCostUsd: 0.2 })])
        .totalUsd,
    ).toBe(0.2);
  });

  it("leaves an overflowing aggregate unknown", () => {
    expect(
      deriveReportedThreadCosts([
        makeActivity("activity-1", "turn-1", { totalCostUsd: Number.MAX_VALUE }),
        makeActivity("activity-2", "turn-2", { totalCostUsd: Number.MAX_VALUE }),
      ]).totalUsd,
    ).toBeNull();
  });

  it("formats reported amounts as USD", () => {
    expect(formatReportedCostUsd(0)).toBe("$0.00");
    expect(formatReportedCostUsd(0.123456)).toBe("$0.123456");
    expect(formatReportedCostUsd(0.0000001)).toBe("<$0.000001");
  });
});
