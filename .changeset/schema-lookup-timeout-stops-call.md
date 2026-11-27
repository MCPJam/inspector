---
"@mcpjam/sdk": patch
---

`MCPClientManager` no longer sends a modern `tools/call` after the `tools/list` that reads the tool's schema times out, is cancelled, or loses its connection: `executeTool` throws that error instead, and so do `mrtrToolParamHeaders` and `mrtrToolParamHeadersAfterMismatch`. When the server answers that `tools/list` with a JSON-RPC error, `-32000` and `-32001` included, the call still goes out, as for any other lookup miss.
