# OpenCode subagent integration

## Goal

Give OpenCode child sessions the existing structured Agents view used by Codex and Claude, without a new UI or changes to parent conversation content.

## Decisions and approach

- Reuse existing provider `task.*` events and shared client-runtime subagent state.
- Use native child session IDs and parentID ancestry for stable identities and nested relationships.
- Normalize child lifecycle, tool progress, metadata, and available usage. Keep child usage separate from parent totals and child text out of the parent transcript.
- Respect resumed sessions, duplicate events, errors, and session/turn cleanup using existing adapter patterns.
- Use existing dependencies; do not introduce polling or new libraries unless native events prove insufficient.
- Web and desktop consume existing task presentation; mobile retains its existing shared-runtime capabilities. No client redesign or contract expansion is intended.
- No browsers or dev servers are authorized. Run only focused tests and targeted checks.

## Tasks

1. Implement child-session task normalization and focused regression tests in OpenCodeAdapter and its tests. Status: completed.
2. Independently review event semantics and shared-consumer compatibility; address concrete defects and run focused verification. Status: completed.

## Current context

OpenCodeAdapter maps native child session ancestry, lifecycle, tool progress, and completed-message usage into task events, including early child events and resumed sessions. Terminal tasks restart only on explicit busy/retry, child events retain originating turns, and rollback clears child tracking. Parent transcript and usage remain isolated. Changes are limited to the adapter and its tests. Web/desktop reuse the existing Agents view; mobile reuses its existing task activity presentation without a new panel. Implementation and independent review are complete. Keep this plan uncommitted.
