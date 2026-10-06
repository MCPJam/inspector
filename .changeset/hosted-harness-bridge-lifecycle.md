---
"@mcpjam/inspector": patch
---

Hosted Claude Code and Codex chats no longer stall for two minutes on a follow-up message. The agent's bridge on the computer was being stopped a minute after it started, so every later turn waited out a reconnect timeout before starting over. Bridges now stay up, each on a port of its own, so a chat waiting on an approval keeps its paused turn while other chats run on the same computer; bridges nothing will use again are stopped, and a resumed turn picks the conversation back up directly.
