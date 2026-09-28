import { describe, expect, it } from "vitest";
import { anthropicAdapter } from "../providers/anthropic.js";
import { openaiAdapter } from "../providers/openai.js";
import {
  DEFAULT_MIN_MISS_INTERVAL_MS,
  StaticModelObservationStore,
  isStaticIdServed,
} from "../static-model-observations.js";
import type { ByokListResult } from "../types.js";

const HOUR = 60 * 60 * 1000;
const T0 = 1_790_000_000_000;

function live(ids: string[], at: number, extra: Partial<ByokListResult> = {}) {
  return {
    ok: true,
    source: "provider-list",
    complete: true,
    observedAt: at,
    models: ids.map((nativeId) => ({
      nativeId,
      ...(openaiAdapter.toCanonicalId(nativeId)
        ? { canonicalId: openaiAdapter.toCanonicalId(nativeId) }
        : {}),
    })),
    ...extra,
  } as ByokListResult;
}

const STATIC = ["gpt-4o", "gpt-4.1", "gpt-5"];

describe("StaticModelObservationStore", () => {
  it("records a first miss without removing", () => {
    const store = new StaticModelObservationStore();
    const obs = store.observe(
      "local:openai",
      openaiAdapter,
      STATIC,
      live(["gpt-4o", "gpt-5"], T0),
    );
    expect(obs.recorded).toBe(true);
    expect(obs.missing).toEqual([
      { nativeId: "gpt-4.1", misses: 1, firstMissedAt: T0, lastMissedAt: T0 },
    ]);
    expect(obs.removed).toEqual([]);
    expect(store.removedIds("local:openai").size).toBe(0);
  });

  it("removes only on a second, separate observation", () => {
    const store = new StaticModelObservationStore();
    const scope = "local:openai";
    store.observe(scope, openaiAdapter, STATIC, live(["gpt-4o", "gpt-5"], T0));
    // The same answer seen again moments later is not a second observation.
    const soon = store.observe(
      scope,
      openaiAdapter,
      STATIC,
      live(["gpt-4o", "gpt-5"], T0 + 1000),
    );
    expect(soon.removed).toEqual([]);
    expect(soon.missing[0].misses).toBe(1);
    const later = store.observe(
      scope,
      openaiAdapter,
      STATIC,
      live(["gpt-4o", "gpt-5"], T0 + DEFAULT_MIN_MISS_INTERVAL_MS),
    );
    expect(later.removed).toEqual(["gpt-4.1"]);
    expect(later.missing[0]).toMatchObject({ misses: 2, firstMissedAt: T0 });
    expect([...store.removedIds(scope)]).toEqual(["gpt-4.1"]);
  });

  it("clears the record when the model is listed again", () => {
    const store = new StaticModelObservationStore({ minMissIntervalMs: 0 });
    const scope = "local:openai";
    store.observe(scope, openaiAdapter, STATIC, live(["gpt-4o", "gpt-5"], T0));
    const back = store.observe(
      scope,
      openaiAdapter,
      STATIC,
      live(STATIC, T0 + HOUR),
    );
    expect(back.missing).toEqual([]);
    // Missing again afterwards starts over at one.
    const again = store.observe(
      scope,
      openaiAdapter,
      STATIC,
      live(["gpt-4o", "gpt-5"], T0 + 2 * HOUR),
    );
    expect(again.missing[0].misses).toBe(1);
    expect(again.removed).toEqual([]);
  });

  it.each([
    [
      "list_failed",
      { ok: false, code: "network_error", message: "down" } as ByokListResult,
    ],
    [
      "list_incomplete",
      live(["gpt-4o"], T0 + HOUR, { complete: false } as never),
    ],
    ["list_empty", live([], T0 + HOUR)],
    [
      "configured_source",
      live(["gpt-4o"], T0 + HOUR, { source: "configured" } as never),
    ],
  ])(
    "an answer that is not evidence (%s) changes nothing",
    (reason, result) => {
      const store = new StaticModelObservationStore();
      const scope = "local:openai";
      store.observe(
        scope,
        openaiAdapter,
        STATIC,
        live(["gpt-4o", "gpt-5"], T0),
      );
      const obs = store.observe(scope, openaiAdapter, STATIC, result);
      expect(obs).toMatchObject({
        recorded: false,
        skippedReason: reason,
        removed: [],
      });
      expect(obs.missing).toEqual([
        { nativeId: "gpt-4.1", misses: 1, firstMissedAt: T0, lastMissedAt: T0 },
      ]);
    },
  );

  it("keeps scopes apart", () => {
    const store = new StaticModelObservationStore({ minMissIntervalMs: 0 });
    store.observe("org:a", openaiAdapter, STATIC, live(["gpt-4o"], T0));
    store.observe("org:a", openaiAdapter, STATIC, live(["gpt-4o"], T0 + 1));
    expect(store.removedIds("org:a").size).toBe(2);
    expect(store.removedIds("org:b").size).toBe(0);
  });
});

describe("isStaticIdServed", () => {
  it("counts an Anthropic alias as served when the list reports its snapshot", () => {
    const listed = [
      {
        nativeId: "claude-sonnet-4-5-20250929",
        canonicalId: "anthropic/claude-sonnet-4.5",
      },
      { nativeId: "claude-opus-4-8-20260301" },
    ];
    // Reviewed alias → canonical match.
    expect(
      isStaticIdServed(anthropicAdapter, "claude-sonnet-4-5", listed),
    ).toBe(true);
    // No reviewed snapshot, but the documented `<alias>-<YYYYMMDD>` shape.
    expect(isStaticIdServed(anthropicAdapter, "claude-opus-4-8", listed)).toBe(
      true,
    );
    expect(isStaticIdServed(anthropicAdapter, "claude-opus-4-7", listed)).toBe(
      false,
    );
  });
});
