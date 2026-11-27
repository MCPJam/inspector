---
"@mcpjam/inspector": patch
"@mcpjam/sdk": patch
"@mcpjam/cli": patch
---

A chat session's trace now names the MCP event that started each event turn: `GET /v1/chat-sessions/:id/trace`, `getChatSessionTrace` in the SDK, `get_chat_session_trace` and `mcpjam cloud sessions trace` return an `event` on that turn with its name, id, delivery mode, origin and when MCPJam received it. Trace destinations accept a new `event` source type that selects background trigger runs, which you can turn on or off in the destination settings, the v1 API, the SDK and `mcpjam cloud trace-destinations --source event`. Until background trigger runs export under their own source type, a server-side rollout, they still match `direct`. In the Inspector's trace timeline, the prompt row of a turn an event started reads `Event: <name>`, with a `Test` badge for a test event, and selecting it shows when the event occurred, when MCPJam received it and when the turn started, with the event's ids to copy. This holds for live Playground turns, reopened conversations, background trigger runs and Sessions detail.
