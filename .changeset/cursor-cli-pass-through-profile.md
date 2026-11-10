---
"@mcpjam/sdk": patch
---

The Cursor CLI template and its bundled catalog row no longer filter App-only tools or pin a capability claim, client identity or protocol version, and their request timeout is 300 seconds instead of 10, so Cursor's own 60-second limit applies. Each of these settings kept a Cursor CLI client's MCP traffic off pass-through forwarding. The catalog row records the measured Cursor CLI handshake as probe evidence instead.
