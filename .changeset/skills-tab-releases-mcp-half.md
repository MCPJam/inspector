---
"@mcpjam/inspector": patch
---

The Skills tab addresses hosted servers by id, and releases its Skills-over-MCP half on its own schedule

Two changes to the same page, one of which the other depends on.

**"From MCP servers" could never work in hosted mode.** The route built its server list keyed by the user-assigned NAME and passed that as `serverId`. Locally that is right — the manager registers connections under their name. Hosted, the same field travels to Convex `authorizeBatch`, which needs the `servers` table id; a name fails argument validation there, before any MCP frame is sent, and the section rendered the backend's `projectId or serverIds are invalid` for every server on every project. It now resolves the id through `useProjectServers`, keeps the name as the display label — a server must never choose the namespace its skills are addressed under — and DROPS a connection with no saved project server behind it rather than sending a name that can only 400.

**`skills-enabled` gated the whole tab; it now gates only the Cloud half.** Cloud Skills are an MCPJam feature whose authoring the backend gates separately, and they are still rolling out. Skills over MCP is a different thing that happens to share the page: a protocol capability served by whatever the user connected, gated by mutual declaration, whose `/api/web/server-skills/*` routes carry no product flag. Redirecting `/skills` away on the Cloud flag held the protocol half hostage to an unrelated rollout. The flag is now passed down as `cloudSkillsEnabled`: with it off the tab renders, shows "From MCP servers", and hides the project store's tree, count, upload and refresh — and never calls the project-store API, which the backend would gate anyway.

Pre-hydration (`undefined`) is treated as off, so the page paints its protocol half immediately and the Cloud store appears when PostHog resolves. Local mode reads a real filesystem and carries no such gate, so `cloudSkillsEnabled` defaults to true and nothing there changes.
