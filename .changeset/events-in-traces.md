---
"@mcpjam/inspector": patch
"@mcpjam/sdk": patch
"@mcpjam/cli": patch
---

A chat session's trace now names the MCP event that started each event turn: `GET /v1/chat-sessions/:id/trace`, `getChatSessionTrace` in the SDK, `get_chat_session_trace` and `mcpjam cloud sessions trace` return an `event` on that turn with its name, id, delivery mode, origin and when MCPJam received it. Trace destinations accept a new `event` source type for background trigger runs, which you can turn on or off in the destination settings, the v1 API, the SDK and `mcpjam cloud trace-destinations --source event`.
