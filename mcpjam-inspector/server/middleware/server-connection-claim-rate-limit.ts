import type { Context, Next } from "hono";
import { ErrorCode } from "../routes/web/errors.js";
import { getClientIp } from "../utils/client-ip.js";
import { HOSTED_MODE } from "../config.js";

/**
 * Per-IP ceilings for the handoff route family.
 *
 * The claim route is deliberately credential-free — that is the whole point of
 * a handoff link — so nothing else bounds how often it can be called. Two costs
 * follow from that. Every attempt spends an authenticated backend round trip on
 * our side, and every attempt is a free guess at a single-use token: the token
 * is 256 bits of `crypto.getRandomValues`, so guessing is not a realistic
 * threat, but "unguessable" is a property of the current mint and not a reason
 * to leave the door unmetered.
 *
 * The post-claim routes are cookie-authenticated but still worth metering:
 * `/state` spends a backend round trip per poll, and `/authorize` does outbound
 * network work — metadata discovery and a dynamic client registration against
 * the target server — BEFORE the backend's per-request attempt budget can
 * refuse it. The limiter here is what refuses before the outbound work is
 * spent; the backend budgets remain the durable cap.
 *
 * Sized so a real person never meets any of them. A visitor claims once; a
 * page reload or a double-click makes it two or three, and a developer testing
 * the flow might reasonably do it a dozen times in a sitting. The state poll
 * runs every couple of seconds only while another actor is working. An
 * authorization happens once, plus however many consent retries a person has
 * patience for.
 *
 * PER PROCESS, not per fleet — the same trade `conformance-run-rate-limit.ts`
 * documents. The window lives in this replica's memory, so a horizontally
 * scaled deployment enforces this per replica and the real ceiling moves with
 * the replica count. It blunts abuse; it is not a guarantee, and making it one
 * needs shared state rather than a smaller number.
 *
 * Local/desktop mode is exempt: there is one user, and it is the person who
 * started the process.
 */

/**
 * Bounded, and fails closed when full. The key comes from a client-supplied
 * forwarding header, so sustained IP churn would otherwise grow this map until
 * the replica died — long before any single bucket hit its limit. Evicting the
 * oldest entry instead would hand a churner a way to reset their own exhausted
 * bucket, which defeats the ceiling exactly where it matters.
 */
const IP_WINDOW_MAX_ENTRIES = 10_000;

interface IpFixedWindowLimiter {
  middleware: (c: Context, next: Next) => Promise<Response | void>;
  resetForTests: () => void;
}

function createIpFixedWindowLimiter(options: {
  limit: number;
  windowMs: number;
  message: string;
  /** Which method actually reaches the guarded handler. The middleware is
   * mounted on a path, so without this a cross-site page could spend
   * somebody's whole budget on requests that were never going to reach the
   * handler — turning a limiter meant to protect the flow into a way to deny
   * it. */
  method: "POST" | "GET";
}): IpFixedWindowLimiter {
  const windows = new Map<string, { count: number; windowStart: number }>();

  setInterval(
    () => {
      const now = Date.now();
      for (const [ip, entry] of windows) {
        if (now - entry.windowStart > options.windowMs * 2) {
          windows.delete(ip);
        }
      }
    },
    5 * 60_000
  ).unref();

  const tooMany = (c: Context, retryAfterMs: number) =>
    c.json(
      {
        code: ErrorCode.RATE_LIMITED,
        message: options.message,
      },
      429,
      { "retry-after": String(Math.max(1, Math.ceil(retryAfterMs / 1000))) }
    );

  const middleware = async (
    c: Context,
    next: Next
  ): Promise<Response | void> => {
    if (!HOSTED_MODE) return next();

    if (c.req.method !== options.method) return next();

    const ip = getClientIp(c);
    // No attributable IP means no bucket to charge. Falling through matches the
    // other limiters' posture rather than collapsing every such caller into one
    // shared bucket, where a single header-stripped request would starve the
    // rest.
    if (!ip) return next();

    const now = Date.now();
    const entry = windows.get(ip);

    if (entry) {
      if (now - entry.windowStart < options.windowMs) {
        if (entry.count >= options.limit) {
          return tooMany(c, entry.windowStart + options.windowMs - now);
        }
        entry.count++;
      } else {
        entry.count = 1;
        entry.windowStart = now;
      }
    } else {
      if (windows.size >= IP_WINDOW_MAX_ENTRIES) {
        return tooMany(c, options.windowMs);
      }
      windows.set(ip, { count: 1, windowStart: now });
    }

    return next();
  };

  return { middleware, resetForTests: () => windows.clear() };
}

const CLAIM_RATE_LIMIT = 20;
const CLAIM_WINDOW_MS = 5 * 60_000;

const claimLimiter = createIpFixedWindowLimiter({
  limit: CLAIM_RATE_LIMIT,
  windowMs: CLAIM_WINDOW_MS,
  message: "Too many attempts from this address. Try again in a few minutes.",
  method: "POST",
});

export const SERVER_CONNECTION_CLAIM_RATE_LIMIT = CLAIM_RATE_LIMIT;
export const serverConnectionClaimRateLimitMiddleware = claimLimiter.middleware;
export function resetServerConnectionClaimRateLimitForTests(): void {
  claimLimiter.resetForTests();
}

/** `/state` polls every ~2s while another actor works; 600/min per IP leaves a
 * handful of tabs behind one NAT untouched while bounding the backend round
 * trips a loop can spend. */
const stateLimiter = createIpFixedWindowLimiter({
  limit: 600,
  windowMs: 60_000,
  message: "Polling too fast. Slow down and try again.",
  method: "GET",
});

export const serverConnectionStateRateLimitMiddleware = stateLimiter.middleware;
export function resetServerConnectionStateRateLimitForTests(): void {
  stateLimiter.resetForTests();
}

/** `/authorize` fires outbound discovery + DCR at the target before any
 * backend budget can refuse; a person authorizes once and retries a handful of
 * times, so 10 per 10 minutes per IP is generous for humans and stingy for a
 * loop pointing us at somebody's authorization server. */
const authorizeLimiter = createIpFixedWindowLimiter({
  limit: 10,
  windowMs: 10 * 60_000,
  message: "Too many authorization attempts. Try again in a few minutes.",
  method: "POST",
});

export const serverConnectionAuthorizeRateLimitMiddleware =
  authorizeLimiter.middleware;
export function resetServerConnectionAuthorizeRateLimitForTests(): void {
  authorizeLimiter.resetForTests();
}
