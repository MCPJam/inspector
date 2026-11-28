---
"@mcpjam/sdk": patch
---

`open_mock_run` refuses a `platformRunId` longer than 200 characters before it sends the request, as the route does.
