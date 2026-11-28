---
"@mcpjam/sdk": minor
---

`@mcpjam/sdk/mocks` now exports `buildMock`, which serves a mock MCP server for one request from a definition and a real-server interface. A tool call answers from a matching saved answer, or is forwarded to the real tool after the host's `authorizeForward` allows it; a blocked or unmatched call returns an error that says why. The optional observer reports each call's source (saved, forwarded, blocked or unmatched) and the real tool of a forward. A saved result is checked against the tool's output schema, and a mock of a server with no tools advertises none.
