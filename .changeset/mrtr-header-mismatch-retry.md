---
"@mcpjam/sdk": patch
"@mcpjam/inspector": patch
---

When a modern (2026-07-28) server refuses a tool call with `-32020` (HeaderMismatch), the client now lists the tools again, rebuilds the `Mcp-Param-*` headers from the fresh `x-mcp-header` marks, and sends the call once more, as the spec says a client SHOULD. This covers the multi-round-trip (MRTR) path, which every inspector tool call takes, and the hosted resume step. Before, these calls failed with the `-32020`. The client does not send again when header mirroring is turned off (`mirrorToolParamHeaders: false`), when the caller set its own `Mcp-Param-*` header, or when the fresh list gives the same headers. `MCPClientManager.mrtrToolParamHeadersAfterMismatch` gives surfaces that send a step themselves the same decision.
