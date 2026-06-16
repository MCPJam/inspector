import { type Context } from "hono";
import {
  fetchConvexGuestSession,
  fetchRemoteGuestSession,
  type GuestSessionFetchContext,
  type RemoteGuestSession,
} from "../../utils/guest-session-source.js";
import { getClientIp } from "../../utils/client-ip.js";
import { hashGuestSpendIp } from "../../utils/guest-spend-ip.js";

// IP-based rate limiting: 10 req/min per IP (sliding window).
//
// This state is a SINGLE shared singleton intentionally exported via
// `allowMint(ip)` so the client `/api/web/guest-session` route AND the
// document-bootstrap path draw from the SAME per-IP budget. Importing this
// module from both keeps them on one limiter rather than two parallel ones.
const ipWindows = new Map<string, { count: number; windowStart: number }>();
const IP_RATE_LIMIT = 10;
const IP_WINDOW_MS = 60_000;

// Cleanup stale entries every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of ipWindows) {
    if (now - entry.windowStart > IP_WINDOW_MS * 2) {
      ipWindows.delete(ip);
    }
  }
}, 5 * 60_000).unref();

/**
 * Consume one unit of the per-IP rate-limit budget for `ip`. Returns `true`
 * when the request is within budget (and records the consumption), `false`
 * when the IP has exceeded `IP_RATE_LIMIT` within the current window.
 *
 * Shared singleton: both the client route and the document bootstrap call
 * this so a guest cannot get 2x the budget by alternating paths.
 */
export function allowMint(ip: string): boolean {
  const now = Date.now();
  const entry = ipWindows.get(ip);
  if (entry) {
    if (now - entry.windowStart < IP_WINDOW_MS) {
      if (entry.count >= IP_RATE_LIMIT) {
        return false;
      }
      entry.count++;
      return true;
    }
    // Reset window
    entry.count = 1;
    entry.windowStart = now;
    return true;
  }
  ipWindows.set(ip, { count: 1, windowStart: now });
  return true;
}

export const GUEST_SESSION_COOKIE_NAME = "__Host-mcpjam_guest_session";
const LOCAL_GUEST_SESSION_COOKIE_NAME = "mcpjam_guest_session";
const LOCAL_GUEST_SESSION_HOSTNAMES = new Set(["localhost", "127.0.0.1"]);

// Forward only the guest-session cookie to the upstream guest service.
// Passing the entire Cookie header would leak unrelated auth/CSRF cookies
// from the Inspector origin to Convex / hosted MCPJam.
function extractCookieValue(
  cookieHeader: string | null | undefined,
  cookieName: string
): string | null {
  if (!cookieHeader) return null;
  const prefix = `${cookieName}=`;
  for (const part of cookieHeader.split(/;\s*/)) {
    if (part.startsWith(prefix)) {
      return part.slice(prefix.length);
    }
  }
  return null;
}

export function extractGuestSessionCookie(
  cookieHeader: string | null | undefined
): string | null {
  const localCookie = extractCookieValue(
    cookieHeader,
    LOCAL_GUEST_SESSION_COOKIE_NAME
  );
  if (localCookie) {
    return `${GUEST_SESSION_COOKIE_NAME}=${localCookie}`;
  }

  const upstreamCookie = extractCookieValue(
    cookieHeader,
    GUEST_SESSION_COOKIE_NAME
  );
  return upstreamCookie
    ? `${GUEST_SESSION_COOKIE_NAME}=${upstreamCookie}`
    : null;
}

function isLocalHttpRequest(requestUrl: string): boolean {
  try {
    const url = new URL(requestUrl);
    return (
      url.protocol === "http:" &&
      LOCAL_GUEST_SESSION_HOSTNAMES.has(url.hostname)
    );
  } catch {
    return false;
  }
}

function rewriteGuestSessionCookieForLocalHttp(cookie: string): string {
  const parts = cookie
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean);
  const [nameValue, ...attributes] = parts;
  if (!nameValue?.startsWith(`${GUEST_SESSION_COOKIE_NAME}=`)) {
    return cookie;
  }

  return [
    nameValue.replace(
      `${GUEST_SESSION_COOKIE_NAME}=`,
      `${LOCAL_GUEST_SESSION_COOKIE_NAME}=`
    ),
    ...attributes.filter((attribute) => !/^secure$/i.test(attribute)),
  ].join("; ");
}

export function appendGuestSessionSetCookie(c: Context, cookie: string): void {
  c.header("Set-Cookie", cookie, { append: true });
  if (isLocalHttpRequest(c.req.url)) {
    const localCookie = rewriteGuestSessionCookieForLocalHttp(cookie);
    if (localCookie !== cookie) {
      c.header("Set-Cookie", localCookie, { append: true });
    }
  }
}

export function shouldFetchGuestSessionFromConvex(): boolean {
  if (process.env.VITE_MCPJAM_HOSTED_MODE === "true") {
    return true;
  }

  return process.env.NODE_ENV !== "production";
}

// Hard deadline for the document-bootstrap mint. Bounds the ENTIRE mint path
// (including `provisionGuestAuthConfigToConvex()` inside
// `fetchConvexGuestSession`), not just the inner fetch — see the comment in
// `mintGuestSessionForDocument`.
const DOCUMENT_MINT_DEADLINE_MS = 1500;

export type DocumentGuestMintResult = {
  session: RemoteGuestSession | null;
  setCookies: string[];
};

/**
 * Mint (or look up) a guest session during a document (SPA HTML) request.
 *
 * Builds the same `GuestSessionFetchContext` the client route builds
 * (request cookie, UA, hashed client IP, `mode: "lookup_or_create"`), selects
 * the Convex vs remote source, and races the ENTIRE mint against a hard
 * deadline.
 *
 * Why the whole-helper race (not just the fetch's AbortSignal):
 * `fetchConvexGuestSession()` awaits `provisionGuestAuthConfigToConvex()`
 * BEFORE the fetch's `AbortSignal.timeout` applies. A hung provisioning step
 * would otherwise leave TTFB unbounded even with a capped fetch. Racing the
 * whole `mint()` promise guarantees the document handler can never block past
 * the deadline; losing the race abandons the mint and serves blob-less.
 *
 * Never throws and never rate-limit-fails the caller — on any failure,
 * timeout, or rate-limit cap the caller simply serves the HTML without a blob
 * and the client falls back to its own POST mint path.
 */
export async function mintGuestSessionForDocument(
  c: Context
): Promise<DocumentGuestMintResult> {
  const empty: DocumentGuestMintResult = { session: null, setCookies: [] };

  const ip = getClientIp(c);
  // Match the client route's rate-limit key behavior: a missing IP keys to
  // "local-dev" so non-prod runs aren't starved. The route hard-fails a
  // missing IP in production, but the document path must NEVER fail the HTML,
  // so we degrade to blob-less instead.
  if (!ip && process.env.NODE_ENV === "production") {
    return empty;
  }
  const rateLimitKey = ip ?? "local-dev";
  if (!allowMint(rateLimitKey)) {
    return empty;
  }

  let ipHash: string | null = null;
  try {
    ipHash = ip ? await hashGuestSpendIp(ip) : null;
  } catch {
    ipHash = null;
  }

  const context: GuestSessionFetchContext = {
    cookie: extractGuestSessionCookie(c.req.header("cookie")),
    userAgent: c.req.header("user-agent") ?? null,
    body: { mode: "lookup_or_create" },
    ...(ipHash ? { ipHash } : {}),
  };

  const mint = async (): Promise<DocumentGuestMintResult> => {
    const result = shouldFetchGuestSessionFromConvex()
      ? await fetchConvexGuestSession(context, DOCUMENT_MINT_DEADLINE_MS)
      : await fetchRemoteGuestSession(context, DOCUMENT_MINT_DEADLINE_MS);

    if (result.kind === "session") {
      return { session: result.session, setCookies: result.setCookies };
    }
    return { session: null, setCookies: result.setCookies };
  };

  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<DocumentGuestMintResult>((resolve) => {
    timeoutHandle = setTimeout(() => resolve(empty), DOCUMENT_MINT_DEADLINE_MS);
  });

  try {
    return await Promise.race([mint(), deadline]);
  } catch {
    // Defense-in-depth: mint() is written to not throw, but never let a
    // bootstrap mint failure escape into the document handler.
    return empty;
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
  }
}

function escapeGuestBootstrapJson(json: string): string {
  return json.replace(/[<>&\u2028\u2029]/g, (ch) => {
    switch (ch) {
      case "<":
        return "\\u003c";
      case ">":
        return "\\u003e";
      case "&":
        return "\\u0026";
      case "\u2028":
        return "\\u2028";
      case "\u2029":
        return "\\u2029";
      default:
        return ch;
    }
  });
}

/**
 * Build the `window.__MCP_GUEST_BOOTSTRAP__` injection script for a minted
 * session, escaping `<`, `>`, `&`, U+2028 and U+2029 in the JSON so the
 * embedded payload can never break out of the `<script>` element.
 */
export function buildGuestBootstrapScript(
  session: RemoteGuestSession
): string {
  const json = escapeGuestBootstrapJson(
    JSON.stringify({
      token: session.token,
      guestId: session.guestId,
      expiresAt: session.expiresAt,
    })
  );
  return `<script>window.__MCP_GUEST_BOOTSTRAP__=${json};</script>`;
}
