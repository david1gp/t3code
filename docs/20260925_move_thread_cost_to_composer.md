# Move thread cost to composer strip

## Goal

Show the existing reported thread total below chat in the composer context strip, between the checkout label (for example, “Local checkout”) and the context-window count (for example, “25k”), before the branch label (for example, “main”). Remove the total from above the message timeline.

## Decisions

- Web and desktop share this composer UI. The separate React Native UI is outside this positional change.
- Keep the existing cost derivation, formatting, and visibility: show zero if reported; hide when total is null. Do not tie visibility to the context-window meter setting.
- Keep the change local to the existing `ChatView`/`BranchToolbar` connection and avoid unrelated layout changes.

## Tasks

1. [completed] Pass the reported total from `ChatView` into `BranchToolbar`, render it after the checkout label and before the context-window meter, and remove its old timeline placement. Preserve responsive label behavior.
2. [completed] Run focused checks for changed web code and inspect the resulting diff. No browser/e2e verification unless the user grants permission.

## Current context

The two web components pass and render the formatted total in the context strip. Focused tests, targeted lint, web typecheck, and diff whitespace checks passed. Browser verification with isolated fixture confirmed checkout → $0.75 → context → branch at desktop and narrow widths; the previous total row above the timeline is gone. Explicit zero remains visible and missing cost remains hidden.
