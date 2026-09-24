/** Keep headers, rows and targets disjoint even when project and thread keys share prefixes. */
export function sidebarGroupedDragId(
  kind: "project" | "thread" | "marker",
  groupKey: string,
  key = "",
) {
  return JSON.stringify([kind, groupKey, key]);
}
