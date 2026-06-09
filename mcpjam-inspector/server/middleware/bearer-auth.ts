import type { Context, Next } from "hono";
import { ErrorCode } from "../routes/web/errors.js";
import { validateGuestTokenDetailedAsync } from "../services/guest-token.js";
import { getWorkOSClient } from "../services/workos-client.js";
import { resolveUserByExternalId } from "../services/identity.js";
import { getRequestLocal, setRequestLocal } from "./request-local.js";
import { logger } from "../utils/logger.js";

/**
 * Reusable Hono middleware that:
 * 1. Requires a Bearer token in the Authorization header (401 if missing).
 * 2. If the token starts with `sk_`, validates it as a WorkOS API key
 *    (memoized per request) and resolves the owning MCPJam user.
 * 3. Otherwise attempts to validate it as a guest JWT.
 * 4. If valid guest token, sets `c.set("guestId", guestId)`.
 * 5. If not a guest token, assumes WorkOS JWT and passes through.
 *
 * Prefix discrimination is sound: real WorkOS JWTs start with `eyJ`
 * (base64 `{"`), so an `sk_` prefix is unambiguous and the branch
 * never falls through to JWT validation.
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
    existing.tokens + elapsed * WORKOS_RATE_REFILL_PER_MS,
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
  next: Next,
): Promise<Response | void> {
  const authHeader = c.req.header("authorization");
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return c.json(
      { code: ErrorCode.UNAUTHORIZED, message: "Bearer token required" },
      401,
    );
  }

  const token = authHeader.slice("Bearer ".length);

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
          401,
        );
      }
      setRequestLocal(c, "workosApiKeyValidation", validation);
    }

    if (!validation.apiKey) {
      return c.json(
        { code: ErrorCode.UNAUTHORIZED, message: "Invalid API key" },
        401,
      );
    }

    const workosKeyId = validation.apiKey.id;
    const workosUserId = validation.apiKey.owner.id;

    // Per-key rate limit. Reject BEFORE doing the Convex user lookup
    // so a flood can't tie up the database either.
    const waitMs = consumeWorkOSToken(workosKeyId);
    if (waitMs !== null) {
      return c.json(
        {
          code: ErrorCode.RATE_LIMITED,
          message: "API key rate limit exceeded. Slow down and retry.",
        },
        429,
        { "Retry-After": String(Math.ceil(waitMs / 1000)) },
      );
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
        500,
      );
    }
    if (!mcpjamUser) {
      return c.json(
        { code: ErrorCode.UNAUTHORIZED, message: "Unknown user" },
        401,
      );
    }

    c.set("authMethod", "workos_api_key");
    c.set("workosApiKeyId", workosKeyId);
    c.set("workosUserId", workosUserId);
    c.set("mcpjamUserId", mcpjamUser._id);

    logger.info("WorkOS API key request", {
      event: "auth.workos_api_key",
      auth_method: "workos_api_key",
      workos_key_id: workosKeyId,
      mcpjam_user_id: mcpjamUser._id,
    });

    return next();
  }

  // Try validating as a guest token
  try {
    const result = await validateGuestTokenDetailedAsync(token);
    if (result.valid && result.guestId) {
      if (process.env.MCPJAM_NONPROD_LOCKDOWN === "true") {
        return c.json(
          {
            code: ErrorCode.FORBIDDEN,
            message: "Guest access is disabled in this environment.",
          },
          403,
        );
      }
      c.set("guestId", result.guestId);
      return next();
    }
  } catch {
    // Guest token service not initialized — treat as non-guest token
  }

  // Not a guest token — assume WorkOS token, allow through
  return next();
}
