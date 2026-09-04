/**
 * "This tab is on its way out — stop treating a dead session as a surprise."
 *
 * Signing out is itself a refresh failure, and everything downstream of a
 * refresh failure is built to fight one.
 *
 * The sequence: `signOut()` wipes the in-memory session and starts navigating
 * to WorkOS's logout endpoint. authkit-js's automatic refresh timer keeps
 * ticking on its 1s interval through that navigation (it is never cancelled —
 * only `dispose()` clears it, and nothing calls that here). The next tick
 * finds no token, attempts a refresh, and WorkOS rejects it because the
 * session it just revoked is gone. That rejection is indistinguishable from a
 * session that died on its own, so it fires `onRefreshFailure`, which raises
 * the "Your session has expired." banner and calls `signIn()` — a SECOND
 * `location.assign` that replaces the still-pending logout navigation.
 *
 * The user clicks Sign out and lands on the hosted login page instead of the
 * signed-out app, having been signed out correctly the whole time. The
 * `?state=…mcpjamPermalinkReturn…` on that URL is this handler's fingerprint.
 *
 * So: latch before every `signOut()` call, and the failure handlers ignore the
 * rejection they are guaranteed to see.
 */

/**
 * How long a sign-out suppresses refresh failures.
 *
 * The latch EXPIRES, and that is the whole design, because a sign-out is not
 * guaranteed to navigate. authkit's `signOut()` builds its logout URL from the
 * session id inside the access token, and returns early — no request, no
 * redirect — when that token is already gone. Pressing Sign out on a session
 * that has ALREADY died is exactly that case: the latch would be set, the page
 * would stay put, and a permanent flag would leave the tab silently swallowing
 * every genuine session failure from then on. That is a worse bug than the
 * redirect this module exists to stop.
 *
 * Ten seconds covers the gap a real sign-out has to bridge — a click, a
 * revocation round trip, and a full-page navigation, against a refresh timer
 * that ticks every second — while a tab that never navigates is back to
 * reporting failures honestly a moment later.
 */
export const SIGN_OUT_SUPPRESSION_WINDOW_MS = 10_000;

let signOutStartedAt: number | null = null;

/**
 * Call IMMEDIATELY before `signOut()`, on every path that signs out.
 *
 * Synchronous and un-awaited on purpose: the refresh timer can fire on the
 * very next tick, so anything deferred is already too late.
 */
export function markSignOutInProgress(now: number = Date.now()): void {
  signOutStartedAt = now;
}

/** True while a sign-out started recently enough to explain a dead session. */
export function isSignOutInProgress(now: number = Date.now()): boolean {
  if (signOutStartedAt === null) return false;
  const elapsed = now - signOutStartedAt;
  // A clock that moved backwards is not a reason to keep suppressing, any more
  // than one that moved forward past the window is.
  //
  // The timestamp is CLEARED here, not merely reported as expired: leaving it
  // in place lets a clock that later catches up revive a latch this call has
  // already declared dead — and a revived latch hides exactly the genuine
  // session failure the expiry exists to let through. Once suppression ends it
  // stays ended, until a new sign-out arms it again.
  if (elapsed < 0 || elapsed > SIGN_OUT_SUPPRESSION_WINDOW_MS) {
    signOutStartedAt = null;
    return false;
  }
  return true;
}

/** Test-only: drop the latch without waiting out the window. */
export function resetSignOutLatchForTests(): void {
  signOutStartedAt = null;
}
