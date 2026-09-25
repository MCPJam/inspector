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

Admission is FIFO. Active leases last 30 seconds and renew every 10 seconds.
Workers abort on failed renewal or before lease expiry; connection cleanup happens
before release. Queue waits stop at 30 seconds. Full/expired waits return 429 with
`details.reason` set to `SERVER_CHECK_QUEUE_FULL` or `SERVER_CHECK_QUEUE_TIMEOUT`
and `Retry-After: 2`. Coordination failure returns 503 with
`SERVER_CHECK_QUEUE_UNAVAILABLE`. Scheduled cleanup removes abandoned queue rows.

The hosted browser sends ten validations at a time, keeps remaining work locally,
and follows saved card order. Queued cards can be cancelled; changing card order
reprioritizes pending checks. The browser only retries the two queue-specific 429s,
with positive jitter and a two-minute retry budget. Existing failure handling is
used for every other error. OAuth user interaction is outside these network slots.

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
