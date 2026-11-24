---
"@mcpjam/cli": minor
"@mcpjam/sdk": minor
"@mcpjam/inspector": minor
---

Remove description experiments: the `evals description-experiment` commands, their operations and MCP tools, the experiment card, and the `DescriptionExperiment*` exports of `@mcpjam/sdk/contract`. They only ever ran behind a staff flag. To compare a rewritten tool description, edit it on a mock server and run a climb. `HostRunner` and `MCPClientManager.getToolsForAiSdk` keep their `toolDescriptionOverrides` option.
