import type { Context } from "hono";
import type {
  AgentRegistrationCaller,
  AgentRegistrationClaims,
} from "../services/agent-registration-caller.js";

/**
 * Typed request-local store, layered over Hono's `c.set` / `c.get`.
 *
 * Hono already gives us per-request storage via the Context's variable
 * map, but reaching for `c.set(key, value)` with an arbitrary string is
 * untyped — typos slip through and every reader has to widen `unknown`.
 *
 * The WorkOS API key validation is the motivating use case: a single
 * `/api/v1/...` request hits the bearer middleware AND `authorizeBatch`
 * — without per-request memoization we would pay two ~200ms WorkOS
 * validate round-trips for one user-visible request. The cache is
 * intentionally request-local (no cross-request LRU) so revocation
 * stays immediate.
 */
export interface RequestLocalMap {
  /** Successful project authorization, usable only with this request's bearer. */
  authorizedProject: {
    projectId: string;
    organizationId: string;
    bearer: string;
  };
  /** Server-owned same-identity resolver for an active long-running turn. */
  turnAuthorizationBearer: () => Promise<string>;
  workosApiKeyValidation: unknown;
  /**
   * Memoized result of the org-binding lookup for an `sk_…` key. Like the
   * validation cache, this keeps a single user-visible request to one backend
   * round-trip even when `bearerAuthMiddleware` runs on both a parent router
   * and a sub-router. `null` is a real cached value (the lookup ran and the
   * key is orphaned); `undefined` means "not looked up yet".
   */
  workosApiKeyBinding: {
    mcpjamOrganizationId: string;
    /** Epoch ms after which the key is refused; null/absent = no expiry. */
    expiresAt?: number | null;
  } | null;
  /**
   * Set once the per-key WorkOS rate-limit token has been debited for this
   * request. The limit is per user-visible request, not per middleware
   * invocation — this guards against double counting if `bearerAuthMiddleware`
   * ever runs on both a parent and a child router (the same scenario the
   * caches above defend against).
   */
  workosRateLimitConsumed: boolean;
  /**
   * The claims of a `workos_agent` bearer, kept so a long turn can resolve the
   * same user and org again after the 5-minute token has expired.
   */
  workosAgentClaims: AgentRegistrationClaims;
  /** Memoized agent resolution, for the same reason as the caches above. */
  workosAgentCaller: AgentRegistrationCaller;
}

export function getRequestLocal<K extends keyof RequestLocalMap>(
  c: Context,
  key: K
): RequestLocalMap[K] | undefined {
  // `c.get` is typed via Hono's ContextVariableMap; we deliberately bypass
  // it here so callers don't have to extend that global map just to cache
  // an opaque blob for one request.
  return (c.get(key as string) as RequestLocalMap[K] | undefined) ?? undefined;
}

export function setRequestLocal<K extends keyof RequestLocalMap>(
  c: Context,
  key: K,
  value: RequestLocalMap[K] | undefined
): void {
  c.set(key as string, value);
}
