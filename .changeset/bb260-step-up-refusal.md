---
"@mcpjam/sdk": patch
---

Claude readiness's step-up check now fails a protected tool that refuses the call with a 2xx error instead of a 403 `insufficient_scope` challenge, rather than reading it as already authorized.
