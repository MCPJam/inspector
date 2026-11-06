---
"@mcpjam/sdk": patch
"@mcpjam/inspector": patch
---

AI SDK tools converted from MCP no longer send the model the whole raw `CallToolResult` when it has no images. The model gets `content` and `isError` without `_meta`, and without `structuredContent` when `content` already has text, so the payload is no longer sent twice. `structuredContent` is still sent when `content` has no text. The UI keeps the full result, and `projectMcpToolResultForModel` still returns `structuredContent` for plain tools so results forwarded to CLI agents stay valid against the tool's `outputSchema`.
