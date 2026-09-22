import { captureAppSignInReturnPath } from "@/lib/app-signin-return-path";
import { isSignOutInProgress } from "@/lib/auth/sign-out-latch";
import { reportCaught } from "@/lib/error-reporting";
import { permalinkSignInOptions } from "@/lib/permalink-signin-return";
import { useSessionRefreshStore } from "@/stores/session-refresh-store";

/**
 * Handler for `<AuthKitProvider onRefreshFailure>`.
 *
 * Fires when WorkOS actively rejected a refresh: the session is dead, and
 * authkit has already wiped it and latched to its ERROR state. Without this
 * the provider keeps `user` populated, so the app renders signed-in chrome
 * over a connection Convex has already de-authenticated — every mounted query
 * then fires with no identity and crashes into an error boundary.
 *
 * `signIn()` navigates to WorkOS. When the browser still holds a valid SSO
 * cookie — the common case for a transient server-side rejection — the user
 * round-trips silently and comes back with a live session; otherwise they land
 * on login, which is the honest state. Either way the navigation tears the tab
 * down before the burst can surface.
 *
 * authkit skips this callback from its INITIAL state, so a signed-out visitor
 * is never redirected.
 *
 * A sign-out in flight is the one rejection that is NOT a dead session
 * surprising us — it is the session we just deliberately revoked, seen by a
 * refresh timer that keeps ticking through the logout navigation. Acting on it
 * would send `signIn()` over the top of that navigation and land the user on
 * the login page instead of the signed-out app. See `sign-out-latch`.
 *
 * Lives here rather than inline in `main.tsx` so it is testable: `main.tsx`
 * calls `initSentry()` and `createRoot()` at module scope and cannot be
 * imported from a test.
 */
export function handleWorkosRefreshFailure({
  signIn,
}: {
  signIn: (options?: {
    state?: Record<string, string>;
  }) => void | Promise<void>;
}): void {
  if (isSignOutInProgress()) return;
  reportCaught(new Error("WorkOS session refresh failed"), {
    source: "workos_refresh_failure",
    level: "warning",
  });
  // Set BEFORE navigating. On success the page unloads and this never renders;
  // if the navigation is blocked or fails, the banner is already up offering a
  // sign-in, instead of leaving signed-in chrome over a dead session.
  useSessionRefreshStore.getState().notifyFailure("signed_out");
  // This redirect is involuntary — the user did not ask to leave — so the way
  // back matters more here than on a button they chose to press. Without these
  // they return to the app's front door having lost the resource they were on
  // and the project it was scoped to. Same pair the banner's Sign in uses.
  captureAppSignInReturnPath();
  // Fire-and-forget, but wrapped: `signIn` is async and a failure to build the
  // authorization URL would otherwise surface as an unhandled rejection inside
  // authkit's callback. The report above already recorded the dead session.
  void Promise.resolve(signIn(permalinkSignInOptions())).catch(() => {});
}
