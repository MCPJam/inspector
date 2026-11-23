---
"@mcpjam/sdk": patch
---

Keep retrying a failed Events webhook refresh before `refreshBefore` instead of letting the backoff schedule the next attempt after the grant expires.
