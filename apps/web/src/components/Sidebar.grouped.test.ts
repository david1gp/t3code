import { describe, expect, it } from "vite-plus/test";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import type { SidebarProjectSnapshot } from "../sidebarProjectGrouping";
import { sidebarGroupedListsCreate } from "./Sidebar.grouped";
import { sidebarGroupedDropResolve } from "./sidebarGroupedDropResolve";
import { sidebarGroupedDragId } from "./sidebarGroupedDragId";
import { sidebarGroupedDraftBelongsToProject } from "./sidebarGroupedDraftBelongsToProject";
import { sidebarDraftRowsSelect } from "./sidebarDraftRowsSelect";

const project = (key: string, refs: [string, string][]) =>
  ({
    projectKey: key,
    memberProjectRefs: refs.map(([environmentId, projectId]) => ({ environmentId, projectId })),
  }) as unknown as SidebarProjectSnapshot;
const thread = (environmentId: string, projectId: string, id: string) =>
  ({
    environmentId,
    projectId,
    id,
  }) as EnvironmentThreadShell;

describe("grouped sidebar ownership and drops", () => {
  const groups = [
    project("alpha", [
      ["local", "a"],
      ["remote", "a"],
    ]),
    project("beta", [["remote", "b"]]),
  ];
  const sections = {
    pinned: [thread("remote", "a", "p")],
    active: [
      thread("local", "a", "first"),
      thread("remote", "b", "other"),
      thread("remote", "a", "second"),
    ],
    snoozed: [thread("local", "a", "sleep")],
    settled: [thread("remote", "b", "done")],
  };

  it("keeps lifecycle partitions within logical ownership across environments and scope", () => {
    const all = sidebarGroupedListsCreate({ groups, sections, scopeKey: null });
    expect(
      all.map(({ project, sections }) => [project.projectKey, sections.active.map(({ id }) => id)]),
    ).toEqual([
      ["alpha", ["first", "second"]],
      ["beta", ["other"]],
    ]);
    expect(all[0]?.sections.pinned.map(({ id }) => id)).toEqual(["p"]);
    expect(all[0]?.sections.snoozed.map(({ id }) => id)).toEqual(["sleep"]);
    expect(
      sidebarGroupedListsCreate({ groups, sections, scopeKey: "beta" }).map(
        ({ project }) => project.projectKey,
      ),
    ).toEqual(["beta"]);
  });

  it("leaves settled threads and settled counts to the shared flat shelf", () => {
    const lists = sidebarGroupedListsCreate({
      groups,
      sections,
      totals: { settled: [thread("remote", "b", "done"), thread("local", "a", "older")] },
      scopeKey: null,
    });
    expect(
      lists.map(({ sections, totalBySection, items }) => ({
        settled: sections.settled,
        settledTotal: totalBySection.settled,
        settledItems: items.filter((item) => item.kind === "thread" && item.section === "settled"),
      })),
    ).toEqual([
      { settled: [], settledTotal: 0, settledItems: [] },
      { settled: [], settledTotal: 0, settledItems: [] },
    ]);
    expect(
      lists.every(({ items }) =>
        items.some((item) => item.kind === "marker" && item.marker === "settled-placeholder"),
      ),
    ).toBe(true);
  });

  it("rejects cross-project and header drops but permits reorder and lifecycle moves within owner", () => {
    const lists = sidebarGroupedListsCreate({ groups, sections, scopeKey: null });
    const row = (group: string, key: string) => sidebarGroupedDragId("thread", group, key);
    const marker = (group: string, key: string) => sidebarGroupedDragId("marker", group, key);
    expect(
      sidebarGroupedDropResolve({
        groups: lists,
        activeId: row("alpha", "local:first"),
        overId: row("beta", "remote:other"),
      }),
    ).toBeNull();
    expect(
      sidebarGroupedDropResolve({
        groups: lists,
        activeId: row("alpha", "local:first"),
        overId: sidebarGroupedDragId("project", "beta"),
      }),
    ).toBeNull();
    expect(
      sidebarGroupedDropResolve({
        groups: lists,
        activeId: row("alpha", "local:first"),
        overId: row("alpha", "remote:second"),
      })?.target.activeOrder,
    ).toEqual(["remote:second", "local:first"]);
    expect(
      sidebarGroupedDropResolve({
        groups: lists,
        activeId: row("alpha", "local:first"),
        overId: marker("alpha", "pinned-header"),
      })?.target.section,
    ).toBe("pinned");
    expect(
      sidebarGroupedDropResolve({
        groups: lists,
        activeId: row("alpha", "local:first"),
        overId: marker("alpha", "settled-placeholder"),
      })?.target.section,
    ).toBe("settled");
    expect(
      sidebarGroupedDropResolve({
        groups: lists,
        activeId: row("alpha", "local:first"),
        overId: marker("alpha", "snoozed-header"),
      }),
    ).toBeNull();
  });

  it("resolves a flat settled row dropped into its owning project's active section", () => {
    const lists = sidebarGroupedListsCreate({ groups, sections, scopeKey: null });
    const resolved = sidebarGroupedDropResolve({
      groups: lists,
      activeId: "remote:done",
      overId: sidebarGroupedDragId("marker", "beta", "active-placeholder"),
      flatActive: { key: "remote:done", groupKey: "beta" },
    });
    expect(resolved).toMatchObject({
      groupKey: "beta",
      activeKey: "remote:done",
      target: { section: "active" },
    });
  });

  it("keeps drag identity and draft ownership separate when names overlap across environments", () => {
    const collisionGroups = [
      project("project:shared", [["one", "same"]]),
      project("other", [["two", "same"]]),
    ];
    const lists = sidebarGroupedListsCreate({
      groups: collisionGroups,
      scopeKey: null,
      sections: {
        pinned: [],
        active: [thread("one", "same", "first"), thread("two", "same", "first")],
        snoozed: [],
        settled: [],
      },
    });
    const first = sidebarGroupedDragId("thread", "project:shared", "one:first");
    const second = sidebarGroupedDragId("thread", "other", "two:first");
    expect(new Set([first, second, sidebarGroupedDragId("project", "project:shared")]).size).toBe(
      3,
    );
    expect(
      sidebarGroupedDropResolve({ groups: lists, activeId: second, overId: first }),
    ).toBeNull();
    expect(
      sidebarGroupedDraftBelongsToProject(
        { environmentId: "two", projectId: "same" },
        collisionGroups[0]!,
      ),
    ).toBe(false);
    expect(
      sidebarGroupedDraftBelongsToProject(
        { environmentId: "two", projectId: "same" },
        collisionGroups[1]!,
      ),
    ).toBe(true);
    expect(
      sidebarGroupedDraftBelongsToProject({ environmentId: "remote", projectId: "a" }, groups[0]!),
    ).toBe(true);
    const repeated = ["one", "two"].map((projectKey) => ({
      project: { projectKey },
      items: [
        { kind: "marker" as const, marker: "active-placeholder" as const },
        { kind: "thread" as const, key: "shared:thread", section: "active" as const },
      ],
    }));
    expect(
      sidebarGroupedDropResolve({
        groups: repeated,
        activeId: sidebarGroupedDragId("thread", "two", "shared:thread"),
        overId: sidebarGroupedDragId("marker", "two", "active-placeholder"),
      })?.groupKey,
    ).toBe("two");
    expect(
      sidebarGroupedDropResolve({
        groups: repeated,
        activeId: sidebarGroupedDragId("thread", "two", "shared:thread"),
        overId: sidebarGroupedDragId("marker", "one", "active-placeholder"),
      }),
    ).toBeNull();
  });

  it("puts invested and empty drafts under the owning group without changing ungrouped visibility", () => {
    const sessions = {
      invested: {
        environmentId: "remote",
        projectId: "a",
        promotedTo: null,
        createdAt: "2026-01-01",
      },
      empty: { environmentId: "local", projectId: "a", promotedTo: null, createdAt: "2026-01-02" },
      other: { environmentId: "remote", projectId: "b", promotedTo: null, createdAt: "2026-01-03" },
      promoted: {
        environmentId: "local",
        projectId: "a",
        promotedTo: "thread",
        createdAt: "2026-01-04",
      },
    };
    const input = {
      sessions,
      composers: {
        invested: { content: true },
        empty: { content: false },
        other: { content: true },
      },
      scope: null,
      activeDraftId: "empty",
      frozenActive: { routeDraftId: "empty", row: null },
      hasContent: (composer: { content: boolean } | undefined) => composer?.content === true,
    };
    expect(
      sidebarDraftRowsSelect({ ...input, groupProject: groups[0]! }).map((row) => [
        row.draftId,
        row.composer?.content ?? null,
      ]),
    ).toEqual([
      ["empty", null],
      ["invested", true],
    ]);
    expect(
      sidebarDraftRowsSelect({ ...input, groupProject: groups[1]! }).map((row) => row.draftId),
    ).toEqual(["other"]);
    expect(sidebarDraftRowsSelect(input).map((row) => row.draftId)).toEqual(["other", "invested"]);
  });
});
