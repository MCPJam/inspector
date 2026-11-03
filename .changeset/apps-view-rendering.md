---
"@mcpjam/sdk": minor
"@mcpjam/inspector": patch
---

Add `mcpProfile.appsViewRendering` (`"whenDeclared"` by default, or `"always"`) for hosts that render MCP Apps without declaring `io.modelcontextprotocol/ui`. The Gemini and Mistral templates now send the empty capabilities those hosts send, with `"always"`, so a server that checks the declaration before linking UI falls back to text in the inspector as it does in those hosts. The client editor's MCP App support panel gains a switch for the declaration.
