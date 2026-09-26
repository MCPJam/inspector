import type { Context, Next } from "hono";
import { ErrorCode } from "../routes/web/errors.js";
import { validateGuestTokenDetailedAsync } from "../services/guest-token.js";
import { getWorkOSClient } from "../services/workos-client.js";
import { resolveUserByExternalId } from "../services/identity.js";
import { lookupWorkosKeyBinding } from "../services/workos-key-bindings.js";
import {
  classifyAuthKitBearer,
  type AuthKitBearerVerdict,
} from "../services/authkit-jwt.js";
import { getRequestLocal, setRequestLocal } from "./request-local.js";
import {
  handleSlackServiceAuth,
  isSlackServiceToken,
} from "./slack-service-auth.js";
import { logger } from "../utils/logger.js";
import { setRequestLogContext } from "../utils/request-logger.js";
import {
  handleSurfaceServiceAuth,
  isDiscordServiceToken,
} from "./surface-service-auth.js";
import { refuseUnservableSession } from "./session-revocation.js";

/**
 * The sign-out route (`routes/web/auth-session.ts`). It records the revocation
 * of the caller's own session and must answer for a session this process has
 * already marked — a second tab, or a retried sign-out — rather than refuse it.
 */
export const SESSION_REVOKE_PATH = "/api/web/auth-session/revoke";

/**
 * Reusable Hono middleware that:
 * 1. Requires a Bearer token in the Authorization header (401 if missing).
 * 2. If the token starts with `slk_`, handles it as the Slack bot's service
 *    credential (see slack-service-auth.ts) — allowlisted paths only.
 * 3. If the token starts with `sk_`, validates it as a WorkOS API key
 *    (memoized per request) and resolves the owning MCPJam user.
 * 4. Otherwise attempts to validate it as a guest JWT.
 * 5. If valid guest token, sets `c.set("guestId", guestId)`.
 * 6. If not a guest token and it claims a WorkOS AuthKit issuer, VERIFIES it
 *    (signature, issuer, audience, expiry) — `authkit_jwt` on success, 401 on
 *    a token that fails, and 401 `SESSION_REVOKED` for a session known to be
 *    revoked. Anything else passes through for Convex to judge.
 *
 * Prefix discrimination is sound: real WorkOS JWTs start with `eyJ`
 * (base64 `{"`), so `sk_`/`slk_` prefixes are unambiguous and those
 * branches never fall through to JWT validation. `slk_` is checked FIRST
 * because `startsWith("sk_")` would not match it, but the ordering is made
 * explicit so a future prefix change cannot silently route a Slack token
 * into the WorkOS-key branch — which mints delegated tokens.
 */

/**
 * Per-key token bucket for `sk_` validations. WorkOS validate is ~200ms
 * and counts against our org-wide WorkOS rate budget; a misbehaving
 * client should not be able to drain it. In-process Map — resets on
 * deploy, which is fine for v1.
 *
 * Limits: 60 req/min sustained, burst 10. Buckets refill linearly.
 */
const WORKOS_RATE_LIMIT_PER_MIN = 60;
const WORKOS_RATE_BURST = 10;
const WORKOS_RATE_REFILL_PER_MS = WORKOS_RATE_LIMIT_PER_MIN / 60_000;

interface TokenBucket {
  /** Available tokens (fractional). */
  tokens: number;
  /** Last refill timestamp (ms). */
  lastRefill: number;
}

const workosKeyBuckets = new Map<string, TokenBucket>();

// Cleanup stale buckets every 5 minutes so revoked keys don't leak memory.
setInterval(() => {
  const now = Date.now();
  for (const [id, bucket] of workosKeyBuckets) {
    if (now - bucket.lastRefill > 5 * 60_000) {
      workosKeyBuckets.delete(id);
    }
  }
}, 5 * 60_000).unref();

/**
 * Try to consume one token from the bucket for `keyId`. Returns the
 * number of milliseconds the caller should wait before retrying, or
 * `null` if the request was admitted. Rejecting BEFORE incrementing
 * matches token-bucket semantics — a depleted bucket stays depleted
 * until time passes.
 */
function consumeWorkOSToken(keyId: string): number | null {
  const now = Date.now();
  const existing = workosKeyBuckets.get(keyId);
  if (!existing) {
    workosKeyBuckets.set(keyId, {
      tokens: WORKOS_RATE_BURST - 1,
      lastRefill: now,
    });
    return null;
  }

  const elapsed = now - existing.lastRefill;
  const refilled = Math.min(
    WORKOS_RATE_BURST,
    existing.tokens + elapsed * WORKOS_RATE_REFILL_PER_MS
  );
  if (refilled < 1) {
    existing.tokens = refilled;
    existing.lastRefill = now;
    const deficit = 1 - refilled;
    const waitMs = Math.ceil(deficit / WORKOS_RATE_REFILL_PER_MS);
    return Math.max(waitMs, 1);
  }
  existing.tokens = refilled - 1;
  existing.lastRefill = now;
  return null;
}

/** Test-only: clear all token buckets. */
export function resetWorkOSRateLimitForTests(): void {
  workosKeyBuckets.clear();
}

type ValidateApiKeyResult = {
  apiKey: {
    id: string;
    owner: { id: string };
  } | null;
};

export async function bearerAuthMiddleware(
  c: Context,
  next: Next
): Promise<Response | void> {
  const authHeader = c.req.header("authorization");
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    // Label the 401 before returning it. Every branch below rejects a caller
    // who at least presented something; this one rejects a caller who
    // presented nothing, and that is the only 4xx class that carries no
    // signal about our own health. Scanners and crawlers generate it in
    // bulk against the public API, so the storm monitor has to be able to
    // exclude it — see `credentialPresented` in `log-events.ts`.
    setRequestLogContext(c, { credentialPresented: false });
    return c.json(
      { code: ErrorCode.UNAUTHORIZED, message: "Bearer token required" },
      401
    );
  }

  // Set once, here, rather than per-branch: everything past this point had a
  // bearer, so every 401 it produces is somebody's credential failing —
  // invalid key, unknown user, orphaned key alike.
  setRequestLogContext(c, { credentialPresented: true });

  const token = authHeader.slice("Bearer ".length);

  // Slack bot service credential. Terminal either way: it authorizes the
  // request (returns null) or answers it (401/429/503). It must never fall
  // through to the WorkOS-key or JWT branches.
  if (isSlackServiceToken(token)) {
    const denied = await handleSlackServiceAuth(c, token);
    if (denied) return denied;
    return next();
  }

  if (isDiscordServiceToken(token)) {
    // Account-link minting is intentionally usable before an account link
    // exists. The route authenticates the bot credential itself and creates a
    // short-lived pending session; the normal agent paths still require the
    // linked surface identity below.
    if (c.req.path === "/api/surface-link/session") return next();
    const denied = await handleSurfaceServiceAuth(c, token, "discord");
    if (denied) return denied;
    return next();
  }

  // WorkOS API key branch. Real WorkOS JWTs begin with `eyJ`, so an
  // `sk_` prefix is unambiguous; this branch never falls through.
  if (token.startsWith("sk_")) {
    // Request-local memoization: a single `/api/v1/...` call hits this
    // middleware AND `authorizeBatch`, both of which would otherwise
    // pay the ~200ms WorkOS validate cost. Cached per request only —
    // no cross-request cache, so revocation stays immediate.
    let validation = getRequestLocal(c, "workosApiKeyValidation") as
      | ValidateApiKeyResult
      | undefined;
    if (!validation) {
      try {
        // ~200ms validate latency (single global WorkOS endpoint, no
        // local JWKS path). Counts against our WorkOS rate budget.
        validation = (await getWorkOSClient().apiKeys.createValidation({
          value: token,
        })) as unknown as ValidateApiKeyResult;
      } catch (error) {
        logger.warn("WorkOS API key validation threw", {
          error: error instanceof Error ? error.message : String(error),
        });
        return c.json(
          { code: ErrorCode.UNAUTHORIZED, message: "Invalid API key" },
          401
        );
      }
      setRequestLocal(c, "workosApiKeyValidation", validation);
    }

    if (!validation.apiKey) {
      return c.json(
        { code: ErrorCode.UNAUTHORIZED, message: "Invalid API key" },
        401
      );
    }

    const workosKeyId = validation.apiKey.id;
    const workosUserId = validation.apiKey.owner.id;

    // Per-key rate limit. Reject BEFORE doing the Convex user lookup so a
    // flood can't tie up the database either. Debit once per request (memoized
    // like the validation/binding lookups above) so the limit isn't double
    // counted if the middleware ever runs on both a parent and child router.
    if (!getRequestLocal(c, "workosRateLimitConsumed")) {
      const waitMs = consumeWorkOSToken(workosKeyId);
      if (waitMs !== null) {
        return c.json(
          {
            code: ErrorCode.RATE_LIMITED,
            message: "API key rate limit exceeded. Slow down and retry.",
          },
          429,
          { "Retry-After": String(Math.ceil(waitMs / 1000)) }
        );
      }
      setRequestLocal(c, "workosRateLimitConsumed", true);
    }

    let mcpjamUser;
    try {
      mcpjamUser = await resolveUserByExternalId(workosUserId);
    } catch (error) {
      logger.error("Failed to resolve MCPJam user from WorkOS externalId", {
        workosUserId,
        error: error instanceof Error ? error.message : String(error),
      });
      return c.json(
        { code: ErrorCode.INTERNAL_ERROR, message: "Identity lookup failed" },
        500
      );
    }
    if (!mcpjamUser) {
      return c.json(
        { code: ErrorCode.UNAUTHORIZED, message: "Unknown user" },
        401
      );
    }

    // Resolve which MCPJam org this key acts inside. WorkOS keys are not
    // org-scoped natively, so the backend persists the binding at mint time
    // and we look it up here (memoized per request, like the validation
    // above). A missing binding means the key predates binding support or
    // its scope was removed — it cannot be safely delegated, so reject it as
    // orphaned rather than guessing an org.
    let binding = getRequestLocal(c, "workosApiKeyBinding");
    if (binding === undefined) {
      try {
        binding = await lookupWorkosKeyBinding(workosKeyId);
      } catch (error) {
        logger.error("Failed to look up WorkOS API key org binding", {
          workos_key_id: workosKeyId,
          error: error instanceof Error ? error.message : String(error),
        });
        return c.json(
          {
            code: ErrorCode.INTERNAL_ERROR,
            message: "Org binding lookup failed",
          },
          500
        );
      }
      setRequestLocal(c, "workosApiKeyBinding", binding);
    }
    if (!binding) {
      logger.warn("Orphaned WorkOS API key (no org binding)", {
        workos_key_id: workosKeyId,
      });
      // Stay within the v1 public error-code contract: the wire `code` is the
      // canonical UNAUTHORIZED, with the specific reason carried in the opaque
      // `details` bag (see routes/v1/contract.ts — `ORPHANED_KEY` is NOT a
      // first-class v1 code). Clients that care can branch on
      // `details.reason === "ORPHANED_KEY"`; everyone else sees a 401.
      return c.json(
        {
          code: ErrorCode.UNAUTHORIZED,
          message:
            "This API key is not bound to an organization. Re-create it from Settings → API keys.",
          details: { reason: "ORPHANED_KEY" },
        },
        401
      );
    }

    // Expiry, from MCPJam's own record. WorkOS is given the same `expires_at`
    // at mint and normally refuses the key itself before we get here; this
    // makes the guarantee hold even if it did not. A key minted before expiry
    // existed carries none and is not expired retroactively.
    if (
      typeof binding.expiresAt === "number" &&
      binding.expiresAt <= Date.now()
    ) {
      logger.info("Expired WorkOS API key rejected", {
        workos_key_id: workosKeyId,
        mcpjam_organization_id: binding.mcpjamOrganizationId,
      });
      // Same v1 contract as ORPHANED_KEY above: canonical 401, specific
      // reason in `details`.
      return c.json(
        {
          code: ErrorCode.UNAUTHORIZED,
          message:
            "This API key has expired. Create a new one from Settings → API keys.",
          details: { reason: "EXPIRED_KEY" },
        },
        401
      );
    }

    c.set("authMethod", "workos_api_key");
    c.set("workosApiKeyId", workosKeyId);
    c.set("workosUserId", workosUserId);
    c.set("mcpjamUserId", mcpjamUser._id);
    c.set("mcpjamOrganizationId", binding.mcpjamOrganizationId);
    // Onto the LOG context as well, not just the request vars. `/api/v1/*`
    // rows reached Axiom with no `orgId` at all, which structurally disabled
    // the error-class-spike monitor's "affects >= 3 organizations" rule for
    // the entire public API — the rule cannot fire on a field that is never
    // populated, so a v1 error class spiking across every customer counted as
    // one org forever. This is the only place the API-key path knows the org.
    setRequestLogContext(c, { orgId: binding.mcpjamOrganizationId });

    logger.info("WorkOS API key request", {
      event: "auth.workos_api_key",
      auth_method: "workos_api_key",
      workos_key_id: workosKeyId,
      mcpjam_user_id: mcpjamUser._id,
      mcpjam_organization_id: binding.mcpjamOrganizationId,
    });

    return next();
  }

  // Try validating as a guest token
  try {
    const result = await validateGuestTokenDetailedAsync(token);
    if (result.valid && result.guestId) {
      c.set("guestId", result.guestId);
      c.set("authMethod", "guest");
      return next();
    }
  } catch {
    // Guest token service not initialized — treat as non-guest token
  }

  // Not a guest token. A bearer that claims a WorkOS AuthKit issuer is
  // verified HERE — signature against the issuer's JWKS, issuer, audience,
  // expiry — and one that fails is refused before any handler runs. Convex
  // still verifies whatever is forwarded to it; this makes the gateway stop
  // being the one hop that took an AuthKit token at its word. The keys are
  // cached by jose, so on the hot path this is a local signature check.
  const verdict = await classifyAuthKitBearer(token);
  if (verdict.kind === "verified") {
    // A session this process knows to be revoked is refused here, on every
    // route (MJ-011). Only KNOWN revocations: most routes behind this
    // middleware forward the bearer to Convex, which checks the durable record
    // itself, so they need not wait for the list to be current. The routes
    // that decide on their own add that requirement (`requireVerifiedAuth`,
    // API-key management). Sign-out is exempt so it stays idempotent.
    if (c.req.path !== SESSION_REVOKE_PATH) {
      const refusal = refuseUnservableSession(c, verdict.sid, {
        requireFresh: false,
      });
      if (refusal) return refusal;
    }
    c.set("authMethod", "authkit_jwt");
    c.set("workosUserId", verdict.sub);
    if (verdict.sid) c.set("workosSessionId", verdict.sid);
    return next();
  }
  if (verdict.kind === "invalid") {
    // `info`, not `warn`: the volume is attacker-controlled (see the same note
    // in require-verified-auth.ts), and Axiom is where a spike is queried.
    logger.info("Rejected an AuthKit bearer that failed verification", {
      event: "auth.authkit_jwt_rejected",
      reason: verdict.reason,
      path: c.req.path,
    });
    return c.json(
      {
        code: ErrorCode.UNAUTHORIZED,
        message: "Invalid or expired session token",
      },
      401
    );
  }
  if (verdict.kind === "keys_unavailable") {
    warnAuthKitKeysUnavailable(verdict);
  }

  // Everything else passes through UNVERIFIED, exactly as every JWT used to:
  //
  //   - `keys_unavailable`: the issuer is ours but its signing keys could not
  //     be fetched. Failing closed would turn a WorkOS JWKS blip into an
  //     outage for every signed-in user, while the routes behind this
  //     middleware forward the bearer to Convex, which verifies it anyway.
  //   - `foreign_audience`: a valid AuthKit token minted for another audience
  //     (the MCP worker, the CLI's Connect app). The backend decides which
  //     audiences it honours on which path; refusing here would break them.
  //   - `not_authkit`: MCPJam-minted guest/delegated JWTs (verified by Convex
  //     against the guest JWKS), non-JWT strings, or a deployment with no
  //     AuthKit configured at all (the OSS install).
  //
  // It is NOT legitimate for a route that does not forward the bearer to
  // trust this label. Such a route treats "reached the handler" as
  // "authenticated", and nothing downstream ever contradicts it. THE RULE:
  //
  //   A route that does not forward the bearer to Convex MUST mount
  //   `middleware/require-verified-auth.ts`.
  //
  // The label below is what lets that middleware tell the two apart: a
  // request that got here carries an ASSERTED identity, not a verified one.
  c.set("authMethod", "unverified_passthrough");
  return next();
}

/**
 * Throttled: during a JWKS outage every AuthKit request lands here, and the
 * verifier already backs off per issuer (`AUTHKIT_KEYS_UNAVAILABLE_BACKOFF_MS`),
 * so one line per minute is the signal and the rest is noise.
 */
const KEYS_UNAVAILABLE_WARN_INTERVAL_MS = 60_000;
let lastKeysUnavailableWarnAt = 0;

function warnAuthKitKeysUnavailable(
  verdict: Extract<AuthKitBearerVerdict, { kind: "keys_unavailable" }>
): void {
  const now = Date.now();
  if (now - lastKeysUnavailableWarnAt < KEYS_UNAVAILABLE_WARN_INTERVAL_MS) {
    return;
  }
  lastKeysUnavailableWarnAt = now;
  logger.warn(
    "AuthKit signing keys unavailable; deferring bearer verification to Convex",
    {
      event: "auth.authkit_jwks_unavailable",
      issuer: verdict.issuer,
      reason: verdict.reason,
    }
  );
}

/** Test-only: re-arm the throttled JWKS-outage warning. */
export function resetAuthKitKeysWarningForTests(): void {
  lastKeysUnavailableWarnAt = 0;
}
