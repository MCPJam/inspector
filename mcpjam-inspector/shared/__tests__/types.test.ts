import { describe, expect, it } from "vitest";
import { isGuestAllowedModel, isMCPJamProvidedModel } from "../types.js";

describe("MCPJam-provided model classification", () => {
  it("treats openai/gpt-4o-mini as MCPJam-provided", () => {
    expect(isMCPJamProvidedModel("openai/gpt-4o-mini")).toBe(true);
  });

  it("does not expose openai/gpt-4o-mini as guest-allowed", () => {
    expect(isGuestAllowedModel("openai/gpt-4o-mini")).toBe(false);
  });
});
