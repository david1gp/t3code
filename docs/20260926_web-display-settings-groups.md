# Web display settings by area

## Goal

Make web/desktop display preferences in General settings easy to find by the part of the UI they affect. In particular, the chat's current context-size indicator (e.g. `13k`) must have a separate visibility control from the sidebar Usage page shortcut.

## Decisions

- Reorganize existing visibility controls; do not add new preference keys or alter defaults. Existing context indicator and sidebar Usage preferences already operate independently.
- Place chat context indicator visibility and its Simple/Detailed display mode together in Display; Simple is the compact current-token-size text. Keep the existing data-availability behavior of the indicator.
- Group settings by actual location: Sidebar (Usage shortcut), Chat area / toolbar (checkout selector, branch selector, context indicator), Chat composer (inline access mode), and Chat composer footer (compact controls menu), as appropriate to the existing component locations. Do not invent empty groups or label the sidebar Usage shortcut as navbar.
- Keep unrelated Appearance and Organization controls in place, including thread header actions; do not alter their behavior. No server or mobile UI changes.
- Preserve existing settings values, resets, and searchable anchors. Update search metadata for the moved context indicator and remove its legacy-section expansion target; retain other legacy features.

## Tasks

1. **Complete:** Reorganize General Display settings by surface and move the existing context indicator controls from Legacy features into the chat-area group. Update affected labels/search metadata while preserving behavior and anchors.
2. **Complete:** Add or adjust focused settings-search tests as needed, then run only relevant focused tests and scoped lint/typecheck; inspect final diff for unintended changes.

## Current context

- `SettingsPanels.tsx` owns the General Display and Legacy features sections; `settingsSearch.ts` owns searchable row metadata and `settingsSearch.test.ts` covers search. `SettingsSection` provides headings and row grouping.
- `sidebarShowUsage` controls `SidebarChrome`'s Usage shortcut. `contextWindowMeterEnabled` and `contextWindowDisplayMode` control the chat toolbar's context meter. No schema change is necessary.
- Display grouping and search metadata are updated in `SettingsPanels.tsx` and `settingsSearch.ts`; focused coverage in `settingsSearch.test.ts` distinguishes chat context from sidebar Usage. Targeted tests, lint, scoped web typecheck, and diff checks passed. Other pre-existing worktree edits were left intact.
