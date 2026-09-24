import type { CollisionDetection } from "@dnd-kit/core";

/** Compare header positions, not whole project rows (which can contain many threads). */
export function sidebarGroupedProjectCollisionDetect(
  args: Parameters<CollisionDetection>[0],
  projectIds: ReadonlySet<string>,
): ReturnType<CollisionDetection> {
  // Grouped headers have a fixed h-9 height; the pointer sensor is the only
  // grouped drag sensor, so its Y coordinate tracks the grabbed header.
  const y = args.pointerCoordinates?.y ?? args.collisionRect.top + 18;
  let nearest: (typeof args.droppableContainers)[number] | null = null;
  let distance = Infinity;
  for (const container of args.droppableContainers) {
    if (!projectIds.has(String(container.id))) continue;
    const rect = args.droppableRects.get(container.id);
    if (!rect) continue;
    const nextDistance = Math.abs(y - (rect.top + 18));
    if (nextDistance < distance) {
      nearest = container;
      distance = nextDistance;
    }
  }
  return nearest === null
    ? []
    : [{ id: nearest.id, data: { droppableContainer: nearest, value: distance } }];
}
