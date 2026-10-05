---
"@mcpjam/inspector": patch
---

Codex now runs on MCPJam's own app-server adapter everywhere, including hosted chats, evals and swarms, and the old `codex exec` integration is removed. Hosted Codex clients can turn Tool Approval on: each command and file change waits for Approve or Deny, and approved commands keep the same network and file access they have with approval off. Existing hosted Codex chats start a fresh runtime session on their next message, with a notice.
