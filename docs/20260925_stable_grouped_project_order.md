# Stable grouped project order

## Goal

When web sidebar threads are grouped by project, activity in an already-listed project must not move its project group. Users can reorder groups manually. A newly listed logical project group may enter at the top; creating a thread in an existing group must not change group positions.

## Decisions

- Scope is the grouped web sidebar; do not change mobile's separate project list or unrelated pickers and command palette sorting.
- Preserve existing drag-to-reorder, project membership/grouping, and web UI-state persistence. Avoid new contracts or dependencies.
- Make the ordering stable in the default setting, not only after a drag has selected manual mode. Prefer a minimal, explicit ordering policy over activity-sorting existing groups.

## Tasks

1. Implement stable grouped sidebar ordering with first appearance of a new logical group at the top, preserving manual drag ordering and persisted state. Add focused regression tests for existing/new groups and persisted order. Verify targeted tests and relevant type/lint checks only. **Complete**
2. Review integration for cross-entry behavior and verify focused tests after changes; avoid e2e/browser without permission. **Complete**

## Current context

The grouped web sidebar uses a persisted physical-project order independent of thread activity, with new logical groups promoted to the top and absent projects retaining their positions. Existing picker sorting is unchanged; grouped-mode sort options are hidden. Focused logic/UI-state tests, web typecheck, targeted lint, formatting, and diff checks passed.
