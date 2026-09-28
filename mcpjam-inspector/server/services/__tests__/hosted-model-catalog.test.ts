import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  hostedCatalogModelDefinitions,
  isHostedModelDefinition,
  __resetHostedModelCatalogForTests,
  __setHostedCatalogForTests,
  ingestHostedCatalogIds,
  isHostedCatalogModel,
  refreshHostedModelCatalog,
} from "../hosted-model-catalog.js";

// A model id that is in the static seed (MCPJAM_PROVIDED_MODEL_IDS).
const SEED_MODEL = "anthropic/claude-haiku-4.5";
// A hosted model the backend catalog knows about but the static seed does NOT
// (simulates a future backend bulk-add the inspector hasn't shipped a seed for).
const CATALOG_ONLY_MODEL = "newvendor/brand-new-model";
// A genuine BYOK/unknown model — never hosted.
const BYOK_MODEL = "someorg/private-model";

// Billing intent, expressed the way the dispatch reads it: hosted ⇒ MCPJam
// credits, not hosted ⇒ org/BYOK key derivation.
function billingSource(modelId: string, provider?: string): "mcpjam" | "byok" {
  return isHostedCatalogModel(modelId, provider) ? "mcpjam" : "byok";
}

function mockFetchOnce(body: unknown, ok = true, status = 200) {
  vi.spyOn(globalThis, "fetch").mockResolvedValue({
    ok,
    status,
    json: async () => body,
  } as unknown as Response);
}

beforeEach(() => {
  __resetHostedModelCatalogForTests();
  process.env.CONVEX_HTTP_URL = "https://backend.example";
});

afterEach(() => {
  __resetHostedModelCatalogForTests();
  vi.restoreAllMocks();
});

describe("isHostedModelDefinition — the picker's own-provider opt-out", () => {
  // `claude-fable-5` is a bare BYOK static whose provider-canonical form,
  // `anthropic/claude-fable-5`, is a seed member. `(id, provider)` alone reads
  // as hosted — deliberately, for legacy bare host pins.
  it("reads a bare id + provider as hosted when the picker said nothing", () => {
    expect(
      isHostedModelDefinition({ id: "claude-fable-5", provider: "anthropic" }),
    ).toBe(true);
    expect(
      isHostedModelDefinition({
        id: "gpt-5-nano",
        provider: "openai",
        hosted: true,
      }),
    ).toBe(true);
  });

  it("honours an explicit hosted: false — the user's own key, not MCPJam credits", () => {
    expect(
      isHostedModelDefinition({
        id: "claude-fable-5",
        provider: "anthropic",
        hosted: false,
      }),
    ).toBe(false);
    // Even a prefixed seed id: the opt-out only ever moves billing OFF MCPJam.
    expect(
      isHostedModelDefinition({
        id: SEED_MODEL,
        provider: "openai",
        hosted: false,
      }),
    ).toBe(false);
  });

  it("cannot opt INTO hosted billing: true/absent fall through to the id check", () => {
    expect(
      isHostedModelDefinition({ id: BYOK_MODEL, provider: "openai", hosted: true }),
    ).toBe(false);
    expect(isHostedModelDefinition({ id: BYOK_MODEL, provider: "openai" })).toBe(
      false,
    );
  });
});

describe("isHostedCatalogModel — billing classification", () => {
  it("cold start (no catalog fetched): seed model bills to mcpjam, others to BYOK", () => {
    // Byte-identical to the legacy isMCPJamProvidedModel behavior.
    expect(billingSource(SEED_MODEL)).toBe("mcpjam");
    expect(billingSource(CATALOG_ONLY_MODEL)).toBe("byok");
    expect(billingSource(BYOK_MODEL)).toBe("byok");
  });

  it("canonicalizes a bare id with provider the same way the legacy check did", () => {
    // `gpt-5-nano` is only a seed member in its prefixed form `openai/gpt-5-nano`.
    expect(billingSource("gpt-5-nano", "openai")).toBe("mcpjam");
    // Without the provider a bare id can't canonicalize → not hosted.
    expect(billingSource("brand-new-model")).toBe("byok");
  });

  it("a catalog-only model bills to mcpjam once the catalog is warm", () => {
    expect(billingSource(CATALOG_ONLY_MODEL)).toBe("byok"); // cold
    __setHostedCatalogForTests([CATALOG_ONLY_MODEL]);
    expect(billingSource(CATALOG_ONLY_MODEL)).toBe("mcpjam"); // warm
  });

  it("the catalog only ADDS: a warm catalog never demotes a seed model", () => {
    // Catalog that omits the seed model entirely.
    __setHostedCatalogForTests([CATALOG_ONLY_MODEL]);
    expect(billingSource(SEED_MODEL)).toBe("mcpjam");
    expect(billingSource(CATALOG_ONLY_MODEL)).toBe("mcpjam");
    expect(billingSource(BYOK_MODEL)).toBe("byok");
  });
});

describe("ingestHostedCatalogIds — picker-proxy warms the classifier", () => {
  it("a model fed from the picker proxy classifies as mcpjam immediately (no cron wait)", () => {
    // Cold: a brand-new model the hourly cron hasn't picked up misroutes to BYOK.
    expect(billingSource(CATALOG_ONLY_MODEL)).toBe("byok");
    // The /api/mcp/models proxy hands its fresh catalog ids here…
    ingestHostedCatalogIds([SEED_MODEL, CATALOG_ONLY_MODEL]);
    // …and the classifier is current without waiting for the cron refresh.
    expect(billingSource(CATALOG_ONLY_MODEL)).toBe("mcpjam");
  });

  it("an empty/failed proxy fetch never clobbers a warm cache", () => {
    ingestHostedCatalogIds([CATALOG_ONLY_MODEL]);
    expect(billingSource(CATALOG_ONLY_MODEL)).toBe("mcpjam");
    // A subsequent empty ingest (failed/partial fetch) must be a no-op.
    ingestHostedCatalogIds([]);
    expect(billingSource(CATALOG_ONLY_MODEL)).toBe("mcpjam");
  });

  it("a truncated/partial proxy fetch never drops previously-warmed ids", () => {
    // Two models warmed from a full picker fetch…
    ingestHostedCatalogIds([CATALOG_ONLY_MODEL, "openai/some-new-model"]);
    expect(billingSource(CATALOG_ONLY_MODEL)).toBe("mcpjam");
    expect(billingSource("openai/some-new-model")).toBe("mcpjam");
    // …then a NON-EMPTY but truncated fetch that omits one of them. Additive
    // ingest must keep the omitted model classified as hosted (no BYOK
    // mis-dispatch); only the authoritative hourly refresh prunes.
    ingestHostedCatalogIds([CATALOG_ONLY_MODEL]);
    expect(billingSource(CATALOG_ONLY_MODEL)).toBe("mcpjam");
    expect(billingSource("openai/some-new-model")).toBe("mcpjam");
  });
});

describe("refreshHostedModelCatalog — fetch + fail-soft", () => {
  it("parses the { items: [...] } envelope and unions catalog ids over the seed", async () => {
    mockFetchOnce({
      items: [{ id: SEED_MODEL }, { id: CATALOG_ONLY_MODEL }, { id: 123 }],
    });
    await refreshHostedModelCatalog();

    expect(billingSource(CATALOG_ONLY_MODEL)).toBe("mcpjam");
    expect(billingSource(SEED_MODEL)).toBe("mcpjam");
    expect(billingSource(BYOK_MODEL)).toBe("byok");
  });

  it("a non-2xx fetch leaves classification on the seed (catalog-only ⇒ BYOK)", async () => {
    mockFetchOnce({}, false, 503);
    await refreshHostedModelCatalog();

    expect(billingSource(SEED_MODEL)).toBe("mcpjam"); // seed unaffected
    expect(billingSource(CATALOG_ONLY_MODEL)).toBe("byok"); // no catalog
  });

  it("an empty items array is treated as a failed fetch, not an authoritative empty catalog", async () => {
    // Seed a good catalog first…
    __setHostedCatalogForTests([CATALOG_ONLY_MODEL]);
    // …then a 2xx-but-empty refresh must NOT wipe it.
    mockFetchOnce({ items: [] });
    await refreshHostedModelCatalog();

    expect(billingSource(CATALOG_ONLY_MODEL)).toBe("mcpjam"); // preserved
  });

  it("a thrown fetch is swallowed and preserves prior state", async () => {
    __setHostedCatalogForTests([CATALOG_ONLY_MODEL]);
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("ECONNREFUSED"));
    await refreshHostedModelCatalog();

    expect(billingSource(CATALOG_ONLY_MODEL)).toBe("mcpjam"); // preserved
    expect(billingSource(SEED_MODEL)).toBe("mcpjam");
  });

  it("missing CONVEX_HTTP_URL degrades to seed-only without throwing", async () => {
    delete process.env.CONVEX_HTTP_URL;
    await expect(refreshHostedModelCatalog()).resolves.toBeUndefined();
    expect(billingSource(SEED_MODEL)).toBe("mcpjam");
    expect(billingSource(CATALOG_ONLY_MODEL)).toBe("byok");
  });
});

describe("hostedCatalogModelDefinitions", () => {
  it("is the snapshot alone before any live catalog arrives", () => {
    const rows = hostedCatalogModelDefinitions();
    expect(rows.some((row) => row.id === SEED_MODEL)).toBe(true);
    expect(rows.some((row) => row.id === CATALOG_ONLY_MODEL)).toBe(false);
  });

  it("appends live catalog ids beyond the snapshot, once each", () => {
    __setHostedCatalogForTests([SEED_MODEL, CATALOG_ONLY_MODEL, "x-ai/grok-9"]);
    const rows = hostedCatalogModelDefinitions();
    expect(rows.filter((row) => row.id === SEED_MODEL)).toHaveLength(1);
    expect(rows.find((row) => row.id === CATALOG_ONLY_MODEL)).toEqual({
      id: CATALOG_ONLY_MODEL,
      name: expect.any(String),
      provider: "newvendor",
      hosted: true,
    });
    // Live-only ids take their provider through the shared alias table.
    expect(rows.find((row) => row.id === "x-ai/grok-9")?.provider).toBe("xai");
    // Snapshot rows come first, so a `find` still prefers them.
    expect(rows.at(-1)?.id).toBe("x-ai/grok-9");
  });

  it("rebuilds when the live catalog changes", () => {
    const before = hostedCatalogModelDefinitions();
    expect(hostedCatalogModelDefinitions()).toBe(before);
    ingestHostedCatalogIds([CATALOG_ONLY_MODEL]);
    const after = hostedCatalogModelDefinitions();
    expect(after).not.toBe(before);
    expect(after.some((row) => row.id === CATALOG_ONLY_MODEL)).toBe(true);
  });
});
