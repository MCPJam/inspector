import { describe, expect, it } from "vitest";
import { isMCPJamProvidedModel } from "../types.js";

describe("MCPJam-provided model classification", () => {
  it("treats openai/gpt-4o-mini as MCPJam-provided", () => {
    expect(isMCPJamProvidedModel("openai/gpt-4o-mini")).toBe(true);
  });
});
