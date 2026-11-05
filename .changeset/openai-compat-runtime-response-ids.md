---
"@mcpjam/sdk": patch
---

MCP Apps widgets rendered with `window.openai` injected no longer log "Received a response for an unknown message ID". Requests from the `window.openai` runtime now use string ids prefixed `openai-compat:` instead of numbers, so a host that embeds the runtime and assumes numeric JSON-RPC ids needs to accept strings. The runtime keeps the host's replies to its requests away from the widget's MCP Apps client.
