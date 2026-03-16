import { Hono } from "hono";
import { fetchRemoteGuestSession } from "../../utils/guest-session-source.js";
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

/**
 * POST /api/web/guest-session
 *
 * Returns a guest bearer token for unauthenticated visitors.
 * Inspector rate-limits this endpoint locally, then proxies guest token
 * issuance to Convex.
 * Rate limited to 10 requests per minute per IP.
 */
guestSession.post("/", async (c) => {
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

  const session = await fetchRemoteGuestSession();
  if (!session) {
    return c.json(
      {
        code: ErrorCode.INTERNAL_ERROR,
        message:
          "Unable to obtain a guest session right now. Please try again.",
      },
      503,
    );
  }

  return c.json(session);
});

export default guestSession;
