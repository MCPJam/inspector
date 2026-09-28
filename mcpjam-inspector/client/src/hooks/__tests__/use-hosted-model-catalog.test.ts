import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";

// The catalog route (`/api/mcp/models`) is a PUBLIC proxy now — the hook no
// longer reads WorkOS/Convex auth, so no auth mocks are needed.

import {
  catalogDtoToModelDefinition,
  catalogTimestampToMs,
  providerFromCanonicalId,
  resetHostedModelCatalogForTests,
  useHostedModelCatalog,
} from "../use-hosted-model-catalog";

const STORAGE_KEY = "mcpjam.hostedModelCatalog.v3";

function catalogDto(id: string, guestAllowed = true) {
  return {
    id,
    canonical_slug: id,
    name: id,
    created: 0,
    pricing: { prompt: "0", completion: "0", request: "0", image: "0" },
    context_length: 1000,
    architecture: {
      modality: "text->text",
      input_modalities: ["text"],
      output_modalities: ["text"],
      tokenizer: "",
    },
    top_provider: {
      is_moderated: false,
      context_length: 1000,
      max_completion_tokens: 1000,
    },
    per_request_limits: null,
    supported_parameters: [],
    default_parameters: null,
    description: "",
    guestAllowed,
    providerSource: "gateway" as const,
  };
}

function stubFetchJson(body: unknown, ok = true, status = 200) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok, status, json: async () => body }))
  );
}

beforeEach(() => {
  resetHostedModelCatalogForTests();
  window.localStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("providerFromCanonicalId", () => {
  it("derives the provider from the id prefix, applying aliases", () => {
    expect(providerFromCanonicalId("anthropic/claude-haiku-4.5")).toBe(
      "anthropic"
    );
    expect(providerFromCanonicalId("meta-llama/llama-4-scout")).toBe("meta");
    expect(providerFromCanonicalId("x-ai/grok-4-fast")).toBe("xai");
    expect(providerFromCanonicalId("mistralai/mistral-small-2603")).toBe(
      "mistral"
    );
    // Unknown prefix passes through verbatim (renders with a monogram).
    expect(providerFromCanonicalId("nvidia/nemotron")).toBe("nvidia");
  });
});

describe("useHostedModelCatalog", () => {
  it("maps the live backend catalog to hosted ModelDefinitions and persists it", async () => {
    stubFetchJson({ ok: true, data: [catalogDto("newvendor/model-x", false)] });

    const { result } = renderHook(() => useHostedModelCatalog());

    await waitFor(() => expect(result.current.status).toBe("live"));
    const model = result.current.hostedCatalog.find(
      (m) => String(m.id) === "newvendor/model-x"
    );
    expect(model).toMatchObject({
      hosted: true,
      provider: "newvendor",
      guestAllowed: false,
      contextLength: 1000,
    });
    // Last-good cache is persisted for the next (possibly offline) load.
    expect(window.localStorage.getItem(STORAGE_KEY)).toContain(
      "newvendor/model-x"
    );
  });

  it("falls back to the last-good localStorage cache on fetch failure", async () => {
    const cached = [
      {
        id: "cached/model",
        name: "Cached",
        provider: "cached",
        hosted: true,
        guestAllowed: true,
      },
    ];
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(cached));
    stubFetchJson({}, false, 503);

    const { result } = renderHook(() => useHostedModelCatalog());

    await waitFor(() => expect(result.current.status).toBe("fallback"));
    expect(result.current.hostedCatalog).toEqual(cached);
  });

  it("falls back to a non-empty static hosted subset when there is no cache", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("offline");
      })
    );

    const { result } = renderHook(() => useHostedModelCatalog());

    await waitFor(() => expect(result.current.status).toBe("fallback"));
    expect(result.current.hostedCatalog.length).toBeGreaterThan(0);
    expect(result.current.hostedCatalog.every((m) => m.hosted === true)).toBe(
      true
    );
  });

  it("fetches the live catalog for guests too (public route, never empty)", async () => {
    // No auth: the public route is still fetched and upgrades to live.
    stubFetchJson({ ok: true, data: [catalogDto("newvendor/model-x", true)] });

    const { result } = renderHook(() => useHostedModelCatalog());

    await waitFor(() => expect(result.current.status).toBe("live"));
    expect(
      result.current.hostedCatalog.some(
        (m) => String(m.id) === "newvendor/model-x"
      )
    ).toBe(true);
    // No Authorization header is sent to the public proxy.
    const [, init] = vi.mocked(fetch).mock.calls[0] ?? [];
    expect(
      (init as RequestInit | undefined)?.headers as
        | Record<string, string>
        | undefined
    ).not.toHaveProperty("Authorization");
  });

  it("re-attempts the fetch on remount after an offline fallback (no stale pin)", async () => {
    // First load offline → fallback, module-cached.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("offline");
      })
    );
    const first = renderHook(() => useHostedModelCatalog());
    await waitFor(() => expect(first.result.current.status).toBe("fallback"));
    first.unmount();

    // Now online: a `fallback` cache must NOT pin — a fresh mount re-fetches
    // (only a `live` cache short-circuits the fetch).
    stubFetchJson({ ok: true, data: [catalogDto("newvendor/model-x", true)] });
    const second = renderHook(() => useHostedModelCatalog());

    await waitFor(() => expect(second.result.current.status).toBe("live"));
    expect(
      second.result.current.hostedCatalog.some(
        (m) => String(m.id) === "newvendor/model-x"
      )
    ).toBe(true);
  });
});

describe("catalogDtoToModelDefinition", () => {
  it("maps a legacy row (no observations) exactly as before", () => {
    // Today's backend: `created: 0`, a partial parameter list, nothing else.
    const legacy = {
      ...catalogDto("anthropic/claude-haiku-4.5"),
      supported_parameters: ["structured_outputs"],
    };
    expect(catalogDtoToModelDefinition(legacy as any)).toEqual({
      id: "anthropic/claude-haiku-4.5",
      name: "anthropic/claude-haiku-4.5",
      provider: "anthropic",
      hosted: true,
      guestAllowed: true,
      contextLength: 1000,
      supportedParameters: ["structured_outputs"],
    });
  });

  it("carries release, retirement, observations and eligibility", () => {
    const dto = {
      ...catalogDto("openai/gpt-5.6-luna"),
      created: 1_780_000_000,
      released: 1_780_000_000,
      deprecated_at: 1_800_000_000_000,
      supported_parameters: ["tools", "max_tokens"],
      supported_parameters_complete: true,
      free_tier_eligible: false,
      judge_eligible: true,
      catalog_observed_at: 1_790_000_000_000,
      observations: {
        tools: {
          status: "unsupported",
          source: "gateway-catalog",
          observedAt: 1_790_000_000_000,
        },
        openRouterZdr: { status: "supported", source: "openrouter-zdr" },
        // Unrecognized statuses are dropped, not guessed at.
        vision: { status: "maybe", source: "gateway-catalog" },
      },
    };
    expect(catalogDtoToModelDefinition(dto as any)).toMatchObject({
      releasedAt: 1_780_000_000_000,
      deprecatedAt: 1_800_000_000_000,
      supportedParametersComplete: true,
      freeTierEligible: false,
      judgeEligible: true,
      catalogObservedAt: 1_790_000_000_000,
      observations: {
        tools: {
          status: "unsupported",
          source: "gateway-catalog",
          observedAt: 1_790_000_000_000,
        },
        openRouterZdr: { status: "supported", source: "openrouter-zdr" },
      },
    });
    expect(
      catalogDtoToModelDefinition(dto as any).observations
    ).not.toHaveProperty("vision");
  });

  it("falls back to `created` for the release time and to the envelope for observedAt", () => {
    const model = catalogDtoToModelDefinition(
      { ...catalogDto("x/y"), created: 1_700_000_000 } as any,
      1_790_000_000_000
    );
    expect(model.releasedAt).toBe(1_700_000_000_000);
    expect(model.catalogObservedAt).toBe(1_790_000_000_000);
  });

  it("reads seconds and milliseconds, and treats 0 as not reported", () => {
    expect(catalogTimestampToMs(0)).toBeUndefined();
    expect(catalogTimestampToMs(null)).toBeUndefined();
    expect(catalogTimestampToMs(1_780_000_000)).toBe(1_780_000_000_000);
    expect(catalogTimestampToMs(1_780_000_000_000)).toBe(1_780_000_000_000);
  });

  it("drops a v2 cache written before observations existed", async () => {
    window.localStorage.setItem(
      "mcpjam.hostedModelCatalog.v2",
      JSON.stringify([
        { id: "stale/model", name: "Stale", provider: "stale", hosted: true },
      ])
    );
    stubFetchJson({}, false, 503);

    const { result } = renderHook(() => useHostedModelCatalog());

    await waitFor(() => expect(result.current.status).toBe("fallback"));
    expect(
      result.current.hostedCatalog.some((m) => String(m.id) === "stale/model")
    ).toBe(false);
  });
});
