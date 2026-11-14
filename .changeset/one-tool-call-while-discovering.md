---
"@mcpjam/inspector": patch
"@mcpjam/sdk": minor
---

With progressive tool discovery, a step that offers only `search_mcp_tools` and `load_mcp_tools` now asks the model for one tool call, so it loads a tool before calling it instead of sending both in one reply. A call to a tool that is not loaded yet now shows a plain sentence telling the model to call it in its next reply, instead of the backend's raw error JSON. The `load_mcp_tools` description says the same. The SDK exports `offersOnlyMetaTools`, `singleToolCallProviderOptions` and `notLoadedToolMessage`.
