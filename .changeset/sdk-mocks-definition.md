---
"@mcpjam/sdk": minor
---

New entry `@mcpjam/sdk/mocks` with the definition of a mock MCP server: its types, `validateMockDefinition` (with the size, depth, node, pattern and `$ref` caps), `diffMockDefinitions` for a readable change list between two definitions, and `findUncallableInputs`, which refuses an input change that leaves the real tool impossible to call. `@modelcontextprotocol/server` is now a dependency of the SDK rather than a dev dependency.
