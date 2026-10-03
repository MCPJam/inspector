---
"@mcpjam/inspector": patch
"@mcpjam/sdk": patch
---

Report an HTTP error status from the user's MCP server (a 404 at the wrong endpoint path, a 405, the server's own 500) as a 424 `UPSTREAM_HTTP_ERROR` that names the status, instead of a masked hosted 500. The SDK error describer classifies these as `server/http_error`.
