# Sidebar consolidation

## Goal

Use the current web/desktop sidebar as the sole implementation, preserving legacy controls. Project grouping applies only to non-settled threads; settled history remains flat. Mobile is unchanged.

## Decisions

- Remove the legacy selector and implementation after control parity is established.
- Migrate persisted legacy opt-ins to project grouping, overriding the previous grouping value once; clear the legacy opt-in so subsequent grouping changes persist.
- Preserve project sorting, project expansion/order preferences, thread sorting, and configurable per-project preview limits with Show more/less.
- Retain current lifecycle sections, pinned/manual order, snooze behavior, and flat settled paging. Apply thread sort to automatic ordering within non-settled project sections, not across lifecycle boundaries or over explicit manual ordering.
- Preview limits apply to grouped non-settled rows only; do not cap pinned rows or settled history. Reuse existing settings and libraries.
- Preserve project actions through existing equivalent controls rather than duplicating legacy UI.

## Tasks

1. Completed: sorting, preview controls, and member-level project actions are preserved in the current sidebar and project settings.
2. Completed: persisted legacy opt-ins migrate once to grouped mode; legacy selector, implementation, layout and shortcut branches are removed.
3. Completed: independent integrated review and focused automated verification. Browser verification is not authorized and was not performed.

## Current context

The worktree contains existing grouping work and a fix keeping settled rows flat. Preserve unrelated changes. Settings live in packages/contracts/src/settings.ts and hydrate in apps/web/src/hooks/useSettings.ts. Current and legacy sidebars live in apps/web/src/components. Existing project sort and logical-project expansion support should be reused.
Project settings now include member-level rename, grouping override, and Copy Path alongside existing creation/removal equivalents. Sorting and preview helpers have focused tests.
The legacy settings field remains solely for persisted compatibility. Hydration clears it when migrating so later grouping changes remain independent.
