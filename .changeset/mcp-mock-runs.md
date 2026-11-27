---
"@mcpjam/mcp": minor
---

Adds the mock test run tools: `open_mock_run`, `reset_mock_run` and `close_mock_run`. A run pins a version of a mock and gives the caller its own copy of that version's records at an MCP URL of its own. `call_server_tool` takes an `operationKey` that makes a write to a mock's records safe to retry.
