import { describe, expect, it } from "vitest";
import {
  ANTHROPIC_REASONING_EFFORTS,
  HARNESS_REASONING_EFFORTS,
} from "../src/host-config/internal.js";
import {
  MODEL_REASONING_EFFORTS,
  reasoningEffortProviderOptions,
  selectionConfigKey,
  selectionIfMatches,
  selectionKey,
  supportedReasoningEfforts,
  harnessReasoningEfforts,
  isDefaultSelection,
  comparisonKey,
  selectionDistinguishers,
  defaultReasoningEffort,
  type ModelSelection,
  type RequestedModelSelection,
} from "../src/host-config/index.js";
import * as browser from "../src/browser.js";

const HOSTED: ModelSelection = {
  modelId: "openai/gpt-5",
  source: "hosted",
  fallback: { provider: "none", model: "none" },
};

describe("supportedReasoningEfforts", () => {
  it("hosted reads the catalog list only, in canonical order", () => {
    expect(
      supportedReasoningEfforts({
        route: "hosted",
        providerKey: "openai",
        modelId: "openai/gpt-5",
        catalogEfforts: ["high", "low", "bogus", "medium"],
      })
    ).toEqual(["low", "medium", "high"]);
    expect(
      supportedReasoningEfforts({
        route: "hosted",
        providerKey: "openai",
        modelId: "openai/gpt-5",
      })
    ).toEqual([]);
  });

  it("direct/org derive from the provider families and hide unknown models", () => {
    const efforts = (providerKey: string, modelId: string, route = "direct") =>
      supportedReasoningEfforts({
        route: route as "direct",
        providerKey,
        modelId,
      });
    // OpenAI levels are model-specific: none is 5.1+, xhigh is 5.2+.
    expect(efforts("openai", "gpt-5")).toEqual([
      "minimal",
      "low",
      "medium",
      "high",
    ]);
    expect(efforts("openai", "gpt-5.1")).toEqual([
      "none",
      "low",
      "medium",
      "high",
    ]);
    expect(efforts("openai", "openai/gpt-5.2")).toEqual([
      "none",
      "low",
      "medium",
      "high",
      "xhigh",
    ]);
    expect(efforts("openai", "gpt-5.1-codex-max")).toContain("xhigh");
    // Codex never takes "none".
    expect(efforts("openai", "gpt-5.2-codex")).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
    ]);
    // Undocumented Codex variants are hidden, not guessed from the family.
    for (const id of [
      "gpt-5-codex",
      "gpt-5.1-codex",
      "gpt-5.1-codex-mini",
      "gpt-5.3-codex",
    ]) {
      expect(efforts("openai", id), id).toEqual([]);
    }
    expect(efforts("openai", "gpt-5.2-pro")).toEqual([]);
    for (const chat of [
      "gpt-5-chat-latest",
      "gpt-5.1-chat-latest",
      "openai/gpt-5-chat",
    ]) {
      expect(efforts("openai", chat), chat).toEqual([]);
    }
    expect(efforts("openai", "openai/o3-mini")).toEqual([
      "low",
      "medium",
      "high",
    ]);
    // Only o-series ids the provider sends effort for; o1-mini / o1-preview
    // reject the parameter and unknown oN are unverified.
    for (const id of ["o1", "o3", "o4-mini", "o1-2024-12-17"]) {
      expect(efforts("openai", id), id).toEqual(["low", "medium", "high"]);
    }
    for (const id of ["o1-mini", "o1-preview", "o4", "o5", "o3-pro"]) {
      expect(efforts("openai", id), id).toEqual([]);
    }
    // The org runtime is unknown until resolved: nothing is offered.
    expect(efforts("openai", "gpt-5", "org")).toEqual([]);
    expect(efforts("openai", "gpt-4o")).toEqual([]);
    // Per version: 4.5 low-high, 4.6 adds max, Opus 4.7+ adds xhigh.
    expect(efforts("anthropic", "anthropic/claude-opus-4-5")).toEqual([
      "low",
      "medium",
      "high",
    ]);
    expect(efforts("anthropic", "claude-sonnet-4-6")).toEqual([
      "low",
      "medium",
      "high",
      "max",
    ]);
    expect(efforts("anthropic", "claude-opus-4-6")).toEqual([
      "low",
      "medium",
      "high",
      "max",
    ]);
    expect(efforts("anthropic", "claude-opus-4-7")).toEqual([
      ...ANTHROPIC_REASONING_EFFORTS,
    ]);
    expect(efforts("anthropic", "claude-fable-5-1")).toEqual([
      ...ANTHROPIC_REASONING_EFFORTS,
    ]);
    // Two-digit minors parse; a date suffix is not a minor.
    // Undocumented 4.x minors are unverified, so hidden (not inferred).
    expect(efforts("anthropic", "claude-opus-4.10")).toEqual([]);
    // Two-digit minors still parse: a version-5 model with one takes the full set.
    expect(efforts("anthropic", "claude-opus-5-10")).toEqual([
      ...ANTHROPIC_REASONING_EFFORTS,
    ]);
    expect(efforts("anthropic", "claude-sonnet-5-5")).toEqual([
      ...ANTHROPIC_REASONING_EFFORTS,
    ]);
    expect(efforts("anthropic", "claude-opus-4-20250514")).toEqual([]);
    // Older / unverified Claude models reject output_config.effort.
    for (const old of [
      "claude-3-5-sonnet-latest",
      "claude-sonnet-4-20250514",
      "claude-sonnet-4-5",
      "claude-opus-4-1",
      "claude-haiku-4-5",
    ]) {
      expect(efforts("anthropic", old), old).toEqual([]);
    }
    expect(efforts("google", "gemini-3-pro")).toEqual(["low", "high"]);
    expect(efforts("google", "gemini-3.1-pro-preview")).toEqual([
      "low",
      "medium",
      "high",
    ]);
    // Unverified Gemini 3 families are hidden, not given the full set.
    expect(efforts("google", "gemini-3.1-flash-lite-image")).toEqual([]);
    expect(efforts("google", "gemini-3-pro-image-preview")).toEqual([]);
    expect(efforts("google", "gemini-3.1-pro-preview-customtools")).toEqual([]);
    expect(efforts("google", "google/gemini-3-pro-preview")).toEqual([
      "low",
      "high",
    ]);
    expect(efforts("google", "gemini-3-flash")).toEqual([
      "minimal",
      "low",
      "medium",
      "high",
    ]);
    expect(efforts("google", "gemini-2.5-pro")).toEqual([]);
    expect(efforts("ollama", "llama3")).toEqual([]);
  });

  it("org-cloud offers the provider tables (the backend maps them per provider)", () => {
    expect(
      supportedReasoningEfforts({
        route: "orgCloud",
        providerKey: "anthropic",
        modelId: "claude-sonnet-4-6",
      })
    ).toEqual(["low", "medium", "high", "max"]);
    expect(
      supportedReasoningEfforts({
        route: "orgCloud",
        providerKey: "xai",
        modelId: "grok-4",
      })
    ).toEqual([]);
  });

  it("a harness uses its adapter table, verified rows only", () => {
    // Claude Code stays empty: mapping code exists but the live check that
    // would verify it has not run, so an effort there is still refused.
    expect(HARNESS_REASONING_EFFORTS["claude-code"]).toEqual([]);
    expect(HARNESS_REASONING_EFFORTS.cursor).toEqual([]);
    expect(HARNESS_REASONING_EFFORTS.codex).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
    ]);
    for (const harness of ["claude-code", "codex", "cursor"] as const) {
      expect(harnessReasoningEfforts(harness)).toEqual([
        ...HARNESS_REASONING_EFFORTS[harness],
      ]);
      // A model that lists every level: the adapter's table decides.
      expect(
        supportedReasoningEfforts({
          route: "hosted",
          providerKey: "openai",
          modelId: "openai/gpt-5",
          catalogEfforts: [...MODEL_REASONING_EFFORTS],
          harness,
        })
      ).toEqual([...HARNESS_REASONING_EFFORTS[harness]]);
    }
  });

  it("a harness offers only levels its model also lists (fail closed when unknown)", () => {
    const codex = (catalogEfforts?: string[]) =>
      supportedReasoningEfforts({
        route: "hosted",
        providerKey: "openai",
        modelId: "openai/gpt-5-nano",
        catalogEfforts,
        harness: "codex",
      });
    expect(codex(["minimal", "low", "medium", "high"])).toEqual([
      "low",
      "medium",
      "high",
    ]);
    expect(codex([])).toEqual([]);
    expect(codex(undefined)).toEqual([]);
  });

  it("every table level is a known effort", () => {
    for (const level of ANTHROPIC_REASONING_EFFORTS) {
      expect(MODEL_REASONING_EFFORTS).toContain(level);
    }
  });
});

describe("reasoningEffortProviderOptions", () => {
  it("maps the supported families", () => {
    expect(
      reasoningEffortProviderOptions({
        providerKey: "openai",
        modelId: "gpt-5",
        effort: "high",
      })
    ).toEqual({ openai: { reasoningEffort: "high" } });
    expect(
      reasoningEffortProviderOptions({
        providerKey: "anthropic",
        modelId: "claude-sonnet-4-6",
        effort: "low",
      })
    ).toEqual({ anthropic: { effort: "low", thinking: { type: "adaptive" } } });
    expect(
      reasoningEffortProviderOptions({
        providerKey: "anthropic",
        modelId: "anthropic/claude-opus-4-5",
        effort: "low",
      })
    ).toEqual({ anthropic: { effort: "low" } });
    expect(
      reasoningEffortProviderOptions({
        providerKey: "google",
        modelId: "gemini-3-flash",
        effort: "minimal",
      })
    ).toEqual({ google: { thinkingConfig: { thinkingLevel: "minimal" } } });
  });

  it("refuses (undefined) an unsupported level or model", () => {
    expect(
      reasoningEffortProviderOptions({
        providerKey: "openai",
        modelId: "gpt-5",
        effort: "max",
      })
    ).toBeUndefined();
    expect(
      reasoningEffortProviderOptions({
        providerKey: "openai",
        modelId: "gpt-4o",
        effort: "low",
      })
    ).toBeUndefined();
    expect(
      reasoningEffortProviderOptions({
        providerKey: "mistral",
        modelId: "mistral-large",
        effort: "low",
      })
    ).toBeUndefined();
  });
});

describe("selectionConfigKey", () => {
  it("splits on effort where selectionKey does not", () => {
    const high = { ...HOSTED, settings: { reasoningEffort: "high" as const } };
    expect(selectionKey(high)).toBe(selectionKey(HOSTED));
    expect(selectionConfigKey(high)).not.toBe(selectionConfigKey(HOSTED));
  });

  it("ignores key order and empty settings", () => {
    const shuffled = {
      fallback: { model: "none", provider: "none" },
      settings: {},
      source: "hosted",
      modelId: "openai/gpt-5",
    } as ModelSelection;
    expect(selectionConfigKey(shuffled)).toBe(selectionConfigKey(HOSTED));
  });

  it("is the backend's canonical JSON (field order pinned)", () => {
    const org: ModelSelection = {
      modelId: "anthropic/claude-sonnet-4-5",
      source: "local",
      connectionRef: {
        kind: "localProvider",
        providerKey: "custom",
        customProviderName: "mine",
      },
      nativeModelId: "native",
      settings: { temperature: 0.2, reasoningEffort: "low" },
      fallback: { provider: "openrouter", model: "none" },
    };
    expect(selectionConfigKey(org)).toBe(
      '{"modelId":"anthropic/claude-sonnet-4-5","source":"local",' +
        '"connectionRef":{"kind":"localProvider","providerKey":"custom","customProviderName":"mine"},' +
        '"nativeModelId":"native","settings":{"reasoningEffort":"low","temperature":0.2},' +
        '"fallback":{"provider":"openrouter","model":"none"}}'
    );
  });
});

describe("selectionIfMatches", () => {
  it("keeps a selection only for its own model", () => {
    expect(selectionIfMatches(HOSTED, "openai/gpt-5")).toBe(HOSTED);
    expect(selectionIfMatches(HOSTED, "openai/gpt-5-mini")).toBeUndefined();
    expect(selectionIfMatches(undefined, "openai/gpt-5")).toBeUndefined();
    expect(selectionIfMatches(HOSTED, undefined)).toBeUndefined();
  });
});

describe("comparisonKey", () => {
  it("keys a default selection as the bare model id (byte-identical to pre-selection keys)", () => {
    const legacy: RequestedModelSelection = {
      source: "legacy",
      modelId: "openai/gpt-5",
    };
    expect(isDefaultSelection(legacy)).toBe(true);
    expect(comparisonKey(legacy)).toBe("openai/gpt-5");
    expect(
      comparisonKey({ ...legacy, provider: "openai" } as RequestedModelSelection)
    ).toBe("openai/gpt-5");
    expect(isDefaultSelection(HOSTED)).toBe(true);
    expect(comparisonKey(HOSTED)).toBe("openai/gpt-5");
    // An empty settings object and a different fallback are still default.
    expect(
      comparisonKey({
        ...HOSTED,
        settings: {},
        fallback: { provider: "openrouter", model: "none" },
      })
    ).toBe("openai/gpt-5");
  });

  it("splits on effort, temperature, native id, source and connection", () => {
    const high = { ...HOSTED, settings: { reasoningEffort: "high" as const } };
    const low = { ...HOSTED, settings: { reasoningEffort: "low" as const } };
    const native = { ...HOSTED, nativeModelId: "gpt-5-2025" };
    const org: ModelSelection = {
      ...HOSTED,
      source: "org",
      connectionRef: { kind: "orgProvider", id: "p1" },
    };
    const keys = [HOSTED, high, low, native, org].map(comparisonKey);
    expect(new Set(keys).size).toBe(5);
    for (const s of [high, low, native, org]) {
      expect(isDefaultSelection(s)).toBe(false);
    }
  });

  it("ignores fallback and key order", () => {
    const a = {
      ...HOSTED,
      settings: { reasoningEffort: "high" as const, temperature: 0.5 },
    };
    const b = {
      fallback: { model: "none", provider: "openrouter" },
      settings: { temperature: 0.5, reasoningEffort: "high" },
      source: "hosted",
      modelId: "openai/gpt-5",
    } as ModelSelection;
    expect(comparisonKey(a)).toBe(comparisonKey(b));
  });

  it("matches the backend golden byte for byte", () => {
    expect(
      comparisonKey({ ...HOSTED, settings: { reasoningEffort: "high" } })
    ).toBe(
      'openai/gpt-5\u0000{"modelId":"openai/gpt-5","source":"hosted","settings":{"reasoningEffort":"high"}}'
    );
    expect(
      comparisonKey({
        modelId: "anthropic/claude-sonnet-4-5",
        source: "local",
        connectionRef: {
          kind: "localProvider",
          providerKey: "custom",
          customProviderName: "mine",
        },
        nativeModelId: "native",
        settings: { temperature: 0.2, reasoningEffort: "low" },
        fallback: { provider: "openrouter", model: "none" },
      })
    ).toBe(
      "anthropic/claude-sonnet-4-5\u0000" +
        '{"modelId":"anthropic/claude-sonnet-4-5","source":"local",' +
        '"connectionRef":{"kind":"localProvider","providerKey":"custom","customProviderName":"mine"},' +
        '"nativeModelId":"native","settings":{"reasoningEffort":"low","temperature":0.2}}'
    );
  });
});

describe("selectionDistinguishers", () => {
  const high = { ...HOSTED, settings: { reasoningEffort: "high" as const } };
  const low = { ...HOSTED, settings: { reasoningEffort: "low" as const } };

  it("always names a set effort, even for a lone model", () => {
    expect(selectionDistinguishers(high, [high])).toEqual(["High"]);
    expect(
      selectionDistinguishers(high, [
        high,
        { ...HOSTED, modelId: "openai/gpt-5-mini" },
      ])
    ).toEqual(["High"]);
  });

  it("shows nothing for a lone model with no effort", () => {
    expect(selectionDistinguishers(HOSTED, [HOSTED])).toEqual([]);
  });

  it("shows only the effort when only the effort differs", () => {
    expect(selectionDistinguishers(high, [high, low])).toEqual(["High"]);
    expect(selectionDistinguishers(low, [high, low])).toEqual(["Low"]);
    expect(selectionDistinguishers(HOSTED, [HOSTED, high])).toEqual([
      "Default",
    ]);
  });

  it("shows source and effort when both differ", () => {
    const org: ModelSelection = {
      ...high,
      source: "org",
      connectionRef: { kind: "orgProvider", id: "p1" },
    };
    expect(selectionDistinguishers(org, [org, low])).toEqual([
      "Org key",
      "High",
    ]);
    expect(selectionDistinguishers(low, [org, low])).toEqual(["MCPJam", "Low"]);
  });

  it("labels temperature", () => {
    const warm = { ...HOSTED, settings: { temperature: 0.7 } };
    expect(selectionDistinguishers(warm, [warm, HOSTED])).toEqual(["Temp 0.7"]);
    expect(selectionDistinguishers(HOSTED, [warm, HOSTED])).toEqual([
      "Default temp",
    ]);
  });
});

describe("defaultReasoningEffort", () => {
  it("answers the provider default per family", () => {
    expect(defaultReasoningEffort("anthropic/claude-sonnet-4-6", "hosted")).toBe(
      "high"
    );
    expect(defaultReasoningEffort("openai/gpt-5", "hosted")).toBe("medium");
    expect(defaultReasoningEffort("openai/gpt-5.2", "hosted")).toBe("none");
    expect(defaultReasoningEffort("openai/o3", "hosted")).toBe("medium");
    expect(defaultReasoningEffort("google/gemini-3-pro-preview", "hosted")).toBe(
      "high"
    );
    expect(defaultReasoningEffort("gpt-5", "direct", "openai")).toBe("medium");
  });

  it("is undefined when unknown or the runtime is unresolved", () => {
    expect(defaultReasoningEffort("anthropic/claude-haiku-4-5", "hosted")).toBe(
      undefined
    );
    expect(defaultReasoningEffort("mistralai/mistral-large", "hosted")).toBe(
      undefined
    );
    expect(defaultReasoningEffort("openai/gpt-5", "org")).toBeUndefined();
    expect(defaultReasoningEffort("gpt-5", "direct")).toBeUndefined();
  });
});

describe("browser entry", () => {
  it("keeps the level tables off the public entries", () => {
    const record = browser as Record<string, unknown>;
    for (const name of [
      "OPENAI_REASONING_EFFORTS",
      "ANTHROPIC_REASONING_EFFORTS",
      "GOOGLE_REASONING_EFFORTS",
      "HARNESS_REASONING_EFFORTS",
    ]) {
      expect(record[name], name).toBeUndefined();
    }
  });

  it("exports the effort helpers", () => {
    expect(typeof browser.supportedReasoningEfforts).toBe("function");
    expect(typeof browser.reasoningEffortProviderOptions).toBe("function");
    expect(typeof browser.selectionConfigKey).toBe("function");
    expect(typeof browser.selectionIfMatches).toBe("function");
    expect(typeof browser.comparisonKey).toBe("function");
    expect(typeof browser.isDefaultSelection).toBe("function");
    expect(typeof browser.selectionDistinguishers).toBe("function");
    expect(typeof browser.defaultReasoningEffort).toBe("function");
  });
});
