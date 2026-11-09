---
"@mcpjam/inspector": patch
---

Cursor CLI chats keep their session from one turn to the next: the MCP configuration Cursor gets now stays the same for the whole chat, on the signed proxy as well as with forwarding.

Completed Cursor conversations also reopen from their saved session after the Cursor process exits, instead of reusing a dead connection. Pending approvals still require their original live session.
