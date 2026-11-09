---
"@mcpjam/inspector": patch
---

Hosted conformance runs started from the CLI, MCP or `/api/v1` now check the server's protocol version before the run starts, and leave out any suite with no saved checks for that version, as the app does, instead of ending that suite incomplete. A retry with the same idempotency key returns the run that key started, with its original suites and settings. The 30-starts-per-10-minutes limit is no longer spent by a refused request or a retry.
