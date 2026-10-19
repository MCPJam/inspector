---
"@mcpjam/inspector": patch
---

An eval launch that reaches a server in the middle of restarting is refused with a retryable `429` (`RATE_LIMITED`, reason `SERVER_DRAINING`, `Retry-After`) instead of starting a run the shutdown would cut short. Nothing retries it for you yet: the SDK and CLI report it as an error, so a caller that must ride out a deploy, such as `mcpjam eval run` in CI, retries the launch itself. That is safe, because the refusal comes before anything is written.
