---
"@mcpjam/sdk": patch
---

Logs Require A Log Level (`modern-logs-require-log-level`) now passes a `logProbe` tool that sends no logs when asked for them. On 2026-07-28 the server "MAY send" log notifications once a level is requested, so sending none is allowed. A log on a request without a level still fails. The `readiness-log-level-filtering` advice still reports a silent tool, at no cost. Because a server that never logs now passes, this check is no longer evidence for the logging features on the server-features page.
