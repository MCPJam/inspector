---
"@mcpjam/sdk": minor
"@mcpjam/inspector": minor
---

Decide MCP Events support from each client's saved host config instead of a per-subscription profile. The Events tab subscribes as a chosen client and offers only the delivery modes that client, the event and the runtime all support; the host editor gains an Event delivery setting; and trigger runs connect as the subscription's client. The SDK exports `subscribableModes` and the `com.mcpjam/events` helpers.
