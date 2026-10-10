import { useEffect } from "react";
import { usePostHog } from "posthog-js/react";
import { getAppRouter } from "@/router-ref";
import { syncSessionRecording } from "@/lib/session-privacy";
import { syncSentryReplay } from "@/lib/sentry";
import type { LocationLike } from "@/shared/credential-urls";

/**
 * Stop session recording while the user is on a bearer-credential route.
 *
 * `/results/<token>` is reachable by in-app navigation, and a user who lands
 * anywhere else and then follows a results link already has an active
 * recorder — which snapshots the address bar, token and all. This closes that
 * window on every route change. The session's privacy level is applied by
 * `useSessionPrivacy`; both feed the same two sync functions.
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
    // BOTH recorders. PostHog is not the only thing capturing DOM+text on
    // the hosted surface — Sentry Replay is a second one, and gating only
    // PostHog would leave the token-bearing page in a Sentry replay. See
    // docs/session-replay-masking.md ("Two recorders, one boundary").
    //
    // Applied once for the current location too, so a hard load onto
    // `/results/` is covered before any navigation happens.
    //
    // The PostHog half is conditional on a client, the Sentry half is not:
    // Sentry Replay is gated on the platform, so an ad-blocked or disabled
    // PostHog would otherwise leave it recording `/results/<token>`.
    //
    // The whole location, not only the path: a secret query or fragment key
    // (`?code=`, `#token=`) blocks recording too. The STOP side also runs
    // before navigation, in `installRecorderNavigationGuard`; this is where
    // recording resumes once the location is clean again.
    const apply = (location: LocationLike) => {
      if (posthog) syncSessionRecording(posthog, location);
      syncSentryReplay(location);
    };
    const { pathname, search, hash } = window.location;
    apply({ pathname, search, hash });

    const router = getAppRouter();
    if (!router) return;
    return router.subscribe((state) =>
      apply({
        pathname: state.location.pathname,
        search: state.location.search,
        hash: state.location.hash,
      }),
    );
  }, [posthog]);
}
