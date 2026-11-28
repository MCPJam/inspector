---
"@mcpjam/sdk": minor
---

Adds test runs of a mock server: `open_mock_run` pins a version and gives the run its own copy of the version's records at an MCP URL of its own (it returns `runId`, `version`, `runUrl`, `epoch` and `expiresAt`; a run lasts 24 hours), `reset_mock_run` restores the saved records and returns the next epoch's URL, and `close_mock_run` ends access at once. The client has `openMockRun`, `resetMockRun` and `closeMockRun`. `call_server_tool` and `callServerTool` take an `operationKey` that makes a write to a mock's records safe to retry: the same key with the same call writes once.
