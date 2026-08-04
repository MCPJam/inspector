/**
 * Per-request capture for SEP-2549 cache-serve provenance (§11.2).
 *
 * The SDK's `cacheEventLogger` is a single manager-level callback — it has no
 * notion of "the current HTTP request." To surface `servedFromCache` on the
 * response of the request that actually triggered the hit (and only that
 * request, even under concurrent requests against the same long-lived
 * manager), we scope capture with `AsyncLocalStorage`: each route wraps its
 * manager call in `withCacheEventCapture`, and the shared `cacheEventLogger`
 * pushes into whichever store is active on the current async context.
 *
 * This is a LOCAL, request-scoped signal only — it must never be written to
 * the rpc/wire log (`rpc-log-bus.ts` / `hosted-rpc-logs.ts`). A cache hit is
 * precisely the case where no JSON-RPC request left the process.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import type { CacheHitEvent } from "@mcpjam/sdk";

const cacheEventStorage = new AsyncLocalStorage<CacheHitEvent[]>();

/**
 * The single `cacheEventLogger` instance to wire into every long-lived
 * `MCPClientManager` the inspector constructs (server/index.ts, server/app.ts).
 * Fires on every fresh cache serve; a no-op outside of
 * `withCacheEventCapture` (e.g. background reconnects) so it's always safe to
 * wire unconditionally.
 */
export function cacheEventLogger(event: CacheHitEvent): void {
  const bucket = cacheEventStorage.getStore();
  if (bucket) bucket.push(event);
}

/**
 * Run `fn`, capturing any cache-serve events it (transitively) triggers via
 * `cacheEventLogger`. Returns both the result and the captured events so the
 * caller can decide what — if anything — to surface as `servedFromCache`.
 */
export async function withCacheEventCapture<T>(
  fn: () => Promise<T>,
): Promise<{ result: T; events: CacheHitEvent[] }> {
  const events: CacheHitEvent[] = [];
  const result = await cacheEventStorage.run(events, fn);
  return { result, events };
}

/** Provenance annotation shape surfaced on route responses. */
export type ServedFromCacheAnnotation = { ageMs: number };

/**
 * Reduce captured events to the response annotation. Absence is semantic —
 * callers must OMIT `servedFromCache` entirely when this returns `undefined`,
 * never send a falsy/empty placeholder (a serve the operator can't see is
 * indistinguishable from a fabricated response, and the inverse — a
 * fabricated "cache" badge with no real hit — is just as misleading).
 */
export function toServedFromCache(
  events: CacheHitEvent[],
): ServedFromCacheAnnotation | undefined {
  if (events.length === 0) return undefined;
  // Most recent hit — routes here issue at most one cacheable call, but a
  // paginated caller (listAll*) may loop; the last page's age is the
  // freshest signal.
  const last = events[events.length - 1];
  return { ageMs: last.ageMs };
}
