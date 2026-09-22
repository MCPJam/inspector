import { describe, expect, it } from "vitest";
import {
  cacheEventLogger,
  toServedFromCache,
  withCacheEventCapture,
} from "../cache-events.js";
import type { CacheHitEvent } from "@mcpjam/sdk";

function hit(overrides: Partial<CacheHitEvent> = {}): CacheHitEvent {
  return {
    serverId: "test-server",
    method: "tools/list",
    params: "",
    ageMs: 42,
    ...overrides,
  };
}

describe("cache-events", () => {
  it("captures events fired inside withCacheEventCapture", async () => {
    const { result, events } = await withCacheEventCapture(async () => {
      cacheEventLogger(hit({ ageMs: 7 }));
      return "done";
    });

    expect(result).toBe("done");
    expect(events).toHaveLength(1);
    expect(events[0].ageMs).toBe(7);
  });

  it("is a no-op outside any capture scope", () => {
    // Must not throw when no AsyncLocalStorage context is active — e.g. a
    // background reconnect that never went through a captured route.
    expect(() => cacheEventLogger(hit())).not.toThrow();
  });

  it("does not leak events across concurrent captures", async () => {
    const [a, b] = await Promise.all([
      withCacheEventCapture(async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        cacheEventLogger(hit({ serverId: "a", ageMs: 1 }));
        return "a";
      }),
      withCacheEventCapture(async () => {
        cacheEventLogger(hit({ serverId: "b", ageMs: 2 }));
        return "b";
      }),
    ]);

    expect(a.events).toEqual([expect.objectContaining({ serverId: "a" })]);
    expect(b.events).toEqual([expect.objectContaining({ serverId: "b" })]);
  });

  it("toServedFromCache omits the annotation when there was no hit", () => {
    expect(toServedFromCache([])).toBeUndefined();
  });

  it("toServedFromCache surfaces the most recent hit's age", () => {
    expect(
      toServedFromCache([hit({ ageMs: 10 }), hit({ ageMs: 99 })]),
    ).toEqual({ ageMs: 99 });
  });
});
