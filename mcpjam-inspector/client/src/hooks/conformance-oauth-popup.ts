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
