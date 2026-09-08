import { createHash } from "node:crypto";
import type { Context, Next } from "hono";
import { ErrorCode } from "../routes/web/errors.js";
import { getClientIp } from "../utils/client-ip.js";
import { HOSTED_MODE } from "../config.js";

/**
 * Per-credential ceiling on the routes that spend our egress dialling a
 * caller-named MCP server: `/servers/doctor` and `/servers/validate`, on both
 * `/api/web` and their `/v1` twins.
 *
 * WHY THESE TWO ROUTES HAVE THEIR OWN BUDGET. `guestRateLimitMiddleware` is the
 * only limiter on `/api/web/servers/*`, and it returns `next()` the moment
 * there is no `guestId` — so a signed-in caller was unmetered (finding MJ-012,
 * confirmed: forty consecutive requests, zero 429s). The `sk_` bucket inside
 * `bearerAuthMiddleware` meters an API key at 60/min, which is a budget for API
 * calls in general and not for outbound connections in particular.
 * `passthroughRateLimitMiddleware` meters per credential but is mounted only on
 * `/v1/*` and only for the one unverified class. None of that bounds "how much
 * of our egress may one caller spend", which is the quantity that made MJ-001's
 * port scan practical at scale.
 *
 * This is the doctor/validate slice of MJ-012, not MJ-012 itself: metering the
 * whole `/api/web/*` family is that finding's remediation and a much wider
 * blast radius.
 *
 * PER CREDENTIAL, WITH A PER-IP BACKSTOP — the split
 * `passthrough-rate-limit.ts` documents, for the reason it gives. A bearer
 * costs nothing to rotate, so a per-credential bucket alone brakes an honest
 * client and nobody else; the address is what rotated requests converge on. The
 * ordering below is load-bearing for the same reason it is there: a caller
 * already being refused must not be able to spend the budget it shares with
 * everyone behind the same NAT.
 *
 * SIZING. Measured rather than guessed. Hosted connect-shaped activity over the
 * 30 days to 2026-09-07 runs p50 1, p95 3, p99 5, observed maximum 10 per
 * person per five minutes, and per address the distribution is the same (max
 * 10, never more than two people behind one address). 20 is four times p99 and
 * twice the observed ceiling; 60 leaves room for a NAT far larger than any
 * we have seen. `/servers/doctor` has no first-party caller at all — not the
 * client, not the CLI, which runs the SDK doctor in-process — so there is no
 * in-product burst pattern these numbers could be cutting into.
 *
 * PER PROCESS, not per fleet. The windows live in this replica's memory, so a
 * horizontally scaled deployment enforces this per replica and the real ceiling
 * moves with the replica count. That is the same deliberate trade
 * `conformance-run-rate-limit.ts` and `passthrough-rate-limit.ts` document: it
 * blunts abuse rather than metering a product, and making it exact needs shared
 * state, not a smaller number.
 *
 * Local/desktop mode is exempt. `routes/web/**` is mounted there too, and the
 * one user is the person who started the process, dialling their own server.
 */

/** Per-credential requests per window. See SIZING above. */
const CREDENTIAL_LIMIT = 20;
/** Per-address requests per window — the backstop for rotated credentials. */
const IP_LIMIT = 60;
const WINDOW_MS = 5 * 60_000;

/**
 * Bounded, and the two maps behave differently when full — the reasoning is
 * `passthrough-rate-limit.ts`'s and applies unchanged. Neither is ever an LRU:
 * evicting the oldest entry would hand a churner a way to reset its own
 * exhausted bucket, defeating the ceiling exactly where it matters.
 */
const MAX_ENTRIES = 10_000;

type Window = { count: number; windowStart: number };

const credentialWindows = new Map<string, Window>();
const ipWindows = new Map<string, Window>();

for (const windows of [credentialWindows, ipWindows]) {
  setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of windows) {
      if (now - entry.windowStart > WINDOW_MS * 2) windows.delete(key);
    }
  }, 5 * 60_000).unref();
}

/** `null` = allowed, a number = ms until the window rolls, `"absent"` = no window yet. */
function chargeExisting(
  windows: Map<string, Window>,
  key: string,
  limit: number
): number | null | "absent" {
  const entry = windows.get(key);
  if (!entry) return "absent";
  const now = Date.now();
  if (now - entry.windowStart >= WINDOW_MS) {
    entry.count = 1;
    entry.windowStart = now;
    return null;
  }
  if (entry.count >= limit) {
    return entry.windowStart + WINDOW_MS - now;
  }
  entry.count++;
  return null;
}

function admit(windows: Map<string, Window>, key: string): boolean {
  if (windows.size >= MAX_ENTRIES) return false;
  windows.set(key, { count: 1, windowStart: Date.now() });
  return true;
}

/**
 * The caller's identity, as the gateway already resolved it.
 *
 * `bearerAuthMiddleware` sets exactly one of these, so the branches are a
 * discrimination rather than a preference order. The raw bearer is HASHED
 * before it becomes a map key: it is a credential, and an in-memory structure
 * that can end up in a heap dump has no business holding the value.
 *
 * An EMPTY bearer still gets a key, deliberately — the same hole
 * `passthrough-rate-limit.ts` closes from the other side. Treating "no
 * credential" as "no bucket" would let a caller skip the tighter budget by
 * sending no credential and spend only the shared per-IP window, which is the
 * spend-someone-else's-budget move the ordering exists to prevent.
 */
function credentialKey(c: Context): string {
  const apiKeyId = c.get("workosApiKeyId");
  if (typeof apiKeyId === "string" && apiKeyId) return `key:${apiKeyId}`;
  const guestId = c.get("guestId");
  if (typeof guestId === "string" && guestId) return `guest:${guestId}`;
  const authorization = c.req.header("authorization");
  const token = authorization?.startsWith("Bearer ")
    ? authorization.slice(7).trim()
    : "";
  return `bearer:${createHash("sha256").update(token).digest("hex")}`;
}

function tooMany(c: Context, retryAfterMs: number) {
  return c.json(
    {
      code: ErrorCode.RATE_LIMITED,
      message:
        "Too many server diagnostics from this account. Try again in a few minutes.",
    },
    429,
    {
      "Retry-After": String(Math.max(1, Math.ceil(retryAfterMs / 1000))),
    }
  );
}

export async function mcpEgressRateLimitMiddleware(
  c: Context,
  next: Next
): Promise<Response | void> {
  if (!HOSTED_MODE) return next();

  // POST ONLY, and the reason is the same one `server-connection-claim-rate-limit.ts`
  // gives for its own method gate: the middleware is mounted on a PATH, so
  // without this any method reaching that path spends the budget. Both guarded
  // routes are POST — a GET or HEAD to them opens no MCP connection at all, so
  // charging it would let a caller exhaust its own doctor quota with requests
  // that cost us no egress, and then meet a 429 on the operation that does.
  if (c.req.method !== "POST") return next();

  const key = credentialKey(c);

  // ORDER IS LOAD-BEARING: a credential that ALREADY has a window is charged
  // first, and a refusal there returns before the shared IP window is touched.
  // Charging the IP first would let a caller who has exhausted its own budget
  // go on spending the address's budget with every rejected request — denying
  // service to unrelated people at no cost to itself.
  let credentialNeedsWindow = false;
  const credentialRefusal = chargeExisting(
    credentialWindows,
    key,
    CREDENTIAL_LIMIT
  );
  if (credentialRefusal === "absent") {
    credentialNeedsWindow = true;
  } else if (credentialRefusal !== null) {
    return tooMany(c, credentialRefusal);
  }

  const ip = getClientIp(c);
  if (ip) {
    const ipKey = `ip:${ip}`;
    const refusal = chargeExisting(ipWindows, ipKey, IP_LIMIT);
    if (refusal === "absent") {
      // The IP map FAILS CLOSED at its cap: nothing sits underneath it, and
      // filling it takes 10k distinct addresses — a distributed flood, which is
      // the situation a brake exists to bite in.
      if (!admit(ipWindows, ipKey)) return tooMany(c, WINDOW_MS);
    } else if (refusal !== null) {
      return tooMany(c, refusal);
    }
  }

  // Only NOW does a first-seen credential occupy an entry: the IP backstop has
  // already admitted this request, so the rate at which this map can be filled
  // is the rate that backstop allows rather than the rate an attacker can
  // invent bearers. If it is full anyway the request has still been metered by
  // address, which is the safer degradation — refusing traffic we have merely
  // run out of room to classify would make the limiter the outage.
  if (credentialNeedsWindow) {
    admit(credentialWindows, key);
  }

  return next();
}

export const MCP_EGRESS_CREDENTIAL_LIMIT = CREDENTIAL_LIMIT;
export const MCP_EGRESS_IP_LIMIT = IP_LIMIT;
export const MCP_EGRESS_WINDOW_MS = WINDOW_MS;
export const MCP_EGRESS_MAX_ENTRIES = MAX_ENTRIES;

export function resetMcpEgressRateLimitForTests(): void {
  credentialWindows.clear();
  ipWindows.clear();
}
