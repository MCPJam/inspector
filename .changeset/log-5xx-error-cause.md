---
"@mcpjam/inspector": patch
---

Record *why* a server 5xx failed, not just that one did.

`http.request.failed` previously carried a status code and a blanket
`errorCode: "internal_error"`, with the message discarded. That made a week of
hosted-connect 502s (`/api/web/servers/validate`, `/api/web/tools/list`,
`/api/web/chat-v2`) undiagnosable — Axiom could count them but never explain
them.

The cause was structural rather than a missing field: Hono runs `onError`
*inside* `next()`, so `requestLogContextMiddleware` never observes a route's
throw. Its `thrown` branch is unreachable whenever an error handler is
registered, which is always, so every 5xx fell through to the catch-all label.

The handlers now hand the cause over explicitly via a `webErrorMeta` context
var — set by `webError()` and by the global `onError` — and the middleware
emits the route's real `ErrorCode` (`SERVER_UNREACHABLE`, `TIMEOUT`, …) plus a
new `errorMessage` field. The meta is bound to its status and ignored on
mismatch, so a route that emits a 4xx and later fails with an unrelated 500
cannot mislabel the 500. Messages are capped at 500 chars.

Also hardens `scrubLogPayload`: secrets carried in a URL query string
(`?access_token=`, `?code=`, `?api_key=`, …) are now redacted inside string
values. Key-based redaction only walked object keys, so a URL embedded in an
error message previously survived into Axiom intact.

Logging only — no status codes, response bodies, or routing change.
