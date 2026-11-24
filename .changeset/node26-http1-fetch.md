---
"@mcpjam/sdk": patch
"@mcpjam/inspector": patch
---

On Node 26, MCP connections and conformance runs from the SDK, the CLI and the local Inspector use HTTP/1.1 by default, as they do on Node 24. Node 26's `fetch` switched to HTTP/2, where a request cancelled as it starts could crash the process about four seconds later with `socket idle timeout`, for example during a conformance run against a Python-SDK server. Other requests keep Node's default, and a `fetch` you pass in is used as given.
