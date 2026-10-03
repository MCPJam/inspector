---
"@mcpjam/inspector": patch
---

Hosted Connect now answers within 45 s of the request's arrival. A hung MCP server fails the check with "The MCP server did not respond in time" (424 `TIMEOUT`) before the Connect button gives up, instead of running on for minutes after the user was told it timed out.
