import type {
  OrchestrationThreadActivity,
  OrchestrationThreadReportedCost,
  TurnId,
} from "@t3tools/contracts";

interface ThreadReportedCosts {
  readonly byTurnId: ReadonlyMap<TurnId, number>;
  readonly provisionalByTurnId: ReadonlySet<TurnId>;
  readonly hasProvisionalCost: boolean;
  readonly totalUsd: number | null;
}

export function threadReportedCosts(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
  reportedCosts?: ReadonlyArray<OrchestrationThreadReportedCost>,
): ThreadReportedCosts {
  if (reportedCosts !== undefined) {
    const byTurnId = new Map<TurnId, number>();
    const provisionalByTurnId = new Set<TurnId>();
    let hasProvisionalCost = false;
    let totalUsd = 0;
    for (const report of reportedCosts) {
      if (!Number.isFinite(report.totalCostUsd) || report.totalCostUsd < 0) continue;
      byTurnId.set(report.turnId, report.totalCostUsd);
      if (report.status === "provisional") provisionalByTurnId.add(report.turnId);
      else provisionalByTurnId.delete(report.turnId);
      hasProvisionalCost ||= report.status === "provisional";
      totalUsd += report.totalCostUsd;
      if (!Number.isFinite(totalUsd)) {
        return { byTurnId, provisionalByTurnId, hasProvisionalCost, totalUsd: null };
      }
    }
    return {
      byTurnId,
      provisionalByTurnId,
      hasProvisionalCost,
      totalUsd: byTurnId.size === 0 ? null : totalUsd,
    };
  }

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
    if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return;
    const cost = (payload as Record<string, unknown>).totalCostUsd;
    if (typeof cost !== "number" || !Number.isFinite(cost) || cost < 0) return;

    const previous = latestByTurn.get(activity.turnId);
    if (
      previous &&
      (previous.createdAt > activity.createdAt ||
        (previous.createdAt === activity.createdAt && previous.index > index))
    ) {
      return;
    }
    latestByTurn.set(activity.turnId, {
      createdAt: activity.createdAt,
      index,
      cost,
      provisional: (payload as Record<string, unknown>).status === "provisional",
    });
  });

  const byTurnId = new Map<TurnId, number>();
  const provisionalByTurnId = new Set<TurnId>();
  let hasProvisionalCost = false;
  let totalUsd = 0;
  for (const [turnId, report] of latestByTurn) {
    byTurnId.set(turnId, report.cost);
    if (report.provisional) provisionalByTurnId.add(turnId);
    hasProvisionalCost ||= report.provisional;
    totalUsd += report.cost;
    if (!Number.isFinite(totalUsd)) {
      return { byTurnId, provisionalByTurnId, hasProvisionalCost, totalUsd: null };
    }
  }

  return {
    byTurnId,
    provisionalByTurnId,
    hasProvisionalCost,
    totalUsd: byTurnId.size === 0 ? null : totalUsd,
  };
}
