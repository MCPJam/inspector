import { useEffect } from "react";
import { usePostHog } from "posthog-js/react";
import { useLocation } from "react-router";
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
 * Mount once, high in the tree.
 */
export function useSessionRecordingPathGuard(): void {
  const posthog = usePostHog();
  const location = useLocation();

  useEffect(() => {
    if (!posthog) return;
    syncSessionRecordingForPath(posthog, location.pathname);
  }, [posthog, location.pathname]);
}
