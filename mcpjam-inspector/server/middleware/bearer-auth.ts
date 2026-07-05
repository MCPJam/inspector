import type { Context, Next } from "hono";
import { ErrorCode } from "../routes/web/errors.js";
import { validateGuestTokenDetailedAsync } from "../services/guest-token.js";
import {
  hashApiKey,
  validatePlatformApiKey,
} from "../services/platform-api-key-validation.js";
import { getRequestLocal, setRequestLocal } from "./request-local.js";
import { logger } from "../utils/logger.js";

/**
 * Reusable Hono middleware that:
 * 1. Requires a Bearer token in the Authorization header (401 if missing).
 * 2. If the token is a platform API key (`sk_mcpjam_…`), validates it against
 *    the backend (memoized per request) and sets the resolved identity.
 * 3. Otherwise attempts to validate it as a guest JWT.
 * 4. If valid guest token, sets `c.set("guestId", guestId)`.
 * 5. If not a guest token, assumes WorkOS JWT and passes through.
 *
 * Prefix discrimination is sound: real WorkOS JWTs start with `eyJ`
 * (base64 `{"`), so an `sk_` prefix is unambiguous and the branch
 * never falls through to JWT validation.
 */

// Exact shape of a platform API key: `sk_mcpjam_` + 48 lowercase hex chars
// (24 random bytes). Rejecting a malformed key here — before hashing or any
// network call — is what actually stops a random-garbage flood (and cheaply
// bounces legacy WorkOS-format `sk_…` keys); the per-key bucket alone would
// grant each novel invalid key one backend round-trip.
//
// FORMAT CONTRACT: must match what the backend mints in
// `generatePlatformApiKeyParts` (mcpjam-backend repo, convex/lib/keys.ts —
// format test in convex/__tests__/platformApiKeys.test.ts). Loosening or
// tightening either side alone strands newly minted keys at this gate.
const PLATFORM_API_KEY_RE = /^sk_mcpjam_[0-9a-f]{48}$/;

/**
 * Per-key token bucket for `sk_` validations, keyed by the key's hash. A
 * misbehaving client should not be able to flood the backend validate route.
 * In-process Map — resets on deploy, which is fine for v1.
 *
 * Limits: 60 req/min sustained, burst 10. Buckets refill linearly.
 */
const API_KEY_RATE_LIMIT_PER_MIN = 60;
const API_KEY_RATE_BURST = 10;
const API_KEY_RATE_REFILL_PER_MS = API_KEY_RATE_LIMIT_PER_MIN / 60_000;

interface TokenBucket {
  /** Available tokens (fractional). */
  tokens: number;
  /** Last refill timestamp (ms). */
  lastRefill: number;
}

const apiKeyBuckets = new Map<string, TokenBucket>();

// Hard cap on tracked buckets. Distinct well-formed-but-invalid keys each get
// an entry BEFORE backend validation, so a spray of random sk_mcpjam_… strings
// would otherwise grow the Map unbounded between sweeps. At the cap, evict the
// oldest-inserted entry (Map preserves insertion order) — under a flood those
// are overwhelmingly the attacker's one-shot keys, and a legit key that gets
// evicted merely restarts with a fresh burst.
const API_KEY_BUCKETS_MAX = 50_000;

// Cleanup stale buckets every 5 minutes so revoked keys don't leak memory.
setInterval(() => {
  const now = Date.now();
  for (const [id, bucket] of apiKeyBuckets) {
    if (now - bucket.lastRefill > 5 * 60_000) {
      apiKeyBuckets.delete(id);
    }
  }
}, 5 * 60_000).unref();

/**
 * Try to consume one token from the bucket for `bucketKey` (the key's hash).
 * Returns the number of milliseconds the caller should wait before retrying,
 * or `null` if the request was admitted. Rejecting BEFORE incrementing
 * matches token-bucket semantics — a depleted bucket stays depleted until
 * time passes.
 */
function consumeApiKeyToken(bucketKey: string): number | null {
  const now = Date.now();
  const existing = apiKeyBuckets.get(bucketKey);
  if (!existing) {
    if (apiKeyBuckets.size >= API_KEY_BUCKETS_MAX) {
      const oldest = apiKeyBuckets.keys().next().value;
      if (oldest !== undefined) {
        apiKeyBuckets.delete(oldest);
      }
    }
    apiKeyBuckets.set(bucketKey, {
      tokens: API_KEY_RATE_BURST - 1,
      lastRefill: now,
    });
    return null;
  }

  const elapsed = now - existing.lastRefill;
  const refilled = Math.min(
    API_KEY_RATE_BURST,
    existing.tokens + elapsed * API_KEY_RATE_REFILL_PER_MS,
  );
  if (refilled < 1) {
    existing.tokens = refilled;
    existing.lastRefill = now;
    const deficit = 1 - refilled;
    const waitMs = Math.ceil(deficit / API_KEY_RATE_REFILL_PER_MS);
    return Math.max(waitMs, 1);
  }
  existing.tokens = refilled - 1;
  existing.lastRefill = now;
  return null;
}

/** Test-only: clear all token buckets. */
export function resetApiKeyRateLimitForTests(): void {
  apiKeyBuckets.clear();
}

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

  // Platform API key branch. Real WorkOS JWTs begin with `eyJ`, so an `sk_`
  // prefix is unambiguous; this branch never falls through.
  if (token.startsWith("sk_")) {
    // Cheap format gate first: a malformed key is rejected before hashing or
    // any backend call, so garbage floods never reach the validate route.
    if (!PLATFORM_API_KEY_RE.test(token)) {
      return c.json(
        { code: ErrorCode.UNAUTHORIZED, message: "Invalid API key" },
        401,
      );
    }

    const tokenHash = hashApiKey(token);

    // Per-key rate limit, keyed by the hash (the key's stable identity). Reject
    // BEFORE the backend call so a flood can't tie it up. Debit once per
    // request (memoized) so the limit isn't double counted if the middleware
    // runs on both a parent and a child router.
    if (!getRequestLocal(c, "apiKeyRateLimitConsumed")) {
      const waitMs = consumeApiKeyToken(tokenHash);
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
      setRequestLocal(c, "apiKeyRateLimitConsumed", true);
    }

    // Request-local memoization: a single `/api/v1/...` call hits this
    // middleware AND `authorizeBatch`, both of which would otherwise pay the
    // backend validate cost. Cached per request only — no cross-request cache,
    // so revocation stays immediate. `null` is a real cached value (looked up,
    // invalid); `undefined` means not looked up yet.
    let validation = getRequestLocal(c, "platformApiKeyValidation");
    if (validation === undefined) {
      try {
        validation = await validatePlatformApiKey(tokenHash);
      } catch (error) {
        logger.error("Platform API key validation failed", {
          error: error instanceof Error ? error.message : String(error),
        });
        return c.json(
          { code: ErrorCode.INTERNAL_ERROR, message: "Identity lookup failed" },
          500,
        );
      }
      setRequestLocal(c, "platformApiKeyValidation", validation);
    }

    if (!validation) {
      // Unknown / revoked / owner lost org membership are indistinguishable —
      // all 401 "Invalid API key" so the endpoint can't probe key state.
      return c.json(
        { code: ErrorCode.UNAUTHORIZED, message: "Invalid API key" },
        401,
      );
    }

    // Context fields kept identical to the WorkOS era so every downstream
    // consumer (buildConvexAuthHeaders, the delegated-token exchange, the
    // `/api/v1/*` routes) is untouched. `workosUserId` carries the WorkOS
    // `externalId`; `workosApiKeyId` now carries the platform key id.
    c.set("authMethod", "workos_api_key");
    c.set("workosApiKeyId", validation.keyId);
    c.set("workosUserId", validation.externalId);
    c.set("mcpjamUserId", validation.userId);
    c.set("mcpjamOrganizationId", validation.organizationId);

    // Log labels say platform_api_key even though the Hono context literal
    // stays "workos_api_key" (compat contract, see comment above) — log
    // queries should not report platform keys as WorkOS traffic.
    logger.info("Platform API key request", {
      event: "auth.platform_api_key",
      auth_method: "platform_api_key",
      key_id: validation.keyId,
      mcpjam_user_id: validation.userId,
      mcpjam_organization_id: validation.organizationId,
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
