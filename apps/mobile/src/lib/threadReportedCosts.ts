import type { OrchestrationThreadActivity, TurnId } from "@t3tools/contracts";

interface ThreadReportedCosts {
  readonly byTurnId: ReadonlyMap<TurnId, number>;
  readonly totalUsd: number | null;
}

export function threadReportedCosts(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): ThreadReportedCosts {
  const latestByTurn = new Map<
    TurnId,
    { readonly createdAt: string; readonly index: number; readonly cost: number }
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
    latestByTurn.set(activity.turnId, { createdAt: activity.createdAt, index, cost });
  });

  const byTurnId = new Map<TurnId, number>();
  let totalUsd = 0;
  for (const [turnId, report] of latestByTurn) {
    byTurnId.set(turnId, report.cost);
    totalUsd += report.cost;
  }

  return { byTurnId, totalUsd: byTurnId.size === 0 ? null : totalUsd };
}
