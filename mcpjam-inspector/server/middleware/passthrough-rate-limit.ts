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
 * ## Bounded — and what happens at the bound differs between the two maps
 *
 * Both keys are attacker-controlled, so sustained churn would otherwise grow
 * these maps until the replica died — long before any single bucket hit its
 * limit. Neither map is ever an LRU: evicting the oldest entry would hand a
 * churner a way to reset their own exhausted bucket, which defeats the ceiling
 * exactly where it matters.
 *
 * From there the two maps diverge, because filling them is not equally cheap
 * and being full is not equally harmful:
 *
 *   - A NEW TOKEN KEY IS ONLY CREATED ONCE THE IP BACKSTOP HAS ADMITTED THE
 *     REQUEST. Otherwise one host cycling 10k invented bearers fills the token
 *     map outright: each of those requests is refused by the IP window, but
 *     the entry it inserted on the way past is already there. A full map that
 *     refuses new keys then denies every legitimate caller whose token is not
 *     already resident — the limiter becomes a remotely-triggered outage, for
 *     the price of 10k requests every few minutes. Gating INSERTION on the IP
 *     charge bounds the fill rate to what that backstop already permits.
 *   - IF THE TOKEN MAP IS FULL ANYWAY (many hosts, many tokens), a new key
 *     degrades to IP-only metering instead of being refused. A real backstop
 *     sits underneath it, so the safe direction is the coarser budget rather
 *     than refusing traffic we have simply run out of room to classify.
 *   - THE IP MAP DOES FAIL CLOSED at its cap. Nothing sits under it, and
 *     filling it takes 10k distinct addresses — a distributed flood, which is
 *     the situation a brake exists to bite in.
 *
 * Tokens that already have a window are still charged FIRST, which is the
 * property the ordering comment further down protects.
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

/** No window for this key yet — the caller decides whether to create one. */
const ABSENT = "absent" as const;

interface FixedWindowMap {
  /**
   * Charge a key that already has a window. `null` = allowed, a number =
   * refused with ms until it rolls, `ABSENT` = no window exists yet.
   *
   * Split out from `charge` so a caller can consult a cheaper backstop before
   * deciding to occupy an entry — see the header on why insertion, not
   * exhaustion, is what an attacker actually goes after here.
   */
  chargeExisting: (key: string) => number | null | typeof ABSENT;
  /** Create a window for an absent key. `false` when the map is full. */
  admit: (key: string) => boolean;
  /** `chargeExisting` then `admit` — for keys with nothing underneath them. */
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

  function chargeExisting(key: string): number | null | typeof ABSENT {
    const now = Date.now();
    const entry = windows.get(key);
    if (!entry) return ABSENT;

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

  function admit(key: string): boolean {
    // Full: never evict — see the header. Whether that means "refuse" or
    // "fall back to a coarser budget" is the CALLER's decision, because only
    // the caller knows whether anything sits underneath this map.
    if (windows.size >= MAX_ENTRIES) return false;
    windows.set(key, { count: 1, windowStart: Date.now() });
    return true;
  }

  return {
    chargeExisting,
    admit,
    charge(key: string): number | null {
      const existing = chargeExisting(key);
      if (existing !== ABSENT) return existing;
      return admit(key) ? null : windowMs;
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
  // An EMPTY bearer still gets a token key, deliberately. `bearerAuthMiddleware`
  // labels `Bearer ` with nothing after it as passthrough, and treating that as
  // "no token" let a caller skip the tighter budget by deliberately sending no
  // credential — spending only the SHARED per-IP window, which is precisely the
  // "spend someone else's budget" move the ordering below exists to prevent,
  // reached from the other side. Anonymous callers now share one token bucket.
  const token = authorization?.startsWith("Bearer ")
    ? authorization.slice(7).trim()
    : null;
  const tokenKey = token === null ? null : bearerKey(token);

  // ORDER IS LOAD-BEARING: a token that ALREADY has a window is charged FIRST,
  // and a refusal there returns before the shared IP window is touched.
  //
  // Charging the IP first turns this limiter into a weapon. One caller
  // exhausts its own token budget, and every subsequent REJECTED request still
  // spends from the IP window it shares with everyone behind the same NAT,
  // office or carrier — so a client that is already being refused can go on to
  // deny service to unrelated people at no cost to itself.
  //
  // The rotating-token case still converges on the IP, which was the reason
  // for having two keys at all: each fresh token has no window of its own, so
  // it falls through to the IP charge below.
  let tokenNeedsWindow = false;
  if (tokenKey) {
    const refusedMs = tokenWindows.chargeExisting(tokenKey);
    if (refusedMs === ABSENT) {
      tokenNeedsWindow = true;
    } else if (refusedMs !== null) {
      return tooMany(c, refusedMs);
    }
  }

  // The per-IP backstop, charged for EVERY request that got past the token
  // bucket — including one with no parseable bearer at all.
  const ip = getClientIp(c);
  if (ip) {
    const refusedMs = ipWindows.charge(`ip:${ip}`);
    if (refusedMs !== null) return tooMany(c, refusedMs);
  }

  // Only NOW does a first-seen token occupy an entry: the IP backstop has
  // already admitted this request, so the rate at which the map can be filled
  // is the rate that backstop allows, not the rate an attacker can invent
  // bearers. If it is full anyway, this request has still been metered by IP —
  // see the header on why that degradation beats refusing.
  if (tokenKey && tokenNeedsWindow) {
    tokenWindows.admit(tokenKey);
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
