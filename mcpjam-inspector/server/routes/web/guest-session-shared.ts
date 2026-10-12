import { type Context } from "hono";
import { getConnInfo } from "@hono/node-server/conninfo";
import {
  fetchGuestSession,
  type GuestSessionFetchContext,
  type RemoteGuestSession,
} from "../../utils/guest-session-source.js";
import { getSpendClientIp } from "../../utils/client-ip.js";
import { hashGuestSpendIp } from "../../utils/guest-spend-ip.js";
import {
  applyScopedCookieWrites,
  usesScopedSessionCookies,
} from "../../utils/scoped-cookie-context.js";
import type { ScopedCookieWrite } from "../../utils/scoped-cookies.js";
import {
  applyUpstreamGuestCookies,
  resolveLocalGuestCookie,
  upstreamGuestCookieHeader,
  upstreamGuestCookieWrites,
} from "./guest-cookie-scope.js";

// IP-based rate limiting: 10 req/min per IP (sliding window).
//
// This state is a SINGLE shared singleton intentionally exported via
// `consumeMintBudget` so the client `/api/web/guest-session` route AND the
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

export type MintBudget =
  | { allowed: true }
  | { allowed: false; retryAfterSeconds: number };

/**
 * Consume one unit of the per-IP rate-limit budget for `ip`. When the IP has
 * exceeded `IP_RATE_LIMIT` within the current window, says how long until the
 * window resets instead.
 */
function allowMint(ip: string): MintBudget {
  const now = Date.now();
  const entry = ipWindows.get(ip);
  if (entry) {
    if (now - entry.windowStart < IP_WINDOW_MS) {
      if (entry.count >= IP_RATE_LIMIT) {
        return {
          allowed: false,
          retryAfterSeconds: Math.max(
            1,
            Math.ceil((entry.windowStart + IP_WINDOW_MS - now) / 1000)
          ),
        };
      }
      entry.count++;
      return { allowed: true };
    }
    // Reset window
    entry.count = 1;
    entry.windowStart = now;
    return { allowed: true };
  }
  ipWindows.set(ip, { count: 1, windowStart: now });
  return { allowed: true };
}

const LOOPBACK_ADDRESSES = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

/**
 * A request this machine made to its own local Inspector: not hosted mode, the
 * TCP peer is loopback, and so is the client IP the limiter would key on. All
 * three, so a same-host reverse proxy forwarding someone else's IP is still
 * limited, and a remote caller cannot qualify by sending a loopback
 * `x-forwarded-for`.
 *
 * Every tab, reload and dev-server restart on a developer's machine shares the
 * one loopback key, so the limiter only ever throttled the developer. The
 * authority still caps guest CREATION per IP on its side.
 */
function isLocalLoopbackRequest(c: Context, ip: string | null): boolean {
  if (process.env.VITE_MCPJAM_HOSTED_MODE === "true") return false;
  if (!ip || !LOOPBACK_ADDRESSES.has(ip)) return false;
  try {
    const peer = getConnInfo(c).remote.address;
    return peer !== undefined && LOOPBACK_ADDRESSES.has(peer);
  } catch {
    return false;
  }
}

/**
 * Charge one guest-session request from `ip` (null keys to "local-dev") to the
 * per-IP budget, unless it is this machine calling its own local Inspector.
 *
 * Shared singleton: both the client route and the document bootstrap call
 * this so a guest cannot get 2x the budget by alternating paths.
 */
export function consumeMintBudget(c: Context, ip: string | null): MintBudget {
  if (isLocalLoopbackRequest(c, ip)) return { allowed: true };
  return allowMint(ip ?? "local-dev");
}

export const GUEST_SESSION_COOKIE_NAME = "__Host-mcpjam_guest_session";

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

/**
 * The guest cookie a NON-loopback (hosted / own-hostname) request carries, in
 * the form the authority expects. Loopback requests never use this: they keep
 * the guest in their namespace's scoped cookie (`guest-cookie-scope.ts`).
 */
export function extractGuestSessionCookie(
  cookieHeader: string | null | undefined
): string | null {
  const upstreamCookie = extractCookieValue(
    cookieHeader,
    GUEST_SESSION_COOKIE_NAME
  );
  return upstreamCookie
    ? `${GUEST_SESSION_COOKIE_NAME}=${upstreamCookie}`
    : null;
}

/**
 * Pass the authority's guest `Set-Cookie` through on a non-loopback request.
 * A loopback request mirrors it into its scoped cookie instead and never
 * emits the upstream cookie (`applyUpstreamGuestCookies`).
 */
export function appendGuestSessionSetCookie(c: Context, cookie: string): void {
  if (usesScopedSessionCookies(c)) {
    applyUpstreamGuestCookies(c, [cookie]);
    return;
  }
  c.header("Set-Cookie", cookie, { append: true });
}

// Hard deadline for the document-bootstrap mint. Bounds the ENTIRE mint path
// (a legacy-cookie lookup included), not just the inner fetch — see the
// comment in `mintGuestSessionForDocument`.
const DOCUMENT_MINT_DEADLINE_MS = 1500;

export type DocumentGuestMintResult = {
  session: RemoteGuestSession | null;
  setCookies: string[];
};

/**
 * Mint (or look up) a guest session during a document (SPA HTML) request.
 *
 * Builds the same `GuestSessionFetchContext` the client route builds
 * (guest cookie, UA, hashed client IP, `mode: "lookup_or_create"`), sends it to
 * the selected guest authority, and races the ENTIRE mint against a hard
 * deadline, so the document handler can never block past it; losing the race
 * abandons the mint and serves blob-less. A loopback mint's scoped cookie is
 * written only when the mint wins: a loser finishing after the response went
 * out would otherwise write a guest the browser never receives. The helper
 * performs no configuration writes of any kind.
 *
 * Never throws and never rate-limit-fails the caller — on any failure,
 * timeout, or rate-limit cap the caller simply serves the HTML without a blob
 * and the client falls back to its own POST mint path.
 */
export async function mintGuestSessionForDocument(
  c: Context
): Promise<DocumentGuestMintResult> {
  const empty: DocumentGuestMintResult = { session: null, setCookies: [] };

  const ip = getSpendClientIp(c);
  // Match the client route's rate-limit key behavior: a missing IP keys to
  // "local-dev" so non-prod runs aren't starved. The route hard-fails a
  // missing IP in production, but the document path must NEVER fail the HTML,
  // so we degrade to blob-less instead.
  if (!ip && process.env.NODE_ENV === "production") {
    return empty;
  }
  if (!consumeMintBudget(c, ip).allowed) {
    return empty;
  }

  let ipHash: string | null = null;
  try {
    ipHash = ip ? await hashGuestSpendIp(ip) : null;
  } catch {
    ipHash = null;
  }

  const base = {
    userAgent: c.req.header("user-agent") ?? null,
    ...(ipHash ? { ipHash } : {}),
  };

  type MintOutcome = DocumentGuestMintResult & {
    scopedWrites: ScopedCookieWrite[];
  };
  const deadlineAt = Date.now() + DOCUMENT_MINT_DEADLINE_MS;

  const mint = async (): Promise<MintOutcome> => {
    if (usesScopedSessionCookies(c)) {
      // Loopback: the guest lives in this namespace's scoped cookie, which
      // this path writes itself; nothing upstream is passed through.
      const local = await resolveLocalGuestCookie(
        c,
        base,
        DOCUMENT_MINT_DEADLINE_MS
      );
      if (local.kind === "lookup_failed") return { ...empty, scopedWrites: [] };
      if (local.kind === "migrated") {
        return {
          session: local.result.session,
          setCookies: [],
          scopedWrites: [local.write],
        };
      }
      // Only what is left of the deadline: a create still in flight when the
      // race is lost would mint a guest nobody keeps.
      const result = await fetchGuestSession(
        {
          ...base,
          cookie: local.upstream
            ? upstreamGuestCookieHeader(local.upstream)
            : null,
          body: { mode: "lookup_or_create" },
        },
        Math.max(0, deadlineAt - Date.now())
      );
      return {
        session: result.kind === "session" ? result.session : null,
        setCookies: [],
        scopedWrites: upstreamGuestCookieWrites(result.setCookies),
      };
    }

    const context: GuestSessionFetchContext = {
      ...base,
      cookie: extractGuestSessionCookie(c.req.header("cookie")),
      body: { mode: "lookup_or_create" },
    };
    const result = await fetchGuestSession(context, DOCUMENT_MINT_DEADLINE_MS);
    return {
      session: result.kind === "session" ? result.session : null,
      setCookies: result.setCookies,
      scopedWrites: [],
    };
  };

  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<null>((resolve) => {
    timeoutHandle = setTimeout(() => resolve(null), DOCUMENT_MINT_DEADLINE_MS);
  });

  try {
    const outcome = await Promise.race([mint(), deadline]);
    if (!outcome) return empty;
    if (outcome.scopedWrites.length > 0) {
      applyScopedCookieWrites(c, outcome.scopedWrites);
    }
    return { session: outcome.session, setCookies: outcome.setCookies };
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
