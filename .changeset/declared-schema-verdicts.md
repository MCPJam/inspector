---
"@mcpjam/inspector": patch
"@mcpjam/evaluators": patch
---

Fail declared output schema assertions when the MCP client rejects invalid or missing structured content. Declared output schema assertions also check the results of pinned tool calls, after the run and in assert steps, each against the schema its own server declared. Step assertions now read tool declarations and show Not applicable when there is nothing to check. Stored assertion errors display as Error in the scorecard and assertions list. Authored result schemas accept a JSON object, true, or false.
