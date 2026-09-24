# Tracing Convex query failures

The browser observes the existing Convex watches, including failed cached
results and failures a component catches. It makes no additional backend
requests and keeps the original result, thrown error, callbacks and cleanup.

In `inspector-client`, search `request_id:<id from the Convex event>`.
`convex_backend` identifies the client's backend hostname (which can be a custom
domain); `convex_function` identifies the query. Existing `release`, `dist`,
`deployment`, and user identity identify the caller. `extra.page_location` is
sanitized. Request IDs do not change Sentry fingerprints.

Query reports omit arguments, raw validation messages, query strings, fragments,
share credentials, request headers, breadcrumbs and frame locals. Server Error
messages retain their protocol prefix; other query messages become Query failed.
Original frames remain for source-map resolution. Authorization refusals stay
quiet. Existing Sentry enablement and PostHog surface rules still apply.

Duplicate reports use a per-session bounded cache (500 backend/request pairs)
for caught reports and another at Sentry's beforeSend boundary, which also
covers automatic global errors. Missing request IDs are not deduplicated.

## Staging verification

Run only on an authenticated staging deployment containing this branch:

1. In a temporary staging-only harness, instantiate the same client, initialize
   Sentry with environment `staging`, and call `traceConvexQueries(client, url)`.
   Confirm the URL belongs to staging before issuing any query.
2. Subscribe once to an intentionally absent query, such as
   `diagnostics:missingQueryTracingSmoke`, with empty arguments. Catch the local
   error, then unsubscribe and close the test client. Do not add a backend
   function or commit the deliberately failing call.
3. Find the staging Convex event and search its request ID in `inspector-client`.
   Confirm version, build surface, deployment, backend hostname, function name
   and sanitized page location, and exactly one client event for that request.
4. Confirm a normal query still works. Remove the temporary harness.

This change does not instrument already-running old bundles or recover missing
historical metadata. A backend-only recurrence is still unidentified; it is not
proof that the caller used an old version.

The initial implementation's live staging check was blocked by Cloudflare
Access sign-in. Production was not probed during implementation.
