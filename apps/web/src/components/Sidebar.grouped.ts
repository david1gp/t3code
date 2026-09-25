import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { SidebarProjectSnapshot } from "../sidebarProjectGrouping";
import type { SidebarListItem, SidebarSection } from "./Sidebar.logic";
import { sidebarGroupedThreadPreview } from "./sidebarGroupedThreadPreview";

export function sidebarGroupedListsCreate(input: {
  groups: readonly SidebarProjectSnapshot[];
  sections: Record<SidebarSection, readonly EnvironmentThreadShell[]>;
  totals?: Partial<Record<SidebarSection, readonly EnvironmentThreadShell[]>>;
  scopeKey: string | null;
  previewLimit?: number;
  expandedPreviewProjects?: ReadonlySet<string>;
}) {
  const byRef = new Map(
    input.groups.flatMap((group) =>
      group.memberProjectRefs.map(
        (ref) => [`${ref.environmentId}\0${ref.projectId}`, group.projectKey] as const,
      ),
    ),
  );
  const lists = new Map<
    string,
    {
      project: SidebarProjectSnapshot;
      sections: Record<SidebarSection, EnvironmentThreadShell[]>;
      totalBySection: Record<SidebarSection, number>;
      items: SidebarListItem[];
      dragItems: SidebarListItem[];
      preview: ReturnType<typeof sidebarGroupedThreadPreview<EnvironmentThreadShell>>;
    }
  >();
  for (const project of input.groups) {
    if (input.scopeKey !== null && input.scopeKey !== project.projectKey) continue;
    lists.set(project.projectKey, {
      project,
      sections: { pinned: [], active: [], snoozed: [], settled: [] },
      totalBySection: { pinned: 0, active: 0, snoozed: 0, settled: 0 },
      items: [],
      dragItems: [],
      preview: { pinned: [], active: [], snoozed: [], hasMore: false },
    });
  }
  // Settled threads always render in the shared flat shelf, never in project groups.
  for (const section of ["pinned", "active", "snoozed"] as const) {
    for (const thread of input.sections[section]) {
      const group = lists.get(byRef.get(`${thread.environmentId}\0${thread.projectId}`) ?? "");
      if (group) group.sections[section].push(thread);
    }
    for (const thread of input.totals?.[section] ?? input.sections[section]) {
      const group = lists.get(byRef.get(`${thread.environmentId}\0${thread.projectId}`) ?? "");
      if (group) group.totalBySection[section] += 1;
    }
  }
  for (const group of lists.values()) {
    group.preview = sidebarGroupedThreadPreview({
      pinned: group.sections.pinned,
      active: group.sections.active,
      snoozed: group.sections.snoozed,
      limit: input.previewLimit ?? Number.POSITIVE_INFINITY,
      expanded: input.expandedPreviewProjects?.has(group.project.projectKey) ?? false,
    });
    const rows = (section: SidebarSection): SidebarListItem[] =>
      group.sections[section].map((thread) => ({
        kind: "thread",
        key: scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
        section,
      }));
    group.items = [
      { kind: "marker", marker: "pinned-header" },
      ...rows("pinned"),
      { kind: "marker", marker: "pinned-divider" },
      { kind: "marker", marker: "active-placeholder" },
      ...rows("active"),
      { kind: "marker", marker: "snoozed-header" },
      ...rows("snoozed"),
      // Kept as an invisible structural boundary so grouped drops can settle
      // an owned active thread; the actual settled shelf renders once below.
      { kind: "marker", marker: "settled-header" },
      { kind: "marker", marker: "settled-placeholder" },
    ];
    const visibleKeys = new Set(
      [group.preview.pinned, group.preview.active, group.preview.snoozed]
        .flat()
        .map((thread) => scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id))),
    );
    group.dragItems = group.items.filter(
      (item) => item.kind === "marker" || visibleKeys.has(item.key),
    );
  }
  return [...lists.values()];
}
