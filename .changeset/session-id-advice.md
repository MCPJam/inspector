---
"@mcpjam/sdk": patch
---

A 2026-07-28 server that sends an `Mcp-Session-Id` header no longer fails `modern-no-session-id`. That revision only says a server SHOULD not mint or echo session ids, so it is reported by a new piece of advice, No Session Id (`readiness-no-session-id`, 2026-07-28 only), which costs no points. The check is renamed "Sessionless Exchange" and lists the session ids it saw in its details. It no longer marks the "No sessions" server feature: a pass does not show it any more, and that row keeps its own probe.
