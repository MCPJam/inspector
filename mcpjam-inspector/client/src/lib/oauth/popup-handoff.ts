/**
 * The sign-in popup for the OAuth checks and the OAuth Debugger: opens it,
 * writes the marker the callback page looks for (see
 * `popup-handoff-marker.ts`), listens for the answer and cleans up.
 *
 * A popup that reads as closed is not a failure: once a COOP page cuts the
 * link, Chrome reports `closed === true` straight away while the user is
 * still signing in. So the handoff keeps listening until its deadline and
 * only then shows the redirect URL hint.
 */
import { useCallback, useEffect, useRef } from "react";
import {
  dismissOAuthCallbackHint,
  showOAuthCallbackHint,
} from "@/lib/oauth/callback-hint";
import {
  deleteOAuthPopupMarker,
  oauthCallbackChannelName,
  parseOAuthCallbackMessage,
  readAuthorizationUrlState,
  writeOAuthPopupMarker,
  type OAuthCallbackMessage,
  type OAuthPopupFlow,
} from "@/lib/oauth/popup-handoff-marker";

export type { OAuthCallbackMessage } from "@/lib/oauth/popup-handoff-marker";

/** Only web URLs may open the authorization popup. */
export function isWebUrl(raw: string): boolean {
  try {
    const { protocol } = new URL(raw);
    return protocol === "https:" || protocol === "http:";
  } catch {
    return false;
  }
}

export interface OAuthPopupHandoffOptions {
  authorizationUrl: string;
  flow: OAuthPopupFlow;
  /** Called once, with the first answer whose `state` matches. */
  onResult: (message: OAuthCallbackMessage) => void;
  /** Stop waiting and show the hint after this long. Omit to rely on `expire`. */
  deadlineMs?: number;
  /** Called once if the deadline passes, or `expire` runs, with no answer. */
  onExpire?: () => void;
  /** Ends the hint's sentence: "run again" or "try again". */
  retryLabel?: string;
}

export interface OAuthPopupHandoff {
  /** The popup, or null when the browser blocked it. */
  readonly popup: Window | null;
  /** Opens the popup again for the same request, e.g. after a block. */
  reopen(): Window | null;
  /** The deadline passed: stop waiting and show the hint. */
  expire(): void;
  /** The flow ended some other way: stop waiting, quietly. */
  cancel(): void;
}

function openPopupWindow(authorizationUrl: string): Window | null {
  const width = 600;
  const height = 700;
  const left = window.screenX + (window.outerWidth - width) / 2;
  const top = window.screenY + (window.outerHeight - height) / 2;
  // A fresh name each time, so an old popup holding a stale code is not reused.
  return window.open(
    authorizationUrl,
    `oauth_authorization_${Date.now()}`,
    `width=${width},height=${height},left=${left},top=${top},toolbar=no,location=no,status=no,menubar=no,scrollbars=yes,resizable=yes`,
  );
}

export function startOAuthPopupHandoff(
  options: OAuthPopupHandoffOptions,
): OAuthPopupHandoff {
  const { authorizationUrl, flow, onResult } = options;
  const expectedState = readAuthorizationUrlState(authorizationUrl);
  const cleanups: Array<() => void> = [];
  let finished = false;

  const writeMarker = () =>
    expectedState ? writeOAuthPopupMarker(expectedState, flow) : null;

  const finish = () => {
    if (finished) return false;
    finished = true;
    for (const cleanup of cleanups.splice(0)) cleanup();
    if (expectedState) deleteOAuthPopupMarker(expectedState);
    return true;
  };

  const deliver = (data: unknown) => {
    const message = parseOAuthCallbackMessage(data);
    // Our flows always send `state`; without one, no answer can be matched.
    if (!message || !expectedState || message.state !== expectedState) return;
    if (!finish()) return;
    dismissOAuthCallbackHint();
    onResult(message);
  };

  // Written before the popup opens, so the callback can never beat it.
  const stateHash = writeMarker();

  const handleMessage = (event: MessageEvent) => {
    // The callback page posts to window.location.origin; anything else is a
    // foreign window injecting a code.
    if (event.origin !== window.location.origin) return;
    deliver(event.data);
  };
  window.addEventListener("message", handleMessage);
  cleanups.push(() => window.removeEventListener("message", handleMessage));

  if (stateHash && typeof BroadcastChannel !== "undefined") {
    const channel = new BroadcastChannel(oauthCallbackChannelName(stateHash));
    channel.onmessage = (event) => deliver(event.data);
    cleanups.push(() => channel.close());
  }

  const expire = () => {
    if (!finish()) return;
    showOAuthCallbackHint(options.retryLabel);
    options.onExpire?.();
  };

  if (options.deadlineMs !== undefined) {
    const timer = setTimeout(expire, options.deadlineMs);
    cleanups.push(() => clearTimeout(timer));
  }

  let popup = openPopupWindow(authorizationUrl);

  return {
    get popup() {
      return popup;
    },
    reopen() {
      if (finished) return null;
      writeMarker();
      popup = openPopupWindow(authorizationUrl);
      return popup;
    },
    expire,
    cancel() {
      finish();
    },
  };
}

/** One handoff at a time per component; a new start cancels the last. */
export function useOAuthPopupHandoff() {
  const handoffRef = useRef<OAuthPopupHandoff | null>(null);

  const cancel = useCallback(() => {
    handoffRef.current?.cancel();
    handoffRef.current = null;
  }, []);

  const start = useCallback(
    (options: OAuthPopupHandoffOptions) => {
      cancel();
      const handoff = startOAuthPopupHandoff({
        ...options,
        onResult: (message) => {
          if (handoffRef.current === handoff) handoffRef.current = null;
          options.onResult(message);
        },
        onExpire: () => {
          if (handoffRef.current === handoff) handoffRef.current = null;
          options.onExpire?.();
        },
      });
      handoffRef.current = handoff;
      return handoff;
    },
    [cancel],
  );

  const reopen = useCallback(() => handoffRef.current?.reopen() ?? null, []);

  const expire = useCallback(() => {
    handoffRef.current?.expire();
    handoffRef.current = null;
  }, []);

  // Deferred so StrictMode's mount-time unmount and remount keeps a handoff
  // started during that first mount; a real unmount still cancels it.
  const unmountTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  useEffect(() => {
    clearTimeout(unmountTimerRef.current);
    return () => {
      unmountTimerRef.current = setTimeout(cancel, 0);
    };
  }, [cancel]);

  return { start, reopen, expire, cancel };
}
