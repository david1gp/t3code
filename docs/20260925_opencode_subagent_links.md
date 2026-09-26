# OpenCode subagent links

## Goal

Open an OpenCode child conversation from a subtle external-link icon below the agent duration in the web/desktop Agents panel.

## Decisions and approach

- Use the existing OpenCode connection URL and child session directory (falling back to the parent directory) to build `/<unpadded UTF-8 base64url directory>/session/<child session ID>`.
- Populate existing `runHandles.sessionUrl`; keep contracts and shared projection unchanged.
- Show the icon only when a session URL exists. Provide an accessible name and tooltip, “Open in OpenCode”, and use existing external navigation for web/desktop.
- Place the icon below, not beside, the duration. Use existing UI primitives and libraries.
- No mobile changes, new settings, transcript viewer, or browser testing without permission.

## Tasks

1. Complete: emit session URLs from OpenCode child linkage and add focused adapter tests.
2. Complete: render the duration-below icon in AgentsPanel.
3. Complete: review integrated diff and run focused checks only.

## Current context

OpenCode serves its frontend through a catch-all route. Existing runHandles propagation supports sessionUrl. Remote browsers must be able to reach the configured OpenCode address.
