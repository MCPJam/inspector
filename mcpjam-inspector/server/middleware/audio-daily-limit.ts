import type { Context, Next } from "hono";
import { ErrorCode } from "../routes/web/errors.js";
import { getAttestedClientIp } from "../utils/client-ip.js";
import { HOSTED_MODE } from "../config.js";

/**
 * Per-address DAILY ceiling on guest voice transcription, layered under the
 * 60/min per-guest limiter.
 *
 * ## Why a second key is needed at all
 *
 * Transcription is billed per audio-minute against MCPJam's provider balance,
 * and the backend already meters it — `voiceSecondsRemaining` is derived there
 * from a per-identity daily credit bucket. That bucket is keyed on the guest
 * identity, and a guest identity is free to mint: `POST /api/web/guest-session`
 * hands one to anybody, 10 times a minute per IP
 * (`routes/web/guest-session-shared.ts`). A per-identity budget therefore
 * bounds one polite caller and nothing else — an actor willing to make one
 * extra request gets a fresh allowance whenever the old one runs out.
 *
 * The address is the coarsest thing the same actor cannot re-roll for free, so
 * it is the honest unit for "how much of our provider balance may one actor
 * spend in a day". Both limits apply; the per-minute one is the tighter budget
 * a real client meets first.
 *
 * ## ATTESTED addresses only, and one shared bucket for the rest
 *
 * `getAttestedClientIp`, not `getClientIp`. The latter answers "who does this
 * request say it is", which is a header the caller writes — and a limiter keyed
 * on a value the caller rotates is a memory-exhaustion primitive rather than a
 * limiter: enough rotations fill the table, and because this one FAILS CLOSED
 * at its bound, every guest arriving afterwards would be refused. That turns
 * the control into a remotely-triggered outage for the price of a few thousand
 * requests. `utils/client-ip.ts` documents the distinction; this follows the
 * consumer pattern `routes/web/bench.ts` established.
 *
 * So an attested address (Cloudflare rewrites `cf-connecting-ip` on the hosted
 * edge, or an operator names their own ingress header) gets its own window, and
 * everything un-attestable shares ONE pooled window with a larger allowance.
 * Pooled rather than skipped: skipping would make the ceiling opt-out by
 * stripping a header.
 *
 * ## Guests only
 *
 * A signed-in caller is bounded by their organization's own daily entitlement,
 * which is real shared state and cannot be multiplied by minting anything. A
 * WorkOS API key is metered per key in `bearer-auth.ts`. Charging either of
 * them against a shared address bucket would penalize a team behind one office
 * NAT for being on the same network, and buys nothing the backend does not
 * already enforce against a non-forgeable identity.
 *
 * ## PER REPLICA, not per fleet
 *
 * The windows live in this process's memory, so a horizontally scaled
 * deployment enforces this per replica and the real ceiling is this number
 * times the replica count — the same trade `conformance-run-rate-limit.ts` and
 * `bench.ts` document. This is an edge brake that refuses a flood here instead
 * of carrying it to Convex to be refused there. It is NOT the authoritative
 * spend ceiling and must not be described as one: that is the backend's credit
 * bucket. If this ever needs to be exact it needs shared state, not a smaller
 * number.
 *
 * Local/desktop mode is exempt: the "fleet" there is one developer's laptop.
 */

/**
 * Requests per address per day. Generous against a human — the product caps one
 * recording at 180s, so this is hours of dictation from a single address — and
 * a hard bound where there was effectively none.
 *
 * Env-tunable so a mis-sized limit is a config change rather than a deploy.
 */
const DEFAULT_DAILY_LIMIT = 200;
const DAILY_LIMIT = (() => {
  const raw = process.env.MCPJAM_AUDIO_DAILY_IP_LIMIT;
  if (!raw) return DEFAULT_DAILY_LIMIT;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_DAILY_LIMIT;
})();

/** The pooled window covers many callers, so it gets a multiple. */
const UNATTESTED_DAILY_LIMIT = 4 * DAILY_LIMIT;
const UNATTESTED_CLIENT_KEY = "_unattested";

const DAILY_WINDOW_MS = 24 * 60 * 60_000;

/**
 * Bounded. At the bound this limiter DEGRADES rather than refusing, which is
 * the opposite of what `conformance-run-rate-limit.ts`, `bench.ts` and
 * `passthrough-rate-limit.ts` do — deliberately, and for the reason
 * `passthrough-rate-limit.ts` itself states when it explains why ITS ip map
 * fails closed: "Nothing sits under it."
 *
 * Something sits under this one. The backend caps guest voice spend at
 * $0.20/day per identity and $1.00/day per IP hash
 * (`convex/usage/rateLimit.ts`), and that is the authoritative ceiling; this is
 * a volume brake in front of it. Refusing new callers at a full map would
 * therefore trade a cost problem that is already bounded for an availability
 * problem that is not — and the trade is worse here than in those other
 * limiters because this window is a DAY, so a full map stays full for a day
 * rather than draining in ten minutes. Someone with 10k attestable addresses
 * could otherwise turn a spend brake into a day-long voice outage for every
 * guest on the replica.
 *
 * Not an LRU either: evicting the oldest entry to make room would hand a
 * churner a way to clear their own exhausted window, which is the one property
 * a ceiling cannot give up. New callers simply go unmetered here until a window
 * expires, and stay metered by the backend throughout.
 */
const WINDOW_MAX_ENTRIES = 10_000;
const windows = new Map<string, { count: number; windowStart: number }>();

// Memory sweep, not the clock — correctness comes from the expiry-in-place
// check below. Hourly rather than the 5-minute cadence the per-minute limiters
// use: entries here live a day, so a frequent sweep would walk the whole map to
// evict nothing.
setInterval(
  () => {
    const now = Date.now();
    for (const [key, entry] of windows) {
      if (now - entry.windowStart >= DAILY_WINDOW_MS) {
        windows.delete(key);
      }
    }
  },
  60 * 60_000
).unref();

export function resetAudioDailyLimitForTests(): void {
  windows.clear();
}

/** Test-only: the bound is only meaningful if a test can actually observe it. */
export function audioDailyLimitWindowCountForTests(): number {
  return windows.size;
}

export const AUDIO_DAILY_IP_LIMIT = DAILY_LIMIT;
export const AUDIO_DAILY_WINDOW_MAX_ENTRIES = WINDOW_MAX_ENTRIES;

/** An attested address gets its own window; everyone else shares one. */
function clientBudget(c: Context) {
  const attested = getAttestedClientIp(c);
  return attested
    ? { key: attested, limit: DAILY_LIMIT }
    : { key: UNATTESTED_CLIENT_KEY, limit: UNATTESTED_DAILY_LIMIT };
}

/**
 * The only 429 this middleware produces, so `Retry-After` is unconditional —
 * the published spec promises it on every rate-limited response, and an
 * optional header is how that promise gets broken by a later branch.
 */
function rateLimited(c: Context, message: string, windowStart: number) {
  return c.json({ code: ErrorCode.RATE_LIMITED, message }, 429, {
    // A fixed window, so the wait is exactly the remainder of it.
    "Retry-After": String(
      Math.max(
        1,
        Math.ceil((windowStart + DAILY_WINDOW_MS - Date.now()) / 1000)
      )
    ),
  });
}

export async function audioDailyLimitMiddleware(
  c: Context,
  next: Next
): Promise<Response | void> {
  if (!HOSTED_MODE) return next();

  // Guests only. `bearerAuthMiddleware` has already run and set this for a
  // validated guest token; a signed-in caller has no `guestId` and is metered
  // by their own entitlement upstream.
  if (!c.get("guestId")) return next();

  const { key, limit } = clientBudget(c);
  const now = Date.now();
  const entry = windows.get(key);

  if (entry) {
    if (now - entry.windowStart >= DAILY_WINDOW_MS) {
      // Expired in place. The sweep timer is a memory sweep, not the clock —
      // correctness cannot depend on when it last ran.
      entry.count = 1;
      entry.windowStart = now;
      return next();
    }
    if (entry.count >= limit) {
      return rateLimited(
        c,
        "Daily voice transcription limit reached for this address. Sign in for higher limits.",
        entry.windowStart
      );
    }
    entry.count++;
    return next();
  }

  if (windows.size >= WINDOW_MAX_ENTRIES) {
    // Full: admit without metering rather than refuse. See the comment on
    // WINDOW_MAX_ENTRIES — the backend's per-identity and per-IP daily spend
    // caps still apply to this request, so the cost stays bounded, while
    // refusing here would let anyone holding 10k addresses deny guest voice to
    // everyone else on this replica for a day.
    return next();
  }
  windows.set(key, { count: 1, windowStart: now });

  return next();
}
