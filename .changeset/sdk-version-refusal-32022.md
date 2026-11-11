---
"@mcpjam/sdk": patch
"@mcpjam/inspector": patch
---

A connection pinned to an older MCP protocol version now reports "this server doesn't support that version" when a 2026-07-28 server refuses it with JSON-RPC -32022, instead of trying the SSE fallback and showing a raw "HTTP 400, then HTTP 405" error.
