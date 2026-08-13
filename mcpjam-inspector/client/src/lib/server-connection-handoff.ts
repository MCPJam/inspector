/**
 * The handoff page's routing and its one piece of cross-navigation state.
 *
 * Two paths, and the difference between them is the whole claim protocol:
 *
 *   /connect/server/<token>          carries the single-use handoff token
 *   /connect/server/request/<id>     carries nothing secret at all
 *
 * The page trades the first for a `__Host-` cookie and then replaces the URL
 * with the second, so the token stops existing in the address bar, in
 * `history`, and in any `Referer` the page later sends. A user who bookmarks
 * or shares what they see after the claim shares an identifier that is
 * deliberately printable and grants nothing.
 *
 * THE MARKER IS NOT A CREDENTIAL, AND MUST NEVER BECOME ONE. Page JavaScript
 * cannot read the continuation cookie — that is the point of it being
 * HttpOnly — so when the authorization server redirects to `/oauth/callback`,
 * nothing in the URL says which flow that callback belongs to. The marker
 * answers only that question. It holds a request id and the `state` this
 * attempt expects, both of which already travel in the open — the request id is
 * printed in tool output, and `state` goes to the provider in a query string.
 * The actual authority for finishing the flow is the cookie the browser sends
 * automatically. Putting anything else in here would move a secret into storage
 * that any script on this origin can read.
 *
 * IT MATCHES ON `state`, NOT MERELY ON EXISTENCE. `/oauth/callback` is shared
 * with the Inspector's own OAuth flow. A marker that claimed any callback would
 * swallow that flow's callbacks in the same tab the moment someone abandoned a
 * handoff — a bug with no error and no obvious cause. Requiring the returning
 * `state` to be the one this attempt sent makes the branch unambiguous, and the
 * expiry means an abandoned attempt stops claiming anything at all.
 *
 * `sessionStorage`, not `localStorage`: the flow lives inside one tab's visit,
 * and a marker that outlived the tab would follow the user into unrelated work.
 */

const TOKEN_PATH = /^\/connect\/server\/([A-Za-z0-9_-]+)\/?$/;
const REQUEST_PATH = /^\/connect\/server\/request\/([A-Za-z0-9_-]+)\/?$/;

const MARKER_KEY = "mcpjam-server-connection-pending";

export type HandoffRoute =
  | { kind: "claim"; handoffToken: string }
  | { kind: "request"; requestId: string };

/**
 * Which handoff page — if either — this path is.
 *
 * `request` is checked first because `/connect/server/request/<id>` also
 * matches the shape of a token path if you only look at the segment count, and
 * treating a request id as a handoff token would burn a claim that cannot
 * succeed.
 */
export function matchHandoffRoute(pathname: string): HandoffRoute | null {
  const request = REQUEST_PATH.exec(pathname);
  if (request?.[1]) {
    return { kind: "request", requestId: request[1] };
  }
  const token = TOKEN_PATH.exec(pathname);
  // "request" is a literal segment, not a token — the regex above already
  // claimed it, and this guard covers the bare `/connect/server/request` case
  // that neither pattern should treat as a token.
  if (token?.[1] && token[1] !== "request") {
    return { kind: "claim", handoffToken: token[1] };
  }
  return null;
}

export function handoffRequestPath(requestId: string): string {
  return `/connect/server/request/${requestId}`;
}

/** An attempt cannot outlive the request it belongs to, and the backend caps
 * that at an hour. A marker past this point is abandoned, and abandoned markers
 * must stop claiming callbacks. */
const MARKER_TTL_MS = 60 * 60 * 1000;

export interface PendingAuthorization {
  requestId: string;
  /** The `state` this attempt sent, read back out of the authorization URL. */
  state: string;
  expiresAt: number;
}

export function rememberPendingAuthorization(
  requestId: string,
  authorizationUrl: string,
  now: number = Date.now()
): void {
  let state: string | null = null;
  try {
    state = new URL(authorizationUrl).searchParams.get("state");
  } catch {
    state = null;
  }
  if (!state) return;
  try {
    sessionStorage.setItem(
      MARKER_KEY,
      JSON.stringify({ requestId, state, expiresAt: now + MARKER_TTL_MS })
    );
  } catch {
    // Storage can be unavailable (private mode, a blocked partition). The flow
    // still completes — the callback simply cannot route itself back, and the
    // user lands on the app shell rather than the handoff page. Failing the
    // authorization over it would be worse.
  }
}

export function readPendingAuthorization(
  now: number = Date.now()
): PendingAuthorization | null {
  try {
    const raw = sessionStorage.getItem(MARKER_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<PendingAuthorization>;
    if (
      typeof parsed?.requestId !== "string" ||
      typeof parsed?.state !== "string" ||
      typeof parsed?.expiresAt !== "number"
    ) {
      return null;
    }
    if (parsed.expiresAt <= now) return null;
    return parsed as PendingAuthorization;
  } catch {
    // Unreadable storage, or a marker written by an older build. Either way it
    // is not a marker this code can act on, and guessing would be worse than
    // letting the callback fall through to the flow that does understand it.
    return null;
  }
}

/** Whether this callback is the one that marker is waiting for. Existence alone
 * is not enough — see the module docblock. */
export function callbackMatchesPending(
  pending: PendingAuthorization | null,
  callback: CallbackParams | null
): boolean {
  return Boolean(pending && callback && pending.state === callback.state);
}

export function clearPendingAuthorization(): void {
  try {
    sessionStorage.removeItem(MARKER_KEY);
  } catch {
    // Nothing to do — see above.
  }
}

export interface CallbackParams {
  state: string;
  code?: string;
  iss?: string;
  error?: string;
  errorDescription?: string;
}

/**
 * Read an OAuth callback's query, or decline it.
 *
 * Declining matters as much as reading. `/oauth/callback` is shared with the
 * Inspector's own OAuth flow, and a marker left by a connection attempt must
 * not capture a callback that belongs to something else — so a callback is
 * only ours when it carries a `state` AND one of the two things an
 * authorization server can answer with.
 */
export function readCallbackParams(search: string): CallbackParams | null {
  const params = new URLSearchParams(search);
  const state = params.get("state")?.trim();
  if (!state) return null;

  const code = params.get("code")?.trim() || undefined;
  const error = params.get("error")?.trim() || undefined;
  if (!code && !error) return null;

  return {
    state,
    code,
    error,
    iss: params.get("iss")?.trim() || undefined,
    // Bounded because it is a third party's prose and it ends up rendered.
    errorDescription:
      params.get("error_description")?.trim().slice(0, 300) || undefined,
  };
}

/** Statuses from which nothing further happens, mirroring the backend's
 * `TERMINAL_STATUSES`. The page stops polling on these. */
const TERMINAL = new Set(["ready", "failed", "expired", "cancelled"]);

export function isTerminalHandoffStatus(status: string): boolean {
  return TERMINAL.has(status);
}

/** Statuses where the page is waiting on work it did not start and cannot
 * hurry — the worker's, or the user's, elsewhere. */
const WAITING = new Set(["discovering", "authorizing", "validating"]);

export function isWaitingHandoffStatus(status: string): boolean {
  return WAITING.has(status);
}
