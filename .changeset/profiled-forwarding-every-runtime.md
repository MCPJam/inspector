---
"@mcpjam/inspector": patch
---

GitHub Copilot CLI and Cursor CLI clients now take MCPJam's profiled bridge when native forwarding admits it, as Claude Code and Codex already do, instead of keeping their proxy route. On that bridge, MCPJam's own tool-call correlation key no longer reaches the server.
