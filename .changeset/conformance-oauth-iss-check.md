---
"@mcpjam/sdk": patch
"@mcpjam/inspector": patch
---

OAuth conformance on 2026-07-28 now checks the authorization response's `iss` (RFC 9207) before the token request. A missing `iss` from a server that advertises `iss` support, or an `iss` that doesn't match the recorded issuer, now fails the run. A callback with no `state` is rejected when the run expected one.
