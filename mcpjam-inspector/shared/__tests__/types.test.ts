import { describe, expect, it } from "vitest";
import {
  getCanonicalModelId,
  getModelById,
  hostedModelDefinitionsFromSnapshot,
  hostedProviderFromCanonicalId,
  isMCPJamGuestAllowedModel,
  isMCPJamProvidedModel,
  isModelSupported,
  normalizeOauthProtocolMode,
  resolveEffectiveOauthProtocolMode,
  SERVER_FORM_OAUTH_PROTOCOL_MODES,
  SUPPORTED_MODELS,
} from "../types.js";

describe("MCPJam-provided model classification", () => {
  it("treats openai/gpt-4o-mini as MCPJam-provided", () => {
    expect(isMCPJamProvidedModel("openai/gpt-4o-mini")).toBe(true);
  });

  it("treats every provided hosted model as guest-allowed (guests un-curated)", () => {
    // Guest curation is gone — enforcement is spend caps, not an allowlist.
    // isMCPJamGuestAllowedModel now mirrors isMCPJamProvidedModel: a formerly
    // guest-gated premium model is guest-allowed too.
    const ids = [
      "anthropic/claude-haiku-4.5",
      "openai/gpt-oss-120b",
      "mistralai/mistral-small-2603",
      // formerly guest-gated premium:
      "openai/gpt-5.4",
      "openai/gpt-5.5-pro",
      "deepseek/deepseek-v4-pro",
      "anthropic/claude-opus-4.6",
      "anthropic/claude-opus-4.7",
      "google/gemini-3.1-pro-preview",
      "mistralai/mistral-large-2512",
    ];
    for (const id of ids) {
      expect(isMCPJamProvidedModel(id)).toBe(true);
      expect(isMCPJamGuestAllowedModel(id)).toBe(true);
    }
    // A non-provided (BYOK/unknown) id is still not guest-allowed.
    expect(isMCPJamGuestAllowedModel("somevendor/not-hosted")).toBe(false);
  });

  it("derives hosted provider from the id prefix (display rows removed)", () => {
    // Hosted display rows no longer live in SUPPORTED_MODELS — provider comes
    // from the canonical id prefix (with the OpenRouter→provider aliases).
    expect(hostedProviderFromCanonicalId("qwen/qwen3.6-plus")).toBe("qwen");
    expect(hostedProviderFromCanonicalId("x-ai/grok-4-fast")).toBe("xai");
    expect(hostedProviderFromCanonicalId("x-ai/grok-4.5")).toBe("xai");
    expect(hostedProviderFromCanonicalId("mistralai/mistral-small-2603")).toBe(
      "mistral"
    );
    expect(hostedProviderFromCanonicalId("meta-llama/llama-4-scout")).toBe(
      "meta"
    );
    expect(getModelById("qwen/qwen3.6-plus")).toBeUndefined();
  });

  it("normalizes bare model ids with provider metadata", () => {
    expect(getCanonicalModelId("claude-haiku-4.5", "anthropic")).toBe(
      "anthropic/claude-haiku-4.5"
    );
    expect(isMCPJamProvidedModel("claude-haiku-4.5", "anthropic")).toBe(true);
    expect(isMCPJamProvidedModel("grok-4.5", "xai")).toBe(true);
    expect(isMCPJamProvidedModel("grok-4-fast", "xai")).toBe(true);
  });

  it("canonicalizes against an injected catalog (catalog-only ids)", () => {
    const catalog = [
      { id: "newvendor/brand-new-model", provider: "newvendor" },
    ];
    // A bare id resolves to the prefixed catalog id when the catalog is injected…
    expect(getCanonicalModelId("brand-new-model", "newvendor", catalog)).toBe(
      "newvendor/brand-new-model"
    );
    // …and an exact catalog id passes through.
    expect(
      getCanonicalModelId("newvendor/brand-new-model", undefined, catalog)
    ).toBe("newvendor/brand-new-model");
    // Without the injected catalog, the unknown bare id can't be canonicalized.
    expect(getCanonicalModelId("brand-new-model", "newvendor")).toBe(
      "brand-new-model"
    );
  });

  it("classifies hosted ids via the snapshot, not the static display rows", () => {
    // Display rows are gone → getModelById returns undefined for hosted ids…
    expect(getModelById("openai/gpt-4o-mini")).toBeUndefined();
    expect(getModelById("z-ai/glm-5.2")).toBeUndefined();
    // …but they are still MCPJam-provided and count as "supported".
    expect(isMCPJamProvidedModel("openai/gpt-4o-mini")).toBe(true);
    expect(isMCPJamProvidedModel("deepseek/deepseek-v4-pro")).toBe(true);
    expect(isModelSupported("z-ai/glm-5.2")).toBe(true);
    expect(getModelById("google/gemini-3-pro-preview")).toBeUndefined();
  });

  it("isModelSupported stays permissive for provider-prefixed ids (catalog is the real gate)", () => {
    // A provider-prefixed id we don't statically know may be a newer catalog
    // model — supported optimistically so a fresh backend model isn't snapped
    // to a template default before this snapshot regenerates.
    expect(isModelSupported("newvendor/some-new-model")).toBe(true);
    // A bare id that isn't a BYOK static remains unsupported.
    expect(isModelSupported("totally-unknown-bare-model")).toBe(false);
  });

  it("SUPPORTED_MODELS is BYOK-only: no hosted (slash / '(Free)') rows remain", () => {
    for (const model of SUPPORTED_MODELS) {
      const id = String(model.id);
      // Only BYOK bare ids or "azure/…" ids survive; no hosted "(Free)" names.
      expect(model.name.endsWith("(Free)")).toBe(false);
      if (id.includes("/")) {
        expect(id.startsWith("azure/")).toBe(true);
      }
    }
  });

  it("hostedModelDefinitionsFromSnapshot() is a non-empty, all-hosted fallback", () => {
    const hosted = hostedModelDefinitionsFromSnapshot();
    expect(hosted.length).toBeGreaterThan(100);
    expect(hosted.every((m) => m.hosted === true)).toBe(true);
    // Every hosted snapshot model is guest-allowed now (guests un-curated).
    expect(hosted.every((m) => m.guestAllowed === true)).toBe(true);
  });
});

describe("normalizeOauthProtocolMode (connect-form OAuth protocol)", () => {
  // Single source for the Add and Edit connect forms — both previously kept
  // private copies that had to preserve 2026-07-28 in lockstep.
  it("preserves every concrete protocol era, including the 2026-07-28 draft", () => {
    expect(normalizeOauthProtocolMode("2025-03-26")).toBe("2025-03-26");
    expect(normalizeOauthProtocolMode("2025-06-18")).toBe("2025-06-18");
    expect(normalizeOauthProtocolMode("2025-11-25")).toBe("2025-11-25");
    expect(normalizeOauthProtocolMode("2026-07-28")).toBe("2026-07-28");
  });

  it("does not silently degrade a stored 2026-07-28 pin to 2025-11-25", () => {
    expect(normalizeOauthProtocolMode("2026-07-28")).not.toBe("2025-11-25");
  });

  it("preserves the deferred 'auto' sentinel through hydration", () => {
    // "auto" is a valid mode the wire-pin bridge resolves later; coercing it
    // to a concrete era here would drop the sentinel and make the bridge
    // unreachable for prefilled/edited servers.
    expect(normalizeOauthProtocolMode("auto")).toBe("auto");
  });

  it("falls back to 2025-11-25 for unknowns and undefined", () => {
    expect(normalizeOauthProtocolMode(undefined)).toBe("2025-11-25");
    expect(normalizeOauthProtocolMode("garbage")).toBe("2025-11-25");
  });

  it("derives its accepted set from the single-source tuple", () => {
    // Every concrete era normalizes to itself; the tuple IS the source the
    // union and the membership check share, so this guards against drift.
    for (const era of SERVER_FORM_OAUTH_PROTOCOL_MODES) {
      expect(normalizeOauthProtocolMode(era)).toBe(era);
    }
  });
});

describe("resolveEffectiveOauthProtocolMode (auto → wire-pin bridge)", () => {
  it("resolves 'auto' to the 2026 flow only under a 2026-07-28 wire pin", () => {
    expect(resolveEffectiveOauthProtocolMode("auto", "2026-07-28")).toBe(
      "2026-07-28"
    );
  });

  it("resolves 'auto' to the 2025-11-25 default without a 2026 wire pin", () => {
    expect(resolveEffectiveOauthProtocolMode("auto", "2025-11-25")).toBe(
      "2025-11-25"
    );
    expect(resolveEffectiveOauthProtocolMode("auto", undefined)).toBe(
      "2025-11-25"
    );
  });

  it("passes an explicit selection straight through — it always wins", () => {
    expect(resolveEffectiveOauthProtocolMode("2025-06-18", "2026-07-28")).toBe(
      "2025-06-18"
    );
    expect(resolveEffectiveOauthProtocolMode("2026-07-28", undefined)).toBe(
      "2026-07-28"
    );
  });
});
