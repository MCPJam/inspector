import { describe, it, expect } from "vitest";
import {
  mapModelIdToTokenizerBackend,
  estimateTokensFromChars,
} from "../tokenizer-helpers.js";

describe("mapModelIdToTokenizerBackend", () => {
  describe("Anthropic models", () => {
    it("maps claude-opus-4-1 correctly", () => {
      expect(mapModelIdToTokenizerBackend("claude-opus-4-1")).toBe(
        "anthropic/claude-opus-4.1"
      );
    });

    it("maps claude-sonnet-4-5 correctly", () => {
      expect(mapModelIdToTokenizerBackend("claude-sonnet-4-5")).toBe(
        "anthropic/claude-sonnet-4.5"
      );
    });

    it("maps claude-3-5-sonnet-latest correctly", () => {
      expect(mapModelIdToTokenizerBackend("claude-3-5-sonnet-latest")).toBe(
        "anthropic/claude-3.5-sonnet"
      );
    });

    it("maps prefixed anthropic models", () => {
      expect(
        mapModelIdToTokenizerBackend("anthropic/claude-3-5-sonnet-latest")
      ).toBe("anthropic/claude-3.5-sonnet");
    });
  });

  describe("OpenAI models", () => {
    it("maps gpt-4o correctly", () => {
      expect(mapModelIdToTokenizerBackend("gpt-4o")).toBe("openai/gpt-4o");
    });

    it("maps gpt-4o-mini correctly", () => {
      expect(mapModelIdToTokenizerBackend("gpt-4o-mini")).toBe(
        "openai/gpt-4o-mini"
      );
    });

    it("maps gpt-5 variants correctly", () => {
      expect(mapModelIdToTokenizerBackend("gpt-5")).toBe("openai/gpt-5");
      expect(mapModelIdToTokenizerBackend("gpt-5-mini")).toBe(
        "openai/gpt-5-mini"
      );
    });
  });

  describe("DeepSeek models", () => {
    it("maps deepseek-chat correctly", () => {
      expect(mapModelIdToTokenizerBackend("deepseek-chat")).toBe(
        "deepseek/deepseek-v3.1"
      );
    });

    it("maps deepseek-reasoner correctly", () => {
      expect(mapModelIdToTokenizerBackend("deepseek-reasoner")).toBe(
        "deepseek/deepseek-r1"
      );
    });
  });

  describe("Google Gemini models", () => {
    it("maps gemini-2.5-pro correctly", () => {
      expect(mapModelIdToTokenizerBackend("gemini-2.5-pro")).toBe(
        "google/gemini-2.5-pro"
      );
    });

    it("maps gemini-2.5-flash correctly", () => {
      expect(mapModelIdToTokenizerBackend("gemini-2.5-flash")).toBe(
        "google/gemini-2.5-flash"
      );
    });
  });

  describe("xAI models", () => {
    it("maps grok-3 correctly", () => {
      expect(mapModelIdToTokenizerBackend("grok-3")).toBe("xai/grok-3");
    });

    it("normalizes x-ai prefix to xai", () => {
      expect(mapModelIdToTokenizerBackend("x-ai/grok-4-fast")).toBe(
        "xai/grok-4-fast-reasoning"
      );
    });
  });

  describe("Mistral models", () => {
    it("maps mistral-large-latest correctly", () => {
      expect(mapModelIdToTokenizerBackend("mistral-large-latest")).toBe(
        "mistral/mistral-large"
      );
    });

    it("maps codestral-latest correctly", () => {
      expect(mapModelIdToTokenizerBackend("codestral-latest")).toBe(
        "mistral/codestral"
      );
    });
  });

  describe("provider prefix normalization", () => {
    it("normalizes z-ai to zai", () => {
      expect(mapModelIdToTokenizerBackend("z-ai/glm-4.6")).toBe(
        "zai/glm-4.5"
      );
    });

    it("passes through already normalized prefixes", () => {
      const result = mapModelIdToTokenizerBackend("custom-provider/some-model");
      expect(result).toBe("custom-provider/some-model");
    });
  });

  describe("fallback behavior", () => {
    it("returns null for completely unknown models", () => {
      expect(mapModelIdToTokenizerBackend("unknown-model-xyz")).toBe(null);
    });
  });
});

describe("estimateTokensFromChars", () => {
  it("estimates 1 token per 4 characters", () => {
    expect(estimateTokensFromChars("1234")).toBe(1);
    expect(estimateTokensFromChars("12345678")).toBe(2);
  });

  it("rounds up for partial tokens", () => {
    expect(estimateTokensFromChars("12345")).toBe(2); // 5/4 = 1.25 -> 2
    expect(estimateTokensFromChars("123")).toBe(1); // 3/4 = 0.75 -> 1
  });

  it("handles empty string", () => {
    expect(estimateTokensFromChars("")).toBe(0);
  });

  it("handles long text", () => {
    const longText = "a".repeat(1000);
    expect(estimateTokensFromChars(longText)).toBe(250);
  });
});
