import {
  canonicalizeHostConfigV2,
  computeHostConfigHashV2,
  assertModelSelection,
  defaultFallbackForPurpose,
  isLegacySelection,
  isModelSelection,
  MODEL_SELECTION_PURPOSES,
  ModelSelectionValidationError,
  selectionFromLegacyModelId,
  selectionKey,
  validateModelSelection,
} from "../src/host-config/internal";
import type {
  HostConfigInputV2,
  ModelSelection,
  ModelSelectionIssueCode,
  RequestedModelSelection,
} from "../src/host-config/internal";
import * as publicHostConfig from "../src/host-config/index";
import * as browser from "../src/browser";

const hosted: ModelSelection = {
  modelId: "anthropic/claude-sonnet-4.5",
  source: "hosted",
  fallback: { provider: "none", model: "none" },
};

const org: ModelSelection = {
  modelId: "openai/gpt-5",
  source: "org",
  connectionRef: { kind: "orgProvider", id: "k17abc" },
  fallback: { provider: "none", model: "none" },
};

const local: ModelSelection = {
  modelId: "openai/gpt-5",
  source: "local",
  connectionRef: {
    kind: "localProvider",
    providerKey: "azure",
    customProviderName: "eastus",
  },
  nativeModelId: "gpt5-prod-deployment",
  settings: { reasoningEffort: "high", temperature: 0.2 },
  fallback: { provider: "openrouter", model: "none" },
};

function codes(value: unknown): ModelSelectionIssueCode[] {
  const result = validateModelSelection(value);
  return result.ok ? [] : result.issues.map((i) => i.code);
}

function issuePaths(value: unknown): string[] {
  const result = validateModelSelection(value);
  return result.ok ? [] : result.issues.map((i) => i.path);
}

describe("validateModelSelection — accepted shapes", () => {
  it.each([
    ["hosted", hosted],
    ["org", org],
    ["local with every optional field", local],
    [
      "local without customProviderName",
      {
        ...local,
        connectionRef: { kind: "localProvider", providerKey: "ollama" },
      },
    ],
    ["temperature at 0", { ...hosted, settings: { temperature: 0 } }],
    ["temperature at 2", { ...hosted, settings: { temperature: 2 } }],
    ["OpenRouter-style suffix", { ...hosted, modelId: "z-ai/glm-4.6:free" }],
  ])("accepts %s", (_label, value) => {
    const result = validateModelSelection(value);
    expect(result).toEqual({ ok: true, selection: value });
    expect(isModelSelection(value)).toBe(true);
  });

  it("accepts every reasoning effort", () => {
    for (const reasoningEffort of [
      "none",
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]) {
      expect(
        isModelSelection({ ...hosted, settings: { reasoningEffort } })
      ).toBe(true);
    }
  });

  it("returns a copy with a fixed key order", () => {
    const shuffled = {
      fallback: { model: "none", provider: "openrouter" },
      settings: { temperature: 0.2, reasoningEffort: "high" },
      nativeModelId: local.nativeModelId,
      connectionRef: {
        customProviderName: "eastus",
        providerKey: "azure",
        kind: "localProvider",
      },
      source: "local",
      modelId: local.modelId,
    };
    const result = validateModelSelection(shuffled);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(JSON.stringify(result.selection)).toBe(JSON.stringify(local));
    expect(result.selection).not.toBe(shuffled);
  });

  it("collapses an empty settings object to absent", () => {
    const result = validateModelSelection({ ...hosted, settings: {} });
    expect(result).toEqual({ ok: true, selection: hosted });
    if (result.ok) expect("settings" in result.selection).toBe(false);
  });
});

describe("validateModelSelection — rejected shapes", () => {
  it("rejects a secret-bearing field at the top level", () => {
    const result = validateModelSelection({ ...org, apiKey: "x" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues).toEqual([
      expect.objectContaining({ path: "apiKey", code: "unknown_key" }),
    ]);
    expect(() => assertModelSelection({ ...org, apiKey: "x" })).toThrow(
      /modelSelection\.apiKey: unknown key "apiKey"/
    );
  });

  it("rejects unknown keys inside connectionRef, settings and fallback", () => {
    expect(
      issuePaths({
        ...org,
        connectionRef: { kind: "orgProvider", id: "k1", secret: "s" },
      })
    ).toEqual(["connectionRef.secret"]);
    expect(
      issuePaths({
        ...local,
        connectionRef: {
          kind: "localProvider",
          providerKey: "openai",
          apiKey: "sk-x",
        },
      })
    ).toEqual(["connectionRef.apiKey"]);
    expect(
      issuePaths({ ...hosted, settings: { temperature: 1, topP: 0.9 } })
    ).toEqual(["settings.topP"]);
    expect(
      issuePaths({
        ...hosted,
        fallback: { provider: "none", model: "none", extra: 1 },
      })
    ).toEqual(["fallback.extra"]);
  });

  it("hosted ⇒ no connectionRef", () => {
    expect(
      codes({ ...hosted, connectionRef: { kind: "orgProvider", id: "k1" } })
    ).toEqual(["connection_ref_mismatch"]);
  });

  it("org ⇒ connectionRef.kind === 'orgProvider'", () => {
    const { connectionRef: _omit, ...noRef } = org;
    expect(codes(noRef)).toEqual(["connection_ref_mismatch"]);
    expect(
      codes({
        ...org,
        connectionRef: { kind: "localProvider", providerKey: "openai" },
      })
    ).toEqual(["connection_ref_mismatch"]);
  });

  it("local ⇒ connectionRef.kind === 'localProvider'", () => {
    const { connectionRef: _omit, ...noRef } = local;
    expect(codes(noRef)).toEqual(["connection_ref_mismatch"]);
    expect(
      codes({ ...local, connectionRef: { kind: "orgProvider", id: "k1" } })
    ).toEqual(["connection_ref_mismatch"]);
  });

  it("rejects a malformed connectionRef", () => {
    expect(
      codes({ ...org, connectionRef: { kind: "orgProvider", id: "" } })
    ).toEqual(["invalid_value"]);
    expect(codes({ ...org, connectionRef: { kind: "orgProvider" } })).toEqual([
      "required",
    ]);
    expect(
      codes({ ...org, connectionRef: { kind: "vault", id: "x" } })
    ).toEqual(["invalid_value"]);
    expect(codes({ ...org, connectionRef: "k1" })).toEqual(["invalid_type"]);
  });

  it.each([
    ["empty", ""],
    ["bare id", "gpt-4o"],
    ["leading slash", "/gpt-4o"],
    ["trailing slash", "openai/"],
    ["uppercase provider", "OpenAI/gpt-4o"],
    ["inner whitespace", "openai/gpt 4o"],
    ["surrounding whitespace", " openai/gpt-4o"],
  ])("rejects a non-canonical modelId (%s)", (_label, modelId) => {
    const result = validateModelSelection({ ...hosted, modelId });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.map((i) => i.path)).toEqual(["modelId"]);
  });

  it("rejects a missing or non-string modelId", () => {
    const { modelId: _omit, ...noId } = hosted;
    expect(codes(noId)).toEqual(["required"]);
    expect(codes({ ...hosted, modelId: 42 })).toEqual(["invalid_type"]);
  });

  it.each([
    ["negative", -0.1, "out_of_range"],
    ["above 2", 2.01, "out_of_range"],
    ["NaN", Number.NaN, "invalid_type"],
    ["Infinity", Number.POSITIVE_INFINITY, "invalid_type"],
    ["string", "0.5", "invalid_type"],
  ])("rejects temperature %s", (_label, temperature, code) => {
    expect(codes({ ...hosted, settings: { temperature } })).toEqual([code]);
  });

  it("rejects an unknown reasoning effort", () => {
    expect(
      codes({ ...hosted, settings: { reasoningEffort: "ultra" } })
    ).toEqual(["invalid_value"]);
  });

  it("rejects a bad source, including the read-only legacy source", () => {
    expect(codes({ ...hosted, source: "byok" })).toEqual(["invalid_value"]);
    const legacy = validateModelSelection({ ...hosted, source: "legacy" });
    expect(legacy.ok).toBe(false);
    if (!legacy.ok) expect(legacy.issues[0].message).toMatch(/never saved/);
    const { source: _omit, ...noSource } = hosted;
    expect(codes(noSource)).toEqual(["required"]);
  });

  it("requires fallback and pins fallback.model to 'none'", () => {
    const { fallback: _omit, ...noFallback } = hosted;
    expect(codes(noFallback)).toEqual(["required"]);
    expect(
      codes({ ...hosted, fallback: { provider: "gateway", model: "none" } })
    ).toEqual(["invalid_value"]);
    expect(
      codes({
        ...hosted,
        fallback: { provider: "openrouter", model: "openai/gpt-5" },
      })
    ).toEqual(["invalid_value"]);
  });

  it("rejects an empty nativeModelId", () => {
    expect(codes({ ...local, nativeModelId: "" })).toEqual(["invalid_value"]);
  });

  it.each([null, "hosted", [hosted], new Map()])(
    "rejects a non-plain-object value (%s)",
    (value) => {
      expect(codes(value)).toEqual(["invalid_type"]);
    }
  );

  it("reports every issue, not just the first", () => {
    expect(
      codes({
        modelId: "gpt-4o",
        source: "org",
        settings: { temperature: 9 },
        apiKey: "x",
      }).sort()
    ).toEqual(
      [
        "unknown_key",
        "model_id_not_canonical",
        "connection_ref_mismatch",
        "out_of_range",
        "required",
      ].sort()
    );
  });

  it("assertModelSelection throws a structured error", () => {
    try {
      assertModelSelection({ ...hosted, settings: { temperature: 3 } });
      throw new Error("expected a throw");
    } catch (error) {
      expect(error).toBeInstanceOf(ModelSelectionValidationError);
      expect((error as ModelSelectionValidationError).issues).toEqual([
        expect.objectContaining({
          path: "settings.temperature",
          code: "out_of_range",
        }),
      ]);
    }
  });
});

describe("legacy selections", () => {
  it("wraps a bare id verbatim, without inferring a source", () => {
    expect(selectionFromLegacyModelId("gpt-4o")).toEqual({
      source: "legacy",
      modelId: "gpt-4o",
    });
    expect(selectionFromLegacyModelId("anthropic/claude-sonnet-4.5")).toEqual({
      source: "legacy",
      modelId: "anthropic/claude-sonnet-4.5",
    });
  });

  it("rejects an empty id", () => {
    expect(() => selectionFromLegacyModelId("")).toThrow(/non-empty/);
    expect(() => selectionFromLegacyModelId("   ")).toThrow(/non-empty/);
  });

  it("isLegacySelection narrows a RequestedModelSelection", () => {
    const requested: RequestedModelSelection[] = [
      selectionFromLegacyModelId("gpt-4o"),
      hosted,
      org,
    ];
    expect(requested.map((r) => isLegacySelection(r))).toEqual([
      true,
      false,
      false,
    ]);
    const first = requested[0];
    if (!isLegacySelection(first)) {
      // Narrowed to ModelSelection: `fallback` is reachable.
      expect(first.fallback).toBeDefined();
    }
    expect(isLegacySelection({ source: "legacy", modelId: "" })).toBe(false);
    expect(isLegacySelection(null)).toBe(false);
  });

  it("a legacy selection is never a valid saved selection", () => {
    expect(isModelSelection(selectionFromLegacyModelId("openai/gpt-5"))).toBe(
      false
    );
  });
});

describe("selectionKey", () => {
  it("builds source:connection:modelId", () => {
    expect(selectionKey(hosted)).toBe("hosted::anthropic/claude-sonnet-4.5");
    expect(selectionKey(org)).toBe("org:k17abc:openai/gpt-5");
    expect(selectionKey(local)).toBe("local:azure:eastus:openai/gpt-5");
    expect(
      selectionKey({
        ...local,
        connectionRef: { kind: "localProvider", providerKey: "openai" },
      })
    ).toBe("local:openai:openai/gpt-5");
    expect(selectionKey(selectionFromLegacyModelId("gpt-4o"))).toBe(
      "legacy::gpt-4o"
    );
  });

  it("keeps same-id rows through different connections distinct", () => {
    const keys = new Set([
      selectionKey({ ...hosted, modelId: "openai/gpt-5" }),
      selectionKey(org),
      selectionKey({
        ...org,
        connectionRef: { kind: "orgProvider", id: "k99other" },
      }),
      selectionKey(local),
      selectionKey(selectionFromLegacyModelId("openai/gpt-5")),
    ]);
    expect(keys.size).toBe(5);
  });

  it("ignores settings and fallback (row identity, not configuration)", () => {
    expect(
      selectionKey({
        ...org,
        settings: { temperature: 1 },
        fallback: { provider: "openrouter", model: "none" },
      })
    ).toBe(selectionKey(org));
  });
});

describe("defaultFallbackForPurpose", () => {
  it("chat falls back to OpenRouter; every other purpose refuses", () => {
    for (const purpose of MODEL_SELECTION_PURPOSES) {
      expect(defaultFallbackForPurpose(purpose)).toEqual({
        provider: purpose === "chat" ? "openrouter" : "none",
        model: "none",
      });
    }
    expect(MODEL_SELECTION_PURPOSES).toEqual([
      "chat",
      "evalTarget",
      "persona",
      "judge",
      "analysis",
      "harnessLease",
    ]);
  });

  it("returns a fresh object each call", () => {
    const a = defaultFallbackForPurpose("judge");
    a.provider = "openrouter";
    expect(defaultFallbackForPurpose("judge").provider).toBe("none");
  });
});

// ── HostConfigV2 integration ───────────────────────────────────────────

function base(overrides: Partial<HostConfigInputV2> = {}): HostConfigInputV2 {
  return {
    hostStyle: "claude",
    modelId: "anthropic/claude-sonnet-4.5",
    systemPrompt: "You are a helpful assistant.",
    temperature: 0.7,
    requireToolApproval: false,
    connectionDefaults: { headers: {}, requestTimeout: 10000 },
    clientCapabilities: {},
    hostContext: {},
    ...overrides,
  };
}

/**
 * sha256 of `base()` computed on the canonicalizer BEFORE `modelSelection`
 * existed. It must never move: a config without a selection keeps its
 * content address.
 */
const PRE_FEATURE_BASE_HASH =
  "b487787f40e2d6165553a84832d0f4e9cb650ea416c517b837b4f60cec8d1b96";

describe("canonicalizeHostConfigV2 — modelSelection", () => {
  it("a config without modelSelection hashes exactly as before the field existed", async () => {
    expect(await computeHostConfigHashV2(base())).toBe(PRE_FEATURE_BASE_HASH);
    expect(
      await computeHostConfigHashV2(base({ modelSelection: undefined }))
    ).toBe(PRE_FEATURE_BASE_HASH);
    const canonical = canonicalizeHostConfigV2(base());
    expect("modelSelection" in canonical).toBe(false);
  });

  it("keeps a matching selection, right after modelId, and hashes it", async () => {
    const canonical = canonicalizeHostConfigV2(
      base({ modelSelection: hosted })
    );
    expect(canonical.modelSelection).toEqual(hosted);
    const keys = Object.keys(canonical);
    expect(keys.indexOf("modelSelection")).toBe(keys.indexOf("modelId") + 1);
    expect(
      await computeHostConfigHashV2(base({ modelSelection: hosted }))
    ).not.toBe(PRE_FEATURE_BASE_HASH);
  });

  it("distinguishes the same model id through different credentials", async () => {
    const viaHosted = await computeHostConfigHashV2(
      base({
        modelId: "openai/gpt-5",
        modelSelection: { ...hosted, modelId: "openai/gpt-5" },
      })
    );
    const viaOrg = await computeHostConfigHashV2(
      base({ modelId: "openai/gpt-5", modelSelection: org })
    );
    expect(viaHosted).not.toBe(viaOrg);
  });

  it("is independent of the selection's input key order", async () => {
    const reordered = {
      fallback: { model: "none", provider: "openrouter" },
      settings: { temperature: 0.2, reasoningEffort: "high" },
      nativeModelId: local.nativeModelId,
      connectionRef: {
        customProviderName: "eastus",
        providerKey: "azure",
        kind: "localProvider",
      },
      source: "local",
      modelId: local.modelId,
    } as unknown as ModelSelection;
    const a = base({ modelId: "openai/gpt-5", modelSelection: local });
    const b = base({ modelId: "openai/gpt-5", modelSelection: reordered });
    expect(await computeHostConfigHashV2(a)).toBe(
      await computeHostConfigHashV2(b)
    );
  });

  it("rejects disagreement between modelSelection.modelId and modelId", () => {
    expect(() =>
      canonicalizeHostConfigV2(
        base({ modelId: "anthropic/claude-sonnet-4.5", modelSelection: org })
      )
    ).toThrow(
      'hostConfigV2: modelSelection.modelId ("openai/gpt-5") must equal modelId ("anthropic/claude-sonnet-4.5")'
    );
  });

  it("rejects an invalid selection with the host-config error prefix", () => {
    expect(() =>
      canonicalizeHostConfigV2(
        base({
          modelSelection: {
            ...hosted,
            apiKey: "x",
          } as unknown as ModelSelection,
        })
      )
    ).toThrow(/^hostConfigV2: modelSelection\.apiKey: unknown key/);
    expect(() =>
      canonicalizeHostConfigV2(
        base({
          modelSelection: {
            ...hosted,
            connectionRef: { kind: "orgProvider", id: "k1" },
          },
        })
      )
    ).toThrow(ModelSelectionValidationError);
    expect(() =>
      canonicalizeHostConfigV2(
        base({ modelSelection: null as unknown as ModelSelection })
      )
    ).toThrow(/hostConfigV2: modelSelection: must be a plain object/);
  });

  it("round-trips through the canonical JSON", async () => {
    const input = base({ modelId: "openai/gpt-5", modelSelection: local });
    const canonical = canonicalizeHostConfigV2(input);
    const reparsed = JSON.parse(JSON.stringify(canonical)) as HostConfigInputV2;
    const again = canonicalizeHostConfigV2(reparsed);
    expect(again).toEqual(canonical);
    expect(JSON.stringify(again)).toBe(JSON.stringify(canonical));
    expect(await computeHostConfigHashV2(reparsed)).toBe(
      await computeHostConfigHashV2(input)
    );
  });
});

describe("model selection exports", () => {
  it.each([
    ["@mcpjam/sdk/host-config", publicHostConfig],
    ["@mcpjam/sdk/browser", browser],
  ])("%s exports the helpers", (_label, mod) => {
    const m = mod as Record<string, unknown>;
    for (const name of [
      "validateModelSelection",
      "isModelSelection",
      "assertModelSelection",
      "selectionFromLegacyModelId",
      "isLegacySelection",
      "selectionKey",
      "defaultFallbackForPurpose",
      "ModelSelectionValidationError",
    ]) {
      expect(typeof m[name]).toBe("function");
    }
    expect(m.MODEL_SELECTION_PURPOSES).toBe(MODEL_SELECTION_PURPOSES);
  });
});
