import { resolveSidebarDropTarget, type SidebarListItem } from "./Sidebar.logic";
import { sidebarGroupedDragId } from "./sidebarGroupedDragId";

export function sidebarGroupedDropResolve(input: {
  groups: readonly {
    project: { projectKey: string };
    items: readonly SidebarListItem[];
    dragItems?: readonly SidebarListItem[];
  }[];
  activeId: string;
  overId: string;
  flatActive?: { key: string; groupKey: string };
}) {
  const group = input.flatActive
    ? input.groups.find((candidate) => candidate.project.projectKey === input.flatActive?.groupKey)
    : input.groups.find((candidate) =>
        candidate.items.some(
          (item) =>
            item.kind === "thread" &&
            sidebarGroupedDragId("thread", candidate.project.projectKey, item.key) ===
              input.activeId,
        ),
      );
  if (!group) return null;
  if (
    group.dragItems &&
    !group.dragItems.some(
      (item) =>
        sidebarGroupedDragId(
          item.kind === "thread" ? "thread" : "marker",
          group.project.projectKey,
          item.kind === "thread" ? item.key : item.marker,
        ) === input.overId,
    )
  )
    return null;
  const activeKey = input.flatActive
    ? input.flatActive.key
    : group.items.find(
        (item) =>
          item.kind === "thread" &&
          sidebarGroupedDragId("thread", group.project.projectKey, item.key) === input.activeId,
      );
  if (typeof activeKey !== "string" && activeKey?.kind !== "thread") return null;
  // Headers are separate sortable items; rows never leave their logical owner.
  const marker = group.items.find(
    (item) =>
      item.kind === "marker" &&
      sidebarGroupedDragId("marker", group.project.projectKey, item.marker) === input.overId,
  );
  const overThread = group.items.find(
    (item) =>
      item.kind === "thread" &&
      sidebarGroupedDragId("thread", group.project.projectKey, item.key) === input.overId,
  );
  const resolvedActiveKey = typeof activeKey === "string" ? activeKey : activeKey.key;
  const items = input.flatActive
    ? [
        ...group.items,
        { kind: "thread" as const, key: resolvedActiveKey, section: "settled" as const },
      ]
    : group.items;
  const target = resolveSidebarDropTarget(
    items,
    resolvedActiveKey,
    marker?.kind === "marker"
      ? `sidebar-marker-${marker.marker}`
      : overThread?.kind === "thread"
        ? overThread.key
        : "",
  );
  return target === null
    ? null
    : { groupKey: group.project.projectKey, activeKey: resolvedActiveKey, target };
}
