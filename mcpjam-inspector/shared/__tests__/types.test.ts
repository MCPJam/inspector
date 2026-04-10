import { describe, expect, it } from "vitest";
import {
  getModelById,
  isMCPJamGuestAllowedModel,
  isMCPJamProvidedModel,
} from "../types.js";

describe("MCPJam-provided model classification", () => {
  it("treats openai/gpt-4o-mini as MCPJam-provided", () => {
    expect(isMCPJamProvidedModel("openai/gpt-4o-mini")).toBe(true);
  });

  it("keeps claude-haiku-4.5 as the only guest-allowed MCPJam model", () => {
    expect(isMCPJamGuestAllowedModel("anthropic/claude-haiku-4.5")).toBe(true);
    expect(isMCPJamProvidedModel("anthropic/claude-haiku-4.5")).toBe(true);
    expect(isMCPJamProvidedModel("openai/gpt-5.4")).toBe(true);
    expect(isMCPJamProvidedModel("qwen/qwen3.6-plus")).toBe(true);
    expect(isMCPJamGuestAllowedModel("openai/gpt-oss-120b")).toBe(false);
    expect(isMCPJamGuestAllowedModel("openai/gpt-5.4")).toBe(false);
    expect(isMCPJamGuestAllowedModel("qwen/qwen3.6-plus")).toBe(false);
  });

  it("resolves provider metadata for new qwen and xAI hosted models", () => {
    expect(getModelById("qwen/qwen3.6-plus")?.provider).toBe("qwen");
    expect(getModelById("x-ai/grok-4-fast")?.provider).toBe("xai");
  });

  it("resolves exact hosted IDs that are allowlisted in the backend", () => {
    expect(getModelById("google/gemini-3-pro-preview")).toBeUndefined();
    expect(getModelById("openai/gpt-4o-mini")?.provider).toBe("openai");
    expect(getModelById("openai/gpt-5.4-mini")?.provider).toBe("openai");
    expect(getModelById("google/gemini-3.1-pro-preview")?.provider).toBe(
      "google",
    );
    expect(getModelById("z-ai/glm-4.6")?.provider).toBe("z-ai");
  });
});
