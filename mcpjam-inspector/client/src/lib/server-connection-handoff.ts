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

const SIGN_IN_RETURN_KEY = "mcpjam-server-connection-sign-in-return";

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
      // `Number.isFinite`, not just `typeof === "number"`. `Infinity` and `NaN`
      // are both numbers and both survive the comparison below — `Infinity` is
      // never `<= now`, and every comparison with `NaN` is false — so either one
      // produces a marker that outlives the TTL this function exists to enforce.
      !Number.isFinite(parsed?.expiresAt)
    ) {
      return null;
    }
    if (parsed.expiresAt! <= now) return null;
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

/**
 * Coming back to a handoff link after signing in.
 *
 * The backend refuses an account-owned link to a visitor it cannot identify,
 * and the answer is "sign in" — but signing in is a full-page redirect to
 * WorkOS and back to `/callback`, which is not this page. Something has to
 * carry the way home across that round trip.
 *
 * WHAT CROSSES THE NETWORK IS A NONCE, NOT THE LINK. AuthKit round-trips its
 * `state` through the authorization server, so anything put there is written
 * into a WorkOS request, a redirect URL, and this browser's history. The
 * handoff token must not be in any of those, so `state` carries only a random
 * correlator and the return path stays in `sessionStorage`, same-origin.
 *
 * THIS IS THE ONE PLACE THE MODULE STORES SOMETHING SENSITIVE, and it is worth
 * being explicit about why it is allowed here when the docblock above forbids
 * it for the pending-authorization marker. The return path contains the handoff
 * token — but at the moment it is written, that token is already in
 * `window.location`, readable by any script on this origin. What storage adds
 * is not readability, it is LIFETIME: the token would outlive the navigation
 * that removes it from the address bar. So the lifetime is cut back on three
 * sides — the marker is single-use (reading it deletes it), it expires in
 * minutes rather than the request's hour, and the successful claim on return
 * consumes the token itself.
 *
 * It is matched on the nonce for the same reason the pending marker is matched
 * on `state`: a sign-in the user started somewhere else in this tab must not be
 * hijacked into a handoff page they had already walked away from.
 */

/** Long enough to sign in, including a password reset or an emailed code;
 * short enough that an abandoned attempt stops holding a token. The request
 * itself still expires on the backend's own one-hour clock. */
const SIGN_IN_RETURN_TTL_MS = 15 * 60 * 1000;

interface HandoffSignInReturn {
  path: string;
  nonce: string;
  expiresAt: number;
}

/**
 * A same-origin path that is safe to send a browser to after login.
 *
 * Rejects anything that could leave this origin. `//evil.com` and `/\evil.com`
 * are the two that matter: both start with `/`, and both are read by browsers
 * as protocol-relative URLs pointing somewhere else entirely. Parsing against
 * the origin and re-checking is the belt to that braces.
 */
export function safeReturnPath(value: unknown, origin: string): string | null {
  if (typeof value !== "string" || !value.startsWith("/")) return null;
  if (value.startsWith("//") || value.startsWith("/\\")) return null;
  try {
    const url = new URL(value, origin);
    if (url.origin !== origin) return null;
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return null;
  }
}

function mintNonce(): string {
  try {
    return crypto.randomUUID();
  } catch {
    // Only a correlator, never a capability — the marker it points at is
    // already scoped to this tab, so a weaker source here costs nothing.
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  }
}

/**
 * Remember where to come back to, and return the nonce to send through
 * AuthKit's `state`.
 *
 * Returns `null` when the path is unsafe or storage is unavailable — the
 * caller then signs the user in WITHOUT a return, which lands them on the app
 * shell. Worse, but not broken: the link is still valid and still in their
 * terminal.
 */
export function rememberHandoffSignInReturn(
  path: string,
  origin: string,
  now: number = Date.now()
): string | null {
  const safe = safeReturnPath(path, origin);
  if (!safe) return null;
  const nonce = mintNonce();
  try {
    sessionStorage.setItem(
      SIGN_IN_RETURN_KEY,
      JSON.stringify({
        path: safe,
        nonce,
        expiresAt: now + SIGN_IN_RETURN_TTL_MS,
      })
    );
    return nonce;
  } catch {
    return null;
  }
}

/**
 * Consume the return path for this nonce, or `null`.
 *
 * ALWAYS deletes the marker, including on a mismatch. The marker holds a
 * handoff token; leaving it behind because the nonce did not line up would keep
 * that token alive for the rest of the tab's life on exactly the path where
 * something has already gone sideways.
 */
export function takeHandoffSignInReturn(
  nonce: unknown,
  origin: string,
  now: number = Date.now()
): string | null {
  let raw: string | null = null;
  try {
    raw = sessionStorage.getItem(SIGN_IN_RETURN_KEY);
    sessionStorage.removeItem(SIGN_IN_RETURN_KEY);
  } catch {
    return null;
  }
  if (!raw || typeof nonce !== "string" || !nonce) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<HandoffSignInReturn>;
    if (
      typeof parsed?.path !== "string" ||
      typeof parsed?.nonce !== "string" ||
      !Number.isFinite(parsed?.expiresAt)
    ) {
      return null;
    }
    if (parsed.expiresAt! <= now) return null;
    if (parsed.nonce !== nonce) return null;
    // Re-validated on the way out, not merely on the way in: what is parsed
    // here is whatever is in storage now, which is not necessarily what this
    // build wrote.
    return safeReturnPath(parsed.path, origin);
  } catch {
    return null;
  }
}

/**
 * Which request a spent handoff token became.
 *
 * WHAT THIS EXISTS TO PREVENT. The continuation cookie has ONE name, so it
 * always describes the last link this browser claimed — not the link in the
 * address bar. When a spent token's claim fails, asking `/state` answers "your
 * most recent request", and a browser that claimed link A and then link B would
 * answer a reopened A with B: a different server, possibly a different project,
 * silently swapped in behind the same URL the user just opened. Resuming has to
 * mean "this link", not "some link of yours".
 *
 * So the claim records what it produced, and a resume proceeds only when the
 * cookie names that same request. A mismatch is not a resume — it is an honest
 * used-link screen, because the session that link belonged to really is gone.
 *
 * `localStorage`, unlike everything else in this module: the case this serves is
 * reopening the link, and a link is reopened in a NEW TAB more often than not.
 * The cookie it is checked against is per-browser, so a per-tab record would go
 * missing in exactly the situation it exists for.
 *
 * THE TOKEN IT KEYS ON IS ALREADY SPENT. This is written after a claim
 * SUCCEEDS, and a successful claim is what consumes the token — what lands in
 * storage is a value that no longer opens anything, paired with a request id
 * that is printed in tool output anyway. The lifetime still matches the
 * backend's own hour, so an old record cannot answer for a request that has
 * long since expired.
 */
const CLAIMED_KEY = "mcpjam-server-connection-claimed";

interface ClaimedHandoff {
  handoffToken: string;
  requestId: string;
  expiresAt: number;
}

export function rememberClaimedHandoff(
  handoffToken: string,
  requestId: string,
  now: number = Date.now()
): void {
  try {
    localStorage.setItem(
      CLAIMED_KEY,
      JSON.stringify({
        handoffToken,
        requestId,
        expiresAt: now + MARKER_TTL_MS,
      })
    );
  } catch {
    // Unavailable storage costs the resume, not the flow: the claim already
    // succeeded, and this run of the page continues normally. Only a LATER
    // reopen is affected, and it degrades to the used-link screen — the same
    // answer this page gave before resuming existed.
  }
}

/**
 * The request this token became, if this browser is the one that claimed it.
 *
 * Returns `null` for a token this browser never claimed, for a record past the
 * request's own hour, and for anything unreadable — every one of which means
 * the caller cannot prove the link is theirs, which is the only condition that
 * licenses a resume.
 */
export function readClaimedHandoff(
  handoffToken: string,
  now: number = Date.now()
): string | null {
  try {
    const raw = localStorage.getItem(CLAIMED_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<ClaimedHandoff>;
    if (
      typeof parsed?.handoffToken !== "string" ||
      typeof parsed?.requestId !== "string" ||
      !Number.isFinite(parsed?.expiresAt)
    ) {
      return null;
    }
    if (parsed.expiresAt! <= now) return null;
    if (parsed.handoffToken !== handoffToken) return null;
    return parsed.requestId;
  } catch {
    return null;
  }
}

/** The key AuthKit's round-tripped `state` carries the nonce under. */
export const HANDOFF_SIGN_IN_STATE_KEY = "mcpjamHandoffReturn";

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
