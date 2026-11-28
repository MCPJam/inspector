/**
 * What Inspector reports when the app is still not usable
 * `APP_LOAD_STALL_MS` after the page started: the step it is stuck on.
 *
 * Declared in `shared/` because the telemetry catalog only collects diagnostic
 * codes from here and the SDK (`CODE_LISTS` in
 * `scripts/generate-telemetry-catalogs.mjs`); these are the `code` values the
 * strict Sentry boundary forwards for that event.
 */
export const APP_LOAD_STALL_CODES = [
  // The guest session could not be created and the retries gave up.
  "app_load/guest_session_failed",
  // A signed-in user's session could not be refreshed and the retries gave up.
  "app_load/session_refresh_failed",
  // The guest authority refused a new guest (its per-IP cap).
  "app_load/guest_session_refused",
  // Still waiting for an identity: neither a guest nor a signed-in user yet.
  "app_load/auth_pending",
  // Authenticated, but with no actor to set up a user record for: neither a
  // signed-in user id nor a guest actor key.
  "app_load/actor_pending",
  // The actor is known, but its user record is not set up yet.
  "app_load/user_setup_pending",
] as const;

export type AppLoadStallCode = (typeof APP_LOAD_STALL_CODES)[number];

/** Long enough that a slow but working network does not page anyone. */
export const APP_LOAD_STALL_MS = 30_000;

/**
 * How long startup may run with no reported failure before the user is
 * offered recovery actions. Shorter than `APP_LOAD_STALL_MS`, so the user has
 * a way out before the stall is reported.
 */
export const STARTUP_RECOVERY_DEADLINE_MS = 20_000;

export function appLoadStallCode(state: {
  guestRefused: boolean;
  sessionRefreshFailed: boolean;
  /** A WorkOS user is present, so a refresh failure is theirs, not a guest's. */
  signedIn: boolean;
  authenticated: boolean;
  identityKnown: boolean;
}): AppLoadStallCode {
  if (state.guestRefused) return "app_load/guest_session_refused";
  if (state.sessionRefreshFailed) {
    return state.signedIn
      ? "app_load/session_refresh_failed"
      : "app_load/guest_session_failed";
  }
  if (!state.authenticated) return "app_load/auth_pending";
  return state.identityKnown
    ? "app_load/user_setup_pending"
    : "app_load/actor_pending";
}
