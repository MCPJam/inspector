import { describe, expect, it } from "vitest";
import {
  ANTHROPIC_REASONING_EFFORTS,
  HARNESS_REASONING_EFFORTS,
  MODEL_REASONING_EFFORTS,
  reasoningEffortProviderOptions,
  selectionConfigKey,
  selectionIfMatches,
  selectionKey,
  supportedReasoningEfforts,
  type ModelSelection,
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
    expect(efforts("openai", "gpt-5")).toEqual([
      "none",
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
    ]);
    expect(efforts("openai", "openai/o3-mini", "org")).toContain("high");
    expect(efforts("openai", "gpt-4o")).toEqual([]);
    expect(efforts("anthropic", "claude-sonnet-4-5")).toEqual([
      ...ANTHROPIC_REASONING_EFFORTS,
    ]);
    expect(efforts("google", "gemini-3-pro")).toEqual([
      "minimal",
      "low",
      "medium",
      "high",
    ]);
    expect(efforts("google", "gemini-2.5-pro")).toEqual([]);
    expect(efforts("ollama", "llama3")).toEqual([]);
  });

  it("org-cloud has none until the backend applies an effort there", () => {
    expect(
      supportedReasoningEfforts({
        route: "orgCloud",
        providerKey: "anthropic",
        modelId: "claude-sonnet-4-5",
      })
    ).toEqual([]);
  });

  it("a harness uses its adapter table, which is empty until verified", () => {
    for (const harness of ["claude-code", "codex", "cursor"] as const) {
      expect(HARNESS_REASONING_EFFORTS[harness]).toEqual([]);
      expect(
        supportedReasoningEfforts({
          route: "hosted",
          providerKey: "openai",
          modelId: "openai/gpt-5",
          catalogEfforts: ["high"],
          harness,
        })
      ).toEqual([]);
    }
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
        modelId: "claude-sonnet-4-5",
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
        modelId: "gemini-3-pro",
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

describe("browser entry", () => {
  it("exports the effort helpers", () => {
    expect(typeof browser.supportedReasoningEfforts).toBe("function");
    expect(typeof browser.reasoningEffortProviderOptions).toBe("function");
    expect(typeof browser.selectionConfigKey).toBe("function");
    expect(typeof browser.selectionIfMatches).toBe("function");
  });
});
