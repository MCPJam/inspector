---
"@mcpjam/sdk": minor
---

`@mcpjam/sdk/plugin-bundle` exports two pure MCP-config shape primitives:
`selectPluginMcpServerMap` resolves which of the three compatible document
shapes a config uses (direct map, `mcp_servers`, `mcpServers`) and returns its
entries verbatim, and `detectPluginMcpTransport` classifies a single server
config as stdio or http.

Both are policy-free: they report what the shape says and apply none of the
plugin import path's stricter rules (HTTPS-only URLs, server-name format,
secret stripping), so a consumer with different policy — the inspector's
MCP-JSON import, which must keep plain-HTTP URLs and free-form server names
working — can share the shape and transport handling without inheriting them.
`normalizePluginMcpConfig` now delegates to both, so the strict path and every
other consumer can never drift.

A selection failure also carries a typed `reason` (`document-not-an-object` |
`duplicate-wrapper` | `bare-server-config` | `server-map-not-an-object`) so
callers can render their own guidance without matching on message text —
several of these share one persisted issue code.

Transport spelling is now normalized by folding away separators rather than
only underscores, so `streamable-http`, `streamable_http`, and
`streamableHttp` all classify as http. The MCP spec fixes the transport's name
but leaves the config spelling to each implementation, and all three appear in
the wild. This only ADDS accepted spellings; nothing that classified before
now fails.
