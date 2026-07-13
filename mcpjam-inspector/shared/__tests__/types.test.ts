import { describe, expect, it } from "vitest";
import {
  getCanonicalModelId,
  getModelById,
  isMCPJamGuestAllowedModel,
  isMCPJamProvidedModel,
} from "../types.js";

describe("MCPJam-provided model classification", () => {
  it("treats openai/gpt-4o-mini as MCPJam-provided", () => {
    expect(isMCPJamProvidedModel("openai/gpt-4o-mini")).toBe(true);
  });

  it("gates only the premium hosted models from guest access", () => {
    expect(isMCPJamGuestAllowedModel("anthropic/claude-haiku-4.5")).toBe(true);
    expect(isMCPJamProvidedModel("anthropic/claude-haiku-4.5")).toBe(true);
    expect(isMCPJamProvidedModel("openai/gpt-5.4")).toBe(true);
    expect(isMCPJamProvidedModel("openai/gpt-5.5")).toBe(true);
    expect(isMCPJamProvidedModel("openai/gpt-5.5-pro")).toBe(true);
    expect(isMCPJamProvidedModel("deepseek/deepseek-v4-pro")).toBe(true);
    expect(isMCPJamProvidedModel("deepseek/deepseek-v4-flash")).toBe(true);
    expect(isMCPJamProvidedModel("qwen/qwen3.6-plus")).toBe(true);
    expect(isMCPJamProvidedModel("mistralai/mistral-small-2603")).toBe(true);
    expect(isMCPJamProvidedModel("mistralai/mistral-medium-3-5")).toBe(true);
    expect(isMCPJamProvidedModel("mistralai/mistral-large-2512")).toBe(true);
    expect(isMCPJamProvidedModel("mistralai/devstral-2512")).toBe(true);
    expect(isMCPJamProvidedModel("z-ai/glm-5.2")).toBe(true);
    expect(isMCPJamGuestAllowedModel("openai/gpt-oss-120b")).toBe(true);
    expect(isMCPJamGuestAllowedModel("mistralai/mistral-small-2603")).toBe(
      true,
    );
    expect(isMCPJamGuestAllowedModel("mistralai/devstral-2512")).toBe(true);
    expect(isMCPJamGuestAllowedModel("mistralai/mistral-medium-3-5")).toBe(
      false,
    );
    expect(isMCPJamGuestAllowedModel("mistralai/mistral-large-2512")).toBe(
      false,
    );
    expect(isMCPJamGuestAllowedModel("openai/gpt-5.4")).toBe(false);
    expect(isMCPJamGuestAllowedModel("openai/gpt-5.4-mini")).toBe(false);
    expect(isMCPJamGuestAllowedModel("openai/gpt-5.4-nano")).toBe(false);
    expect(isMCPJamGuestAllowedModel("openai/gpt-5.4-pro")).toBe(false);
    expect(isMCPJamGuestAllowedModel("openai/gpt-5.5")).toBe(false);
    expect(isMCPJamGuestAllowedModel("openai/gpt-5.5-pro")).toBe(false);
    expect(isMCPJamGuestAllowedModel("deepseek/deepseek-v4-pro")).toBe(false);
    expect(isMCPJamGuestAllowedModel("deepseek/deepseek-v4-flash")).toBe(
      false,
    );
    expect(isMCPJamGuestAllowedModel("anthropic/claude-opus-4.6")).toBe(false);
    expect(isMCPJamGuestAllowedModel("anthropic/claude-opus-4.6-fast")).toBe(
      false,
    );
    expect(isMCPJamGuestAllowedModel("anthropic/claude-sonnet-4.6")).toBe(
      false,
    );
    expect(isMCPJamGuestAllowedModel("anthropic/claude-opus-4.7")).toBe(false);
    expect(isMCPJamGuestAllowedModel("google/gemini-3.1-pro-preview")).toBe(
      false,
    );
    expect(isMCPJamGuestAllowedModel("qwen/qwen3.6-plus")).toBe(true);
    expect(isMCPJamGuestAllowedModel("z-ai/glm-5.2")).toBe(true);
  });

  it("resolves provider metadata for new hosted models", () => {
    expect(getModelById("qwen/qwen3.6-plus")?.provider).toBe("qwen");
    expect(getModelById("x-ai/grok-4-fast")?.provider).toBe("xai");
    expect(getModelById("x-ai/grok-4.5")?.provider).toBe("xai");
    expect(getModelById("mistralai/mistral-small-2603")?.provider).toBe(
      "mistral",
    );
  });

  it("normalizes bare model ids with provider metadata", () => {
    expect(getCanonicalModelId("claude-haiku-4.5", "anthropic")).toBe(
      "anthropic/claude-haiku-4.5",
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
    expect(
      getCanonicalModelId("brand-new-model", "newvendor", catalog),
    ).toBe("newvendor/brand-new-model");
    // …and an exact catalog id passes through.
    expect(
      getCanonicalModelId("newvendor/brand-new-model", undefined, catalog),
    ).toBe("newvendor/brand-new-model");
    // Without the injected catalog, the unknown bare id can't be canonicalized.
    expect(getCanonicalModelId("brand-new-model", "newvendor")).toBe(
      "brand-new-model",
    );
  });

  it("resolves exact hosted IDs that are allowlisted in the backend", () => {
    expect(getModelById("google/gemini-3-pro-preview")).toBeUndefined();
    expect(getModelById("openai/gpt-4o-mini")?.provider).toBe("openai");
    expect(getModelById("openai/gpt-5.4-mini")?.provider).toBe("openai");
    expect(getModelById("openai/gpt-5.5")?.provider).toBe("openai");
    expect(getModelById("deepseek/deepseek-v4-pro")?.provider).toBe(
      "deepseek",
    );
    expect(getModelById("google/gemini-3.1-pro-preview")?.provider).toBe(
      "google",
    );
    expect(getModelById("z-ai/glm-4.6")?.provider).toBe("z-ai");
    expect(getModelById("z-ai/glm-5.2")?.contextLength).toBe(1000000);
    expect(getModelById("mistralai/devstral-2512")?.contextLength).toBe(
      262144,
    );
  });
});
