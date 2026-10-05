---
"@mcpjam/inspector": patch
---

A Codex or Claude Code client's model picker, in the Playground and the client editor, now lists only models that harness can run, and no longer drops back to Claude Haiku: an unrunnable saved model falls back to the client's own model. The Playground also stops saving a placeholder model over your selection before it has loaded.
