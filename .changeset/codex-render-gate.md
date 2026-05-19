---
"@mcpjam/inspector": patch
---

Chat / Tools / Trace replays / Playground / hosted chatbox: don't render widget iframes for hosts whose effective `clientCapabilities` (host config + per-server overrides) don't advertise the MCP UI extension per SEP-1865. The render gate now calls the same `resolveEffectiveClientCapabilities` function the connect path uses, so the renderer and `initialize` always evaluate the same blob. Codex (elicitation-only CLI) falls through to the plain tool-result row; SDK-default hosts (Claude, ChatGPT, Copilot, MCPJam) keep rendering widgets.

Behavioral notes:
- Server-level `clientCapabilities` overrides are now honored at render time. A server that re-advertises the UI extension renders widgets even when the host (e.g. Codex) strips it — server-level override beats host identity, matching `initialize`.
- SEP-1865 strictness: the helper now requires `extensions["io.modelcontextprotocol/ui"].mimeTypes` to include `text/html;profile=mcp-app`. Custom configs with bare `{ extensions: { [id]: {} } }` (no `mimeTypes` array) stop rendering widgets. SDK-default capability shapes are unaffected.
