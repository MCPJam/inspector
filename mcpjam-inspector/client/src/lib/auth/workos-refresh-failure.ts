import { reportCaught } from "@/lib/error-reporting";

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
 * Lives here rather than inline in `main.tsx` so it is testable: `main.tsx`
 * calls `initSentry()` and `createRoot()` at module scope and cannot be
 * imported from a test.
 */
export function handleWorkosRefreshFailure({
  signIn,
}: {
  signIn: () => void | Promise<void>;
}): void {
  reportCaught(new Error("WorkOS session refresh failed"), {
    source: "workos_refresh_failure",
    level: "warning",
  });
  // Fire-and-forget, but wrapped: `signIn` is async and a failure to build the
  // authorization URL would otherwise surface as an unhandled rejection inside
  // authkit's callback. The report above already recorded the dead session.
  void Promise.resolve(signIn()).catch(() => {});
}
