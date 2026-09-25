import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { SidebarProjectSnapshot } from "../sidebarProjectGrouping";
import type { SidebarListItem, SidebarSection } from "./Sidebar.logic";

export function sidebarGroupedListsCreate(input: {
  groups: readonly SidebarProjectSnapshot[];
  sections: Record<SidebarSection, readonly EnvironmentThreadShell[]>;
  totals?: Partial<Record<SidebarSection, readonly EnvironmentThreadShell[]>>;
  scopeKey: string | null;
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
      preview: {
        pinned: EnvironmentThreadShell[];
        active: EnvironmentThreadShell[];
        snoozed: EnvironmentThreadShell[];
        hasMore: false;
      };
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
    // Keep the existing render shape while the grouped view consumes these
    // arrays; unlike the ungrouped list, grouped projects never preview-limit.
    group.preview = {
      pinned: [...group.sections.pinned],
      active: [...group.sections.active],
      snoozed: [...group.sections.snoozed],
      hasMore: false,
    };
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
      ...rows("snoozed"),
    ];
    group.dragItems = [...group.items];
  }
  return [...lists.values()].filter(
    (group) =>
      group.sections.pinned.length + group.sections.active.length + group.sections.snoozed.length >
      0,
  );
}
