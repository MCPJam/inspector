/**
 * Stop both session recorders BEFORE the address bar changes to a credential
 * location — a share link, a tester link, an OAuth callback, any URL with a
 * secret query or fragment key (`shared/credential-urls.ts`).
 *
 * `useSessionRecordingPathGuard` reacts to the router after a navigation has
 * committed. That is after the URL changed, and the recorders read the URL
 * whenever they emit: PostHog's replay stamps `$url_changed` from
 * `location.href` on the next rrweb event, Sentry's history instrumentation
 * records a navigation frame as `pushState` runs. Reacting afterwards means
 * scrubbing afterwards, and Sentry offers no hook over its rrweb page
 * metadata. So this runs FIRST:
 *
 *  - `history.pushState` / `replaceState` are wrapped. The wrapper decides on
 *    the TARGET URL and, when it is blocked, syncs both recorders against it
 *    — which stops them — before the original runs. Installed after Sentry's
 *    own history instrumentation, so it is the outermost wrapper and runs
 *    before Sentry's handler sees the navigation.
 *  - `popstate` and `hashchange` cannot be intercepted before the URL moves;
 *    capture-phase listeners registered at boot (before the recorders add
 *    theirs) stop the recorders on the first tick.
 *
 * It only ever STOPS. Resuming on the way out is the path guard's job, after
 * the navigation has left the credential page — resuming here, before the
 * URL changed, would record the page being left.
 *
 * Never throws: a failed guard must not break navigation.
 */
import {
  isReplayBlockedUrl,
  type LocationLike,
} from "../../../shared/credential-urls";
import {
  lastSyncedPostHogClient,
  syncSessionRecording,
} from "./session-privacy";
import { syncSentryReplay } from "./sentry";

function locationOf(url: URL): LocationLike {
  return { pathname: url.pathname, search: url.search, hash: url.hash };
}

/** Stop both recorders if `target` is a location they must not record. */
export function stopRecordersBeforeNavigation(target: URL): void {
  try {
    if (
      !isReplayBlockedUrl(`${target.pathname}${target.search}${target.hash}`)
    ) {
      return;
    }
    const location = locationOf(target);
    const client = lastSyncedPostHogClient();
    if (client) syncSessionRecording(client, location);
    syncSentryReplay(location);
  } catch {
    // Never break navigation over a guard.
  }
}

let installed: (() => void) | null = null;

/**
 * Install the guard on `window.history` and the window. Idempotent; returns
 * an uninstall function (tests).
 */
export function installRecorderNavigationGuard(): () => void {
  if (installed) return installed;
  if (typeof window === "undefined" || !window.history) return () => {};

  const history = window.history;
  const originalPush = history.pushState;
  const originalReplace = history.replaceState;

  const wrap = (original: History["pushState"]): History["pushState"] =>
    function guardedHistoryChange(
      this: History,
      data: unknown,
      unused: string,
      url?: string | URL | null,
    ) {
      if (url !== undefined && url !== null) {
        try {
          stopRecordersBeforeNavigation(new URL(url, window.location.href));
        } catch {
          // An unparseable URL makes `original` throw too; let it.
        }
      }
      return original.call(this, data, unused, url);
    };

  history.pushState = wrap(originalPush);
  history.replaceState = wrap(originalReplace);

  const onUrlMoved = () => {
    try {
      stopRecordersBeforeNavigation(new URL(window.location.href));
    } catch {
      // see above
    }
  };
  window.addEventListener("popstate", onUrlMoved, true);
  window.addEventListener("hashchange", onUrlMoved, true);

  installed = () => {
    history.pushState = originalPush;
    history.replaceState = originalReplace;
    window.removeEventListener("popstate", onUrlMoved, true);
    window.removeEventListener("hashchange", onUrlMoved, true);
    installed = null;
  };
  return installed;
}
