---
"@mcpjam/inspector": patch
---

Hosted harness chats keep a GitHub Copilot CLI or Codex conversation when the chat's computer is replaced, as they already do for Claude Code: the agent resumes with its conversation, and is told that files, tools and shell state from earlier turns are gone. Each runtime now declares which of its files hold the conversation, and only those are saved.
