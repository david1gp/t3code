# Web display options

## Goal

Allow users to independently hide the visible chat-area checkout, branch, and access-mode controls, plus the sidebar Usage shortcut, without changing runtime behavior. All controls remain shown by default.

## Decisions

- Add three client-local boolean preferences for showing the checkout selector, branch selector, and inline composer access-mode control. Default each to true to preserve existing UI.
- The checkout preference hides the visible `Local checkout` run-context control in both desktop and compact toolbar layouts; the branch preference hides the visible `main` branch control in applicable toolbar layouts. Keep underlying state and other routes for changing these values intact.
- The access-mode preference hides the inline composer Access control. Access choices appear in the compact composer menu only when inline Access is enabled and that control overflows; hiding inline Access does not expose a duplicate Access menu route. Runtime access behavior is unchanged.
- Reuse the existing `sidebarShowUsage` preference. Move its setting from Organization to a new Display section with the three new preferences. Do not duplicate its state or change the Usage page.
- Keep preferences client-local across web and desktop; do not add mobile controls for web-only chrome. Follow existing contracts/defaults and settings persistence, and retain existing responsive behavior when visible.

## Tasks

1. [done] Add the three client-setting schema defaults and focused contract/persistence tests.
2. [done] Add a Display section to General settings with independent switches and relocate Show Usage, including settings search/reset metadata as needed.
3. [done] Apply checkout and branch visibility preferences in the chat toolbar in both responsive forms, without changing unrelated controls.
4. [done] Apply access-mode visibility preference to the inline composer control.
5. [done] Run focused verification of modified scopes and review cross-surface/default behavior. Do not run repository-wide or e2e tests; browser verification only if user authorizes it.

## Current context

The three new preferences are `showCheckoutSelector`, `showBranchSelector`, and `showInlineAccessMode`; they default to true in `packages/contracts/src/settings.ts` and have focused contract tests. General settings Display includes them and the preexisting `sidebarShowUsage`, with search and reset coverage. The hidden branch picker remains accessible via its shortcut without hiding the PR badge. Hidden checkout remains available through a contextual command palette action and its shortcut. The compact composer menu appears only when enabled and at least one actionable control overflows; its Access choices are shown only for overflowed inline Access. Focused tests and scoped typechecks pass. Browser/e2e verification was not authorized.
