// Keep this module dependency-free: main captures the callback before loading
// the app, analytics, error reporting, or any OAuth modules (the same reason
// `access-link.ts` is dependency-free).

/**
 * The OAuth callback inbox: where an MCP server's authorization answer waits
 * once it has been taken out of the address bar.
 *
 * WHY THE ANSWER LEAVES THE URL. An authorization server returns to
 * `/oauth/callback?code=…&state=…`, and the code is a one-time credential.
 * Everything that observes the page sees the address bar — PostHog's
 * `$current_url` and session replay, Sentry's transaction names and
 * breadcrumbs, the `Referer` of every request the page makes, the history
 * entry the back button returns to. The telemetry sinks scrub what they
 * receive, but scrubbing is a second line; the first is for the code not to be
 * there. So `main.tsx` moves the parameters in here BEFORE it imports
 * `app-bootstrap` (which starts Sentry and PostHog), and replaces the URL with
 * the same pathname and `?oauth_pending=1`. That marker is the only trace the
 * callback leaves in the URL: it says "the answer is in the inbox", and it
 * carries nothing.
 *
 * WHAT IS CAPTURED: every query parameter, not a list. The readers need
 * `code`, `state`, `error`, `error_description`, `error_uri` and `iss`; the
 * desktop hand-offs (`electron-mcp-callback.ts`, `OAuthDebugCallback`) forward
 * the WHOLE query to the app, and providers add their own (`session_state`).
 * Everything an authorization server put on our redirect URI is its answer.
 *
 * THE FRAGMENT is kept only when it is a plain anchor or carries only
 * non-secret-looking keys. A `response_mode=fragment` provider would put the
 * code there; nothing in this app reads a callback fragment, so losing one
 * costs nothing.
 *
 * PERSISTENCE: memory only. The code is a credential, and a copy in any
 * storage outlives the page that needed it — so a reload of the pending page
 * (a user refreshing a slow exchange, or `main.tsx`'s own "Reload MCPJam"
 * recovery) does not restore it. It is answered instead with the explicit
 * "expired" error below, and the user starts the connection again. The code
 * is single-use and expires within minutes anyway, so a retry is what a
 * restored copy would usually have come to.
 *
 * A RELOAD OF THE PENDING PAGE is answered with an explicit `error` instead of an empty inbox. Every reader
 * already has an error path that tells the user and routes them home; an
 * empty inbox on `/oauth/callback` would instead leave the app on its
 * callback loading screen with nothing that could ever finish it.
 *
 * THE URL FALLBACK. On a callback path WITHOUT the marker, the readers see the
 * query as it stands. That is what happens on any load that did not go through
 * `main.tsx` (a unit test rendering a component directly, a future entry
 * point). It is not the production path, and it deliberately does not scrub:
 * a `replaceState` issued from inside a render would desync the router, which
 * never observes it.
 */

/** Query key of the marker the scrubbed callback URL carries. */
export const OAUTH_PENDING_PARAM = "oauth_pending";

/** The marker's value. */
export const OAUTH_PENDING_VALUE = "1";

/** What a reload with nothing to restore answers with. */
export const OAUTH_CALLBACK_EXPIRED_ERROR = "invalid_request";
export const OAUTH_CALLBACK_EXPIRED_DESCRIPTION =
  "The authorization response was no longer available after the page reloaded. Start the connection again.";

interface InboxEntry {
  /** The callback pathname the answer arrived on. */
  pathname: string;
  /** The answer, as a query string without `?`. */
  params: string;
  /** Which callback this is: every capture and deposit gets a new one. */
  attempt: string;
}

let inbox: InboxEntry | null = null;
let attempts = 0;

function nextAttempt(): string {
  attempts += 1;
  return `inbox:${attempts}`;
}

/**
 * The MCP server OAuth callback routes: `/oauth/callback` and everything
 * under it (the debugger's `/oauth/callback/debug`). Not the WorkOS sign-in's
 * `/callback` — authkit-js owns that one.
 */
export function isOAuthCallbackPath(pathname: string): boolean {
  return (
    pathname === "/oauth/callback" || pathname.startsWith("/oauth/callback/")
  );
}

/** Whether a query string is the scrubbed callback's marker. */
export function hasOAuthPendingMarker(search: string): boolean {
  try {
    return (
      new URLSearchParams(search).get(OAUTH_PENDING_PARAM) ===
      OAUTH_PENDING_VALUE
    );
  } catch {
    return false;
  }
}

/** The URL a callback's answer is parked behind. */
export function oauthPendingPath(pathname: string): string {
  return `${pathname}?${OAUTH_PENDING_PARAM}=${OAUTH_PENDING_VALUE}`;
}

const SECRET_LOOKING_KEY =
  /token|secret|code|key|sig|cred|pass|state|session|auth|ticket|assertion/i;
const PLAIN_ANCHOR = /^[A-Za-z][\w-]{0,63}$/;

/**
 * Whether a fragment may stay on the scrubbed URL: a plain anchor
 * (`#tools`, which `consumeAccessLinkFromUrl` leaves behind), or key/value
 * pairs none of whose keys looks like a credential. Anything else — including
 * an opaque value that might be a bare token — is dropped.
 */
function isSafeFragment(hash: string): boolean {
  const body = hash.startsWith("#") ? hash.slice(1) : hash;
  if (!body) return false;
  if (!body.includes("=")) return PLAIN_ANCHOR.test(body);
  return body.split("&").every((pair) => {
    const key = pair.split("=", 1)[0] ?? "";
    try {
      const decoded = decodeURIComponent(key);
      return decoded !== "" && !SECRET_LOOKING_KEY.test(decoded);
    } catch {
      return false;
    }
  });
}

/**
 * Move an MCP OAuth callback's answer from the address bar into the inbox.
 * Runs once, in `main.tsx`, before telemetry exists.
 *
 *  - A callback path with a query: every parameter goes into the inbox, and
 *    the URL becomes `<pathname>?oauth_pending=1`,
 *    keeping `history.state` and any fragment that carries no secret.
 *  - A callback path with only the marker: a reload of the pending page.
 *    Nothing survived it (memory only), so the answer is the explicit
 *    "expired" error (see the module docblock).
 *  - Anything else: untouched.
 *
 * Returns whether the inbox now holds an answer.
 */
export function captureOAuthCallbackFromUrl(): boolean {
  if (typeof window === "undefined") return false;
  const { pathname, search, hash } = window.location;
  if (!isOAuthCallbackPath(pathname)) return false;

  const params = new URLSearchParams(search);
  const marked = params.get(OAUTH_PENDING_PARAM) === OAUTH_PENDING_VALUE;
  params.delete(OAUTH_PENDING_PARAM);

  if ([...params.keys()].length > 0) {
    inbox = { pathname, params: params.toString(), attempt: nextAttempt() };
  } else if (marked) {
    if (inbox?.pathname === pathname) return true;
    inbox = {
      attempt: nextAttempt(),
      pathname,
      params: new URLSearchParams({
        error: OAUTH_CALLBACK_EXPIRED_ERROR,
        error_description: OAUTH_CALLBACK_EXPIRED_DESCRIPTION,
      }).toString(),
    };
  } else {
    return false;
  }

  const keptHash = hash && isSafeFragment(hash) ? hash : "";
  try {
    history.replaceState(
      history.state,
      "",
      `${oauthPendingPath(pathname)}${keptHash}`,
    );
  } catch {
    // A sandboxed document can refuse replaceState. The readers still find
    // the answer in the inbox; only the address bar is left as it was.
  }
  return true;
}

/**
 * Put an answer that arrived some other way into the inbox — the desktop app
 * receives it on its custom scheme and routes itself to the callback page —
 * and return the URL to navigate to, so the code is never written into the
 * address bar at all.
 */
export function depositOAuthCallbackParams(
  params: URLSearchParams,
  pathname = "/oauth/callback",
): string {
  const copy = new URLSearchParams(params);
  copy.delete(OAUTH_PENDING_PARAM);
  inbox = { pathname, params: copy.toString(), attempt: nextAttempt() };
  return oauthPendingPath(pathname);
}

/**
 * The callback's answer, or `null`. Non-destructive: every reader on the page
 * may ask, any number of times (StrictMode runs effects twice).
 *
 * Scoped like the URL it replaces: it answers only while the page is still
 * on the callback pathname, so once the owner navigates away the answer
 * stops existing for every reader at once — exactly as `?code=` used to when
 * the route was restored.
 */
export function readOAuthCallbackParams(): URLSearchParams | null {
  if (typeof window === "undefined") return null;
  const { pathname, search } = window.location;
  if (!isOAuthCallbackPath(pathname)) return null;
  if (hasOAuthPendingMarker(search)) {
    return inbox && inbox.pathname === pathname
      ? new URLSearchParams(inbox.params)
      : null;
  }
  // The URL fallback; see the module docblock.
  const params = new URLSearchParams(search);
  return [...params.keys()].length > 0 ? params : null;
}

/**
 * WHICH callback answer the page is showing, or `null` when it shows none.
 *
 * Every pending page has the same URL now (`/oauth/callback?oauth_pending=1`),
 * so the URL can no longer tell one authorization attempt from the next: a
 * slow completion of attempt A could otherwise finalize, consume and navigate
 * away from attempt B's answer. Owners capture this when they start and
 * compare it before they finish; effects key on it so a second answer
 * deposited onto the same URL runs them again.
 */
export function readOAuthCallbackAttempt(): string | null {
  if (typeof window === "undefined") return null;
  const { pathname, search } = window.location;
  if (!isOAuthCallbackPath(pathname)) return null;
  if (hasOAuthPendingMarker(search)) {
    return inbox && inbox.pathname === pathname ? inbox.attempt : null;
  }
  // The URL fallback: the query itself is the identity, as it always was.
  return search && search !== "?" ? `url:${search}` : null;
}

/**
 * Whether a callback answer is waiting: a `code` or an `error`, the two
 * things an authorization server can answer with.
 */
export function hasPendingOAuthCallback(): boolean {
  const params = readOAuthCallbackParams();
  return Boolean(params && (params.has("code") || params.has("error")));
}

/**
 * Take the answer and clear it — only if it is still `attempt`'s, when one is
 * named. Called by the
 * owner that finished the callback, right before it leaves the callback
 * route, so the code does not outlive the flow it belonged to.
 */
export function consumeOAuthCallbackParams(
  attempt?: string | null,
): URLSearchParams | null {
  // An owner that names its attempt only ever consumes its own answer: a
  // newer one deposited meanwhile belongs to someone else.
  if (attempt !== undefined && attempt !== readOAuthCallbackAttempt()) {
    return null;
  }
  const params = readOAuthCallbackParams();
  inbox = null;
  return params;
}

/** Test-only: forget everything. */
export function resetOAuthCallbackInboxForTests(): void {
  inbox = null;
}
