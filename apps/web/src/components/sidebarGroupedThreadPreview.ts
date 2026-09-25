export function sidebarGroupedThreadPreview<T>(input: {
  pinned: readonly T[];
  active: readonly T[];
  snoozed: readonly T[];
  limit: number;
  expanded: boolean;
}) {
  const remaining = Math.max(0, input.limit - input.pinned.length);
  const hasMore = input.active.length + input.snoozed.length > remaining;
  return {
    pinned: [...input.pinned],
    active:
      input.expanded || !hasMore
        ? [...input.active]
        : input.active.slice(0, Math.min(input.active.length, remaining)),
    snoozed:
      input.expanded || !hasMore
        ? [...input.snoozed]
        : input.snoozed.slice(0, Math.max(0, remaining - input.active.length)),
    hasMore,
  };
}
