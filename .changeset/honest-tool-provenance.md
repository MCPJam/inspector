---
"@mcpjam/inspector": patch
"@mcpjam/evaluators": patch
---

Record whether each eval and chat trace tool span came from an MCP server, a native runtime tool, a built-in tool (skill tools included) or an unknown source, so readiness reports can tell an unrecognized tool from an invented MCP call.
