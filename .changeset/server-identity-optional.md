---
"@mcpjam/sdk": patch
---

Modern Client Handshake (`modern-client-handshake`) no longer fails a 2026-07-28 server that sends no `io.modelcontextprotocol/serverInfo`. The spec says servers SHOULD include it and types the field optional, so leaving it out breaks no MUST. A run against such a server went from failed to passed. The missing identity is now reported by a new piece of advice, Server Identity (`readiness-server-identity`, 2026-07-28 only), which costs no points. A malformed identity still fails Server Discover.

On a 2026-07-28 pin, an internal error from `server/discover` or invalid required discovery fields now fail the discovery checks. Reports include the original JSON-RPC error when the server sends one.
