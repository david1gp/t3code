import type {
  OrchestrationThreadActivity,
  OrchestrationThreadReportedCost,
  TurnId,
} from "@t3tools/contracts";

export function deriveReportedThreadCosts(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
  reportedCosts?: ReadonlyArray<OrchestrationThreadReportedCost>,
): {
  readonly byTurnId: ReadonlyMap<TurnId, number>;
  readonly hasProvisionalCost: boolean;
  readonly totalUsd: number | null;
} {
  if (reportedCosts !== undefined) {
    const byTurnId = new Map<TurnId, number>();
    let hasProvisionalCost = false;
    let totalUsd = 0;
    for (const report of reportedCosts) {
      if (!Number.isFinite(report.totalCostUsd) || report.totalCostUsd < 0) continue;
      byTurnId.set(report.turnId, report.totalCostUsd);
      hasProvisionalCost ||= report.status === "provisional";
      totalUsd += report.totalCostUsd;
      if (!Number.isFinite(totalUsd)) return { byTurnId, hasProvisionalCost, totalUsd: null };
    }
    return {
      byTurnId,
      hasProvisionalCost,
      totalUsd: byTurnId.size === 0 ? null : totalUsd,
    };
  }

  const byTurnId = new Map<TurnId, number>();
  const latestByTurn = new Map<
    TurnId,
    {
      readonly createdAt: string;
      readonly index: number;
      readonly cost: number;
      readonly provisional: boolean;
    }
  >();
  activities.forEach((activity, index) => {
    if (activity.kind !== "usage.cost" || activity.turnId === null) return;
    const payload = activity.payload;
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return;
    const totalCostUsd = (payload as Record<string, unknown>).totalCostUsd;
    if (typeof totalCostUsd !== "number" || !Number.isFinite(totalCostUsd) || totalCostUsd < 0) {
      return;
    }
    const previous = latestByTurn.get(activity.turnId);
    if (
      previous &&
      (previous.createdAt > activity.createdAt ||
        (previous.createdAt === activity.createdAt && previous.index > index))
    )
      return;
    latestByTurn.set(activity.turnId, {
      createdAt: activity.createdAt,
      index,
      cost: totalCostUsd,
      provisional: (payload as Record<string, unknown>).status === "provisional",
    });
  });

  let hasProvisionalCost = false;
  for (const [turnId, report] of latestByTurn) {
    byTurnId.set(turnId, report.cost);
    hasProvisionalCost ||= report.provisional;
  }
  if (byTurnId.size === 0) return { byTurnId, hasProvisionalCost, totalUsd: null };
  let totalUsd = 0;
  for (const costUsd of byTurnId.values()) {
    totalUsd += costUsd;
    if (!Number.isFinite(totalUsd)) return { byTurnId, hasProvisionalCost, totalUsd: null };
  }
  return { byTurnId, hasProvisionalCost, totalUsd };
}

export function formatReportedCostUsd(value: number): string {
  if (value > 0 && value < 0.000001) return "<$0.000001";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 6,
  }).format(value);
}
