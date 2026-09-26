# Compact project sidebar

## Goal

Add optional web/desktop sidebar grouping of threads under collapsible logical project headings, with compact row preferences. Preserve the existing ungrouped layout by default. Mobile is out of scope.

## Decisions

- Independent client preferences: group threads by project, show provider logos, show branch labels. Defaults preserve current appearance.
- Reuse existing logical project grouping, project ordering and persisted expansion state.
- Drag headings to reorder projects; drag threads to reorder within their logical project. Reject cross-project thread drops. Preserve existing lifecycle behavior within a project.
- Manual dragging takes precedence over automatic sorting for the relevant ordering preference.
- Newly created threads appear under their owning project and expand that project, including non-sidebar creation entry points.
- Hidden row metadata stays available in tooltips. Avoid an empty branch line when hidden.
- Reuse existing dependencies. Do not change unrelated worktree edits or live user state.

## Tasks

1. Add defaulted client preferences and organization settings controls; verify focused settings tests.
2. Implement grouped sidebar rendering, expansion, constrained thread/header drag ordering, and compact metadata; add focused behavior tests.
3. Independently review integration and run focused tests/type checks; correct feature defects.
4. Run one authorized browser verification against isolated development state, covering toggles, persistence, project/thread drag boundaries, collapse, and newly created threads.

## Status

- Task 1: completed.
- Task 2: completed.
- Task 3: completed.
- Task 4: completed.

## Current context

Current Sidebar.tsx uses a flat lifecycle-section list. LegacySidebar.tsx provides reusable project ordering/expansion patterns, but should not be replaced or modified unnecessarily. Client preferences are defined in packages/contracts/src/settings.ts; controls live in SettingsPanels.tsx. User has explicitly requested implementation and validation, authorizing browser verification.
Preferences available: sidebarGroupThreadsByProject (false), sidebarShowProviderLogos (true), sidebarShowBranchLabels (true). Package commands are available through bunx vp.
Grouped rendering and drag helpers are implemented in Sidebar.tsx, Sidebar.grouped.ts, and sidebarGroupedDropResolve.ts. Drafts render within their owning groups. Common creation and plan-implementation paths reveal and expand the owner. Grouped thread/header dragging selects manual ordering. Browser validation should exercise integrated behavior with multiple projects and threads.
Project-header collision detection uses header positions rather than expanded group centers. Implementation and authorized integrated browser validation are complete; mobile remains out of scope.
