/**
 * The timings of a box preparation (`prepare-conversation-box.ts`), which a
 * Send that meets one (`box-preparing-wait.ts`) also waits by. None of them is
 * the backend's: the claim's own TTL comes back with every claim and renewal.
 */

/** How long a preparation may run in all. */
export const PREPARATION_DEADLINE_MS = 3 * 60_000;
/** How often a running preparation renews its claim. */
export const CLAIM_RENEWAL_MS = 60_000;
/** Each claim, renewal or release call's own bound. */
export const CLAIM_CALL_TIMEOUT_MS = 15_000;
