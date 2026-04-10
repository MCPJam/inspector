import { describe, expect, it } from "vitest";
import {
  getModelById,
  isMCPJamGuestAllowedModel,
  isMCPJamProvidedModel,
  isMCPJamSignInRequiredModel,
} from "../types.js";

describe("MCPJam-provided model classification", () => {
  it("treats openai/gpt-4o-mini as MCPJam-provided", () => {
    expect(isMCPJamProvidedModel("openai/gpt-4o-mini")).toBe(true);
  });

  it("marks newly added hosted models as sign-in required", () => {
    expect(isMCPJamSignInRequiredModel("openai/gpt-5.4")).toBe(true);
    expect(isMCPJamSignInRequiredModel("qwen/qwen3.6-plus")).toBe(true);
    expect(isMCPJamSignInRequiredModel("openai/gpt-oss-120b")).toBe(true);
    expect(isMCPJamSignInRequiredModel("anthropic/claude-haiku-4.5")).toBe(
      false,
    );
  });

  it("keeps claude-haiku-4.5 as the only guest-allowed MCPJam model", () => {
    expect(isMCPJamGuestAllowedModel("anthropic/claude-haiku-4.5")).toBe(true);
    expect(isMCPJamGuestAllowedModel("openai/gpt-oss-120b")).toBe(false);
  });

  it("resolves provider metadata for new qwen and xAI hosted models", () => {
    expect(getModelById("qwen/qwen3.6-plus")?.provider).toBe("qwen");
    expect(getModelById("x-ai/grok-4-fast")?.provider).toBe("xai");
  });
});
