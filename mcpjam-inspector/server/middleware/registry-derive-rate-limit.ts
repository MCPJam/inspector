import type { Context, Next } from "hono";
import { ErrorCode } from "../routes/web/errors.js";
import { getClientIp } from "../utils/client-ip.js";
import { HOSTED_MODE } from "../config.js";

/**
 * Per-IP ceiling on org-registry URL derivation.
 *
 * Deriving an entry means dialing a server the caller named — an MCP
 * initialize, an SSE fallback, resource metadata, authorization-server
 * metadata, each with its own retries. The route authorizes first (org
 * membership, checked against the backend with the caller's own bearer), so
 * this is not the thing standing between a stranger and our egress. It bounds
 * how much of that egress ONE member can spend, which authorization does not:
 * a member is entitled to add entries, not to point us at a thousand addresses
 * a minute.
 *
 * Sized for the act it meters. Adding a server to the shelf is a deliberate,
 * occasional thing: paste, look at what came back, maybe fix a typo and paste
 * again. Twenty in ten minutes covers a person setting up a whole team's
 * registry in one sitting and still refuses a loop.
 *
 * PER PROCESS, not per fleet — the same trade `conformance-run-rate-limit.ts`
 * documents at length. The window lives in this replica's memory, so the real
 * ceiling is this number times the replica count and it moves when the
 * deployment scales. It blunts abuse; making it a guarantee needs shared
 * state, not a smaller number.
 *
 * Local/desktop mode is exempt: one user, dialing servers they already have.
 */

const DERIVE_RATE_LIMIT = 20;
const DERIVE_WINDOW_MS = 10 * 60_000;

/**
 * Bounded, and FAILS CLOSED when full rather than evicting. The key comes from
 * a client-supplied forwarding header, so sustained IP churn would otherwise
 * grow this map until the replica died — and evicting the oldest entry would
 * hand a churner a way to reset their own exhausted bucket, defeating the
 * ceiling exactly where it matters.
 */
const IP_WINDOW_MAX_ENTRIES = 10_000;
const ipWindows = new Map<string, { count: number; windowStart: number }>();

setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of ipWindows) {
    if (now - entry.windowStart > DERIVE_WINDOW_MS * 2) {
      ipWindows.delete(ip);
    }
  }
}, 5 * 60_000).unref();

export const REGISTRY_DERIVE_RATE_LIMIT = DERIVE_RATE_LIMIT;

export function resetRegistryDeriveRateLimitForTests(): void {
  ipWindows.clear();
}

export function consumeRegistryDeriveRateLimit(c: Context): Response | null {
  if (!HOSTED_MODE) return null;
  if (c.req.method !== "POST") return null;

  const ip = getClientIp(c);
  if (!ip) return null;

  const now = Date.now();
  const entry = ipWindows.get(ip);
  const tooMany = (retryAfterMs: number) =>
    c.json(
      {
        code: ErrorCode.RATE_LIMITED,
        message:
          "Too many servers derived from this address. Try again in a few minutes.",
      },
      429,
      { "Retry-After": String(Math.max(1, Math.ceil(retryAfterMs / 1000))) }
    );

  if (entry) {
    if (now - entry.windowStart < DERIVE_WINDOW_MS) {
      if (entry.count >= DERIVE_RATE_LIMIT) {
        return tooMany(entry.windowStart + DERIVE_WINDOW_MS - now);
      }
      entry.count++;
    } else {
      entry.count = 1;
      entry.windowStart = now;
    }
  } else {
    if (ipWindows.size >= IP_WINDOW_MAX_ENTRIES) {
      return tooMany(DERIVE_WINDOW_MS);
    }
    ipWindows.set(ip, { count: 1, windowStart: now });
  }

  return null;
}

export async function registryDeriveRateLimitMiddleware(
  c: Context,
  next: Next
): Promise<Response | void> {
  return consumeRegistryDeriveRateLimit(c) ?? next();
}
