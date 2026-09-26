# Composer display options

## Goal

- When **Show inline access mode** is off, do not expose Access through the compact composer menu. Hide the ellipsis if there are no other overflowed controls.
- Add a separate web Display preference to hide the composer ellipsis unconditionally, even when other controls overflow. Keep current behavior by default.

## Decisions

- These are client-local preferences for web and desktop; mobile's separate composer is unchanged.
- Keep the existing inline-access preference and default. Access is omitted from the compact menu when it is off; overflowed provider traits and Chat/Plan controls remain in that menu when the new ellipsis preference is on.
- The new preference defaults to showing the compact composer menu. When off, intentionally leave overflowed controls inaccessible through that menu; do not change layout/overflow placement or add a substitute entry point.
- Do not change runtime-mode selection, stored mode, or unrelated keybindings. A hidden access control must not be reopened by the composer shortcut.
- Preserve composer-controls-hidden precedence. Do not touch unrelated in-progress edits.

## Tasks

1. [x] Add a default-on client setting for the compact composer menu, its web Display switch/reset/search entry, and focused settings/search tests.
2. [x] Wire the preference into the web composer, remove Access from compact menu when inline access is off, and hide ellipsis when the new preference is off or no remaining controls need it. Add focused behavior tests, including overflow and hidden-controls cases; verify composer shortcut does not reopen hidden access.
3. [x] Run targeted tests and scoped typechecks/lint for touched areas. No browser/e2e work without explicit authorization.

## Current context

- Existing inline-access option lives in `packages/contracts/src/settings.ts` and `apps/web/src/components/settings/SettingsPanels.tsx` and reaches `ChatComposer` via `ChatView`.
- `CompactComposerControlsMenu` currently always renders Access, and `shouldShowCompactComposerControlsMenu` shows ellipsis solely when inline Access is hidden. Overflowed provider traits and Chat/Plan may also live there.
- The old `docs/20260925_web-display-options.md` describes Access remaining available through the menu; revise that superseded statement so plans agree.
- A pre-existing modification to `apps/web/src/components/Sidebar.tsx` is out of scope.
- `showCompactComposerMenu` is now present in the client settings and web Display/search UI; focused settings/search tests and scoped contracts/web typechecks passed.
- Composer overflow visibility requires an actionable control; Access and shortcut metadata are conditional. Focused settings and composer tests, scoped contracts/web typechecks, targeted lint, and diff checks pass. No browser/e2e verification was authorized.
