# Hosted server check queue

Both `/api/web/servers/{validate,doctor}` and
`/api/v1/projects/:projectId/servers/:serverId/{validate,doctor}` share ten active
checks and one hundred waiting requests per verified user. This replaces the old
20-per-credential and 60-per-IP five-minute diagnostics windows. Existing guest,
API-key, authorization, URL, and upstream-pressure controls remain in force.

Convex's `serverCheckQueues` table coordinates instances. WorkOS sessions and
API keys use the same verified WorkOS user id; guests use their verified guest id.
Unverified passthrough tokens must be verified by Convex before admission. The
internal HTTP route requires the inspector service credential and is not a public
queue-management API.

Manual requests have priority, FIFO by click/admission order. Legacy requests,
API validation, and doctor calls default to manual. Hosted validation may include
`_serverCheck: { requestId: <UUID>, intent: "manual" | "automatic" }`.
`POST /api/web/servers/checks/promote` accepts `{ requestId }` under the same
verified bearer/guest authentication; it can only promote that user's request.

A waiting manual request interrupts the newest automatic execution when all ten
slots are occupied. Interrupted leases remain active until cleanup releases them;
already-requested interruptions count toward the slots needed. Manual executions
and established runtime connections are never interrupted. At the 100-waiting
bound, manual admission can replace the newest automatic waiter. Active leases
last 30 seconds, renew every 10 seconds, and poll for interruption every second.
Workers abort on failed renewal or before lease expiry; connection cleanup happens
before release. Queue waits stop at 30 seconds. Full/expired waits return 429 with
`details.reason` set to `SERVER_CHECK_QUEUE_FULL` or `SERVER_CHECK_QUEUE_TIMEOUT`
and `Retry-After: 2`. Coordination failure returns 503 with
`SERVER_CHECK_QUEUE_UNAVAILABLE`. Scheduled cleanup removes abandoned queue rows.

The hosted browser sends ten validations at a time, keeps remaining work locally,
and follows saved card order for automatic work. Manual work goes first; if all
browser slots are busy, one automatic attempt is aborted and its promise must
settle before a manual attempt can dispatch. Backend admission still waits for
actual connection cleanup. “Connect next” promotes queued work; “Keep connecting”
protects an active check. Queued cards can be cancelled; changing card order
reprioritizes pending checks. The browser only retries the two queue-specific 429s,
with positive jitter and a two-minute retry budget. Existing failure handling is
used for other errors except HTTP 409 `SERVER_CHECK_PREEMPTED`: the original
browser job stays pending and restarts with a fresh attempt ID and signal after a
short delay. This does not consume the congestion retry budget or show an error.
Promotion retries a not-yet-admitted ID to cover cross-replica arrival races.
OAuth user interaction is outside these network slots.

## Rollout

1. Deploy the additive Convex schema, internal operations, and HTTP endpoint first.
   No backfill is required. Test on the personal deployment selected by `env.dev`.
2. Deploy inspector backend admission and outbound cancellation. Its existing
   `CONVEX_HTTP_URL` and `INSPECTOR_SERVICE_TOKEN` must target that same backend.
3. Deploy the client scheduler and queue labels.

Do not ship an intermediate build that exempts validation without the shared
coordinator. Monitor `[server-check.queue]` admission counts, waiting time,
refusals, lost leases, and release failures in existing request logs. A rollback
of inspector code must not remove the additive Convex tables while workers still
hold leases. No new global concurrency cap is introduced.
