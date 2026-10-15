import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  loadLastOwnProviderModelId,
  loadLeadModelProviderHint,
  saveLeadModelProviderHint,
  loadSelectedModelId,
  loadSelectedModelIds,
  replaceLeadModelId,
  saveLastOwnProviderModelId,
  saveSelectedModelId,
  saveSelectedModelIds,
  subscribeSelectedModelId,
  subscribeSelectedModelIds,
  loadSelectedModelSelections,
  migrateSelectedModelsToV2,
  normalizeSelectedModelSelections,
  saveSelectedModelSelections,
  subscribeSelectedModelSelections,
  type SelectedModelsMigrationContext,
} from "../selected-model-storage";
import { comparisonKey, type ModelSelection } from "@mcpjam/sdk/browser";

const LEAD_KEY = "mcp-inspector-selected-model";
const ARRAY_KEY = "mcp-inspector-selected-models";
const OWN_PROVIDER_KEY = "mcp-inspector-last-own-provider-model";
const PROVIDER_HINT_KEY = "mcp-inspector-selected-model-provider";

describe("selected-model-storage", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    localStorage.clear();
  });

  describe("loadLastOwnProviderModelId / saveLastOwnProviderModelId", () => {
    it("round-trips an own-provider model id", () => {
      saveLastOwnProviderModelId("claude-haiku-4-5");
      expect(loadLastOwnProviderModelId()).toBe("claude-haiku-4-5");
      expect(localStorage.getItem(OWN_PROVIDER_KEY)).toBe("claude-haiku-4-5");
    });

    it("returns null when nothing is stored", () => {
      expect(loadLastOwnProviderModelId()).toBeNull();
    });

    it("treats blank ids as cleared", () => {
      saveLastOwnProviderModelId("claude-haiku-4-5");
      saveLastOwnProviderModelId("   ");
      expect(loadLastOwnProviderModelId()).toBeNull();
      expect(localStorage.getItem(OWN_PROVIDER_KEY)).toBeNull();
    });

    it("is independent of the lead selection", () => {
      saveLastOwnProviderModelId("claude-haiku-4-5");
      // The lead flips to a free-tier model — the own-provider memory is what
      // the BYOK hand-off reads back, so it must survive this (BACK2-628).
      saveSelectedModelId("anthropic/claude-haiku-4.5");
      expect(loadLastOwnProviderModelId()).toBe("claude-haiku-4-5");
    });
  });

  describe("loadSelectedModelIds / saveSelectedModelIds", () => {
    it("returns [] when nothing is stored", () => {
      expect(loadSelectedModelIds()).toEqual([]);
    });

    it("round-trips a normalized array", () => {
      saveSelectedModelIds(["a", "b", "c"]);
      expect(loadSelectedModelIds()).toEqual(["a", "b", "c"]);
      expect(localStorage.getItem(ARRAY_KEY)).toBe(JSON.stringify(["a", "b", "c"]));
    });

    it("dedupes, trims, and drops non-strings on save", () => {
      saveSelectedModelIds([
        " a ",
        "a",
        "",
        // @ts-expect-error — exercising runtime normalization
        null,
        "b",
        "b",
      ]);
      expect(loadSelectedModelIds()).toEqual(["a", "b"]);
    });

    it("removes the key when saving an empty array", () => {
      saveSelectedModelIds(["a"]);
      saveSelectedModelIds([]);
      expect(localStorage.getItem(ARRAY_KEY)).toBeNull();
    });

    it("returns [] when the stored JSON is malformed", () => {
      localStorage.setItem(ARRAY_KEY, "{not json");
      expect(loadSelectedModelIds()).toEqual([]);
    });
  });

  describe("replaceLeadModelId", () => {
    it("seeds the array with [newId] when it is currently empty", () => {
      replaceLeadModelId("openai/gpt-5");
      expect(loadSelectedModelId()).toBe("openai/gpt-5");
      expect(loadSelectedModelIds()).toEqual(["openai/gpt-5"]);
    });

    it("is a no-op on the array when newId already sits at index 0", () => {
      saveSelectedModelIds(["a", "b", "c"]);
      replaceLeadModelId("a");
      expect(loadSelectedModelId()).toBe("a");
      expect(loadSelectedModelIds()).toEqual(["a", "b", "c"]);
    });

    it("rotates an existing id at index k > 0 to the front, preserving count", () => {
      saveSelectedModelIds(["a", "b", "c"]);
      replaceLeadModelId("c");
      expect(loadSelectedModelId()).toBe("c");
      // count preserved (3), c moved to slot 0, original order otherwise intact
      expect(loadSelectedModelIds()).toEqual(["c", "a", "b"]);
    });

    it("replaces the lead slot when newId is not in the array, preserving count", () => {
      saveSelectedModelIds(["a", "b", "c"]);
      replaceLeadModelId("z");
      expect(loadSelectedModelId()).toBe("z");
      // count preserved (3); slot 0 replaced, slots 1+ untouched
      expect(loadSelectedModelIds()).toEqual(["z", "b", "c"]);
    });

    it("clears the lead but leaves the array intact when called with null", () => {
      saveSelectedModelIds(["a", "b", "c"]);
      saveSelectedModelId("a");
      replaceLeadModelId(null);
      expect(loadSelectedModelId()).toBeNull();
      expect(loadSelectedModelIds()).toEqual(["a", "b", "c"]);
    });

    it("treats whitespace-only ids like null", () => {
      saveSelectedModelIds(["a", "b"]);
      saveSelectedModelId("a");
      replaceLeadModelId("   ");
      expect(loadSelectedModelId()).toBeNull();
      expect(loadSelectedModelIds()).toEqual(["a", "b"]);
    });

    it("preserves multi-column count when switching hosts (regression for column-drift bug)", () => {
      // Two-column setup in "host A".
      saveSelectedModelIds(["host-a-lead", "extra"]);
      saveSelectedModelId("host-a-lead");

      // Host switch to "host B" with a different default lead.
      replaceLeadModelId("host-b-lead");

      // Count stays at 2; new host's lead sits at slot 0; second column
      // (the workspace preference) is preserved.
      const ids = loadSelectedModelIds();
      expect(ids.length).toBe(2);
      expect(ids[0]).toBe("host-b-lead");
      expect(ids[1]).toBe("extra");
      expect(loadSelectedModelId()).toBe("host-b-lead");
    });
  });

  describe("subscribeSelectedModelId", () => {
    it("fires the callback when the lead is saved", () => {
      const cb = vi.fn();
      const unsubscribe = subscribeSelectedModelId(cb);
      saveSelectedModelId("openai/gpt-5");
      expect(cb).toHaveBeenCalled();
      unsubscribe();
    });

    it("does NOT fire the lead callback when only the array is saved", () => {
      // Regression: `saveSelectedModelIds` is called as a mirror by the
      // in-app React setter and must not feed back into React state by
      // dispatching the lead-id channel. The host-switch primitive
      // (`replaceLeadModelId`) is the only path that updates the array
      // from outside React and uses its own channel
      // (`subscribeSelectedModelIds`).
      const cb = vi.fn();
      const unsubscribe = subscribeSelectedModelId(cb);
      saveSelectedModelIds(["a", "b"]);
      expect(cb).not.toHaveBeenCalled();
      unsubscribe();
    });

    it("fires the lead callback once per replaceLeadModelId, and the read after the event sees both keys updated", () => {
      saveSelectedModelIds(["a", "b"]);
      saveSelectedModelId("a");

      let observedLead: string | null | undefined;
      let observedArray: string[] | undefined;
      const cb = vi.fn(() => {
        observedLead = loadSelectedModelId();
        observedArray = loadSelectedModelIds();
      });
      const unsubscribe = subscribeSelectedModelId(cb);

      // "c" isn't in the array, so the lead slot is replaced; count
      // (2) is preserved — that's the column-drift fix.
      replaceLeadModelId("c");

      // Subscriber receives an event and re-reads both lead and array
      // — and sees a consistent snapshot (both updated together).
      expect(cb).toHaveBeenCalledTimes(1);
      expect(observedLead).toBe("c");
      expect(observedArray).toEqual(["c", "b"]);

      unsubscribe();
    });

    it("stops firing after unsubscribe", () => {
      const cb = vi.fn();
      const unsubscribe = subscribeSelectedModelId(cb);
      unsubscribe();
      saveSelectedModelId("anything");
      expect(cb).not.toHaveBeenCalled();
    });
  });

  describe("subscribeSelectedModelIds", () => {
    it("does NOT fire when only `saveSelectedModelIds` is called (in-app mirror path)", () => {
      const cb = vi.fn();
      const unsubscribe = subscribeSelectedModelIds(cb);
      saveSelectedModelIds(["a", "b"]);
      expect(cb).not.toHaveBeenCalled();
      unsubscribe();
    });

    it("fires when `replaceLeadModelId` mutates the array (host-switch path)", () => {
      saveSelectedModelIds(["a", "b"]);
      saveSelectedModelId("a");

      const cb = vi.fn();
      const unsubscribe = subscribeSelectedModelIds(cb);
      // Replaces slot 0 ("a") with "c" — array changes.
      replaceLeadModelId("c");
      expect(cb).toHaveBeenCalledTimes(1);
      unsubscribe();
    });

    it("does NOT fire when `replaceLeadModelId` leaves the array untouched (lead already at slot 0)", () => {
      saveSelectedModelIds(["a", "b"]);
      saveSelectedModelId("a");

      const cb = vi.fn();
      const unsubscribe = subscribeSelectedModelIds(cb);
      // "a" is already at slot 0 — no array change, no array event.
      replaceLeadModelId("a");
      expect(cb).not.toHaveBeenCalled();
      unsubscribe();
    });

    it("stops firing after unsubscribe", () => {
      saveSelectedModelIds(["a"]);
      const cb = vi.fn();
      const unsubscribe = subscribeSelectedModelIds(cb);
      unsubscribe();
      replaceLeadModelId("b");
      expect(cb).not.toHaveBeenCalled();
    });
  });
});

describe("lead model provider hint", () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => localStorage.clear());

  it("round-trips the pair it was picked as", () => {
    saveLeadModelProviderHint({
      modelId: "anthropic/claude-sonnet-5",
      provider: "openrouter",
    });
    expect(loadLeadModelProviderHint()).toEqual({
      modelId: "anthropic/claude-sonnet-5",
      provider: "openrouter",
    });
  });

  it("is empty until something is picked", () => {
    expect(loadLeadModelProviderHint()).toBeNull();
  });

  it("clears on null", () => {
    saveLeadModelProviderHint({ modelId: "a/b", provider: "openrouter" });
    saveLeadModelProviderHint(null);
    expect(localStorage.getItem(PROVIDER_HINT_KEY)).toBeNull();
    expect(loadLeadModelProviderHint()).toBeNull();
  });

  // Whatever is in storage came from a browser we do not control; a bad value
  // must read as "no hint", which means the id-only resolution of before.
  it.each([
    ["not JSON", "{oops"],
    ["a bare string", JSON.stringify("openrouter")],
    ["missing provider", JSON.stringify({ modelId: "a/b" })],
    ["blank id", JSON.stringify({ modelId: " ", provider: "openrouter" })],
    ["wrong types", JSON.stringify({ modelId: 1, provider: true })],
  ])("reads %s as no hint", (_label, raw) => {
    localStorage.setItem(PROVIDER_HINT_KEY, raw);
    expect(loadLeadModelProviderHint()).toBeNull();
  });
});

describe("compare line-up storage v2", () => {
  const V2_KEY = "mcp-inspector-selected-model-selections.v2";
  const SONNET = "anthropic/claude-sonnet-5";
  const GPT = "openai/gpt-5";
  const openRouterSonnet: ModelSelection = {
    modelId: SONNET,
    source: "local",
    connectionRef: { kind: "localProvider", providerKey: "openrouter" },
    fallback: { provider: "openrouter", model: "none" },
  };
  const context = (
    overrides: Partial<SelectedModelsMigrationContext> = {},
  ): SelectedModelsMigrationContext => ({
    catalogStatus: "live",
    hostedCatalogModelIds: new Set([SONNET, GPT]),
    ownKeySelectionsFor: () => [],
    ...overrides,
  });

  beforeEach(() => localStorage.clear());
  afterEach(() => localStorage.clear());

  it("honours a provider hint that names exactly one own-key connection", () => {
    saveSelectedModelIds([SONNET, GPT]);
    saveLeadModelProviderHint({ modelId: SONNET, provider: "openrouter" });
    const ownKeySelectionsFor = vi.fn((modelId: string, provider: string) =>
      modelId === SONNET && provider === "openrouter" ? [openRouterSonnet] : [],
    );

    const migrated = migrateSelectedModelsToV2(
      context({ ownKeySelectionsFor }),
    );

    // Both ids are hosted catalog ids, but the OpenRouter pick stays on the
    // user's key: the hint wins over catalog membership.
    expect(migrated).toEqual([
      openRouterSonnet,
      {
        modelId: GPT,
        source: "hosted",
        fallback: { provider: "none", model: "none" },
      },
    ]);
    expect(ownKeySelectionsFor).toHaveBeenCalledWith(SONNET, "openrouter");
    expect(loadSelectedModelSelections()).toEqual(migrated);
  });

  it("converts an id in the live hosted catalog to a plain hosted selection", () => {
    saveSelectedModelIds([GPT]);
    const migrated = migrateSelectedModelsToV2(context());
    expect(migrated).toEqual([
      {
        modelId: GPT,
        source: "hosted",
        fallback: { provider: "none", model: "none" },
      },
    ]);
    // Default selection: the card keys exactly as the bare id did in v1.
    expect(comparisonKey(migrated![0]!)).toBe(GPT);
  });

  it("stores an id outside the catalog as legacy (own key only), never hosted", () => {
    saveSelectedModelIds(["gpt-4o", "x-ai/grok-9"]);
    expect(migrateSelectedModelsToV2(context())).toEqual([
      { source: "legacy", modelId: "gpt-4o" },
      { source: "legacy", modelId: "x-ai/grok-9" },
    ]);
  });

  it("does not migrate until the catalog is live, keeping the v1 behaviour", () => {
    saveSelectedModelIds([SONNET, "gpt-4o"]);
    for (const catalogStatus of ["loading", "fallback"] as const) {
      // Even with the snapshot's ids at hand, nothing is decided off them.
      expect(migrateSelectedModelsToV2(context({ catalogStatus }))).toBeNull();
    }
    expect(localStorage.getItem(V2_KEY)).toBeNull();
    expect(loadSelectedModelSelections()).toBeNull();
    expect(loadSelectedModelIds()).toEqual([SONNET, "gpt-4o"]);
  });

  it("waits while the hinted row is not listed yet (org config loading)", () => {
    saveSelectedModelIds([SONNET]);
    saveLeadModelProviderHint({ modelId: SONNET, provider: "openrouter" });
    expect(
      migrateSelectedModelsToV2(context({ isProviderRowListed: () => false })),
    ).toBeNull();
    expect(localStorage.getItem(V2_KEY)).toBeNull();
  });

  it("does not honour a hint that names more than one connection", () => {
    saveSelectedModelIds(["gpt-4o"]);
    saveLeadModelProviderHint({ modelId: "gpt-4o", provider: "openai" });
    const second: ModelSelection = {
      ...openRouterSonnet,
      modelId: "openai/gpt-4o",
      source: "org",
      connectionRef: { kind: "orgProvider", id: "org-openai" },
    };
    expect(
      migrateSelectedModelsToV2(
        context({ ownKeySelectionsFor: () => [openRouterSonnet, second] }),
      ),
    ).toEqual([{ source: "legacy", modelId: "gpt-4o", provider: "openai" }]);
  });

  it("migrates once, keeps the v1 key for rollback, and notifies", () => {
    saveSelectedModelIds([GPT]);
    const callback = vi.fn();
    const unsubscribe = subscribeSelectedModelSelections(callback);
    migrateSelectedModelsToV2(context());
    expect(callback).toHaveBeenCalledTimes(1);
    expect(loadSelectedModelIds()).toEqual([GPT]);

    saveSelectedModelIds(["gpt-4o"]);
    expect(migrateSelectedModelsToV2(context())).toEqual([
      {
        modelId: GPT,
        source: "hosted",
        fallback: { provider: "none", model: "none" },
      },
    ]);
    expect(callback).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  it("prefers the caller's in-memory v1 list over the stored one", () => {
    saveSelectedModelIds(["gpt-4o"]);
    expect(migrateSelectedModelsToV2(context({ v1ModelIds: [GPT] }))).toEqual([
      {
        modelId: GPT,
        source: "hosted",
        fallback: { provider: "none", model: "none" },
      },
    ]);
  });

  it("keeps two efforts of one model as two entries, deduped and capped", () => {
    const hosted = (effort?: "low" | "high"): ModelSelection => ({
      modelId: SONNET,
      source: "hosted",
      fallback: { provider: "openrouter", model: "none" },
      ...(effort ? { settings: { reasoningEffort: effort } } : {}),
    });
    saveSelectedModelSelections([
      hosted("low"),
      hosted("high"),
      // Same comparisonKey as the first (fallback is not identity).
      { ...hosted("low"), fallback: { provider: "none", model: "none" } },
      { modelId: "not canonical", source: "hosted" } as never,
      hosted(),
      { source: "legacy", modelId: "gpt-4o" },
    ]);
    expect(loadSelectedModelSelections()).toEqual([
      hosted("low"),
      hosted("high"),
      hosted(),
    ]);
    expect(normalizeSelectedModelSelections("nope")).toEqual([]);
  });
});
