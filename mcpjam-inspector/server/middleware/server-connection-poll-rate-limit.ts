import type { Context, Next } from "hono";
import { ErrorCode } from "../routes/web/errors.js";
import { getClientIp } from "../utils/client-ip.js";

/**
 * A budget for POLLING, which the shared guest limiter is the wrong shape for.
 *
 * The connection status GET is polled every 2–10 seconds for as long as the
 * person takes to authorize in their browser — which is the whole point of the
 * flow, and can legitimately be minutes. Charged to the shared 60-per-minute
 * guest bucket, a normal poll spends half of it and can 429 the guest out of the
 * flow they are watching, and out of everything else they were doing at the same
 * time. Rate-limiting a client for following the protocol we told it to follow
 * is not a limit doing its job.
 *
 * So the status route is exempted from the shared bucket (see
 * `guest-rate-limit.ts`) and metered here instead, at a ceiling sized for
 * polling rather than for API calls. 240 per minute is roughly eight concurrent
 * pollers at the fastest interval — far above any real use, and still a bound.
 *
 * PER PROCESS, like its neighbours. The window lives in this replica's memory,
 * so the fleet-wide ceiling is this number times the replica count. It blunts
 * abuse; it does not meter a product.
 */

const POLL_RATE_LIMIT = 240;
const POLL_WINDOW_MS = 60_000;

/** Bounded, and fails closed when full — see `server-connection-claim-rate-limit.ts`
 * for why evicting the oldest entry would defeat the ceiling it enforces. */
const KEY_WINDOW_MAX_ENTRIES = 10_000;
const windows = new Map<string, { count: number; windowStart: number }>();

setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of windows) {
    if (now - entry.windowStart > POLL_WINDOW_MS * 2) {
      windows.delete(key);
    }
  }
}, 5 * 60_000).unref();

export function resetServerConnectionPollRateLimitForTests(): void {
  windows.clear();
}

export const SERVER_CONNECTION_POLL_RATE_LIMIT = POLL_RATE_LIMIT;

const tooMany = (c: Context) =>
  c.json(
    {
      code: ErrorCode.RATE_LIMITED,
      message: "Polling too fast. Wait a few seconds between status checks.",
    },
    429,
    { "Retry-After": "5" }
  );

export async function serverConnectionPollRateLimitMiddleware(
  c: Context,
  next: Next
): Promise<Response | void> {
  // Signed-in callers are metered by their own key upstream; a guest identity
  // is free to mint, so the honest unit for a guest is the address.
  const guestId = c.get("guestId");
  const key = guestId ? `guest:${guestId}` : `ip:${getClientIp(c) ?? ""}`;
  if (key === "ip:") return next();

  const now = Date.now();
  const entry = windows.get(key);

  if (entry) {
    if (now - entry.windowStart < POLL_WINDOW_MS) {
      if (entry.count >= POLL_RATE_LIMIT) return tooMany(c);
      entry.count++;
    } else {
      entry.count = 1;
      entry.windowStart = now;
    }
  } else {
    if (windows.size >= KEY_WINDOW_MAX_ENTRIES) return tooMany(c);
    windows.set(key, { count: 1, windowStart: now });
  }

  return next();
}

/**
 * The paths this limiter owns, so the shared guest limiter can stand aside.
 *
 * Lives here rather than in `guest-rate-limit.ts` so the exemption and the
 * budget that replaces it are defined together — an exemption whose replacement
 * lives in another file is one deletion away from being a hole.
 */
export function hasDedicatedPollBudget(method: string, path: string): boolean {
  return (
    method === "GET" && /^\/api\/v1\/server-connections\/[^/]+$/.test(path)
  );
}
