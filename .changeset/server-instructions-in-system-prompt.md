---
"@mcpjam/inspector": patch
---

Playground chat, evals, goal runs and event turns now include the selected servers' instructions in the system prompt, in the same "MCP Server Instructions" layout Claude Code uses. Token counts and results can change for servers that send instructions, so measure an eval baseline again. Codex, OpenCode and clients set to run on MCPJam's MCP client get them in their instructions; a harness session whose servers send instructions starts fresh once.
