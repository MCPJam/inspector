---
"@mcpjam/sdk": minor
"@mcpjam/inspector": patch
---

Export `REGISTRATION_ENDPOINT_MISSING_NO_FALLBACK_CLIENT` and `REGISTRATION_ENDPOINT_MISSING_STRICT_CONFORMANCE` from `@mcpjam/sdk/browser`, the messages every OAuth state machine writes when an authorization server has no `registration_endpoint` (with no pre-registered client configured, or under strict conformance).

The inspector's OAuth debugger now keeps those failures out of its error reporting. It is the server under test not offering dynamic client registration, not an MCPJam fault; the toast still shows it.
