import type { Context, Next } from "hono";
import { ErrorCode } from "../routes/web/errors.js";
import { getClientIp } from "../utils/client-ip.js";
import { HOSTED_MODE } from "../config.js";

/**
 * Per-IP ceiling on handoff claim attempts.
 *
 * The claim route is deliberately credential-free — that is the whole point of
 * a handoff link — so nothing else bounds how often it can be called. Two costs
 * follow from that. Every attempt spends an authenticated backend round trip on
 * our side, and every attempt is a free guess at a single-use token: the token
 * is 256 bits of `crypto.getRandomValues`, so guessing is not a realistic
 * threat, but "unguessable" is a property of the current mint and not a reason
 * to leave the door unmetered.
 *
 * Sized so a real person never meets it. A visitor claims once; a page reload
 * or a double-click makes it two or three, and a developer testing the flow
 * might reasonably do it a dozen times in a sitting. 20 in five minutes leaves
 * all of that alone.
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

const CLAIM_RATE_LIMIT = 20;
const CLAIM_WINDOW_MS = 5 * 60_000;

/**
 * Bounded, and fails closed when full. The key comes from a client-supplied
 * forwarding header, so sustained IP churn would otherwise grow this map until
 * the replica died — long before any single bucket hit its limit. Evicting the
 * oldest entry instead would hand a churner a way to reset their own exhausted
 * bucket, which defeats the ceiling exactly where it matters.
 */
const IP_WINDOW_MAX_ENTRIES = 10_000;
const ipWindows = new Map<string, { count: number; windowStart: number }>();

setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of ipWindows) {
    if (now - entry.windowStart > CLAIM_WINDOW_MS * 2) {
      ipWindows.delete(ip);
    }
  }
}, 5 * 60_000).unref();

export function resetServerConnectionClaimRateLimitForTests(): void {
  ipWindows.clear();
}

export const SERVER_CONNECTION_CLAIM_RATE_LIMIT = CLAIM_RATE_LIMIT;

const tooMany = (c: Context) =>
  c.json(
    {
      code: ErrorCode.RATE_LIMITED,
      message: "Too many attempts from this address. Try again in a few minutes.",
    },
    429
  );

export async function serverConnectionClaimRateLimitMiddleware(
  c: Context,
  next: Next
): Promise<Response | void> {
  if (!HOSTED_MODE) return next();

  // POST ONLY. `/claim` is a POST route, but the middleware is mounted on the
  // path, so a cross-site page could spend somebody's whole budget on image
  // GETs that were never going to reach the handler — turning a limiter meant
  // to protect the flow into a way to deny it.
  if (c.req.method !== "POST") return next();

  const ip = getClientIp(c);
  // No attributable IP means no bucket to charge. Falling through matches the
  // other limiters' posture rather than collapsing every such caller into one
  // shared bucket, where a single header-stripped request would starve the rest.
  if (!ip) return next();

  const now = Date.now();
  const entry = ipWindows.get(ip);

  if (entry) {
    if (now - entry.windowStart < CLAIM_WINDOW_MS) {
      if (entry.count >= CLAIM_RATE_LIMIT) return tooMany(c);
      entry.count++;
    } else {
      entry.count = 1;
      entry.windowStart = now;
    }
  } else {
    if (ipWindows.size >= IP_WINDOW_MAX_ENTRIES) return tooMany(c);
    ipWindows.set(ip, { count: 1, windowStart: now });
  }

  return next();
}
