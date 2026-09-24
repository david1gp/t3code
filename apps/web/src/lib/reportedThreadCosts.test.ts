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

  it("formats reported amounts as USD", () => {
    expect(formatReportedCostUsd(0)).toBe("$0.00");
    expect(formatReportedCostUsd(0.123456)).toBe("$0.123456");
    expect(formatReportedCostUsd(0.0000001)).toBe("<$0.000001");
  });
});
