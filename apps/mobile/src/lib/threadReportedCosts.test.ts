import { describe, expect, it } from "vite-plus/test";
import { EventId, TurnId, type OrchestrationThreadActivity } from "@t3tools/contracts";

import { threadReportedCosts } from "./threadReportedCosts";

function costActivity(
  id: string,
  turnId: string,
  totalCostUsd: number,
  createdAt: string,
): OrchestrationThreadActivity {
  return {
    id: EventId.make(id),
    kind: "usage.cost",
    summary: "Usage cost",
    tone: "info",
    createdAt,
    turnId: TurnId.make(turnId),
    payload: { totalCostUsd },
  };
}

describe("threadReportedCosts", () => {
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

  it("keeps an unreported total unknown and rejects invalid reports", () => {
    expect(threadReportedCosts([]).totalUsd).toBeNull();
    expect(
      threadReportedCosts([
        costActivity("invalid-negative", "one", -1, "2026-01-01T00:00:00.000Z"),
        costActivity("invalid-nan", "two", Number.NaN, "2026-01-02T00:00:00.000Z"),
      ]).totalUsd,
    ).toBeNull();
  });
});
