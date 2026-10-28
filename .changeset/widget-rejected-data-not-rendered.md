---
"@mcpjam/inspector": patch
---

An MCP App eval no longer counts a widget as rendered when it painted but rejected its tool result, or when the result could not be sent to it. The render records "Render error" with the reason, such as a tool result that does not match the MCP Apps tool result format.
