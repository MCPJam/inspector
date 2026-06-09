import type { Context } from "hono";

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
  workosApiKeyValidation: unknown;
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
  value: RequestLocalMap[K]
): void {
  c.set(key as string, value);
}
