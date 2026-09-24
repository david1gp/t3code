import type { OrchestrationThreadActivity, TurnId } from "@t3tools/contracts";

export function deriveReportedThreadCosts(activities: ReadonlyArray<OrchestrationThreadActivity>): {
  readonly byTurnId: ReadonlyMap<TurnId, number>;
  readonly totalUsd: number | null;
} {
  const byTurnId = new Map<TurnId, number>();
  const latestByTurn = new Map<TurnId, { readonly createdAt: string; readonly index: number }>();
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
    latestByTurn.set(activity.turnId, { createdAt: activity.createdAt, index });
    byTurnId.set(activity.turnId, totalCostUsd);
  });

  if (byTurnId.size === 0) return { byTurnId, totalUsd: null };
  let totalUsd = 0;
  for (const costUsd of byTurnId.values()) totalUsd += costUsd;
  return { byTurnId, totalUsd };
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
