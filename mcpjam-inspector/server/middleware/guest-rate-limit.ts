import type { Context, Next } from "hono";
import { ErrorCode } from "../routes/web/errors.js";

/**
 * Per-guestId rate limiting for OAuth proxy routes.
 * In-memory sliding window: 60 req/min per guestId.
 */

const GUEST_RATE_LIMIT = 60;
const GUEST_WINDOW_MS = 60_000;

const guestWindows = new Map<
  string,
  { count: number; windowStart: number }
>();

// Cleanup stale entries every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [id, entry] of guestWindows) {
    if (now - entry.windowStart > GUEST_WINDOW_MS * 2) {
      guestWindows.delete(id);
    }
  }
}, 5 * 60_000).unref();

export async function guestRateLimitMiddleware(
  c: Context,
  next: Next,
): Promise<Response | void> {
  const guestId = c.get("guestId");
  if (!guestId) {
    // Not a guest request — skip rate limiting
    return next();
  }

  const now = Date.now();
  const entry = guestWindows.get(guestId);

  if (entry) {
    if (now - entry.windowStart < GUEST_WINDOW_MS) {
      if (entry.count >= GUEST_RATE_LIMIT) {
        return c.json(
          {
            code: ErrorCode.RATE_LIMITED,
            message:
              "Guest rate limit exceeded. Try again later or sign in for higher limits.",
          },
          429,
        );
      }
      entry.count++;
    } else {
      entry.count = 1;
      entry.windowStart = now;
    }
  } else {
    guestWindows.set(guestId, { count: 1, windowStart: now });
  }

  return next();
}
