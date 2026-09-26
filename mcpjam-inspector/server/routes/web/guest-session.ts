import { Hono } from "hono";
import { sanitizeGuestSessionFailureDetails } from "@/shared/guest-session-failure";
import {
  fetchConvexGuestPromotionProof,
  fetchConvexGuestSession,
  fetchConvexGuestSessionRevoke,
  fetchRemoteGuestPromotionProof,
  fetchRemoteGuestSession,
  fetchRemoteGuestSessionRevoke,
  type GuestSessionFetchContext,
  type GuestSessionRequestBody,
} from "../../utils/guest-session-source.js";
import { getSpendClientIp } from "../../utils/client-ip.js";
import { hashGuestSpendIp } from "../../utils/guest-spend-ip.js";
import {
  GUEST_SESSION_COOKIE_NAME,
  allowMint,
  appendGuestSessionSetCookie,
  extractGuestSessionCookie,
  shouldFetchGuestSessionFromConvex,
} from "./guest-session-shared.js";
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
 * forwards browser cookie/UA context to the upstream guest service so the
 * server can resolve a stable guest from the HttpOnly cookie. Spoofable
 * client IP headers are intentionally not forwarded. Set-Cookie
 * headers from upstream are passed through unchanged, with an additional
 * local HTTP-compatible cookie emitted for localhost/127.0.0.1 runtimes.
 *
 * Inspector rate-limits this endpoint locally and either:
 * - proxies to Convex in hosted web and local dev
 * - relays through hosted Inspector in local production runtimes
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

  const context: GuestSessionFetchContext = {
    cookie: extractGuestSessionCookie(c.req.header("cookie")),
    userAgent: c.req.header("user-agent") ?? null,
    body,
    ...(ipHash ? { ipHash } : {}),
  };

  const result = shouldFetchGuestSessionFromConvex()
    ? await fetchConvexGuestSession(context)
    : await fetchRemoteGuestSession(context);

  for (const cookie of result.setCookies) {
    appendGuestSessionSetCookie(c, cookie);
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

guestSession.post("/revoke", async (c) => {
  const context: GuestSessionFetchContext = {
    cookie: extractGuestSessionCookie(c.req.header("cookie")),
    userAgent: c.req.header("user-agent") ?? null,
  };

  const result = shouldFetchGuestSessionFromConvex()
    ? await fetchConvexGuestSessionRevoke(context)
    : await fetchRemoteGuestSessionRevoke(context);

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

  const context: GuestSessionFetchContext = {
    cookie: extractGuestSessionCookie(c.req.header("cookie")),
    userAgent: c.req.header("user-agent") ?? null,
  };

  const result = shouldFetchGuestSessionFromConvex()
    ? await fetchConvexGuestPromotionProof(context)
    : await fetchRemoteGuestPromotionProof(context);

  if (result.kind === "proof") {
    return c.json(result.proof);
  }

  if (result.kind === "miss") {
    return c.body(null, 204);
  }

  if (result.kind === "revoked") {
    for (const cookie of result.setCookies) {
      appendGuestSessionSetCookie(c, cookie);
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
