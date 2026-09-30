import { describe, expect, it } from "vite-plus/test";
import { EventId, TurnId, type OrchestrationThreadActivity } from "@t3tools/contracts";

import { threadReportedCosts } from "./threadReportedCosts";

function costActivity(
  id: string,
  turnId: string,
  totalCostUsd: number,
  createdAt: string,
  status?: "provisional" | "final",
): OrchestrationThreadActivity {
  return {
    id: EventId.make(id),
    kind: "usage.cost",
    summary: "Usage cost",
    tone: "info",
    createdAt,
    turnId: TurnId.make(turnId),
    payload: { totalCostUsd, ...(status ? { status } : {}) },
  };
}

describe("threadReportedCosts", () => {
  it("tracks provisional status per turn and clears it when final costs replace the reports", () => {
    const completed = costActivity(
      "completed-partial",
      "completed",
      0.2,
      "2026-01-01T00:00:00.000Z",
      "provisional",
    );
    const current = costActivity(
      "current-partial",
      "current",
      0.3,
      "2026-01-02T00:00:00.000Z",
      "provisional",
    );
    const provisionalCosts = threadReportedCosts([completed, current]);
    expect(provisionalCosts.hasProvisionalCost).toBe(true);
    expect(provisionalCosts.provisionalByTurnId.has(TurnId.make("current"))).toBe(true);

    const finalCosts = threadReportedCosts([
      completed,
      current,
      costActivity("completed-final", "completed", 0.25, "2026-01-03T00:00:00.000Z", "final"),
      costActivity("current-final", "current", 0.35, "2026-01-04T00:00:00.000Z", "final"),
    ]);
    expect(finalCosts.hasProvisionalCost).toBe(false);
    expect(finalCosts.provisionalByTurnId.size).toBe(0);
    expect(
      threadReportedCosts([costActivity("legacy", "legacy", 0.1, "2026-01-05T00:00:00.000Z")])
        .hasProvisionalCost,
    ).toBe(false);
  });

  it("keeps the latest correction per turn and sums distinct reported turns", () => {
    const costs = threadReportedCosts([
      costActivity("turn-one", "one", 0.25, "2026-01-01T00:00:00.000Z"),
      costActivity("turn-two", "two", 0, "2026-01-02T00:00:00.000Z"),
      costActivity("turn-one-correction", "one", 0.4, "2026-01-03T00:00:00.000Z"),
    ]);

    expect(costs.byTurnId.get(TurnId.make("one"))).toBe(0.4);
    expect(costs.byTurnId.get(TurnId.make("two"))).toBe(0);
    expect(costs.totalUsd).toBe(0.4);
  });

  it("prefers cumulative summaries outside the activity window and follows live updates", () => {
    const oldTurn = TurnId.make("old-turn");
    const currentTurn = TurnId.make("current-turn");
    const activityWindow = [
      costActivity("current-activity", "current-turn", 0.3, "2026-01-02T00:00:00.000Z"),
    ];
    const summary = [
      { turnId: oldTurn, totalCostUsd: 0.7, status: "final" as const },
      { turnId: currentTurn, totalCostUsd: 0.4, status: "provisional" as const },
    ];

    expect(threadReportedCosts(activityWindow, summary)).toMatchObject({
      totalUsd: 1.1,
      hasProvisionalCost: true,
    });
    expect(threadReportedCosts(activityWindow, summary).byTurnId.get(oldTurn)).toBe(0.7);
    expect(
      threadReportedCosts(activityWindow, [
        { turnId: oldTurn, totalCostUsd: 0.8, status: "final" },
        { turnId: currentTurn, totalCostUsd: 0.4, status: "provisional" },
      ]).totalUsd,
    ).toBeCloseTo(1.2);
  });

  it("falls back to activities for older servers without summaries", () => {
    expect(
      threadReportedCosts([costActivity("legacy", "legacy-turn", 0.2, "2026-01-01T00:00:00.000Z")])
        .totalUsd,
    ).toBe(0.2);
  });

  it("keeps an unreported total unknown and rejects invalid reports", () => {
    expect(threadReportedCosts([]).totalUsd).toBeNull();
    expect(
      threadReportedCosts([
        costActivity("invalid-negative", "one", -1, "2026-01-01T00:00:00.000Z"),
        costActivity("invalid-nan", "two", Number.NaN, "2026-01-02T00:00:00.000Z"),
      ]).totalUsd,
    ).toBeNull();
  });

  it("leaves an overflowing aggregate unknown", () => {
    expect(
      threadReportedCosts([
        costActivity("large-one", "one", Number.MAX_VALUE, "2026-01-01T00:00:00.000Z"),
        costActivity("large-two", "two", Number.MAX_VALUE, "2026-01-02T00:00:00.000Z"),
      ]).totalUsd,
    ).toBeNull();
  });
});
