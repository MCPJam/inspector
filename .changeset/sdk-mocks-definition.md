---
"@mcpjam/sdk": minor
---

New entry `@mcpjam/sdk/mocks` for mock MCP servers. It exports the definition's types, `validateMockDefinition` (with the size, depth, node, pattern and `$ref` caps), `diffMockDefinitions` for a readable change list, `findUncallableInputs`, which refuses an input change that leaves the real tool impossible to call, and `buildMock`, which serves a real server's tools with the definition merged in as a `createMcpHandler` handler for the 2025 revisions and 2026-07-28. `@modelcontextprotocol/server` is now a dependency of the SDK rather than a dev dependency.
