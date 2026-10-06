import { Hono } from "hono";
import { sanitizeGuestSessionFailureDetails } from "@/shared/guest-session-failure";
import type { Context } from "hono";
import {
  fetchGuestPromotionProof,
  fetchGuestSession,
  fetchGuestSessionRevoke,
  type GuestSessionFetchContext,
  type GuestSessionFetchResult,
  type GuestSessionRequestBody,
} from "../../utils/guest-session-source.js";
import { getSpendClientIp } from "../../utils/client-ip.js";
import { hashGuestSpendIp } from "../../utils/guest-spend-ip.js";
import {
  applyScopedCookieWrites,
  usesScopedSessionCookies,
} from "../../utils/scoped-cookie-context.js";
import {
  GUEST_SESSION_COOKIE_NAME,
  allowMint,
  appendGuestSessionSetCookie,
  extractGuestSessionCookie,
} from "./guest-session-shared.js";
import {
  applyUpstreamGuestCookies,
  clearScopedGuestCookie,
  deleteMatchedLegacyGuestCookies,
  resolveLocalGuestCookie,
  upstreamGuestCookieHeader,
} from "./guest-cookie-scope.js";
import { ErrorCode, webError } from "./errors.js";

const guestSession = new Hono();

// Bound the size of the legacy migration token we will forward upstream.
// Real guest JWTs are well under this limit; anything larger is either
// malformed or an attempt to inflate the upstream request body.
const MAX_LEGACY_TOKEN_LENGTH = 4096;
// Copy shown when the per-IP creation cap refuses a new guest. Sign-in is the
// real next step; retrying is not.
export const GUEST_SESSION_REFUSED_MESSAGE =
  "Too many guest sessions from your network today. Sign in to continue.";
const GUEST_SESSION_REFUSED_RETRY_AFTER_S = 600;

function parseRequestBody(raw: unknown): GuestSessionRequestBody {
  if (!raw || typeof raw !== "object") return {};
  const body = raw as Record<string, unknown>;
  const out: GuestSessionRequestBody = {};
  if (body.mode === "lookup_only" || body.mode === "lookup_or_create") {
    out.mode = body.mode;
  }
  if (
    typeof body.legacyToken === "string" &&
    body.legacyToken.length > 0 &&
    body.legacyToken.length <= MAX_LEGACY_TOKEN_LENGTH
  ) {
    out.legacyToken = body.legacyToken;
  }
  return out;
}

/**
 * POST /api/web/guest-session
 *
 * Returns a guest bearer token for unauthenticated visitors. Inspector
 * forwards the guest cookie and UA to the ONE selected guest authority
 * (`utils/guest-authority.ts`) so it can resolve a stable guest from the
 * HttpOnly cookie. Spoofable client IP headers are intentionally not
 * forwarded.
 *
 * On a deployment reached by its own hostname the authority's Set-Cookie is
 * passed through unchanged. On a loopback Inspector the guest lives in this
 * instance's namespace-scoped cookie instead (`guest-cookie-scope.ts`), so
 * concurrent instances on one machine never share or overwrite a guest.
 *
 * Rate limited to 10 requests per minute per IP.
 */
guestSession.post("/", async (c) => {
  const ip = getSpendClientIp(c);
  if (!ip && process.env.NODE_ENV === "production") {
    return c.json(
      {
        code: ErrorCode.RATE_LIMITED,
        message:
          "Unable to determine client IP for guest session rate limiting.",
      },
      429
    );
  }
  const rateLimitKey = ip ?? "local-dev";

  // Check rate limit (shared singleton — see guest-session-shared.ts)
  if (!allowMint(rateLimitKey)) {
    return c.json(
      {
        code: ErrorCode.RATE_LIMITED,
        message: "Too many guest session requests. Try again later.",
      },
      429
    );
  }

  let body: GuestSessionRequestBody = {};
  try {
    const raw = await c.req.json();
    body = parseRequestBody(raw);
  } catch {
    body = {};
  }

  // Hash the client IP so Convex can record the IP-bucket key on the
  // guest's session row. Lets the credit-balance display reflect the
  // per-IP cap on the very first load after a cookie clear, before any
  // /stream call has run.
  const clientIp = getSpendClientIp(c);
  const ipHash = clientIp ? await hashGuestSpendIp(clientIp) : null;

  const base = {
    userAgent: c.req.header("user-agent") ?? null,
    ...(ipHash ? { ipHash } : {}),
  };

  let result: GuestSessionFetchResult;
  if (usesScopedSessionCookies(c)) {
    // Loopback: this instance's guest lives in its namespace's scoped cookie;
    // a legacy shared cookie is migrated through `lookup_only` first.
    const local = await resolveLocalGuestCookie(c, base);
    if (local.kind === "migrated") {
      applyScopedCookieWrites(c, [local.write]);
      result = local.result;
    } else if (local.kind === "lookup_failed") {
      // A lookup never creates a guest, so its 429 is not the creation cap the
      // 429 below tells the user to sign in over.
      result = { ...local.result, status: 503 };
    } else {
      result = await fetchGuestSession({
        ...base,
        body,
        cookie: local.upstream
          ? upstreamGuestCookieHeader(local.upstream)
          : null,
      });
      applyUpstreamGuestCookies(c, result.setCookies);
    }
  } else {
    const context: GuestSessionFetchContext = {
      ...base,
      cookie: extractGuestSessionCookie(c.req.header("cookie")),
      body,
    };
    result = await fetchGuestSession(context);
    for (const cookie of result.setCookies) {
      appendGuestSessionSetCookie(c, cookie);
    }
  }

  if (result.kind === "session") {
    return c.json(result.session);
  }

  if (result.kind === "miss") {
    return c.body(null, 204);
  }

  if (result.status === 403) {
    return c.json(
      {
        code: ErrorCode.FORBIDDEN,
        message: "Guest session revoked.",
      },
      403
    );
  }

  // The backend caps guest session CREATION per client IP (mcpjam-backend
  // #1391/#1392). That is a deliberate refusal, not an outage: surface it as
  // the 429 it is, with the upstream's Retry-After, so the client stops
  // retrying and offers sign-in instead of "try again".
  if (result.status === 429) {
    c.header(
      "Retry-After",
      String(result.retryAfterSeconds ?? GUEST_SESSION_REFUSED_RETRY_AFTER_S),
    );
    return c.json(
      {
        code: ErrorCode.RATE_LIMITED,
        message: GUEST_SESSION_REFUSED_MESSAGE,
      },
      429,
    );
  }

  // Through `webError` so the code and message reach `webErrorMeta`, and from
  // there `http.request.failed`. Returning `c.json` directly produced a 5xx row
  // with no message at all: on 2026-07-22 this path failed 434 times in a day
  // and the reason was unrecoverable, because the route knew why and threw the
  // text away at the response boundary.
  //
  // `details` says why the upstream hop failed. A self-hosted install makes
  // this 503 on the user's machine, where its log line never reaches us, so the
  // browser's error report is the only place the cause can show up. Fields are
  // picked by name and sanitized: this body is browser-visible on hosted too.
  const details = sanitizeGuestSessionFailureDetails({
    reason: result.reason,
    upstreamStatus: result.upstreamStatus,
    networkCode: result.networkCode,
  });
  return webError(
    c,
    503,
    ErrorCode.INTERNAL_ERROR,
    "Unable to obtain a guest session right now. Please try again.",
    details ? { ...details } : undefined
  );
});

/**
 * POST /api/web/guest-session/revoke
 *
 * Called by the inspector frontend after a successful WorkOS sign-in so
 * the browser's guest cookie cannot resurrect a stale guest identity on
 * sign-out. Forwards the guest cookie to the upstream guest service which
 * marks the session row as revoked and issues a Set-Cookie that clears
 * the cookie on the browser.
 *
 * No body, no auth required at this hop — the operation is bounded by
 * the cookie itself, and is idempotent (no-op if no cookie is present).
 */
// HttpOnly cookie that mirrors `buildExpiredGuestSessionCookie` on the
// upstream. Used as a fallback when the upstream is unreachable or has
// not yet deployed the revoke route — the cookie still gets cleared on
// the browser so a signed-in user cannot resurrect their guest identity
// via cookie replay on sign-out.
function buildExpiredGuestSessionCookie(): string {
  return [
    `${GUEST_SESSION_COOKIE_NAME}=`,
    "HttpOnly",
    "Secure",
    "SameSite=Lax",
    "Path=/",
    "Max-Age=0",
  ].join("; ");
}

/** Loopback revoke: this namespace's guest only. */
async function revokeLocalGuest(c: Context) {
  const local = await resolveLocalGuestCookie(c, {
    userAgent: c.req.header("user-agent") ?? null,
  });
  if (local.kind === "lookup_failed") {
    // A legacy guest might exist and could not be identified: answer like any
    // upstream failure so the client retries, rather than report a revoke
    // that left a resurrectable identity behind.
    return { status: 503, setCookies: [], body: null };
  }
  const upstream = local.upstream;
  const result = upstream
    ? await fetchGuestSessionRevoke({
        cookie: upstreamGuestCookieHeader(upstream),
        userAgent: c.req.header("user-agent") ?? null,
      })
    : { status: 200, setCookies: [], body: { revoked: false } };

  // Clearing THIS instance's guest is the load-bearing part, whatever the
  // authority answered: a signed-in user must not resurrect their guest
  // identity on sign-out. Legacy cookies holding the same identity go too;
  // any other legacy identity is left for whoever owns it.
  clearScopedGuestCookie(c);
  if (upstream) deleteMatchedLegacyGuestCookies(c, upstream);
  return result;
}

guestSession.post("/revoke", async (c) => {
  let result: Awaited<ReturnType<typeof fetchGuestSessionRevoke>>;
  if (usesScopedSessionCookies(c)) {
    result = await revokeLocalGuest(c);
  } else {
    const context: GuestSessionFetchContext = {
      cookie: extractGuestSessionCookie(c.req.header("cookie")),
      userAgent: c.req.header("user-agent") ?? null,
    };
    result = await fetchGuestSessionRevoke(context);

    // Forward the upstream's Set-Cookie when we got one. If the upstream is
    // missing the route (404) or returned a server error, fall back to
    // emitting the expired cookie ourselves — the row revocation is a
    // defense-in-depth nicety, but clearing the browser cookie is the
    // load-bearing part of the contract.
    if (result.setCookies.length > 0) {
      for (const cookie of result.setCookies) {
        appendGuestSessionSetCookie(c, cookie);
      }
    } else {
      appendGuestSessionSetCookie(c, buildExpiredGuestSessionCookie());
    }
  }

  if (result.status >= 200 && result.status < 300) {
    return c.json({ revoked: result.body?.revoked ?? false });
  }

  // Treat upstream 404 (route not deployed) as a soft success — we still
  // cleared the cookie on the browser.
  if (result.status === 404) {
    return c.json({ revoked: false, upstream: "missing" });
  }

  return webError(
    c,
    503,
    ErrorCode.INTERNAL_ERROR,
    "Unable to revoke guest session right now."
  );
});

/**
 * POST /api/web/guest-session/promotion-proof
 *
 * Mints a short-lived (5-minute) JWT scoped exclusively to the
 * guest→WorkOS promotion path. Called immediately before the frontend
 * invokes `users:ensureUser` with `guestProofJwt`. Decoupling this token
 * from the session bearer (24h TTL, served on every guest API call) keeps
 * the replay window for promotion to single-digit minutes regardless of
 * how long the bearer lingers in caches.
 *
 * Rate-limited per IP using the same window/limits as the base session
 * route so a stolen secret cannot be used to flood the upstream.
 */
guestSession.post("/promotion-proof", async (c) => {
  const ip = getSpendClientIp(c);
  if (!ip && process.env.NODE_ENV === "production") {
    return c.json(
      {
        code: ErrorCode.RATE_LIMITED,
        message:
          "Unable to determine client IP for guest session rate limiting.",
      },
      429
    );
  }
  const rateLimitKey = ip ?? "local-dev";

  if (!allowMint(rateLimitKey)) {
    return c.json(
      {
        code: ErrorCode.RATE_LIMITED,
        message: "Too many guest session requests. Try again later.",
      },
      429
    );
  }

  const scoped = usesScopedSessionCookies(c);
  let cookie: string | null;
  if (scoped) {
    const local = await resolveLocalGuestCookie(c, {
      userAgent: c.req.header("user-agent") ?? null,
    });
    if (local.kind === "lookup_failed") {
      return webError(
        c,
        503,
        ErrorCode.INTERNAL_ERROR,
        "Unable to obtain a guest promotion proof right now. Please try again."
      );
    }
    if (local.kind === "migrated") applyScopedCookieWrites(c, [local.write]);
    cookie = local.upstream ? upstreamGuestCookieHeader(local.upstream) : null;
  } else {
    cookie = extractGuestSessionCookie(c.req.header("cookie"));
  }

  const result = await fetchGuestPromotionProof({
    cookie,
    userAgent: c.req.header("user-agent") ?? null,
  });
  if (result.kind === "proof") {
    return c.json(result.proof);
  }

  if (result.kind === "miss") {
    return c.body(null, 204);
  }

  if (result.kind === "revoked") {
    if (scoped) {
      clearScopedGuestCookie(c);
    } else {
      for (const setCookie of result.setCookies) {
        appendGuestSessionSetCookie(c, setCookie);
      }
    }
    return c.json(
      {
        code: ErrorCode.FORBIDDEN,
        message: "Guest session revoked.",
      },
      403
    );
  }

  return webError(
    c,
    503,
    ErrorCode.INTERNAL_ERROR,
    "Unable to obtain a guest promotion proof right now. Please try again."
  );
});

export default guestSession;
