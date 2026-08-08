import { useEffect } from "react";
import { usePostHog } from "posthog-js/react";
import { getAppRouter } from "@/router-ref";
import { syncSessionRecordingForPath } from "@/lib/PosthogUtils";

/**
 * Stop session recording while the user is on a bearer-credential route.
 *
 * `disable_session_recording` is an init-time PostHog option, so it only
 * covers a session that *loads* on `/results/<token>`. That route is reachable
 * by in-app navigation, and a user who lands anywhere else and then follows a
 * results link already has an active recorder — which snapshots the address
 * bar, token and all. This closes that window on every route change.
 *
 * Deliberately NOT `useLocation()`: `App` also renders outside a router (the
 * legacy hash path, and several test harnesses), where the router invariant
 * throws. The same reason `AppContent` reads `getRouteFallbackPathname()`
 * instead. Subscribing to the module-level router ref works in both worlds and
 * is a no-op when there is no router.
 */
export function useSessionRecordingPathGuard(): void {
  const posthog = usePostHog();

  useEffect(() => {
    if (!posthog) return;

    // Apply once for the current location, so a hard load onto `/results/`
    // is covered even before any navigation happens.
    const apply = (pathname: string) =>
      syncSessionRecordingForPath(posthog, pathname);
    apply(window.location.pathname);

    const router = getAppRouter();
    if (!router) return;
    return router.subscribe((state) => apply(state.location.pathname));
  }, [posthog]);
}
