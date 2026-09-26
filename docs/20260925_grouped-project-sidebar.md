# Grouped-project sidebar refinement

## Goal

When “Group threads by project” is enabled, show compact, unindented thread rows beneath collapsible project headers, with no empty project groups or category headings. Preserve the separate Settled shelf. Make the drag/drop behavior match the visible ordering and verify the result in a browser using a safe copy of machine data or representative local examples.

## Decisions

- Project headers use the Settled shelf’s visual language: label, a rule filling the remaining horizontal space, and a collapse chevron; no project count.
- Each nonempty project shows all non-settled threads in one continuous list, including pinned, active, and snoozed threads. Do not show Pinned/Active/Snoozed headings, project-local preview limits, Show more, or Drop to settle.
- Drops can reorder anywhere within the same project. Crossing the pinned/unpinned boundary changes pin status; explicit row actions still settle threads. Do not let a drop silently move a thread to another project.
- Grouped rows omit repeated project icon/name and place the thread time beside the thread title at the right. Ungrouped rows retain their current identity and layout.
- Hide project groups with zero non-settled threads. Settled threads remain in the bottom Settled collapsible and search remains available.
- Keep the change scoped to the grouped web sidebar (which desktop hosts), with no wire or mobile changes unless exploration reveals shared dependencies.

## Tasks

1. Capture the current grouped sidebar in a real browser with isolated copied machine data or representative local examples; add a before screenshot below. Status: complete.
2. Implement unified project list composition, visibility, ordering and same-project drag/drop; add focused logic tests. Status: complete.
3. Refine project headers and compact grouped rows; remove grouped-only labels, preview and drop placeholder. Status: complete.
4. Run targeted checks and integrated browser verification of layout, collapsed/empty groups, drag/reorder, pin transitions and Settled access; capture an after screenshot. Status: complete.

## Screenshots

- Before: ![Grouped project sidebar before](screenshots/20260925_grouped-project-before.png).
- After: ![Grouped project sidebar after](screenshots/20260925_grouped-project-after.png).
