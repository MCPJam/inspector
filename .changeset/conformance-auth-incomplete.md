---
"@mcpjam/sdk": minor
"@mcpjam/inspector": patch
"@mcpjam/cli": patch
---

Report a server that answers 401 to a run without accepted credentials as `incomplete`, not `failed`, in the protocol, apps and tasks conformance suites. Refused checks are `could-not-run` with a message to connect and run again, carry `details.authorizationRequired: true` (read it with the new `isAuthorizationRequiredCheck`), and the Conformance page shows one reconnect notice. `mcpjam protocol conformance` and `mcpjam conformance run` exit 3 instead of 1 for such a server. Other connection failures still fail.
