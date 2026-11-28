---
"@mcpjam/sdk": patch
---

`open_mock_run` refuses a `platformRunId` longer than 200 characters once trimmed, before it sends the request, as the route does.
