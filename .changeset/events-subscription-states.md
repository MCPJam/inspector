---
"@mcpjam/inspector": patch
"@mcpjam/sdk": patch
---

The Events tab says why the server ended a subscription (event type removed, schema changed, access revoked), shows when webhook delivery is suspended or throttled, says when a server can't replay, labels ending a subscription Unsubscribe, Stop polling or Close stream, and reads the event types again when the server sends `notifications/events/list_changed`. Hosted subscriptions now use MCPJam (built-in) and local ones use the active client, so the "Receive as" picker is gone. The SDK's browser entry exports `classifyEventsRpcError`.
