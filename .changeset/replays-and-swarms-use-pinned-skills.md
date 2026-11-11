---
"@mcpjam/inspector": patch
---

Replaying an eval run now runs it with the skills that run pinned, and stops before the first model call if one of them can't be read. Swarm sessions now load a target's pinned skills the way eval runs do: a plugin's skill by its plugin-qualified name, and an MCP server's skill with the server it came from. Eval runs whose skills predate plugins use the same skill tools as every other run.
