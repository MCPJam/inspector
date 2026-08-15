import type { Context, Next } from "hono";
import { ErrorCode } from "../routes/web/errors.js";
import { hasDedicatedPollBudget } from "./server-connection-poll-rate-limit.js";

/**
 * Per-guestId rate limiting for OAuth proxy routes.
 * In-memory sliding window: 60 req/min per guestId.
 *
 * One route stands outside it: the connection status GET, which is polled every
 * few seconds by design and would spend half this bucket doing what the flow
 * tells it to. It carries its own, poll-shaped budget instead — see
 * `server-connection-poll-rate-limit.ts`, which defines both the exemption and
 * the limiter that replaces it.
 */

const GUEST_RATE_LIMIT = 60;
const GUEST_WINDOW_MS = 60_000;

const guestWindows = new Map<string, { count: number; windowStart: number }>();

// Cleanup stale entries every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [id, entry] of guestWindows) {
    if (now - entry.windowStart > GUEST_WINDOW_MS * 2) {
      guestWindows.delete(id);
    }
  }
}, 5 * 60_000).unref();

export function resetGuestRateLimitForTests(): void {
  guestWindows.clear();
}

export async function guestRateLimitMiddleware(
  c: Context,
  next: Next
): Promise<Response | void> {
  const guestId = c.get("guestId");
  if (!guestId) {
    // Not a guest request — skip rate limiting
    return next();
  }

  // Metered elsewhere, on a budget shaped for polling.
  if (hasDedicatedPollBudget(c.req.method, c.req.path)) {
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
          // This is a FIXED window, so the wait is exactly the remainder of it
          // — the one 429 in the product that can state its reset precisely.
          // It shipped without the header while the published spec promised
          // `Retry-After` on every rate-limited response, which made the
          // promise false on the guest path specifically.
          {
            "Retry-After": String(
              Math.max(
                1,
                Math.ceil((entry.windowStart + GUEST_WINDOW_MS - now) / 1000)
              )
            ),
          }
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
