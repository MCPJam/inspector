import { describe, it, expect } from "vitest";
import { getDefaultTemperatureByProvider } from "../chat-utils.js";

describe("getDefaultTemperatureByProvider", () => {
  describe("known providers", () => {
    it("returns 1.0 for OpenAI", () => {
      expect(getDefaultTemperatureByProvider("openai")).toBe(1.0);
    });

    it("returns 0 for Anthropic", () => {
      expect(getDefaultTemperatureByProvider("anthropic")).toBe(0);
    });

    it("returns 0.9 for Google", () => {
      expect(getDefaultTemperatureByProvider("google")).toBe(0.9);
    });

    it("returns 0.7 for Mistral", () => {
      expect(getDefaultTemperatureByProvider("mistral")).toBe(0.7);
    });
  });

  describe("unknown providers", () => {
    it("returns 0 for unknown provider", () => {
      expect(getDefaultTemperatureByProvider("unknown")).toBe(0);
    });

    it("returns 0 for empty string", () => {
      expect(getDefaultTemperatureByProvider("")).toBe(0);
    });

    it("returns 0 for custom providers", () => {
      expect(getDefaultTemperatureByProvider("custom-provider")).toBe(0);
      expect(getDefaultTemperatureByProvider("deepseek")).toBe(0);
      expect(getDefaultTemperatureByProvider("xai")).toBe(0);
    });
  });

  describe("case sensitivity", () => {
    it("is case sensitive", () => {
      expect(getDefaultTemperatureByProvider("OpenAI")).toBe(0); // not "openai"
      expect(getDefaultTemperatureByProvider("ANTHROPIC")).toBe(0); // not "anthropic"
    });
  });
});
