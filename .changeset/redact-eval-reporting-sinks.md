---
"@mcpjam/sdk": patch
"@mcpjam/cli": patch
---

Keep eval credentials out of logs, error trackers, and exported report files.

Eval replay configs carry live `accessToken` / `refreshToken` / `clientSecret`
values, and they legitimately travel in the ingest request body — replay cannot
authorize an MCP call without them. That is fine while the body is the only
place they appear. It stops being fine the moment something quotes the request
back.

Two paths did. The backend's failure message was passed through
`normalizeReportingErrorMessage` verbatim into `EvalReportingError`, which the
SDK writes to stderr and sends to Sentry as the exception value — so a validator
that echoes the rejected argument, which is exactly what Convex's
`ArgumentValidationError` does, published live credentials to a log line and a
third-party error tracker. Separately, `--out` and `--reporter` are two exports
of the same run, and only the reporter half was redacted: `writeJsonArtifact`
wrote whatever it was handed straight to disk, so the identical report left
clean through one flag and in the clear through the other.

Both are now redacted at the point the data becomes an artifact rather than at
each sink, so a new caller inherits the guarantee instead of having to remember
it. The request body is deliberately unchanged — redacting it would silently
break replay while looking like hardening — and a canary-secret regression test
asserts both directions: the planted credential must reach the request body, and
must reach nothing else.

Adds `redactTelemetryString`, a string-specialized `redactForTelemetry` for
message-shaped sinks.
