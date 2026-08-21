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

/**
 * TWO BUCKETS, because one key cannot answer both questions.
 *
 * Keyed on identity alone, a guest mints a new identity and gets a fresh
 * window — the ceiling means nothing. Keyed on address alone, an office or a
 * corporate proxy shares one bucket, and twenty colleagues polling their own
 * connections lock each other out for following the protocol.
 *
 * So both are charged. The identity bucket is the one a normal caller ever
 * meets; the address bucket sits far above it and exists only to bound the
 * rotation the identity bucket cannot see.
 */
const POLL_RATE_LIMIT = 240;
const ADDRESS_POLL_RATE_LIMIT = 1_200;
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
export const SERVER_CONNECTION_ADDRESS_POLL_RATE_LIMIT =
  ADDRESS_POLL_RATE_LIMIT;

/**
 * Charge one bucket. Returns the seconds until its window rolls over when the
 * budget is spent, or `null` when there was room.
 *
 * The caller advertises THAT number rather than a fixed guess: a fixed window
 * that says "retry in 5s" while it stays closed for another fifty trains a
 * client to hammer a door that will not open, and the honest number is the one
 * the window actually holds.
 */
function charge(
  key: string,
  limit: number,
  now: number
): { retryAfterSeconds: number } | null {
  const entry = windows.get(key);
  if (entry) {
    if (now - entry.windowStart < POLL_WINDOW_MS) {
      if (entry.count >= limit) {
        const remainingMs = POLL_WINDOW_MS - (now - entry.windowStart);
        return { retryAfterSeconds: Math.max(1, Math.ceil(remainingMs / 1000)) };
      }
      entry.count++;
    } else {
      entry.count = 1;
      entry.windowStart = now;
    }
    return null;
  }
  if (windows.size >= KEY_WINDOW_MAX_ENTRIES) {
    return { retryAfterSeconds: Math.ceil(POLL_WINDOW_MS / 1000) };
  }
  windows.set(key, { count: 1, windowStart: now });
  return null;
}

const tooMany = (c: Context, retryAfterSeconds: number) =>
  c.json(
    {
      code: ErrorCode.RATE_LIMITED,
      message: "Polling too fast. Wait a few seconds between status checks.",
    },
    429,
    { "Retry-After": String(retryAfterSeconds) }
  );

export async function serverConnectionPollRateLimitMiddleware(
  c: Context,
  next: Next
): Promise<Response | void> {
  const now = Date.now();

  // The most stable principal available. A validated API key is the caller
  // itself; a guest id is free to mint, which is exactly why it is not the only
  // thing charged.
  const principal =
    (c.get("workosApiKeyId") as string | undefined) ??
    (c.get("mcpjamUserId") as string | undefined) ??
    (c.get("guestId") as string | undefined);
  if (principal) {
    const refused = charge(`principal:${principal}`, POLL_RATE_LIMIT, now);
    if (refused) return tooMany(c, refused.retryAfterSeconds);
  }

  const ip = getClientIp(c);
  if (ip) {
    const refused = charge(`ip:${ip}`, ADDRESS_POLL_RATE_LIMIT, now);
    if (refused) return tooMany(c, refused.retryAfterSeconds);
  }

  // Neither an identity nor an address: nothing to charge, and collapsing every
  // such caller into one bucket would let a single header-stripped request
  // starve the rest.
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
