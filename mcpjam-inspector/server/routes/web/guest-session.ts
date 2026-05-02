import { Hono } from "hono";
import {
  fetchConvexGuestSession,
  fetchRemoteGuestSession,
  type GuestSessionFetchContext,
  type GuestSessionRequestBody,
} from "../../utils/guest-session-source.js";
import { ErrorCode } from "./errors.js";

const guestSession = new Hono();

// IP-based rate limiting: 10 req/min per IP (sliding window)
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

function getClientIp(c: any): string {
  return (
    c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ||
    c.req.header("x-real-ip") ||
    "unknown"
  );
}

function shouldFetchGuestSessionFromConvex(): boolean {
  if (process.env.VITE_MCPJAM_HOSTED_MODE === "true") {
    return true;
  }

  return process.env.NODE_ENV !== "production";
}

function parseRequestBody(raw: unknown): GuestSessionRequestBody {
  if (!raw || typeof raw !== "object") return {};
  const body = raw as Record<string, unknown>;
  const out: GuestSessionRequestBody = {};
  if (body.mode === "lookup_only" || body.mode === "lookup_or_create") {
    out.mode = body.mode;
  }
  if (typeof body.legacyToken === "string" && body.legacyToken.length > 0) {
    out.legacyToken = body.legacyToken;
  }
  return out;
}

/**
 * POST /api/web/guest-session
 *
 * Returns a guest bearer token for unauthenticated visitors. Inspector
 * forwards browser cookie/UA/IP context to the upstream guest service so the
 * server can resolve a stable guest from the HttpOnly cookie. Set-Cookie
 * headers from upstream are passed through unchanged.
 *
 * Inspector rate-limits this endpoint locally and either:
 * - proxies to Convex in hosted web and local dev
 * - relays through hosted Inspector in local production runtimes
 *
 * Rate limited to 10 requests per minute per IP.
 */
guestSession.post("/", async (c) => {
  if (process.env.MCPJAM_NONPROD_LOCKDOWN === "true") {
    return c.json(
      {
        code: ErrorCode.FORBIDDEN,
        message: "Guest access is disabled in this environment.",
      },
      403,
    );
  }

  const ip = getClientIp(c);
  const now = Date.now();

  // Check rate limit
  const entry = ipWindows.get(ip);
  if (entry) {
    if (now - entry.windowStart < IP_WINDOW_MS) {
      if (entry.count >= IP_RATE_LIMIT) {
        return c.json(
          {
            code: ErrorCode.RATE_LIMITED,
            message: "Too many guest session requests. Try again later.",
          },
          429,
        );
      }
      entry.count++;
    } else {
      // Reset window
      entry.count = 1;
      entry.windowStart = now;
    }
  } else {
    ipWindows.set(ip, { count: 1, windowStart: now });
  }

  let body: GuestSessionRequestBody = {};
  try {
    const raw = await c.req.json();
    body = parseRequestBody(raw);
  } catch {
    body = {};
  }

  const context: GuestSessionFetchContext = {
    cookie: c.req.header("cookie") ?? null,
    userAgent: c.req.header("user-agent") ?? null,
    forwardedFor: c.req.header("x-forwarded-for") ?? null,
    realIp: c.req.header("x-real-ip") ?? null,
    body,
  };

  const result = shouldFetchGuestSessionFromConvex()
    ? await fetchConvexGuestSession(context)
    : await fetchRemoteGuestSession(context);

  for (const cookie of result.setCookies) {
    c.header("Set-Cookie", cookie, { append: true });
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
        message: result.message ?? "Guest session revoked.",
      },
      403,
    );
  }

  return c.json(
    {
      code: ErrorCode.INTERNAL_ERROR,
      message:
        "Unable to obtain a guest session right now. Please try again.",
    },
    503,
  );
});

export default guestSession;
