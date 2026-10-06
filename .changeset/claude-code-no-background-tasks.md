---
"@mcpjam/inspector": patch
---

Claude Code harness turns now run subagents and slow commands in the foreground. A task sent to the background could never report back into the chat, and the next message then came back empty.
