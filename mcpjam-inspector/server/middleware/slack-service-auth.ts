/**
 * `slk_` — the MCPJam Slack bot's service credential.
 *
 * WHY IT IS NOT AN `sk_` KEY. An `sk_` key IS a user's credential: whoever
 * holds it acts as that user, everywhere the key is accepted, and the
 * inspector will mint 2-hour org-scoped delegated JWTs for it. The Slack bot
 * runs unattended on a third-party surface and acts for MANY users, so giving
 * it an `sk_` key would mean a compromised bot could harvest portable org
 * tokens for whoever it liked. `slk_` grants nothing by itself: it only names
 * the bot, and every request must ALSO name a Slack user who has completed the
 * account link. The identity comes from the link, not from the token.
 *
 * TOKEN VERIFICATION is against a SHA-256 hash in the environment, with a
 * constant-time compare — the same shape as `INSPECTOR_SERVICE_TOKEN`, the
 * credential this sits beside. It is a single static value rotated by
 * redeploy; what genuinely changes without a deploy (who is linked to whom)
 * is resolved from the backend on every request.
 *
 * FAIL-CLOSED ALLOWLIST. `slk_` is accepted on a short, explicit list of
 * paths and refused everywhere else with a 401. This middleware runs on
 * `/api/v1/*` AND on ~25 `/api/web/*` groups, so a default-allow posture would
 * silently expose the whole web surface to the bot's credential.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import type { Context } from "hono";
import { ErrorCode } from "../routes/web/errors.js";
import {
  resolveSlackActingUser,
  SlackBackendUnavailable,
} from "../services/slack-backend.js";
import { logger } from "../utils/logger.js";

export const SLACK_TOKEN_PREFIX = "slk_";
export const SLACK_TEAM_HEADER = "x-mcpjam-slack-team-id";
export const SLACK_USER_HEADER = "x-mcpjam-slack-user-id";

/**
 * Paths `slk_` may reach, as regexes against the full request path.
 *
 * Deliberately narrow: the agent turn, eval-run create/read (the human-gated
 * Run button and its status poller), and the project list (the App Home
 * picker). Everything the bot does today is on this list; anything it does
 * tomorrow has to be added here on purpose.
 */
const SLACK_ALLOWED_PATHS: ReadonlyArray<RegExp> = [
  /^\/api\/v1\/projects\/[^/]+\/agent$/,
  // POST creates a run. Reachable only for the RETIRED Run-it button, whose
  // handler survives as a shim for buttons on messages posted before the
  // switch to proposals. This entry goes with that shim.
  /^\/api\/v1\/projects\/[^/]+\/eval-runs$/,
  /^\/api\/v1\/projects\/[^/]+\/eval-runs\/[^/]+$/,
  /^\/api\/v1\/projects$/,
  // Executing an action a human approved. Safe to reach with `slk_` for the
  // same reason the agent turn is: the token only names the bot, and the
  // clicker named in the headers is who the execution is authorized as.
  /^\/api\/v1\/projects\/[^/]+\/proposed-actions\/[^/]+\/execute$/,
  // Run EVIDENCE, for posting screenshots when a watched run finishes.
  //
  // Two entries because steps are ITERATION-scoped: the bot lists a run's
  // iterations, then fetches bounded step pages per iteration. Both are reads
  // of a run the acting user can already see (the delegated JWT enforces
  // that), and neither can start or change anything.
  /^\/api\/v1\/projects\/[^/]+\/eval-runs\/[^/]+\/iterations$/,
  /^\/api\/v1\/projects\/[^/]+\/eval-runs\/[^/]+\/iterations\/[^/]+\/steps$/,
];

function isAllowedSlackPath(path: string): boolean {
  return SLACK_ALLOWED_PATHS.some((pattern) => pattern.test(path));
}

/**
 * Per-LINK rate bucket: burst 10, 60/min sustained.
 *
 * Keyed on the acting user's link rather than on the token, because the token
 * is shared by every user of the bot — a token-keyed bucket would let one
 * chatty workspace throttle everybody. In-process, like the `sk_` bucket
 * beside it; the Railway service is pinned to one replica for exactly this
 * reason (see slack-app/railway.toml).
 */
const SLACK_RATE_LIMIT_PER_MIN = 60;
const SLACK_RATE_BURST = 10;
const SLACK_RATE_REFILL_PER_MS = SLACK_RATE_LIMIT_PER_MIN / 60_000;

interface TokenBucket {
  tokens: number;
  lastRefill: number;
}

const slackLinkBuckets = new Map<string, TokenBucket>();

setInterval(() => {
  const now = Date.now();
  for (const [id, bucket] of slackLinkBuckets) {
    if (now - bucket.lastRefill > 5 * 60_000) {
      slackLinkBuckets.delete(id);
    }
  }
}, 5 * 60_000).unref();

/**
 * Hard cap on distinct buckets.
 *
 * The bucket is created BEFORE the account-link lookup (deliberately — see the
 * debit site), so the key is a pair of caller-supplied headers. Without a
 * ceiling, a holder of the shared `slk_` token could mint one permanent bucket
 * per invented header pair and grow this map without limit. The 5-minute sweep
 * below handles the steady state; this handles a burst inside one sweep window.
 */
const SLACK_BUCKET_MAX_ENTRIES = 10_000;

/**
 * How far below the cap one eviction pass trims.
 *
 * Trimming to exactly the cap would put an O(n log n) sort on EVERY subsequent
 * insertion once the map is full — and insertions are attacker-driven, since
 * the key is a pair of caller-supplied headers. That turns a memory bound into
 * a CPU amplifier: each invented header pair would pay for a full sort of ten
 * thousand entries before its request proceeded. Overshooting means the sort
 * runs once per batch instead, so its cost amortizes to O(log n) per insertion.
 */
const SLACK_BUCKET_EVICT_BATCH = 1_024;

/**
 * Trim to a batch below the bound, dropping the FULLEST buckets first.
 *
 * Eviction restores a caller's full burst, so the entries that are safe to drop
 * are the ones already at or near full — a caller who has been quiet long
 * enough to refill loses nothing it did not already have. Evicting by age
 * instead would happily drop a bucket that is empty because its owner is being
 * throttled right now, handing an active abuser a fresh burst and turning the
 * memory bound into a rate-limit bypass. Ties break toward the least recently
 * refilled, which is the idle-caller heuristic the age sort was reaching for.
 */
function evictSlackBuckets(): void {
  if (slackLinkBuckets.size <= SLACK_BUCKET_MAX_ENTRIES) return;
  const now = Date.now();
  const refilled = (bucket: TokenBucket) =>
    Math.min(
      SLACK_RATE_BURST,
      bucket.tokens + (now - bucket.lastRefill) * SLACK_RATE_REFILL_PER_MS
    );
  const byCheapness = [...slackLinkBuckets.entries()].sort((left, right) => {
    const delta = refilled(right[1]) - refilled(left[1]);
    return delta !== 0 ? delta : left[1].lastRefill - right[1].lastRefill;
  });
  const target =
    slackLinkBuckets.size - SLACK_BUCKET_MAX_ENTRIES + SLACK_BUCKET_EVICT_BATCH;
  for (const [id] of byCheapness.slice(0, target)) {
    slackLinkBuckets.delete(id);
  }
}

/** Returns ms to wait, or null when admitted. */
function consumeSlackToken(linkKey: string): number | null {
  const now = Date.now();
  const existing = slackLinkBuckets.get(linkKey);
  if (!existing) {
    slackLinkBuckets.set(linkKey, {
      tokens: SLACK_RATE_BURST - 1,
      lastRefill: now,
    });
    // Evicting a bucket only restores its full burst, so the worst case is one
    // extra burst for a caller who has been quiet longest — a far better
    // failure than unbounded memory.
    evictSlackBuckets();
    return null;
  }
  const refilled = Math.min(
    SLACK_RATE_BURST,
    existing.tokens + (now - existing.lastRefill) * SLACK_RATE_REFILL_PER_MS
  );
  if (refilled < 1) {
    existing.tokens = refilled;
    existing.lastRefill = now;
    return Math.max(Math.ceil((1 - refilled) / SLACK_RATE_REFILL_PER_MS), 1);
  }
  existing.tokens = refilled - 1;
  existing.lastRefill = now;
  return null;
}

/** Test-only. */
export function resetSlackRateLimitForTests(): void {
  slackLinkBuckets.clear();
}

/**
 * Constant-time comparison of the presented token's hash against the
 * configured one. A plain `!==` bails on the first mismatched byte, leaking
 * the divergence position through response latency.
 */
function tokenHashMatches(token: string): boolean {
  const configured = process.env.MCPJAM_SLACK_SERVICE_TOKEN_HASH;
  if (!configured) return false;
  const presented = createHash("sha256").update(token).digest("hex");
  const left = Buffer.from(presented, "utf8");
  const right = Buffer.from(configured.trim().toLowerCase(), "utf8");
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/**
 * Verify a presented `slk_` value outside this middleware's own dispatch.
 *
 * The one legitimate external consumer is the link bridge's session-mint
 * route: minting a connect URL is Slack-bot business, so the bot presents the
 * SAME `slk_` credential there rather than being handed the inspector's
 * environment-root service token (whose blast radius includes arbitrary user
 * delegation). Anything else that wants this should almost certainly be a new
 * entry in the path allowlist instead.
 */
export function isValidSlackServiceToken(token: string): boolean {
  return token.startsWith(SLACK_TOKEN_PREFIX) && tokenHashMatches(token);
}

/**
 * Handle an `slk_` bearer. Returns a Response to short-circuit with, or null
 * when the request has been authorized and should continue.
 */
export async function handleSlackServiceAuth(
  c: Context,
  token: string
): Promise<Response | null> {
  // Token FIRST. The path check below logs a caller-controlled value, so
  // proving the token genuine before reaching it keeps an anonymous caller
  // from writing unbounded log lines (and forging them with CRLF) by sending
  // `Bearer slk_x` at arbitrary paths.
  if (!tokenHashMatches(token)) {
    return c.json(
      { code: ErrorCode.UNAUTHORIZED, message: "Invalid API key" },
      401
    );
  }

  // Path check before ANY backend work: a non-allowlisted route must not cost
  // a round trip, and must not be distinguishable from an invalid token by
  // error text.
  if (!isAllowedSlackPath(c.req.path)) {
    logger.warn("Slack service token used on a non-allowlisted path", {
      // Bounded and newline-stripped: this is request-derived.
      path: c.req.path.slice(0, 200).replace(/[\r\n]/g, ""),
    });
    return c.json(
      { code: ErrorCode.UNAUTHORIZED, message: "Invalid API key" },
      401
    );
  }

  const teamId = c.req.header(SLACK_TEAM_HEADER)?.trim();
  const slackUserId = c.req.header(SLACK_USER_HEADER)?.trim();
  if (!teamId || !slackUserId) {
    // The token names the bot; it never names a user. Without both headers
    // there is no identity to act as, and defaulting to any is unthinkable.
    return c.json(
      {
        code: ErrorCode.UNAUTHORIZED,
        message: `Slack requests must carry ${SLACK_TEAM_HEADER} and ${SLACK_USER_HEADER}.`,
      },
      401
    );
  }

  // Debit BEFORE the lookup, matching the `sk_` branch's reasoning: a flood
  // must not be able to tie up the backend. `linkKey` needs only the headers,
  // so an UNLINKED pair is limited too — otherwise a caller could iterate
  // header values and drive unbounded lookups, each answered with a 401 that
  // still cost a round trip.
  const linkKey = `${teamId}:${slackUserId}`;
  const waitMs = consumeSlackToken(linkKey);
  if (waitMs !== null) {
    return c.json(
      {
        code: ErrorCode.RATE_LIMITED,
        message: "Too many requests from this Slack account. Slow down.",
      },
      429,
      { "Retry-After": String(Math.ceil(waitMs / 1000)) }
    );
  }

  let link;
  try {
    link = await resolveSlackActingUser(teamId, slackUserId);
  } catch (error) {
    // 503, NEVER 401. A backend blip must not tell a linked user to reconnect
    // their account — they would follow the instruction, re-link, and still
    // fail. This distinction is the whole reason the resolver throws instead
    // of returning null.
    logger.error("Slack account-link lookup failed", {
      error: error instanceof Error ? error.message : String(error),
      is_backend_unavailable: error instanceof SlackBackendUnavailable,
    });
    return c.json(
      {
        code: ErrorCode.SERVER_UNREACHABLE,
        message:
          "Could not verify your MCPJam account right now. Try again in a moment.",
      },
      503
    );
  }

  if (!link) {
    return c.json(
      {
        code: ErrorCode.UNAUTHORIZED,
        message: "This Slack account is not linked to MCPJam.",
        details: { reason: "SLACK_ACCOUNT_NOT_LINKED" },
      },
      401
    );
  }

  // `authMethod` is what `getConvexBearerForRequest` dispatches on — presence
  // of the org/user vars is NOT sufficient, since JWT callers can carry them
  // too. A distinct value keeps the two delegation paths separable.
  c.set("authMethod", "slack_service");
  c.set("workosUserId", link.workosUserId);
  c.set("mcpjamUserId", link.userId);
  c.set("mcpjamOrganizationId", link.organizationId);
  // The CANONICAL surface trio, and nothing Slack-named beside it. Routes
  // read only these three, so a second wrapper (Discord) is a new auth branch
  // that sets the same three names and nothing downstream changes. Context
  // vars are per-process, per-request — there is no mid-deploy reader to keep
  // an alias alive for, and an alias that nothing reads is one a new route
  // could start reading by mistake.
  c.set("surfaceKind", "slack");
  c.set("surfaceTenantId", teamId);
  c.set("surfaceActorId", slackUserId);
  c.set("slackDefaultProjectId", link.defaultProjectId ?? undefined);

  logger.info("Slack service request", {
    event: "auth.slack_service",
    auth_method: "slack_service",
    slack_team_id: teamId,
    mcpjam_user_id: link.userId,
    mcpjam_organization_id: link.organizationId,
  });

  return null;
}

/** True when the bearer is an `slk_` token. */
export function isSlackServiceToken(token: string): boolean {
  return token.startsWith(SLACK_TOKEN_PREFIX);
}
