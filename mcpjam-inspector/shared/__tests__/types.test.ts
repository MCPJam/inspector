import { describe, expect, it } from "vitest";
import {
  getCanonicalModelId,
  getModelById,
  hostedModelDefinitionsFromSnapshot,
  hostedProviderFromCanonicalId,
  isServerFormOAuthProtocolMode,
  isMCPJamGuestAllowedModel,
  isMCPJamProvidedModel,
  isModelSupported,
  modelSupportsTemperature,
  modelDefinitionSupportsTemperature,
  type ModelDefinition,
  normalizeOauthProtocolMode,
  resolveEffectiveOauthProtocolMode,
  resolveOAuthProtocolSelection,
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

  it("offers the current Anthropic models to BYOK keys, and no retired ones", () => {
    // The BYOK Anthropic rows are hand-maintained, so they drift behind
    // Anthropic's releases: a user with a valid key could not select Sonnet 5
    // or Opus 5, while five ids that now 404 were still listed. See MMA-2.
    const anthropicIds = SUPPORTED_MODELS.filter(
      (m) => m.provider === "anthropic"
    ).map((m) => String(m.id));

    for (const id of [
      "claude-opus-5",
      "claude-sonnet-5",
      "claude-opus-4-8",
      "claude-opus-4-7",
      "claude-opus-4-6",
      "claude-sonnet-4-6",
    ]) {
      expect(anthropicIds).toContain(id);
    }

    // Retired upstream — listing them offers a selection that can only 404.
    // Opus 4 and Sonnet 4 went out on 2026-06-15, after the 3.x pair.
    for (const id of [
      "claude-3-7-sonnet-latest",
      "claude-3-5-haiku-latest",
      "claude-opus-4-1",
      "claude-opus-4-0",
      "claude-sonnet-4-0",
    ]) {
      expect(anthropicIds).not.toContain(id);
    }
  });

  it("offers the current OpenAI models to BYOK keys", () => {
    // The BYOK OpenAI rows are hand-maintained too, and had drifted to 5.1
    // while the hosted catalog was already serving the 5.6 family, so a user
    // with their own key could not select the newest model. See BACK2-714.
    const openaiIds = SUPPORTED_MODELS.filter(
      (m) => m.provider === "openai"
    ).map((m) => String(m.id));

    for (const id of ["gpt-5.6-luna", "gpt-5.6-sol", "gpt-5.6-terra"]) {
      expect(openaiIds).toContain(id);
    }
  });

  it("reports no temperature support for the Anthropic rows that reject it", () => {
    // Fable 5, Opus 5, Opus 4.8/4.7 and Sonnet 5 answer a temperature with a
    // 400, so every one of these rows would fail on its first request while
    // prepareChatV2 sent the slider value. See MMA-2.
    for (const id of [
      "claude-fable-5",
      "claude-opus-5",
      "claude-opus-4-8",
      "claude-opus-4-7",
      "claude-sonnet-5",
    ]) {
      expect(modelSupportsTemperature(id)).toBe(false);
    }
  });

  it("keeps temperature for the Anthropic rows that still accept it", () => {
    for (const id of [
      "claude-opus-4-6",
      "claude-sonnet-4-6",
      "claude-sonnet-4-5",
      "claude-haiku-4-5",
    ]) {
      expect(modelSupportsTemperature(id)).toBe(true);
    }
  });

  it("answers the same for a hosted id as for the model it names", () => {
    // Hosted ids were exempted while the backend was assumed to own the
    // request body; it substitutes 0.7 instead of stripping, so every one of
    // these was 400ing on its first hosted turn.
    for (const id of [
      "anthropic/claude-opus-4.7",
      "anthropic/claude-opus-4.8",
      "anthropic/claude-sonnet-5",
      "anthropic/claude-fable-5",
      "openai/gpt-5-mini",
    ]) {
      expect(isMCPJamProvidedModel(id)).toBe(true);
      expect(modelSupportsTemperature(id)).toBe(false);
    }
    // A hosted model whose family never dropped the parameters keeps it.
    for (const id of [
      "anthropic/claude-opus-4.6",
      "anthropic/claude-sonnet-4.6",
      "anthropic/claude-haiku-4.5",
    ]) {
      expect(modelSupportsTemperature(id)).toBe(true);
    }
  });

  it("gives every BYOK Anthropic row a context length", () => {
    // getDefaultModel and the token-budget UI both read contextLength; a row
    // added without one silently degrades those rather than failing loudly.
    for (const model of SUPPORTED_MODELS.filter(
      (m) => m.provider === "anthropic"
    )) {
      expect(model.contextLength).toBeGreaterThan(0);
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

describe("modelSupportsTemperature", () => {
  it("still strips temperature for own-provider GPT-5 models", () => {
    expect(modelSupportsTemperature("gpt-5")).toBe(false);
    expect(modelSupportsTemperature("gpt-5.1-codex")).toBe(false);
    expect(modelSupportsTemperature("gpt-5.6-luna")).toBe(false);
  });

  it("strips temperature for a hosted GPT-5 too", () => {
    // Hosted ids used to be exempt on the grounds that the backend owns the
    // body it sends upstream. It substitutes 0.7 rather than stripping, so the
    // exemption only hid the field from the one side that can omit it.
    expect(modelSupportsTemperature("openai/gpt-5")).toBe(false);
  });

  it("resolves a dated snapshot like the alias it pins", () => {
    expect(modelSupportsTemperature("claude-opus-5-20260401")).toBe(false);
  });

  it("resolves a provider-prefixed id by its model family, hosted or not", () => {
    // A prefixed id we don't serve ourselves still reaches the same upstream
    // model on the caller's key, so it rejects temperature just the same — and
    // so does the hosted twin we do serve.
    expect(modelSupportsTemperature("anthropic/claude-opus-5")).toBe(false);
    expect(modelSupportsTemperature("anthropic/claude-sonnet-5")).toBe(false);
  });

  it("keeps temperature for models it knows nothing about", () => {
    expect(modelSupportsTemperature("newvendor/some-new-model")).toBe(true);
    // A blank id matches no family either. It has to fall back to allowing the
    // field rather than being read as a model that rejects it.
    expect(modelSupportsTemperature("")).toBe(true);
    // The id arrives from a catalog row or a persisted config, so a nullish one
    // reaches String() at runtime whatever the signature says. It has to land on
    // the same permissive fallback rather than throwing on the request path.
    expect(modelSupportsTemperature(null as unknown as string)).toBe(true);
    expect(modelSupportsTemperature(undefined as unknown as string)).toBe(true);
  });

  it("strips temperature for Bedrock ids of an affected family", () => {
    // The shape the original report came in under: Bedrock serves the same
    // models over the same request surface, so an inference profile for an
    // affected family 400s identically. None of these are hosted, so the
    // MCPJam-provided carve-out does not apply.
    const ids = [
      "us.anthropic.claude-opus-4-7-20260205-v1:0",
      "eu.anthropic.claude-sonnet-5-20260401-v1:0",
      "arn:aws:bedrock:us-east-1:123456789012:inference-profile/us.anthropic.claude-opus-4-8-20260310-v1:0",
    ];
    for (const id of ids) {
      expect(modelSupportsTemperature(id), id).toBe(false);
    }
  });

  it("keeps temperature for a Bedrock id whose family still accepts it", () => {
    const ids = [
      "us.anthropic.claude-sonnet-4-5-20250929-v1:0",
      "us.anthropic.claude-haiku-4-5-20251001-v1:0",
      // A bare major on Bedrock is followed by the release date; it must not
      // be read as a minor version, which would push Opus 4 over the 4.7
      // threshold.
      "anthropic.claude-opus-4-20250514-v1:0",
    ];
    for (const id of ids) {
      expect(modelSupportsTemperature(id), id).toBe(true);
    }
  });

  it("covers versions past the cutoff that have not shipped yet", () => {
    // The threshold is numeric, so a new release in an affected family is
    // handled without anyone editing this file.
    expect(modelSupportsTemperature("anthropic/claude-opus-4.9")).toBe(false);
    expect(modelSupportsTemperature("anthropic/claude-opus-6")).toBe(false);
    // A family with no threshold of its own is held to 5, so a Haiku 5 loses
    // the field while every shipped Haiku keeps it.
    expect(modelSupportsTemperature("anthropic/claude-haiku-5")).toBe(false);
    expect(modelSupportsTemperature("anthropic/claude-haiku-4.5")).toBe(true);
  });
});

describe("modelDefinitionSupportsTemperature", () => {
  const row = (over: Partial<ModelDefinition>): ModelDefinition =>
    ({
      id: "openai/gpt-4o",
      name: "GPT-4o",
      provider: "openai",
      ...over,
    } as ModelDefinition);

  it("answers from the catalog when it lists parameters", () => {
    expect(
      modelDefinitionSupportsTemperature(
        row({ supportedParameters: ["tools", "temperature"] })
      )
    ).toBe(true);
    expect(
      modelDefinitionSupportsTemperature(
        row({ supportedParameters: ["tools", "max_tokens"] })
      )
    ).toBe(false);
  });

  it("treats absent or empty parameters as no metadata", () => {
    // Every BYOK/org/Ollama row, and any hosted row cached before the field
    // existed, arrives this way. Reading it as "accepts nothing" would strip
    // temperature from the whole picker.
    expect(modelDefinitionSupportsTemperature(row({}))).toBe(true);
    expect(
      modelDefinitionSupportsTemperature(row({ supportedParameters: [] }))
    ).toBe(true);
  });

  it("never lets the catalog restore temperature to a rejecting id", () => {
    // The id predicate knows the request 400s; a stale row claiming otherwise
    // is not new information.
    expect(
      modelDefinitionSupportsTemperature(
        row({
          id: "anthropic/claude-sonnet-5",
          provider: "anthropic",
          supportedParameters: ["temperature"],
        })
      )
    ).toBe(false);
    expect(
      modelDefinitionSupportsTemperature(
        row({ id: "openai/gpt-5", supportedParameters: ["temperature"] })
      )
    ).toBe(false);
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

  it("uses fresh negotiated MCP evidence after an absent wire pin", () => {
    expect(
      resolveEffectiveOauthProtocolMode("auto", undefined, "2026-07-28")
    ).toBe("2026-07-28");
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

describe("auto resolves against an older wire pin", () => {
  // Behavior change worth pinning down: "auto" used to collapse every
  // non-2026 wire pin to 2025-11-25. It now returns the pinned era, so an
  // Auto server pinned to an older revision runs THAT era's OAuth flow.
  it.each(["2025-03-26", "2025-06-18", "2025-11-25", "2026-07-28"] as const)(
    "auto + a %s wire pin resolves to that era",
    (pin) => {
      expect(resolveEffectiveOauthProtocolMode("auto", pin)).toBe(pin);
    }
  );

  it("carries the older pin through the full selection, tagged as wire_pin", () => {
    expect(
      resolveOAuthProtocolSelection({
        mode: "auto",
        wireProtocolVersion: "2025-06-18",
      })
    ).toEqual({
      mode: "auto",
      protocolVersion: "2025-06-18",
      source: "wire_pin",
    });
  });

  it("prefers an explicit OAuth selection over an older wire pin", () => {
    expect(
      resolveOAuthProtocolSelection({
        mode: "2026-07-28",
        wireProtocolVersion: "2025-03-26",
      })
    ).toEqual({
      mode: "2026-07-28",
      protocolVersion: "2026-07-28",
      source: "explicit_oauth",
    });
  });

  it("prefers an explicit wire pin over a freshly negotiated version", () => {
    expect(
      resolveOAuthProtocolSelection({
        mode: "auto",
        wireProtocolVersion: "2025-06-18",
        negotiatedProtocolVersion: "2026-07-28",
      }).protocolVersion
    ).toBe("2025-06-18");
  });
});

describe("resolveOAuthProtocolSelection", () => {
  it("recognizes every shared protocol mode without a second allowlist", () => {
    expect(isServerFormOAuthProtocolMode("auto")).toBe(true);
    for (const mode of SERVER_FORM_OAUTH_PROTOCOL_MODES) {
      expect(isServerFormOAuthProtocolMode(mode)).toBe(true);
    }
    expect(isServerFormOAuthProtocolMode("2099-01-01")).toBe(false);
  });

  it("does not let an Auto flow's previous concrete profile become a pin", () => {
    expect(
      resolveOAuthProtocolSelection({
        mode: "auto",
        legacyProtocolVersion: "2026-07-28",
      })
    ).toEqual({
      mode: "auto",
      protocolVersion: "2025-11-25",
      source: "auth_gated_fallback",
    });
  });

  it("retains concrete behavior for records created before mode existed", () => {
    expect(
      resolveOAuthProtocolSelection({
        legacyProtocolVersion: "2026-07-28",
      })
    ).toEqual({
      mode: "2026-07-28",
      protocolVersion: "2026-07-28",
      source: "explicit_oauth",
    });
  });
});
