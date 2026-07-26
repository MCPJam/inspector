import { describe, expect, it } from "vitest";
import type {
  CacheEntry,
  CacheKey,
  MaybePromise,
  ResponseCacheStore,
} from "@modelcontextprotocol/client";
import { ObservableResponseCache } from "../src/mcp-client-manager/observable-response-cache.js";
import type { CacheHitEvent } from "../src/mcp-client-manager/types.js";

/**
 * Direct unit coverage for the provenance wrapper's two false-hit / leak fixes:
 *  - a fresh entry only emits once it is a value the client would actually
 *    serve (a corrupt document is rejected+refetched, so it must not emit);
 *  - the `storedAt` side table stays bounded even though the inner store's own
 *    evictions are invisible through the `ResponseCacheStore` interface.
 */

function keyOf(key: CacheKey): string {
  return JSON.stringify([key.method, key.params ?? "", key.partition ?? ""]);
}

/** Uncapped in-memory store so the wrapper's OWN bound is what's under test. */
class FakeStore implements ResponseCacheStore {
  readonly map = new Map<string, CacheEntry>();
  private stamp = 0;
  get(key: CacheKey): MaybePromise<CacheEntry | undefined> {
    return this.map.get(keyOf(key));
  }
  set(
    key: CacheKey,
    entry: { value: string; expiresAt?: number; scope?: CacheEntry["scope"] },
  ): MaybePromise<number> {
    const stamp = ++this.stamp;
    this.map.set(keyOf(key), {
      value: entry.value,
      stamp,
      expiresAt: entry.expiresAt,
      scope: entry.scope,
    });
    return stamp;
  }
  delete(key: CacheKey): MaybePromise<void> {
    this.map.delete(keyOf(key));
  }
  evict(method: string): MaybePromise<void> {
    for (const k of [...this.map.keys()]) {
      if ((JSON.parse(k) as [string])[0] === method) this.map.delete(k);
    }
  }
  clear(): MaybePromise<void> {
    this.map.clear();
  }
}

function wrap(inner: ResponseCacheStore, now: () => number) {
  const events: CacheHitEvent[] = [];
  const cache = new ObservableResponseCache(inner, {
    serverId: "srv",
    onHit: (e) => events.push(e),
    now,
  });
  return { cache, events };
}

const FUTURE = 1_000_000;

describe("ObservableResponseCache · serve-gated provenance", () => {
  it("emits a hit for a fresh, serveable document with age + scope", async () => {
    const inner = new FakeStore();
    let clock = 100;
    const { cache, events } = wrap(inner, () => clock);

    await cache.set(
      { method: "tools/list", params: "" },
      { value: JSON.stringify({ tools: [] }), expiresAt: FUTURE, scope: "public" },
    );
    clock = 150;
    await cache.get({ method: "tools/list", params: "" });

    expect(events).toHaveLength(1);
    expect(events[0].method).toBe("tools/list");
    expect(events[0].scope).toBe("public");
    expect(events[0].ageMs).toBe(50);
  });

  it("does NOT emit for a fresh but non-object document (client rejects+refetches)", async () => {
    const inner = new FakeStore();
    const { cache, events } = wrap(inner, () => 100);

    for (const bad of ['"a bare string"', "[1,2,3]", "not-json", "null"]) {
      const key = { method: "resources/read", params: bad };
      await cache.set(key, { value: bad, expiresAt: FUTURE, scope: "private" });
      await cache.get(key);
    }
    expect(events).toHaveLength(0);
  });

  it("does NOT emit for a stale entry and prunes its side-table timestamp", async () => {
    const inner = new FakeStore();
    let clock = 100;
    const { cache, events } = wrap(inner, () => clock);
    const key = { method: "resources/read", params: "u" };

    await cache.set(key, {
      value: JSON.stringify({ ok: 1 }),
      expiresAt: 200,
      scope: "private",
    });
    clock = 500; // now past expiresAt
    await cache.get(key);
    expect(events).toHaveLength(0);

    // Re-store fresh but WITHOUT going through set()'s timestamp (simulate a
    // different writer): a subsequent fresh serve reports ageMs 0, proving the
    // stale read pruned the old timestamp rather than leaving it to skew age.
    inner.map.set(keyOf(key), {
      value: JSON.stringify({ ok: 1 }),
      stamp: 99,
      expiresAt: FUTURE,
      scope: "private",
    });
    await cache.get(key);
    expect(events).toHaveLength(1);
    expect(events[0].ageMs).toBe(0);
  });
});

describe("ObservableResponseCache · bounded side table", () => {
  it("keeps storedAt bounded past the cap; evicted timestamps degrade to ageMs 0", async () => {
    const inner = new FakeStore();
    let clock = 0;
    const { cache, events } = wrap(inner, () => clock);

    // Insert well past the 1024 cap under distinct resources/read URIs.
    for (let i = 0; i < 2000; i++) {
      clock = i + 1;
      await cache.set(
        { method: "resources/read", params: `u${i}` },
        { value: JSON.stringify({ i }), expiresAt: FUTURE, scope: "private" },
      );
    }

    // The oldest key's timestamp must have been evicted from the side table:
    // its still-fresh inner entry serves with ageMs 0 (best-effort fallback),
    // while a recent key retains a real, positive age.
    clock = 5000;
    await cache.get({ method: "resources/read", params: "u0" });
    await cache.get({ method: "resources/read", params: "u1999" });

    const oldHit = events.find((e) => e.params === "u0");
    const recentHit = events.find((e) => e.params === "u1999");
    expect(oldHit?.ageMs).toBe(0);
    expect(recentHit?.ageMs).toBeGreaterThan(0);
  });
});
