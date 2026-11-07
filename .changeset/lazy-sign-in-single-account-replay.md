---
"@mcpjam/inspector": patch
"@mcpjam/sdk": patch
---

Chat now runs a paused tool call again after a mid-session sign-in when the server has only one saved login. Before, the call was dropped with "signed in with a different account" for both 401 and `_meta["mcp/www_authenticate"]` challenges, because a single login carried no connection ID for the resume check. The SDK's `McpToolConnection` gains an optional `implicit` flag for a host-grouped only login.
