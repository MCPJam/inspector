import { useCallback, useEffect, useRef } from "react";
import {
  dismissOAuthCallbackHint,
  showOAuthCallbackHint,
} from "@/components/conformance/oauth-callback-hint";

/** Only web URLs may open the authorization popup. */
export function isWebUrl(raw: string): boolean {
  try {
    const { protocol } = new URL(raw);
    return protocol === "https:" || protocol === "http:";
  } catch {
    return false;
  }
}

/** The OAuth popup, or null when the browser blocked it. */
export function openAuthorizationPopup(
  authorizationUrl: string,
): Window | null {
  return window.open(
    authorizationUrl,
    "oauth_conformance_auth",
    "width=600,height=700,scrollbars=yes"
  );
}

const POPUP_POLL_MS = 500;
// The callback page posts the code 100–500 ms before it closes itself, so a
// close is only "no code" once that message has had time to land.
const POPUP_CLOSE_GRACE_MS = 1_000;

/** Calls `onClosed` once the popup is closed. Returns a stop function. */
export function watchAuthorizationPopup(
  popup: Window,
  onClosed: () => void,
): () => void {
  let graceTimer: ReturnType<typeof setTimeout> | undefined;
  const poll = setInterval(() => {
    if (!popup.closed) return;
    clearInterval(poll);
    graceTimer = setTimeout(onClosed, POPUP_CLOSE_GRACE_MS);
  }, POPUP_POLL_MS);
  return () => {
    clearInterval(poll);
    clearTimeout(graceTimer);
  };
}

/**
 * Opens the sign-in popup and watches it until a code comes back. A popup
 * closed with no code, or a run deadline while one is still open, shows the
 * callback hint: a provider that rejects our redirect URL does so on its own
 * page, where we cannot say anything.
 */
export function useAuthorizationPopup() {
  const watchRef = useRef<{ stop: () => void; hinted: boolean } | null>(null);

  // Wired into the OAuth listener cleanup, so a code, a skip or a new run
  // ends the watch, and drops a hint that turned out to be early.
  const stop = useCallback(() => {
    const watch = watchRef.current;
    watchRef.current = null;
    if (!watch) return;
    watch.stop();
    if (watch.hinted) dismissOAuthCallbackHint();
  }, []);

  const open = useCallback(
    (authorizationUrl: string, cleanupFns?: Array<() => void>) => {
      stop();
      cleanupFns?.push(stop);
      const popup = openAuthorizationPopup(authorizationUrl);
      if (!popup) return popup;
      const watch = { hinted: false, stop: () => {} };
      watch.stop = watchAuthorizationPopup(popup, () => {
        if (watchRef.current !== watch) return;
        watch.hinted = true;
        showOAuthCallbackHint();
      });
      watchRef.current = watch;
      return popup;
    },
    [stop],
  );

  /** The run deadline ended: hint if a popup was still waiting on a code. */
  const expire = useCallback(() => {
    const watch = watchRef.current;
    watchRef.current = null;
    if (!watch) return;
    watch.stop();
    showOAuthCallbackHint();
  }, []);

  useEffect(() => stop, [stop]);

  return { open, expire };
}
