---
"@mcpjam/sdk": minor
---

Enable automatic MCP protocol negotiation for unpinned HTTP connections. MCPJam now probes `server/discover` for modern servers and conservatively falls back to the legacy `initialize` handshake, while explicit protocol pins and stdio connections retain their existing behavior.

Fallback is deliberately conservative: definitive legacy signals **and anything unrecognized** (opaque `400`, `404`, `405`, `406`, `5xx`, `-32601`) fall back to the plain `initialize` handshake on the same connection, byte-equivalent to a 2025 client. Only two outcomes fail the connect: a network outage, and an HTTP probe timeout (on HTTP, silence from a deployed server indicates an outage rather than a legacy server).

OAuth protocol resolution changes for servers left on **Auto**. Auto is now stored as intent rather than baked into a concrete pin at save time, and resolves per flow from: explicit OAuth selection → explicit wire pin → freshly negotiated version → `2025-11-25` when a `401` blocks detection. One consequence worth calling out: an Auto server pinned to an older wire version (for example `2025-06-18`) now runs **that** version's OAuth flow, where it previously always ran `2025-11-25`. Tokens are re-obtained from the top on each login, so no stored credential needs migrating.
