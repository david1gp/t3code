# Context usage display

## Goal

Replace the enabled legacy context circle beside Send with context usage text between the workspace/Current checkout selector and branch selector below the web composer. Offer Simple (`27k`) and Detailed (`9.9% · 27k/272k`) presentation.

## Decisions

- Preserve `contextWindowMeterEnabled` and existing saved opt-in. Add a separate persisted simple/detailed preference, default detailed.
- Reuse context snapshot and token formatting. Preserve useful usage popover information with a text trigger if practical.
- Web and desktop share this change. Mobile has no existing meter and is outside scope. No provider or wire-protocol behavior changes.
- No browser use or dev servers without user permission. Run focused unit tests and targeted checks, not repository-wide checks.

## Tasks

1. Complete: Add display preference contract/default/patch, settings control and search wording, focused contract tests. Use existing libraries.
2. Complete: Pass context snapshot/preferences from ChatView to BranchToolbar; render text between workspace and branch selectors; remove composer circle and placeholder. Test formatting/meaningful logic with focused tests.
3. Complete: Independently review integrated changes and run relevant focused verification.

## Current context

The persisted preference is `contextWindowDisplayMode` with `simple` and `detailed` values, defaulting to `detailed`. Settings control is implemented.
Toolbar text now owns the existing usage popover; composer action-row meter and space reservation are removed.
Restore defaults resets the display mode. Detailed labels retain their natural width at normal sizes and truncate only when space is constrained.
BranchToolbar is mounted immediately after ChatComposer within ComposerSurface.Shell in ChatView. BranchToolbar.ContextStrip orders workspace controls, resting-controls host, then branch selector. ContextWindowMeter contains existing formatting and usage popover. Avoid unrelated refactors and do not commit this plan.
