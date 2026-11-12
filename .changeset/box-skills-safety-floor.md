---
"@mcpjam/inspector": patch
---

Skills MCPJam writes for Claude Code and Codex no longer carry their `allowed-tools` field, so a skill can't let its own tool calls skip approval, and the hosted app no longer adds skills an agent writes in its sandbox to your project.
