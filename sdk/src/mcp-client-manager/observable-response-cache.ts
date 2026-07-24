/**
 * `ObservableResponseCache` — a `ResponseCacheStore` decorator that surfaces
 * PROVENANCE for the SEP-2549 response cache.
 *
 * ## Why this exists
 *
 * The upstream client (`@modelcontextprotocol/client`) serves a cacheable verb
 * from cache — with ZERO wire exchange — whenever a still-fresh entry exists
 * under `cacheMode: "use"` (the default). Freshness requires the server to have
 * sent `ttlMs > 0` (`defaultCacheTtlMs` stays `0`, so a hint-less result is
 * stored but never served). A debugger MUST NOT let such an invisible serve
 * look like a real request: MCPJam surfaces the serve (and its age) so the
 * operator can tell "the server answered this" from "the cache answered this".
 *
 * This wrapper reports each fresh `get` hit to a {@link CacheEventLogger}. That
 * is a channel wholly SEPARATE from the rpc/wire logger: a cache hit is exactly
 * the case where no JSON-RPC request left the process, so it must never be
 * injected into the wire log.
 *
 * ## Known imprecision of the "fresh get ⇒ served" heuristic
 *
 * The store cannot see the caller's `cacheMode`. The upstream client only calls
 * `store.get` on the READ path, which it takes ONLY under `cacheMode: "use"`
 * (verified: `'refresh'`/`'bypass'` short-circuit before consulting the store).
 * So a fresh `get` observed here corresponds to a real serve under `"use"`.
 * The one caveat: the client also probes `tools/list` internally to back
 * `callTool` output-validation / header mirroring, so a fresh `get` for
 * `tools/list` can be an internal derived-view read rather than a user-facing
 * list serve. We report both and accept that over-count — an extra provenance
 * signal is safe; a missed one (an invisible serve shown as a wire request)
 * is not. `ageMs` is best-effort: it is `now − storeTime` for entries THIS
 * wrapper stored; a hit on an entry written by a different wrapper instance
 * (e.g. a shared store) reports `ageMs: 0`.
 */

import {
  InMemoryResponseCacheStore,
  type CacheEntry,
  type CacheKey,
  type MaybePromise,
  type ResponseCacheStore,
} from "@modelcontextprotocol/client";
import type { CacheEventLogger } from "./types.js";

export interface ObservableResponseCacheOptions {
  /** Server whose connection this store backs (stamped onto every event). */
  serverId: string;
  /** Provenance sink for fresh serves. */
  onHit: CacheEventLogger;
  /** Clock injection point (tests). Defaults to `Date.now`. */
  now?: () => number;
}

/** Stable string form of a {@link CacheKey} for the store-time side table. */
function serializeKey(key: CacheKey): string {
  return JSON.stringify([key.method, key.params ?? "", key.partition ?? ""]);
}

/**
 * Wrap a {@link ResponseCacheStore} (default: a fresh in-memory store) so fresh
 * `get` hits are reported to {@link ObservableResponseCacheOptions.onHit}. All
 * mutation/read semantics are delegated verbatim to the wrapped store — the
 * only added behavior is the out-of-band provenance emission and a store-time
 * side table used to compute `ageMs`.
 */
export class ObservableResponseCache implements ResponseCacheStore {
  private readonly inner: ResponseCacheStore;
  private readonly serverId: string;
  private readonly onHit: CacheEventLogger;
  private readonly now: () => number;
  /** key → wall-clock ms at which THIS wrapper last stored the entry. */
  private readonly storedAt = new Map<string, number>();

  constructor(
    inner: ResponseCacheStore = new InMemoryResponseCacheStore(),
    options: ObservableResponseCacheOptions
  ) {
    this.inner = inner;
    this.serverId = options.serverId;
    this.onHit = options.onHit;
    this.now = options.now ?? Date.now;
  }

  async get(key: CacheKey): Promise<CacheEntry | undefined> {
    const entry = await this.inner.get(key);
    // Report only FRESH hits: a stored-but-stale entry (no `expiresAt`, or one
    // in the past) is never served, so it is not provenance-worthy. This
    // mirrors the client's own freshness gate (`expiresAt > now`).
    if (entry?.expiresAt !== undefined && entry.expiresAt > this.now()) {
      const stored = this.storedAt.get(serializeKey(key));
      const ageMs = stored !== undefined ? Math.max(0, this.now() - stored) : 0;
      try {
        this.onHit({
          serverId: this.serverId,
          method: key.method,
          params: key.params ?? "",
          ageMs,
          scope: entry.scope,
        });
      } catch {
        // Provenance is observational — a throwing sink must never cost the
        // caller a result the cache already holds.
      }
    }
    return entry;
  }

  set(
    key: CacheKey,
    entry: { value: string; expiresAt?: number; scope?: CacheEntry["scope"] }
  ): MaybePromise<number> {
    this.storedAt.set(serializeKey(key), this.now());
    return this.inner.set(key, entry);
  }

  delete(key: CacheKey): MaybePromise<void> {
    this.storedAt.delete(serializeKey(key));
    return this.inner.delete(key);
  }

  evict(method: string): MaybePromise<void> {
    for (const k of [...this.storedAt.keys()]) {
      try {
        if ((JSON.parse(k) as [string])[0] === method) this.storedAt.delete(k);
      } catch {
        // Best-effort side-table cleanup; a stale entry only affects ageMs.
      }
    }
    return this.inner.evict(method);
  }

  clear(): MaybePromise<void> {
    this.storedAt.clear();
    return this.inner.clear();
  }
}
