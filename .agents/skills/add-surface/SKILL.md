---
name: add-surface
description: Steps to add a new screen (app surface) to the MCPJam Inspector so the route table, agent wiring, launcher and feature map all know about it. Use before adding a route, a tab, or a page a user navigates to.
---

# Add a surface

A surface is a screen a user navigates to. Each one has a manifest in
`mcpjam-inspector/shared/app-surfaces.ts`, and several registries and tests
are checked against that list. Paths below are relative to `mcpjam-inspector/`.

## 1. Manifest

Add an entry to `APP_SURFACES` in `shared/app-surfaces.ts`. The comments on
`AppSurfaceManifest` describe each field. The ones that trip people up:

- `scope`: `"project"` keeps `canonicalPath` and `routePatterns` project-relative
  (`"servers"`, not `"/p/:projectId/servers"`).
- `canonicalPath` must be one of the surface's own `routePatterns`.
- `navSegments` must not be claimed by another surface.
- `agentTools` is required. New surfaces use `{ kind: "group" }` or
  `{ kind: "none", reason }` with a real reason of at least 20 characters.
  `"global"` is frozen to `servers` and `playground`.
- `hostedBlocked: true` only when the screen cannot work in hosted mode at all.

## 2. Route

- Add a `kind: "screen"` entry with the same `surfaceId` and `scope` to
  `client/src/lib/app-routes.ts`.
- Map that path to an element in `ROUTE_ELEMENTS` in `client/src/router.tsx`.
  Most screens render through a `*Route` function exported from
  `client/src/App.tsx`; the coverage check follows those to find the root
  component.
- Add the same arm to the no-router switch in `App.tsx` (the comment above it
  explains why the two must match).
- Add the canonical path to `routePaths` in `client/src/lib/app-navigation.ts`.
- If the path adds a new literal segment, add it to `APP_ROUTE_WORDS` in
  `shared/telemetry-privacy.ts`.
- Add each nav segment to `LAUNCHER_TABS` in `shared/launcher-tabs.ts`.
- If users reach it from the sidebar, add an item in
  `client/src/components/mcp-sidebar.tsx`.

## 3. Agent wiring

- `kind: "group"`: add a tool group to `SURFACE_TOOL_GROUPS`
  (`client/src/lib/webmcp/groups`), call `useSurfaceAgentBridge` with the
  literal `surfaceId` in the surface's own component, set
  `hasSnapshotProvider: true`, and add a row to `BRIDGE_MODULES` in
  `client/src/lib/__tests__/agent-bridge-modules.ts`.
- `kind: "none"` with a snapshot: same bridge call with only `snapshot`,
  `hasSnapshotProvider: true`, and a `BRIDGE_MODULES` row.

## 4. Test

`scripts/check-surface-test-coverage.mjs` fails when a surface has no test.
A surface counts as covered by any of:

- a Playwright spec under `e2e/` that calls `goto()` on one of its routes;
- a Vitest file in a `__tests__/` folder under `client/` or `shared/` that
  imports the surface's root component (the one its route renders) or a module
  only that surface reaches. Importing shared code such as `logger-view` or a
  store does not count, and neither does `vi.mock` of a module;
- a `// @surface <id>` comment line, only when the code cannot show the link.

Write a test of what the user sees on the screen, next to its neighbours in
`client/src/components/__tests__/`. `TracingTab.test.tsx` is a small example.
Do not add the surface to `scripts/surface-test-coverage-baseline.json`.

## 5. Check

From the repo root:

```bash
npm run check:surface-tests
npm run test -w @mcpjam/inspector -- client/src/lib/__tests__/app-surface-coverage.test.ts client/src/lib/__tests__/agent-tool-coverage.test.ts client/src/lib/__tests__/surface-snapshot-coverage.test.ts client/src/lib/__tests__/launcher-tabs.test.ts client/src/lib/__tests__/session-privacy.test.ts
npm run typecheck:client -w @mcpjam/inspector
```

Then open the new screen in
the running app with the `run-inspector` skill.
