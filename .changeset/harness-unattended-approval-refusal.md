---
"@mcpjam/inspector": patch
---

Evals and swarms on a Claude Code or Codex client with Tool Approval on are now refused up front with a clear reason, instead of failing at the first tool call or stalling silently, since nobody is there to approve. Chats whose saved harness session no longer matches the client's runtime (model, servers, skills, approval setting or transport) now show a "Started a new session" notice instead of silently losing earlier context.
