---
"@mcpjam/sdk": patch
---

A Platform API client built with a `launcher` now names that client on every request in an `x-mcpjam-client` header, used only for usage analytics. Launch headers are still sent only on calls that start a run.
