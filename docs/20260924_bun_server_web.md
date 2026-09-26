# Bun server/web production build

## Goal

Use Bun for dependency installation, production build orchestration, and Node-targeted server bundling. Keep Node as the production server runtime and Vite with the existing plugins for the web app.

## Scope and decisions

- Build only web, server, and required shared dependencies/assets. Do not build desktop, mobile, or marketing.
- Make Bun the default dependency-manager entry point while preserving existing dependency versions, patches, overrides, and necessary native install scripts.
- Preserve unrelated workspace source and existing tooling paths unless a change is necessary for the selected build path. Do not migrate tests or the standalone executable/release workflow.
- Preserve server output layout, runtime external dependencies, worker entry points, frontend copying, and branding behavior.
- Do not deploy, change running services, touch live state, or use a browser.
- Prefer installed dependencies and existing libraries. Preserve unrelated changes.

## Tasks

1. Migrate dependency metadata/install entry point to Bun and verify installation. Status: completed.
2. Implement Node-targeted Bun server bundling and Bun-orchestrated web/server-only production build using Vite frontend plugins. Status: completed.
3. Verify focused build behavior and Node production startup/static serving with isolated temporary state; inspect external dependency requirements and document exact build/run commands. Status: completed.

## Verification

Use focused checks only, not repo-wide tests/typechecks. Run the actual web/server build. Test build-specific logic where meaningful. Exercise the built server through HTTP and Node CLI against isolated temporary state, without browser automation. Do not claim an rsync-ready standalone artifact unless its external dependencies and required helper assets are actually staged and verified.

## Current context

Bun workspace metadata and bun.lock provide the explicit Bun install path. The packageManager pnpm field remains for unrelated VP/release consumers; pnpm-only policy stays in its original configuration. The server production start command must remain Node-based. The separate Node SEA executable packaging is outside this task.
The selected production entry point is bun run build:server-web. It uses the installed Vite JavaScript API for frontend build and Bun for Node-targeted backend bundling, leaving unrelated build workflows intact.
The output requires installed runtime dependencies; dist alone is not a standalone deployment archive. Source installation guidance contains the selected build/run commands. Deployment packaging remains outside this build-only change.
