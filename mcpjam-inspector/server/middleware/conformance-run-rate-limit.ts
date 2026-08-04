import type { Context, Next } from "hono";
import { ErrorCode } from "../routes/web/errors.js";
import { getClientIp } from "../utils/client-ip.js";
import { HOSTED_MODE } from "../config.js";

/**
 * Per-IP ceiling on hosted conformance runs, layered under the existing
 * 60/min per-guest limiter.
 *
 * The per-guest limiter counts identities, and a guest identity is free to
 * mint — so on its own it bounds one caller's politeness, not the fleet's
 * outbound traffic. Since a run makes real requests to a caller-named third
 * party (the protocol suite alone opens several connections; the tasks suite
 * performs a real `tools/call`), the IP is the honest unit for "how much of
 * our egress may one actor spend".
 *
 * Calibrated to parity, not paranoia: a guest can already run these suites in
 * the product today, and a dev iterating on their own server legitimately runs
 * the set repeatedly. 30 runs in 10 minutes leaves that comfortable and still
 * bounds an abuser to a rate no one would call a flood.
 *
 * Local/desktop mode is exempt: the "fleet" there is one developer's laptop
 * dialing their own server.
 */

const RUN_RATE_LIMIT = 30;
const RUN_WINDOW_MS = 10 * 60_000;

/**
 * Bounded. Only expired windows are swept, and the key comes from a
 * client-supplied forwarding header — so sustained IP churn would grow this
 * map indefinitely and exhaust the replica long before any single bucket
 * reached its limit. A limiter that can be turned into the attack is not one.
 */
const IP_WINDOW_MAX_ENTRIES = 10_000;
const ipWindows = new Map<string, { count: number; windowStart: number }>();

setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of ipWindows) {
    if (now - entry.windowStart > RUN_WINDOW_MS * 2) {
      ipWindows.delete(ip);
    }
  }
}, 5 * 60_000).unref();

export function resetConformanceRunRateLimitForTests(): void {
  ipWindows.clear();
}

export async function conformanceRunRateLimitMiddleware(
  c: Context,
  next: Next
): Promise<Response | void> {
  if (!HOSTED_MODE) return next();

  const ip = getClientIp(c);
  // No attributable IP means no bucket to charge. Falling through matches the
  // per-guest limiter's posture (unknown identity ⇒ skip) rather than
  // collapsing every such caller into one shared bucket, which would let one
  // header-stripped request starve the rest.
  if (!ip) return next();

  const now = Date.now();
  const entry = ipWindows.get(ip);

  if (entry) {
    if (now - entry.windowStart < RUN_WINDOW_MS) {
      if (entry.count >= RUN_RATE_LIMIT) {
        return c.json(
          {
            code: ErrorCode.RATE_LIMITED,
            message:
              "Too many conformance runs from this address. Try again in a few minutes.",
          },
          429
        );
      }
      entry.count++;
    } else {
      entry.count = 1;
      entry.windowStart = now;
    }
  } else {
    if (ipWindows.size >= IP_WINDOW_MAX_ENTRIES) {
      // Oldest insertion first — Map preserves insertion order.
      const oldest = ipWindows.keys().next();
      if (!oldest.done) ipWindows.delete(oldest.value);
    }
    ipWindows.set(ip, { count: 1, windowStart: now });
  }

  return next();
}
