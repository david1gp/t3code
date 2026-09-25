import type { CollisionDetection } from "@dnd-kit/core";
import { describe, expect, it } from "vite-plus/test";
import { sidebarGroupedThreadCollisionDetect } from "./sidebarGroupedThreadCollisionDetect";

describe("grouped thread collision", () => {
  const rect = (top: number, height: number) => ({
    top,
    bottom: top + height,
    height,
    left: 0,
    right: 260,
    width: 260,
  });
  const header = "alpha:pinned-header";
  const divider = "alpha:pinned-divider";
  const pinned = "alpha:pinned-thread";
  const active = "alpha:active-thread";
  const foreign = "beta:pinned-thread";
  const ids = [header, divider, pinned, active, foreign];
  const rects = new Map([
    [header, rect(100, 4)],
    [pinned, rect(105, 40)],
    [divider, rect(146, 4)],
    [active, rect(151, 40)],
    [foreign, rect(200, 40)],
  ]);
  const containers = ids.map((id) => ({
    id,
    key: id,
    disabled: false,
    data: { current: {} },
    node: { current: null },
    rect: { current: rects.get(id)! },
  }));
  const argsAt = (y: number) => {
    const collisionRect = rect(y - 20, 40);
    return {
      active: {
        id: "alpha:dragging",
        data: { current: {} },
        rect: { current: { initial: rect(200, 40), translated: collisionRect } },
      },
      collisionRect,
      droppableRects: rects,
      droppableContainers: containers,
      pointerCoordinates: { x: 130, y },
    } satisfies Parameters<CollisionDetection>[0];
  };
  const detect = (y: number, ownerKeys: ReadonlySet<string>, pinnedKeys: ReadonlySet<string>) =>
    sidebarGroupedThreadCollisionDetect(argsAt(y), {
      ownerKeys,
      pinnedKeys,
      pinnedHeaderId: header,
      pinnedDividerId: divider,
      projectIds: new Set(),
    });
  const ownerKeys = new Set([header, divider, pinned, active]);

  it("keeps drops above the first pinned row inside the pinned span", () => {
    expect(detect(103, ownerKeys, new Set([pinned]))[0]?.id).toBe(header);
  });

  it("targets the pinned header when the pinned section is empty", () => {
    expect(detect(103, new Set([header, divider, active]), new Set())[0]?.id).toBe(header);
  });

  it("keeps reordering pinned rows available within the pinned span", () => {
    expect(detect(130, ownerKeys, new Set([pinned]))[0]?.id).toBe(pinned);
  });

  it("preserves ordinary same-project reordering outside the pinned span", () => {
    expect(detect(180, ownerKeys, new Set([pinned]))[0]?.id).toBe(active);
  });

  it("does not substitute a same-project target for a foreign-project drop", () => {
    expect(detect(210, ownerKeys, new Set([pinned]))).toEqual([]);
  });
});
