---
"@mcpjam/inspector": patch
"@mcpjam/sdk": patch
---

New event subscriptions from the Playground agent and Connect event pick their delivery mode in SEP-3415's order: webhook when the server can reach a receiver and signs MCPJam in (hosted, through the inbox; local, through a saved `https` receiver), then push, then poll. A local watch now streams instead of polling every second. Push streams honour the `heartbeatMs` the server grants on `notifications/events/active` and reconnect only after three silent intervals, so a server granting more than 30 s is no longer reconnected every minute.
