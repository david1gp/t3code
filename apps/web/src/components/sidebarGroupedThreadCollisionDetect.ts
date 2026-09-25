import { closestCenter, type CollisionDetection } from "@dnd-kit/core";

/** Keep grouped drops in their owner while treating the pinned span as one target region. */
export function sidebarGroupedThreadCollisionDetect(
  args: Parameters<CollisionDetection>[0],
  input: {
    ownerKeys: ReadonlySet<string>;
    pinnedKeys: ReadonlySet<string>;
    pinnedHeaderId: string;
    pinnedDividerId: string;
    projectIds: ReadonlySet<string>;
  },
): ReturnType<CollisionDetection> {
  const y = args.pointerCoordinates?.y ?? args.collisionRect.top + args.collisionRect.height / 2;
  const headerRect = args.droppableRects.get(input.pinnedHeaderId);
  const dividerRect = args.droppableRects.get(input.pinnedDividerId);
  const overPinnedSpan =
    headerRect !== undefined &&
    dividerRect !== undefined &&
    y >= Math.min(headerRect.top, dividerRect.top) &&
    y <= Math.max(headerRect.bottom, dividerRect.bottom);
  const available = args.droppableContainers.filter(
    (container) => !input.projectIds.has(String(container.id)),
  );
  const x = args.pointerCoordinates?.x ?? args.collisionRect.left + args.collisionRect.width / 2;
  if (
    available.some((container) => {
      if (input.ownerKeys.has(String(container.id))) return false;
      const rect = args.droppableRects.get(container.id);
      return (
        rect !== undefined && x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom
      );
    })
  )
    return [];
  const candidates = overPinnedSpan
    ? available.filter((container) => {
        const id = String(container.id);
        return input.ownerKeys.has(id) && (input.pinnedKeys.has(id) || id === input.pinnedHeaderId);
      })
    : available;
  const collisions = closestCenter({ ...args, droppableContainers: candidates });
  if (overPinnedSpan) return collisions;
  return collisions.filter((collision) => input.ownerKeys.has(String(collision.id)));
}
