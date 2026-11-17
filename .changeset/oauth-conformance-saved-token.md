---
"@mcpjam/sdk": patch
"@mcpjam/inspector": patch
"@mcpjam/cli": patch
---

OAuth conformance no longer reports a server that requires sign-in as not applicable when the server is already signed in. The suite now ignores an `Authorization` custom header, because it signs in for itself, and a challenge the run already saw is no longer undone by a later 200.
