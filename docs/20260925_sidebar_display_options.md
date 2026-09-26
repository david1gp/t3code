# Sidebar display options

## Goal

Allow Pull Requests and Usage to be hidden independently from the web/desktop sidebar through existing sidebar display settings.

## Decisions

- Add client preferences `sidebarShowPullRequests` and `sidebarShowUsage`, both defaulting to true.
- Place separate switches alongside existing sidebar display switches in SettingsPanels' Organization section, following its update and reset conventions.
- Preserve existing Pull Requests capability gating. Preferences affect sidebar visibility only, not routes or feature availability.
- Desktop shares the web sidebar. Mobile has neither sidebar item and needs no navigation change.
- Use existing dependencies. Do not start dev servers or browsers. Do not commit this plan.

## Tasks

1. Completed: add schema preferences, settings switches, sidebar visibility checks, and focused regression tests. Run only relevant tests and targeted lint.
2. Completed: independently review changes and verification coverage for defaults, persistence, independent visibility, and capability gating.

## Current context

Implementation adds both preferences to shared client settings and the client patch schema, independent switches and resets, and sidebar item conditions. Focused preference tests cover persistence and patch decoding. Client preferences use shared schema-driven persistence.
