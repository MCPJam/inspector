// ── Hosted OAuth conformance rendezvous ─────────────────────────────────────
// The OAuth suite runs on the replica that served `/oauth/start`; the code and
// the result cross replicas through Convex (see conformance-oauth-rendezvous.ts).
// Same cadence as hosted elicitation. Kept out of server/config.ts, which the
// browserd daemon bundles: a constant there would make that bundle stale.

/** How often the running replica checks Convex for the authorization code. */
export const CONFORMANCE_OAUTH_POLL_INTERVAL_MS = 1_000;
/** Jitter added per poll so replicas don't synchronize. */
export const CONFORMANCE_OAUTH_POLL_JITTER_MS = 250;
/**
 * Consecutive poll failures tolerated before the run stops waiting. Higher than
 * elicitation's: a consent screen takes minutes, and giving up here loses the
 * whole run rather than one dialog.
 */
export const CONFORMANCE_OAUTH_POLL_MAX_FAILURES = 30;
/** Deadline for one Convex call on these legs; anything slower is a stall. */
export const CONFORMANCE_OAUTH_CONVEX_TIMEOUT_MS = 10_000;
/** How long `/oauth/complete` waits for a result before answering `pending`. */
export const CONFORMANCE_OAUTH_COMPLETE_WAIT_MS = 25_000;
/** How often `/oauth/complete` re-reads the row while it waits. */
export const CONFORMANCE_OAUTH_COMPLETE_INTERVAL_MS = 1_000;
/** Shutdown budget for marking this replica's live runs as stopped. */
export const CONFORMANCE_OAUTH_SHUTDOWN_BUDGET_MS = 2_000;
