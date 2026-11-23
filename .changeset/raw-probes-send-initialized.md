---
"@mcpjam/sdk": patch
---

The protocol checks that open their own 2025-era session now send `notifications/initialized` right after `initialize`, as a client must, before any other request. A server that refuses requests until that notification arrives used to be failed by Invalid Method Error for a refusal MCPJam caused. Notification POST Accepted grades the notification the handshake sent, so it still goes out once per session.
