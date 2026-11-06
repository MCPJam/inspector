---
"@mcpjam/inspector": patch
---

Return a retryable capacity response when an installation refuses a new eval run, without starting or charging a run.

Return existing eval runs on idempotent retries without starting another executor or reserving usage again.
