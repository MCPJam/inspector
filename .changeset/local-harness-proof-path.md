---
"@mcpjam/inspector": patch
---

Local Claude Code now completes real model calls: the local model gateway signs the request path the MCPJam broker actually verifies, instead of the full proxy path that every broker request rejected with "Invalid proof of possession". Approval requests from local and cloud harness runs now carry their tool call id, so the Approve / Deny row renders instead of "No tool invocation found".

Denying a harness tool approval no longer re-sends the decision and fails with "The local session for this approval is no longer available"; the denied call is closed in the chat. A message sent after stopping an approved command now continues the conversation instead of failing with "Lifecycle state has unexpected type 'continue-turn'".

A harness chat that pauses for a tool approval is now saved to chat history, as emulated chats are, so a reload no longer finds it missing and the "This reply couldn't be saved" notice no longer appears for it.
