import { createHash } from "node:crypto";
import type { Context, Next } from "hono";
import { ErrorCode } from "../routes/web/errors.js";
import { getClientIp } from "../utils/client-ip.js";
import { HOSTED_MODE } from "../config.js";

/**
 * A spike brake on the `unverified_passthrough` branch of `bearerAuthMiddleware`.
 *
 * That branch is the one credential class the gateway does not check. An `sk_`
 * key is validated against WorkOS and metered per key; a guest token is
 * validated and metered per guest id. An AuthKit JWT is deliberately NOT
 * verified here — every route it fronts forwards the bearer to Convex, which
 * verifies it against AuthKit's JWKS, and verifying twice would add a JWKS
 * round trip to the hot path to reach the same answer. That reasoning is
 * sound, and it left this branch as the only one that reached the handlers
 * with no budget attached to it at all.
 *
 * ## What this is, and what it is not
 *
 * A PER-REPLICA spike brake. The windows live in this process's memory, so a
 * horizontally scaled deployment enforces this per replica and the real
 * ceiling moves with the replica count — the same trade
 * `server-connection-claim-rate-limit.ts` documents. The real cap is the
 * backend's org-keyed budgets (`lib/expensiveWriteRateLimit.ts` and the daily
 * entitlements), which are shared state and cannot be multiplied by scaling.
 * This exists so a flood is refused at the edge instead of being carried all
 * the way to Convex to be refused there.
 *
 * ## Two keys, because one of them is free to rotate
 *
 * A bearer token costs nothing to change, so a per-token bucket alone brakes
 * an honest client and nothing else: an attacker rotates the token per
 * request and every request gets a fresh budget. The per-IP window is the
 * backstop those rotated requests converge on. Both apply; the token bucket is
 * the tighter one a real client meets first.
 *
 * The token is HASHED before it becomes a map key. It is a credential, and
 * an in-memory structure that can end up in a heap dump has no business
 * holding the raw value.
 *
 * ## Bounded, and fails closed when full
 *
 * Both keys are attacker-controlled, so sustained churn would otherwise grow
 * these maps until the replica died — long before any single bucket hit its
 * limit. At the cap, NEW keys are refused while existing ones keep being
 * served. Evicting the oldest entry instead (an LRU) would hand a churner a
 * way to reset their own exhausted bucket, which defeats the ceiling exactly
 * where it matters.
 *
 * Local/desktop mode is exempt: there is one user, and it is the person who
 * started the process.
 */

/** See the header: bounded, refuse-new-when-full, never an LRU. */
const MAX_ENTRIES = 10_000;

/**
 * Per-token requests per minute.
 *
 * Sized above what a person driving the hosted app produces — a page load
 * fans out into a handful of reads, and a busy session a few dozen a minute —
 * and far below a loop. Deliberately looser than the `sk_` budget (60/min):
 * that one meters a MACHINE credential built for scripting, where this fronts
 * an interactive browser session that legitimately bursts on navigation.
 */
const TOKEN_LIMIT = 120;
const TOKEN_WINDOW_MS = 60_000;

/**
 * Per-IP requests per minute — the backstop for rotated tokens.
 *
 * Higher than the per-token budget on purpose: an IP is not a caller. Offices,
 * VPNs and mobile carriers put many real users behind one address, so this has
 * to clear "a floor of people using the product" while still bounding one
 * machine's loop. It is the ceiling a token-rotating client converges on.
 */
const IP_LIMIT = 600;
const IP_WINDOW_MS = 60_000;

type Window = { count: number; windowStart: number };

interface FixedWindowMap {
  /** `null` = allowed. A number = refused, with ms until the window rolls. */
  charge: (key: string) => number | null;
  clear: () => void;
  size: () => number;
}

function createFixedWindowMap(limit: number, windowMs: number): FixedWindowMap {
  const windows = new Map<string, Window>();

  setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of windows) {
      if (now - entry.windowStart > windowMs * 2) {
        windows.delete(key);
      }
    }
  }, 5 * 60_000).unref();

  return {
    charge(key: string): number | null {
      const now = Date.now();
      const entry = windows.get(key);

      if (entry) {
        if (now - entry.windowStart < windowMs) {
          if (entry.count >= limit) {
            return entry.windowStart + windowMs - now;
          }
          entry.count++;
          return null;
        }
        entry.count = 1;
        entry.windowStart = now;
        return null;
      }

      // Full: refuse the NEW key rather than evicting an existing one. See the
      // header — eviction would let a churner reset their own bucket.
      if (windows.size >= MAX_ENTRIES) return windowMs;

      windows.set(key, { count: 1, windowStart: now });
      return null;
    },
    clear: () => windows.clear(),
    size: () => windows.size,
  };
}

const tokenWindows = createFixedWindowMap(TOKEN_LIMIT, TOKEN_WINDOW_MS);
const ipWindows = createFixedWindowMap(IP_LIMIT, IP_WINDOW_MS);

/** The map key for a bearer. Hashed — see the header. */
function bearerKey(token: string): string {
  return createHash("sha256").update(token).digest("hex").slice(0, 32);
}

function tooMany(c: Context, retryAfterMs: number) {
  return c.json(
    {
      code: ErrorCode.RATE_LIMITED,
      message: "Too many requests. Slow down and retry.",
    },
    429,
    {
      "Retry-After": String(Math.max(1, Math.ceil(retryAfterMs / 1000))),
    }
  );
}

/**
 * Mounted AFTER `bearerAuthMiddleware`, which is what makes the narrow
 * condition below possible: the label it sets is the only thing that
 * distinguishes an asserted identity from a verified one, and every other
 * branch already carries its own budget.
 */
export async function passthroughRateLimitMiddleware(
  c: Context,
  next: Next
): Promise<Response | void> {
  if (!HOSTED_MODE) return next();
  if (c.get("authMethod") !== "unverified_passthrough") return next();

  const authorization = c.req.header("authorization");
  const token = authorization?.startsWith("Bearer ")
    ? authorization.slice(7).trim()
    : null;

  // The per-IP backstop runs FIRST and unconditionally. A caller with no
  // parseable bearer would otherwise skip metering entirely by simply not
  // sending one — and this branch is reached precisely by requests whose
  // credential nothing here has checked.
  const ip = getClientIp(c);
  if (ip) {
    const refusedMs = ipWindows.charge(`ip:${ip}`);
    if (refusedMs !== null) return tooMany(c, refusedMs);
  }

  if (token) {
    const refusedMs = tokenWindows.charge(bearerKey(token));
    if (refusedMs !== null) return tooMany(c, refusedMs);
  }

  return next();
}

export const PASSTHROUGH_TOKEN_LIMIT = TOKEN_LIMIT;
export const PASSTHROUGH_IP_LIMIT = IP_LIMIT;
export const PASSTHROUGH_MAX_ENTRIES = MAX_ENTRIES;

export function resetPassthroughRateLimitForTests(): void {
  tokenWindows.clear();
  ipWindows.clear();
}
