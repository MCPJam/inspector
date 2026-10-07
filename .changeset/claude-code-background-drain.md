---
"@mcpjam/inspector": patch
---

Claude Code harness turns that run without approvals now support background agents again: the turn waits for them to report back, so their answer lands in the same reply instead of being lost. Turns that pause for approvals keep background tasks off and run subagents in the foreground. A Stop or a request deadline during that wait keeps the answer that was already delivered, and a background task stopped by an earlier turn no longer leaves the next reply empty.
