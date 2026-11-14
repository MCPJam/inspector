# Auth refusal diagnostics

Client Sentry events with `source:convex_auth_refusal` are informational diagnostics
for handled `unauthenticated` and `session_revoked` query failures. Backend alerts
and permission checks are unchanged.

Search by `request_id` for the first backend request in an episode. The
`auth_refusal.failures` context holds up to 20 distinct request/function pairs,
including their backend hostnames. Match both request ID and backend deployment.
`version`, `build` (Git SHA, or `unknown` outside a Git checkout), and `surface`
identify the client that actually saw the refusal. Random tab/episode IDs and the
existing recovery ID link the safe state transitions; no user IDs, tokens,
arguments, request headers, page URLs, breadcrumbs or replay context are included.

An episode emits once: when authentication and database-user setup recover, after
15 seconds if still unresolved, or on pagehide before a reload. Further errors in
that episode are suppressed until recovery. The event is best effort; a closed
browser or blocked telemetry can lose it. Older clients cannot send these events,
so a missing match does not prove an old client caused an alert.

Guest promotion/revocation announces a scoped transition to sibling tabs through
BroadcastChannel and localStorage. Matching tabs unmount app subscriptions and
show the MCPJam spinner while auth providers and user setup remain mounted. They
reload at most once automatically in 60 seconds; unavailable sessionStorage means
manual Retry/Sign in instead. Failed or timed-out transitions stay blocked. A
missed announcement falls back to the same recovery on a revoked guest query.
Guest recovery does not call WorkOS sign-out. Existing WorkOS revocation handling
remains unchanged. Requests already executing at promotion can still be refused.

Before a sign-in transition or guest recovery reload, tabs record a one-use
sessionStorage marker for their already-open project route (30-minute expiry).
After authentication, user setup and memberships resolve, an unavailable old
project is replaced with an accessible project’s Home URL. Accessible URLs remain
unchanged. Ordinary direct links still show the project-unavailable page; special
sign-in return flows keep their precedence. Storage failures retain same-page
recovery in memory, but a reload without persistent storage cannot restore the
marker. Temporary page state can be lost during recovery.
