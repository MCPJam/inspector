import { useEffect, useLayoutEffect } from "react";
import { usePostHog } from "posthog-js/react";
import { getAppRouter } from "@/router-ref";
import { useCurrentLocationParts } from "@/lib/app-navigation";
import {
  isCredentialBearingPath,
  syncSessionRecording,
} from "@/lib/session-privacy";
import { syncSentryReplay } from "@/lib/sentry";
import type { LocationLike } from "@/shared/credential-urls";

/**
 * Keep both recorders off while the user is on a credential location, and
 * back on — at the session's level — once they have left it.
 *
 * `/results/<token>` and the other credential locations
 * (`shared/credential-urls.ts`) are reachable by in-app navigation, and a user
 * who lands anywhere else and then follows a results link already has an
 * active recorder — which snapshots the address bar, token and all.
 *
 * STOPPING is early: `installRecorderNavigationGuard` stops both recorders
 * before `pushState` runs, and the router subscription here stops them the
 * moment the router heads for a blocked location (covering `popstate` and
 * anything that bypassed the history wrapper).
 *
 * RESUMING is late, on purpose: only once React has COMMITTED the location it
 * is leaving for. The router announces a navigation before the new route has
 * rendered — and with transitions or a lazy route the old page can stay on
 * screen for a while — so resuming from the router event would take the
 * first full snapshot of the credential page that is still showing. A layout
 * effect keyed on the committed location runs after that commit's DOM
 * mutations and before paint: the snapshot is of the page the URL names.
 *
 * Must run inside the routed tree (`App` is the router's root element), so the
 * committed location is the router's. Outside a router it falls back to the
 * window's location, which is what is on screen there.
 */
export function useSessionRecordingPathGuard(): void {
  const posthog = usePostHog();
  const committed = useCurrentLocationParts();

  // BOTH recorders, and the Sentry half even without a PostHog client:
  // PostHog is routinely ad-blocked, Sentry Replay is not gated on it.
  // See docs/session-replay-masking.md ("Two recorders, one boundary").
  useLayoutEffect(() => {
    const location: LocationLike = {
      pathname: committed.pathname,
      search: committed.search,
      hash: committed.hash,
    };
    if (posthog) syncSessionRecording(posthog, location);
    syncSentryReplay(location);
  }, [posthog, committed.pathname, committed.search, committed.hash]);

  useEffect(() => {
    const router = getAppRouter();
    if (!router) return;
    return router.subscribe((state) => {
      const location: LocationLike = {
        pathname: state.location.pathname,
        search: state.location.search,
        hash: state.location.hash,
      };
      // Stop only. Resuming waits for the commit above.
      if (!isCredentialBearingPath(location)) return;
      if (posthog) syncSessionRecording(posthog, location);
      syncSentryReplay(location);
    });
  }, [posthog]);
}
