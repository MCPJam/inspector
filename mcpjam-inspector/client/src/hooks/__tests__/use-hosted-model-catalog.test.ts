import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";

const authState = vi.hoisted(() => ({ isAuthenticated: true }));
const mockGetAccessToken = vi.hoisted(() => vi.fn());

vi.mock("convex/react", () => ({
  useConvexAuth: () => ({
    isAuthenticated: authState.isAuthenticated,
    isLoading: false,
  }),
}));

vi.mock("@workos-inc/authkit-react", () => ({
  useAuth: () => ({ getAccessToken: mockGetAccessToken }),
}));

import {
  providerFromCanonicalId,
  resetHostedModelCatalogForTests,
  useHostedModelCatalog,
} from "../use-hosted-model-catalog";

const STORAGE_KEY = "mcpjam.hostedModelCatalog.v1";

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
  authState.isAuthenticated = true;
  mockGetAccessToken.mockReset();
  mockGetAccessToken.mockResolvedValue("token-123");
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

  it("skips the auth-gated fetch for guests and serves the fallback (never empty)", async () => {
    authState.isAuthenticated = false;
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const { result } = renderHook(() => useHostedModelCatalog());

    await waitFor(() => expect(result.current.status).toBe("fallback"));
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result.current.hostedCatalog.length).toBeGreaterThan(0);
  });

  it("refetches the live catalog when a guest signs in (no stale fallback pin)", async () => {
    // Guest first: resolves to the static fallback and caches it module-wide.
    authState.isAuthenticated = false;
    stubFetchJson({ ok: true, data: [catalogDto("newvendor/model-x", false)] });

    const { result, rerender } = renderHook(() => useHostedModelCatalog());
    await waitFor(() => expect(result.current.status).toBe("fallback"));

    // Sign in: the guest fallback must NOT pin — the hook fetches the now
    // reachable auth-gated catalog and upgrades to live.
    authState.isAuthenticated = true;
    rerender();

    await waitFor(() => expect(result.current.status).toBe("live"));
    expect(
      result.current.hostedCatalog.some((m) => String(m.id) === "newvendor/model-x")
    ).toBe(true);
  });
});
