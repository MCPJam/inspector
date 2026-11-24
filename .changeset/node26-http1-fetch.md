---
"@mcpjam/sdk": patch
"@mcpjam/cli": patch
"@mcpjam/inspector": patch
---

On Node 26, the Inspector, the CLI and the SDK's MCP connections use HTTP/1.1, as they do on Node 24. Node 26's `fetch` switched to HTTP/2, where a request cancelled as it starts could crash the process about four seconds later with `socket idle timeout`, for example during a conformance run against a Python-SDK server.
