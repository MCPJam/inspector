---
"@mcpjam/inspector": patch
---

Claude Code harness turns can now wait for background agents and workflows to report back, so their answer lands in the same reply. While background tasks stay off, only workflows (which the CLI always runs in the background) use this. A Stop or a request deadline during that wait keeps the answer that was already delivered.
