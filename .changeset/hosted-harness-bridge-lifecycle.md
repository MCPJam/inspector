---
"@mcpjam/inspector": patch
---

Hosted Claude Code and Codex chats no longer stall for two minutes on a follow-up message. The agent's bridge on the computer was being stopped a minute after it started, so every later turn waited out a reconnect timeout before starting over; the bridge now stays up, a new chat on the same computer replaces it cleanly, and a resumed turn picks the conversation back up directly.
