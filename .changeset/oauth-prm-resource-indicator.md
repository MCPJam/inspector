---
"@mcpjam/sdk": patch
---

OAuth debugger: honor the PRM-advertised `resource` identifier in authorization and token requests (fixes #2119).

- The `resource` indicator sent to `/authorize` and `/token` now uses the identifier from the server's Protected Resource Metadata verbatim (it may be a URN), falling back to the server URL only when no PRM resource was discovered. Both requests are guaranteed to send an identical value.
- When the advertised identifier fails the strict origin/path-prefix validation that Quick OAuth and the official MCP SDK apply (RFC 9728 §3.3), the debug flow proceeds but logs a warning explaining that spec-strict clients will refuse to connect.
- Applies to the 2025-06-18 and 2025-11-25 debug state machines (debugger UI, `mcpjam oauth login`, conformance); the 2025-03-26 flow does not fetch PRM and is unchanged.
