---
"@mcpjam/inspector": patch
---

Local Claude Code now completes real model calls: the local model gateway signs the request path the MCPJam broker actually verifies, instead of the full proxy path that every broker request rejected with "Invalid proof of possession". Approval requests from local and cloud harness runs now carry their tool call id, so the Approve / Deny row renders instead of "No tool invocation found".
