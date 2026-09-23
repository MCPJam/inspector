---
"@mcpjam/sdk": minor
"@mcpjam/inspector": patch
---

Export `REGISTRATION_ENDPOINT_MISSING_NO_FALLBACK_CLIENT` from `@mcpjam/sdk/browser`, the message every OAuth state machine writes when an authorization server has no `registration_endpoint` and no pre-registered client is configured.

The inspector's OAuth debugger now keeps that failure out of its error reporting. It is the server under test not offering dynamic client registration, not an MCPJam fault; the toast still shows it.
