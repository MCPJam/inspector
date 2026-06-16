---
"@mcpjam/inspector": patch
---

Preserve `structuredContent` for MCP App widgets on the shared chat path used by
both the Playground and the agent surface (`streamWebChatTurn` →
`handleMCPJamFreeChatModel`). MCP App tools scrub `structuredContent` from their
model-facing output via `toModelOutput`; the shared pipeline previously carried
only that scrubbed copy, so widgets reading `toolResult.structuredContent`
received nothing ("Missing structured content").

`executeToolCallsFromMessages` now stamps the raw, unscrubbed `result` on the
tool-result part whenever it carries `structuredContent` (UI hydration only —
the model copy stays scrubbed), and `emitToolResults` prefers that raw `result`
for the streamed UI output when present. The widget bridge receives a
spec-correct `CallToolResult` (SEP-1865) from the same shared renderer the
Playground already drives.
