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
 * PER PROCESS, not per fleet. The window lives in this replica's memory, so a
 * horizontally scaled deployment enforces 30 runs per IP PER REPLICA — the real
 * ceiling is that number times the replica count, and it moves when the
 * deployment scales. That is a deliberate v1 trade (a shared counter means a
 * round trip on every run, for a limit whose job is to blunt abuse rather than
 * meter a product), but it must not be mistaken for a fleet-wide guarantee: if
 * this ever needs to be exact, it needs shared state, not a smaller number.
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
type RunWindow = { count: number; windowStart: number };
const ipWindows = new Map<string, RunWindow>();
/**
 * The same budget per signed-in user, for `/api/v1` starts. Every MCP and CLI
 * call reaches `/api/v1` from MCPJam's own worker or the user's machine, so
 * the user, not the address, is what an agent in a loop spends.
 */
const userWindows = new Map<string, RunWindow>();

setInterval(() => {
  const now = Date.now();
  for (const windows of [ipWindows, userWindows]) {
    for (const [key, entry] of windows) {
      if (now - entry.windowStart > RUN_WINDOW_MS * 2) {
        windows.delete(key);
      }
    }
  }
}, 5 * 60_000).unref();

export function resetConformanceRunRateLimitForTests(): void {
  ipWindows.clear();
  userWindows.clear();
}

/**
 * Count one run against `key`. `limited` carries the wait until its window
 * resets; `full` means the table is at its bound (see `IP_WINDOW_MAX_ENTRIES`).
 */
function takeRunSlot(
  windows: Map<string, RunWindow>,
  key: string,
  now: number,
): { taken: true } | { taken: false; reason: "limited" | "full"; waitMs: number } {
  const entry = windows.get(key);
  if (entry && now - entry.windowStart < RUN_WINDOW_MS) {
    if (entry.count >= RUN_RATE_LIMIT) {
      return {
        taken: false,
        reason: "limited",
        waitMs: entry.windowStart + RUN_WINDOW_MS - now,
      };
    }
    entry.count++;
    return { taken: true };
  }
  if (entry) {
    entry.count = 1;
    entry.windowStart = now;
    return { taken: true };
  }
  if (windows.size >= IP_WINDOW_MAX_ENTRIES) {
    // FAIL CLOSED rather than evict. Evicting the oldest entry bounds memory
    // but hands whoever owned it a fresh 30-run allowance — so a churner
    // could reset their own exhausted bucket by filling the map, defeating
    // the ceiling at exactly the scale it matters. Refusing the new key
    // keeps both properties.
    return { taken: false, reason: "full", waitMs: 60_000 };
  }
  windows.set(key, { count: 1, windowStart: now });
  return { taken: true };
}

/**
 * Take one `/api/v1` start from `userKey`'s budget, or return how many seconds
 * to wait. Hosted only, like the per-address limit.
 */
export function takeConformanceStartSlot(
  userKey: string,
  now = Date.now(),
): { retryAfterSeconds: number } | null {
  if (!HOSTED_MODE) return null;
  const slot = takeRunSlot(userWindows, userKey, now);
  return slot.taken
    ? null
    : { retryAfterSeconds: Math.max(1, Math.ceil(slot.waitMs / 1000)) };
}

/** Give back a slot whose start dialled nothing: refused, or a replay. */
export function releaseConformanceStartSlot(userKey: string): void {
  if (!HOSTED_MODE) return;
  const entry = userWindows.get(userKey);
  if (entry && entry.count > 0) entry.count--;
}

/** Test-only: the bound is only meaningful if a test can actually observe it. */
export function conformanceRunRateLimitWindowCountForTests(): number {
  return ipWindows.size;
}

export const CONFORMANCE_RUN_IP_WINDOW_MAX_ENTRIES = IP_WINDOW_MAX_ENTRIES;

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

  const slot = takeRunSlot(ipWindows, ip, Date.now());
  if (!slot.taken) {
    return c.json(
      {
        code: ErrorCode.RATE_LIMITED,
        message:
          slot.reason === "limited"
            ? "Too many conformance runs from this address. Try again in a few minutes."
            : "Too many conformance runs right now. Try again in a few minutes.",
      },
      429
    );
  }

  return next();
}
