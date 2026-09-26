# Agent sidebar virtual cost

## Goal

Show an OpenCode subagent's API-equivalent USD cost beside its model, token, and tool counts in the Agents panel. This is not subscription spend.

## Decisions

- Scope is individual agent rows in `AgentsPanel`, not main thread rows or workflow/footer totals.
- Use OpenCode `step-finish` part costs from each child session; do not reuse parent turn costs or infer dollars from aggregate token counts.
- Deduplicate repeated part updates by part ID per child session, treat missing/invalid costs as unavailable rather than zero, and preserve the existing child/parent usage separation.
- Add optional cumulative `costUsd` to task typed usage and client normalization. Existing providers without cost continue to display no cost.
- Format USD using the existing reported-cost formatter, with a concise indication that it is an estimate rather than subscription charges.

## Tasks

1. [x] Extend the task usage contract and OpenCode child-session accounting/emission for cumulative valid per-step cost, with focused adapter tests for duplicates, missing cost, and lifecycle.
2. [x] Propagate optional cost through the client-runtime subagent usage fold and max merge, with focused tests.
3. [x] Render optional cost in the Agents panel metadata line using existing USD formatting; verify focused scope and relevant type/lint checks.

## Current context

OpenCode child sessions emit optional complete finite cost on successful completion, without altering token/tool progress. Client usage preserves optional cost across snapshots. The Agents panel row displays optional `API est.` cost with precise small-amount formatting. Focused adapter, client-runtime, and formatter tests and targeted web/client/contracts checks pass; the server typecheck remains blocked by unrelated existing script errors.
