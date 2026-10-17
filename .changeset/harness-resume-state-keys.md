---
"@mcpjam/inspector": patch
---

Keep a hosted Codex approval when the client's MCP servers have tool schemas using `$schema`, `$ref` or `$defs`: the paused turn's state is now saved, so approving no longer fails with "The session for this approval is no longer available".
