---
"@mcpjam/inspector": patch
---

The Skills tab's "From MCP servers" section works in hosted mode, and Skills over MCP releases on its own schedule

Two changes to the same page, one of which the other depends on.

**"From MCP servers" was empty on every hosted project.** `server-skills-api.ts` hand-assembled its hosted request body as `{ serverId, projectId }` instead of going through `buildServerRequest`, the builder every other per-server hosted route uses. Two of the fields it skipped were load-bearing:

- **`clientCapabilities`.** Without it the ephemeral connection falls back to the SDK defaults, which deliberately omit `io.modelcontextprotocol/skills` (SEP-2133 makes extension support opt-in, and the bare SDK ships no fulfiller). So the connection never advertised the extension, `support.active` was false for every server, and the section — which renders nothing rather than an empty catalog, because "this host never asked" and "this server has no skills" are different facts — showed a header with nothing under it.
- **The resolved server id.** `serverId` travels to Convex `authorizeBatch`, which needs the `servers` table id. The display name fails argument validation there, before any MCP frame is sent, surfacing as `projectId or serverIds are invalid`.

Both are now supplied by the builder, along with the host's `clientInfo`, protocol pins and enterprise-auth policy — so a skills listing initializes on the same wire as every other hosted read of that connection, which is the point of a debugger.

**`skills-enabled` gated the whole tab; it now gates only the Cloud half.** Cloud Skills are an MCPJam feature whose authoring the backend gates separately, still rolling out. Skills over MCP is a different thing that shares the page: a protocol capability served by whatever the user connected, gated by mutual declaration, whose `/api/web/server-skills/*` routes carry no product flag. Redirecting `/skills` away on the Cloud flag held the protocol half hostage to an unrelated rollout. The flag is now passed down as `cloudSkillsEnabled`: with it off the tab renders, shows "From MCP servers", and hides the project store's tree, count, upload and refresh — and never calls the project-store API, which the backend would gate anyway.

Pre-hydration (`undefined`) is treated as off, so the page paints its protocol half immediately and the Cloud store appears when PostHog resolves. Local mode reads a real filesystem and carries no such gate, so `cloudSkillsEnabled` defaults to true and nothing there changes.
