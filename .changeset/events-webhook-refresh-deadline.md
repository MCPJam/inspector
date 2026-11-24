---
"@mcpjam/sdk": patch
---

Keep Events webhook refreshes before `refreshBefore`: a failed refresh is retried before the grant expires instead of after the backoff, and a grant shorter than 2 s is refreshed before it expires.
