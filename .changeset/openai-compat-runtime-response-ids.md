---
"@mcpjam/sdk": patch
---

MCP Apps widgets rendered with `window.openai` injected no longer log "Received a response for an unknown message ID". The `window.openai` runtime now uses its own request ids and keeps the host's replies to its requests away from the widget's MCP Apps client.
