---
"@mcpjam/inspector": patch
---

Harness chats now show their work the way a coding agent does: runs of commands, reads, edits and searches fold into one "Ran 2 commands, read 3 files" row that names the step in progress, Codex's plan appears as a live checklist, and a running Codex command shows its output as it prints. Each built-in tool card now says what it did ("bash  Run npm test"), so an opened row goes straight to those cards, and an approval shows the exact command or file it will act on. A failed command's card now settles as failed instead of looking like it is still running.
