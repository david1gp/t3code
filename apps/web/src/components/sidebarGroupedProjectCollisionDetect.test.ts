import { closestCenter, type CollisionDetection } from "@dnd-kit/core";
import { describe, expect, it } from "vite-plus/test";
import { sidebarGroupedDragId } from "./sidebarGroupedDragId";
import { sidebarGroupedProjectCollisionDetect } from "./sidebarGroupedProjectCollisionDetect";

describe("grouped project header collision", () => {
  const short = sidebarGroupedDragId("project", "short");
  const expanded = sidebarGroupedDragId("project", "expanded");
  const thread = sidebarGroupedDragId("thread", "expanded", "row");
  const rect = (top: number, height: number) => ({
    top,
    bottom: top + height,
    height,
    left: 0,
    right: 260,
    width: 260,
  });
  const rects = new Map([
    [short, rect(100, 36)],
    [expanded, rect(137, 600)],
    [thread, rect(150, 40)],
  ]);
  const containers = [short, expanded, thread].map((id) => ({
    id,
    key: id,
    disabled: false,
    data: { current: {} },
    node: { current: null },
    rect: { current: rects.get(id)! },
  }));
  const ids = new Set([short, expanded]);
  const argsAt = (activeId: string, y: number) => {
    const activeRect = rects.get(activeId)!;
    const collisionRect = rect(y - 18, activeRect.height);
    return {
      active: {
        id: activeId,
        data: { current: {} },
        rect: { current: { initial: activeRect, translated: collisionRect } },
      },
      collisionRect,
      droppableRects: rects,
      droppableContainers: containers,
      pointerCoordinates: { x: 130, y },
    } satisfies Parameters<CollisionDetection>[0];
  };

  it("targets an expanded project's header even when its row center is far below the pointer", () => {
    const args = argsAt(short, 150);
    expect(
      closestCenter({
        ...args,
        droppableContainers: containers.filter((container) => ids.has(container.id)),
      })[0]?.id,
    ).toBe(short);
    expect(sidebarGroupedProjectCollisionDetect(args, ids)[0]?.id).toBe(expanded);
  });

  it("targets a short project's header when dragging an expanded project upward", () => {
    const args = argsAt(expanded, 115);
    expect(
      closestCenter({
        ...args,
        droppableContainers: containers.filter((container) => ids.has(container.id)),
      })[0]?.id,
    ).toBe(expanded);
    expect(sidebarGroupedProjectCollisionDetect(args, ids)[0]?.id).toBe(short);
  });

  it("keeps the active header while over it and ignores thread rows", () => {
    expect(sidebarGroupedProjectCollisionDetect(argsAt(short, 118), ids)[0]?.id).toBe(short);
    expect(sidebarGroupedProjectCollisionDetect(argsAt(short, 155), new Set())[0]).toBeUndefined();
  });
});
