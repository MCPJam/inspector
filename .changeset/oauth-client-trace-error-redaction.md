---
"@mcpjam/inspector": patch
---

Redact credentials echoed into the OAuth trace entries the client builds itself.

`projectOAuthTraceSnapshot({ sanitize })` covers everything derived from a state machine's HTTP history, but not the trace steps the client writes directly — `failOAuthTraceStep` and the OAuth proxy's transport-failure entry. The refresh flow produces *only* those, so it had no error redaction at all: an authorization server that echoes a `refresh_token` back in `error_description` put it verbatim into a persisted, copyable trace.

Both sites now go through `traceOAuthErrorMessage` in the new `lib/oauth/trace-redaction.ts`, gated on `SANITIZE_OAUTH_TRACES` the same way `traceOAuthValue`/`traceOAuthHeaders` already are — local dev still shows the server's raw text, which is the point of the inspector. The redactor itself is the debugger's existing `sanitizeStepError`, moved rather than rewritten: it already handles URL userinfo, named parameters, echoed `Authorization` headers, JSON credential fields, and truncation tails, and it deliberately preserves diagnostic wording like "Bearer token is expired". `debug-state-machine-adapter.ts` re-exports it, so its callers and tests are unchanged.

Also documents `serializeBody` as a live-data path that must never be redacted, matching the note already on `parseOAuthResponseBody`.
