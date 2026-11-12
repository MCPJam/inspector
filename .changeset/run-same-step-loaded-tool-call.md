---
"@mcpjam/inspector": patch
"@mcpjam/sdk": patch
---

When a model loads a tool with `load_mcp_tools` and calls it in the same step, the call now runs if its input fits the tool's schema, instead of failing with an unavailable-tool error. This covers MCPJam-hosted models and bring-your-own-key models alike. The SDK exports `toolIdLoadedEarlierInStep` for this check.
