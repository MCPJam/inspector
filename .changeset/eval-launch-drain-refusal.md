---
"@mcpjam/inspector": patch
---

An eval launch that reaches a server in the middle of restarting is refused with a retryable `429` (`RATE_LIMITED`, reason `SERVER_DRAINING`, `Retry-After`) instead of starting a run the shutdown would cut short.
