# Chat footer metrics fallback

## Goal

In the web UI (including desktop's web view), keep thread cost and context size accessible in the chat composer footer when the separate context strip below the composer is not visible. Respect metric availability and web Display preferences.

## Decisions

- Use `showComposerContextStrip`, not strip mount state, to select the fallback. The strip can be mounted invisibly for measurement.
- Context size follows the existing context-meter enablement and display mode in either location; no new context preference.
- Add independent Display preferences for thread cost in the lower context strip and in the composer fallback. Both default on: the former preserves existing behavior, while the latter makes the requested fallback available. A reported cost is still required.
- The composer fallback is only eligible while the lower context strip is hidden; an off strip-cost preference does not move cost into the composer while the strip itself remains visible.
- Reuse existing cost formatting and `ContextWindowMeter`; do not change usage accounting, provider behavior, or mobile's separate UI.
- Keep the footer compact/responsive and do not duplicate metrics across the two locations.

## Tasks

1. **Settings** — Add the two persisted cost visibility booleans to client settings schema/patch and Display settings UI, with focused schema tests. Default both to true. Status: complete.
2. **Web placement** — Pass already-derived cost/context data and actual strip visibility from ChatView into ChatComposer. Gate cost in BranchToolbar by its strip preference; show cost and context meter in ChatComposer footer only when the strip is hidden, subject to their respective preferences and data gates. Status: complete.
3. **Verification** — Review fallback versus strip, missing cost/context and disabled preferences; add meaningful focused coverage where supported by existing tests, and run targeted tests/typecheck/lint only. No browser/computer use without permission. Status: complete.
