---
"@mcpjam/inspector": patch
---

On a local Inspector, the Set up run sheet now says where each harness client runs before Start ("Runs on this machine · Claude Code"). A client that can't run here shows why and its fix: Set up (the same one-click setup Add client runs), Retry, or another client. Start stays off until every client can run. A suite whose code evaluators or scripts need cloud sandboxes now says so in the sheet with Open on MCPJam, and the pinned-image notice on the suite page links there too. A run that never started headlines "Run didn't start" with its reason instead of "Connection error".
