import { describe, expect, it } from "vitest";
import { isGuestAllowedModel, isMCPJamProvidedModel } from "../types.js";

describe("MCPJam-provided model classification", () => {
  it("treats openai/gpt-4o-mini as MCPJam-provided", () => {
    expect(isMCPJamProvidedModel("openai/gpt-4o-mini")).toBe(true);
  });

  it("matches the backend guest-allowed free model set", () => {
    expect(isGuestAllowedModel("openai/gpt-oss-120b")).toBe(true);
    expect(isGuestAllowedModel("openai/gpt-5-nano")).toBe(true);
    expect(isGuestAllowedModel("openai/gpt-4o-mini")).toBe(false);
  });
});
