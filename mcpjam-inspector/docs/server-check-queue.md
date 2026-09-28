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
actual connection cleanup. Waiting and active checks reuse the existing
“Finishing setup...” status, with no extra priority buttons. The connection
switch can cancel checks; changing card order reprioritizes pending checks. The browser only retries the two queue-specific 429s,
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

## Local browser and desktop connections

Local `/api/mcp/connect` and `/api/mcp/servers/reconnect` use the same browser
scheduler and card actions. A single in-memory coordinator in each Inspector
process shares **10 active attempts and 100 waiting requests** across every tab,
window, and project using that process. Separate processes have independent
allowances. Local admission does not use Convex; configuration and authorization
still use the existing project resolver.

The local endpoints accept the same optional `_serverCheck` metadata; older
callers default to manual. `POST /api/mcp/servers/checks/promote` accepts
`{ requestId }` behind the existing local session authentication. Promotion is
bound to that session, project bearer, and request ID. A runtime connection key can have only one
active attempt. Manual attempts go first and may interrupt the newest automatic
attempt; cleanup keeps its slot and runtime key until finished. Duplicate manual
waiters for one key do not cause extra interruptions. Successfully established
connections leave admission and stay open.

Server waiting is bounded at 30 seconds; the 20-second connection deadline starts
only after admission. Local refusals use the hosted queue reasons and retry
headers. Cancellation reaches resolver requests, HTTP/SSE discovery and startup,
stdio processes, and SDK retries. An attempt closes only the resources it opened,
including account connections and plugin leases. Shutdown aborts waiting and
active attempts and awaits cleanup. Interactive OAuth releases the browser slot;
the resumed connection enters admission again after sign-in.

Ship the SDK cancellation interface and local server support before enabling the
client scheduler. The SDK changeset is a minor release so Changesets updates the
Inspector dependency range to a version containing cancellation support. No
Convex schema change or data migration is required. Monitor
`[local-server-check.queue]` admission, wait time, interruption, and cleanup logs.
CLI doctor, established connections, and tool execution do not use this queue.
