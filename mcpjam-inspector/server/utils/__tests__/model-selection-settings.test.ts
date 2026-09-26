import { describe, expect, it } from "vitest";
import type { ModelSelection } from "@mcpjam/sdk";
import {
  reasoningEffortProviderOptions,
  resolveEffectiveModelSettings,
} from "../model-selection-settings.js";

const OPENAI_GPT5 = { id: "gpt-5", provider: "openai" as const };
const OPENAI_GPT4O = { id: "gpt-4o", provider: "openai" as const };

function localSelection(
  settings: ModelSelection["settings"],
  modelId = "openai/gpt-4o",
): ModelSelection {
  return {
    modelId,
    source: "local",
    connectionRef: { kind: "localProvider", providerKey: "openai" },
    ...(settings ? { settings } : {}),
    fallback: { provider: "none", model: "none" },
  };
}

describe("resolveEffectiveModelSettings: precedence", () => {
  it("per-run override > saved selection > host default", () => {
    const all = resolveEffectiveModelSettings({
      route: "direct",
      modelDefinition: OPENAI_GPT4O,
      override: { temperature: 0.5 },
      selection: localSelection({ temperature: 0.2 }),
      host: { temperature: 0.7 },
    });
    expect(all).toMatchObject({
      ok: true,
      settings: { temperature: 0.5 },
      sources: { temperature: "override" },
    });

    const noOverride = resolveEffectiveModelSettings({
      route: "direct",
      modelDefinition: OPENAI_GPT4O,
      selection: localSelection({ temperature: 0.2 }),
      host: { temperature: 0.7 },
    });
    expect(noOverride).toMatchObject({
      ok: true,
      settings: { temperature: 0.2 },
      sources: { temperature: "selection" },
    });

    const hostOnly = resolveEffectiveModelSettings({
      route: "direct",
      modelDefinition: OPENAI_GPT4O,
      selection: localSelection(undefined),
      host: { temperature: 0.7 },
    });
    expect(hostOnly).toMatchObject({
      ok: true,
      settings: { temperature: 0.7 },
      sources: { temperature: "host" },
    });
  });

  it("a saved temperature of 0 is a value, not an absence", () => {
    const result = resolveEffectiveModelSettings({
      route: "hosted",
      modelDefinition: OPENAI_GPT4O,
      selection: localSelection({ temperature: 0 }),
      host: { temperature: 0.7 },
    });
    expect(result).toMatchObject({ ok: true, settings: { temperature: 0 } });
  });

  it("nothing set anywhere resolves to no settings", () => {
    expect(
      resolveEffectiveModelSettings({
        route: "direct",
        modelDefinition: OPENAI_GPT4O,
      }),
    ).toEqual({ ok: true, settings: {}, sources: {} });
  });
});

describe("resolveEffectiveModelSettings: reasoning effort", () => {
  it("direct: becomes provider options; a host default temperature yields", () => {
    const result = resolveEffectiveModelSettings({
      route: "direct",
      modelDefinition: OPENAI_GPT5,
      selection: localSelection({ reasoningEffort: "high" }, "openai/gpt-5"),
      host: { temperature: 0.7 },
    });
    expect(result).toEqual({
      ok: true,
      settings: { reasoningEffort: "high" },
      sources: { reasoningEffort: "selection" },
      providerOptions: { openai: { reasoningEffort: "high" } },
    });
  });

  it("direct: refused for a model without an effort control", () => {
    const result = resolveEffectiveModelSettings({
      route: "direct",
      modelDefinition: OPENAI_GPT4O,
      selection: localSelection({ reasoningEffort: "high" }),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refusal.code).toBe("capability_missing");
    expect(result.refusal.reason).toContain("reasoning effort");
  });

  it("orgCloud: refused (the backend route does not apply one)", () => {
    const result = resolveEffectiveModelSettings({
      route: "orgCloud",
      modelDefinition: OPENAI_GPT5,
      selection: localSelection({ reasoningEffort: "low" }, "openai/gpt-5"),
    });
    expect(result).toMatchObject({
      ok: false,
      refusal: { code: "capability_missing" },
    });
  });

  it("hosted: kept for the backend to apply, no provider options", () => {
    const result = resolveEffectiveModelSettings({
      route: "hosted",
      modelDefinition: OPENAI_GPT5,
      selection: localSelection({ reasoningEffort: "low" }, "openai/gpt-5"),
    });
    expect(result).toEqual({
      ok: true,
      settings: { reasoningEffort: "low" },
      sources: { reasoningEffort: "selection" },
    });
  });

  it("an explicit temperature with an effort is refused, not silently dropped", () => {
    const fromSelection = resolveEffectiveModelSettings({
      route: "direct",
      modelDefinition: OPENAI_GPT5,
      selection: localSelection(
        { reasoningEffort: "high", temperature: 0.2 },
        "openai/gpt-5",
      ),
    });
    expect(fromSelection).toMatchObject({
      ok: false,
      refusal: { code: "capability_missing" },
    });
    const fromOverride = resolveEffectiveModelSettings({
      route: "hosted",
      modelDefinition: OPENAI_GPT5,
      override: { temperature: 0.3 },
      selection: localSelection({ reasoningEffort: "high" }, "openai/gpt-5"),
    });
    expect(fromOverride.ok).toBe(false);
  });
});

describe("reasoningEffortProviderOptions", () => {
  it("maps each provider's own control", () => {
    expect(
      reasoningEffortProviderOptions({
        providerKey: "anthropic",
        modelId: "anthropic/claude-sonnet-4.5",
        effort: "medium",
      }),
    ).toEqual({
      anthropic: { effort: "medium", thinking: { type: "adaptive" } },
    });
    expect(
      reasoningEffortProviderOptions({
        providerKey: "anthropic",
        modelId: "claude-opus-4-5",
        effort: "max",
      }),
    ).toEqual({ anthropic: { effort: "max" } });
    expect(
      reasoningEffortProviderOptions({
        providerKey: "google",
        modelId: "google/gemini-3-pro",
        effort: "low",
      }),
    ).toEqual({ google: { thinkingConfig: { thinkingLevel: "low" } } });
  });

  it("returns undefined where there is no control to set", () => {
    for (const args of [
      { providerKey: "openai", modelId: "gpt-4o", effort: "high" as const },
      { providerKey: "openai", modelId: "gpt-5", effort: "max" as const },
      {
        providerKey: "google",
        modelId: "gemini-2.5-pro",
        effort: "low" as const,
      },
      { providerKey: "ollama", modelId: "llama3", effort: "low" as const },
      {
        providerKey: "openrouter",
        modelId: "openai/gpt-5",
        effort: "low" as const,
      },
    ]) {
      expect(reasoningEffortProviderOptions(args)).toBeUndefined();
    }
  });
});
