---
"@mcpjam/sdk": patch
---

Classify an OAuth error response from the user's authorization server as an
auth failure instead of an MCPJam internal error.

`parseErrorResponse` (`oauth/browser-auth.ts`) turns a non-ok token, refresh, or
registration response into an `OAuthResponseError` whose message is the server's
`error_description` verbatim — no HTTP status, no errno, no prefix of ours.
`isAuthError` recognised auth by class name, numeric status, or message prose,
so an authorization server whose prose matched none of the patterns fell past
every branch and landed on the inspector's 500 `INTERNAL_ERROR` catch-all.

In production this surfaced as 69 500s in seven hours across
`/api/web/tools/list`, `/api/web/chat-v2` and `/api/web/servers/validate` for a
single customer, whose authorization server was rejecting token refreshes with
`{"error":"invalid_grant","error_description":"Request context not available —
authentication or export lookup failed"}`. The phrase "authentication" appears
there only inside "authentication or export lookup failed", which is not the
`"authentication failed"` pattern. Their authorization server was reported to
them, and to the on-call, as an MCPJam outage.

`isAuthError` now recognises the class by name. It is constructed on exactly one
path — a URL the *user* configured answering a token request with an OAuth error
body — so it identifies the failing hop positively rather than inferring
ownership from a generic error type. The verdict comes from the response shape,
which a third party cannot phrase its way out of; widening the message-pattern
list would have fixed one sentence out of an unbounded set written by other
people.

Consequences at the four call sites:

- the inspector maps it through the existing `403 UPSTREAM_AUTH_FAILED` branch,
  which already carries `upstreamAuthRequired` and the rationale for 403 over
  401. Being a 4xx it also reaches the browser with its body intact rather than
  being replaced at the edge;
- `isRetryableTransientError` stops retrying a rejected grant, which no retry
  can fix;
- `MCPClientManager` wraps it as an `MCPAuthError`, so OAuth escalation hooks in
  and the user is prompted to reconnect the server.

`describeError` also reads the OAuth error code off the same class. It is kept
on `.code` rather than `error`/`error_code`, so `oauthBodySlug` found nothing to
key on and these failures resolved to `internal/unknown` — origin `ambiguous` —
regardless of what the server actually said. They now carry `oauth/invalid_grant`
(or the matching slug) and origin `user_config`.
