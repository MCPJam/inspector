---
"@mcpjam/inspector": patch
"@mcpjam/sdk": patch
---

Fix two hosted conformance-run bugs found live against an OAuth-protected server.

The protocol suite could never start from `runConformance`: the suite entry
spread the server config (which carries `url`) into `MCPConformanceConfig`
(which needs `serverUrl`), so normalization crashed with `Cannot read
properties of undefined (reading 'trim')` before dialing anything and the run
recorded a bare `protocol-could-not-run` skip. The HTTP fields are now mapped
explicitly, an absent `protocolVersion` keeps the default negotiation path,
and a missing `serverUrl` reports the clear configuration error instead of a
TypeError.

Finished suite reports also no longer get destroyed at persistence. Checks
used to attach the raw thrown value (e.g. an `MCPAuthError` class instance)
as `details.errorDetails`; Convex rejected the whole report ("is not a
supported Convex type") and the executor replaced the finished report with a
`could-not-run` skip. Error payloads are now converted to plain JSON-safe
data at the producer (own enumerable props plus name/message/code/statusCode),
the executor deep-sanitizes every report at the persistence boundary, and if
a report body still cannot be written the run keeps the suite's real verdict
and score instead of fabricating a could-not-run result.
