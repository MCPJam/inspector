import { describe, it, expect, vi } from "vitest";
import {
  parseModelString,
  createModel,
  createModelFromString,
  type ModelDefinition,
  type ModelProvider,
} from "./model-factory.js";

// Mock all AI SDK providers to avoid requiring actual API keys
vi.mock("@ai-sdk/anthropic", () => ({
  createAnthropic: vi.fn(() => (modelId: string) => ({
    provider: "anthropic",
    modelId,
  })),
}));

vi.mock("@ai-sdk/openai", () => ({
  createOpenAI: vi.fn(() => {
    const factory = (modelId: string) => ({ provider: "openai", modelId });
    factory.chat = (modelId: string) => ({ provider: "openai-chat", modelId });
    return factory;
  }),
}));

vi.mock("@ai-sdk/azure", () => ({
  createAzure: vi.fn(() => (modelId: string) => ({
    provider: "azure",
    modelId,
  })),
}));

vi.mock("@ai-sdk/deepseek", () => ({
  createDeepSeek: vi.fn(() => (modelId: string) => ({
    provider: "deepseek",
    modelId,
  })),
}));

vi.mock("@ai-sdk/google", () => ({
  createGoogleGenerativeAI: vi.fn(() => (modelId: string) => ({
    provider: "google",
    modelId,
  })),
}));

vi.mock("@ai-sdk/mistral", () => ({
  createMistral: vi.fn(() => (modelId: string) => ({
    provider: "mistral",
    modelId,
  })),
}));

vi.mock("@ai-sdk/xai", () => ({
  createXai: vi.fn(() => (modelId: string) => ({ provider: "xai", modelId })),
}));

vi.mock("@openrouter/ai-sdk-provider", () => ({
  createOpenRouter: vi.fn(() => (modelId: string) => ({
    provider: "openrouter",
    modelId,
  })),
}));

vi.mock("ollama-ai-provider-v2", () => ({
  createOllama: vi.fn(() => (modelId: string) => ({
    provider: "ollama",
    modelId,
  })),
}));

describe("parseModelString", () => {
  describe("provider/model-id format", () => {
    it("parses openai/gpt-4o correctly", () => {
      const result = parseModelString("openai/gpt-4o");
      expect(result).toEqual({
        provider: "openai",
        id: "gpt-4o",
      });
    });

    it("parses anthropic/claude-3-opus-20240229 correctly", () => {
      const result = parseModelString("anthropic/claude-3-opus-20240229");
      expect(result).toEqual({
        provider: "anthropic",
        id: "claude-3-opus-20240229",
      });
    });

    it("parses google/gemini-2.0-flash correctly", () => {
      const result = parseModelString("google/gemini-2.0-flash");
      expect(result).toEqual({
        provider: "google",
        id: "gemini-2.0-flash",
      });
    });

    it("parses deepseek/deepseek-chat correctly", () => {
      const result = parseModelString("deepseek/deepseek-chat");
      expect(result).toEqual({
        provider: "deepseek",
        id: "deepseek-chat",
      });
    });

    it("parses xai/grok-3 correctly", () => {
      const result = parseModelString("xai/grok-3");
      expect(result).toEqual({
        provider: "xai",
        id: "grok-3",
      });
    });

    it("parses azure/gpt-4 correctly", () => {
      const result = parseModelString("azure/gpt-4");
      expect(result).toEqual({
        provider: "azure",
        id: "gpt-4",
      });
    });
  });

  describe("model-id only format (inferred provider)", () => {
    it("infers anthropic for claude models", () => {
      const result = parseModelString("claude-3-opus-20240229");
      expect(result.provider).toBe("anthropic");
      expect(result.id).toBe("claude-3-opus-20240229");
    });

    it("infers openai for gpt models", () => {
      const result = parseModelString("gpt-4-turbo");
      expect(result.provider).toBe("openai");
      expect(result.id).toBe("gpt-4-turbo");
    });

    it("infers openai for o1 models", () => {
      const result = parseModelString("o1-preview");
      expect(result.provider).toBe("openai");
      expect(result.id).toBe("o1-preview");
    });

    it("infers openai for o3 models", () => {
      const result = parseModelString("o3-mini");
      expect(result.provider).toBe("openai");
      expect(result.id).toBe("o3-mini");
    });

    it("infers google for gemini models", () => {
      const result = parseModelString("gemini-2.0-flash-exp");
      expect(result.provider).toBe("google");
      expect(result.id).toBe("gemini-2.0-flash-exp");
    });

    it("infers google for gemma models", () => {
      const result = parseModelString("gemma-3-27b");
      expect(result.provider).toBe("google");
      expect(result.id).toBe("gemma-3-27b");
    });

    it("infers deepseek for deepseek models", () => {
      const result = parseModelString("deepseek-reasoner");
      expect(result.provider).toBe("deepseek");
      expect(result.id).toBe("deepseek-reasoner");
    });

    it("infers mistral for mistral models", () => {
      const result = parseModelString("mistral-large-latest");
      expect(result.provider).toBe("mistral");
      expect(result.id).toBe("mistral-large-latest");
    });

    it("infers mistral for codestral models", () => {
      const result = parseModelString("codestral-latest");
      expect(result.provider).toBe("mistral");
      expect(result.id).toBe("codestral-latest");
    });

    it("infers xai for grok models", () => {
      const result = parseModelString("grok-3-mini");
      expect(result.provider).toBe("xai");
      expect(result.id).toBe("grok-3-mini");
    });

    it("infers ollama for llama models", () => {
      const result = parseModelString("llama-3.3-70b");
      expect(result.provider).toBe("ollama");
      expect(result.id).toBe("llama-3.3-70b");
    });

    it("infers ollama for qwen models", () => {
      const result = parseModelString("qwen-2.5-72b");
      expect(result.provider).toBe("ollama");
      expect(result.id).toBe("qwen-2.5-72b");
    });

    it("defaults to openai for unknown models", () => {
      const result = parseModelString("some-unknown-model");
      expect(result.provider).toBe("openai");
      expect(result.id).toBe("some-unknown-model");
    });
  });

  describe("edge cases", () => {
    it("handles model IDs with hyphens", () => {
      const result = parseModelString("openai/gpt-4-turbo-2024-04-09");
      expect(result).toEqual({
        provider: "openai",
        id: "gpt-4-turbo-2024-04-09",
      });
    });

    it("handles model IDs with dots", () => {
      const result = parseModelString("google/gemini-2.5-pro");
      expect(result).toEqual({
        provider: "google",
        id: "gemini-2.5-pro",
      });
    });

    it("throws error for empty string", () => {
      expect(() => parseModelString("")).toThrow(
        'Invalid model format: . Expected "provider/model-id" or "model-id"',
      );
    });
  });

  describe("model IDs with slashes (OpenRouter)", () => {
    it("parses openrouter/meta/llama-3 correctly", () => {
      const result = parseModelString("openrouter/meta/llama-3");
      expect(result).toEqual({
        provider: "openrouter",
        id: "meta/llama-3",
      });
    });

    it("parses openrouter/anthropic/claude-3.5-sonnet correctly", () => {
      const result = parseModelString("openrouter/anthropic/claude-3.5-sonnet");
      expect(result).toEqual({
        provider: "openrouter",
        id: "anthropic/claude-3.5-sonnet",
      });
    });

    it("parses openrouter/google/gemini-2.0-flash-001 correctly", () => {
      const result = parseModelString("openrouter/google/gemini-2.0-flash-001");
      expect(result).toEqual({
        provider: "openrouter",
        id: "google/gemini-2.0-flash-001",
      });
    });

    it("parses model IDs with multiple slashes", () => {
      const result = parseModelString("openrouter/org/sub/model-name");
      expect(result).toEqual({
        provider: "openrouter",
        id: "org/sub/model-name",
      });
    });
  });
});

describe("createModel", () => {
  const testApiKey = "test-api-key";

  describe("provider routing", () => {
    it("creates anthropic model", () => {
      const result = createModel(
        { provider: "anthropic", id: "claude-3-opus" },
        testApiKey,
      );
      expect(result).toEqual({
        provider: "anthropic",
        modelId: "claude-3-opus",
      });
    });

    it("creates openai model", () => {
      const result = createModel(
        { provider: "openai", id: "gpt-4o" },
        testApiKey,
      );
      expect(result).toEqual({ provider: "openai", modelId: "gpt-4o" });
    });

    it("creates azure model", () => {
      const result = createModel(
        { provider: "azure", id: "gpt-4" },
        testApiKey,
      );
      expect(result).toEqual({ provider: "azure", modelId: "gpt-4" });
    });

    it("creates deepseek model", () => {
      const result = createModel(
        { provider: "deepseek", id: "deepseek-chat" },
        testApiKey,
      );
      expect(result).toEqual({
        provider: "deepseek",
        modelId: "deepseek-chat",
      });
    });

    it("creates google model", () => {
      const result = createModel(
        { provider: "google", id: "gemini-pro" },
        testApiKey,
      );
      expect(result).toEqual({ provider: "google", modelId: "gemini-pro" });
    });

    it("creates ollama model", () => {
      const result = createModel(
        { provider: "ollama", id: "llama3" },
        testApiKey,
      );
      expect(result).toEqual({ provider: "ollama", modelId: "llama3" });
    });

    it("creates mistral model", () => {
      const result = createModel(
        { provider: "mistral", id: "mistral-large" },
        testApiKey,
      );
      expect(result).toEqual({ provider: "mistral", modelId: "mistral-large" });
    });

    it("creates litellm model (uses openai chat)", () => {
      const result = createModel(
        { provider: "litellm", id: "custom-model" },
        testApiKey,
      );
      expect(result).toEqual({
        provider: "openai-chat",
        modelId: "custom-model",
      });
    });

    it("creates openrouter model", () => {
      const result = createModel(
        { provider: "openrouter", id: "meta/llama-3" },
        testApiKey,
      );
      expect(result).toEqual({
        provider: "openrouter",
        modelId: "meta/llama-3",
      });
    });

    it("creates xai model", () => {
      const result = createModel({ provider: "xai", id: "grok-3" }, testApiKey);
      expect(result).toEqual({ provider: "xai", modelId: "grok-3" });
    });
  });

  describe("error handling", () => {
    it("throws error for invalid model definition (missing id)", () => {
      expect(() =>
        createModel(
          { provider: "openai", id: "" } as ModelDefinition,
          testApiKey,
        ),
      ).toThrow("Invalid model definition");
    });

    it("throws error for invalid model definition (missing provider)", () => {
      expect(() =>
        createModel({ provider: "" as ModelProvider, id: "gpt-4" }, testApiKey),
      ).toThrow("Invalid model definition");
    });

    it("throws error for null model definition", () => {
      expect(() =>
        createModel(null as unknown as ModelDefinition, testApiKey),
      ).toThrow("Invalid model definition");
    });

    it("throws error for undefined model definition", () => {
      expect(() =>
        createModel(undefined as unknown as ModelDefinition, testApiKey),
      ).toThrow("Invalid model definition");
    });

    it("throws error for unsupported provider", () => {
      expect(() =>
        createModel(
          { provider: "unknown-provider" as ModelProvider, id: "model" },
          testApiKey,
        ),
      ).toThrow("Unsupported provider: unknown-provider");
    });
  });
});

describe("createModelFromString", () => {
  const testApiKey = "test-api-key";

  it("creates model from provider/id format", () => {
    const result = createModelFromString("openai/gpt-4o", testApiKey);
    expect(result).toEqual({ provider: "openai", modelId: "gpt-4o" });
  });

  it("creates model from id-only format with inferred provider", () => {
    const result = createModelFromString("claude-3-opus", testApiKey);
    expect(result).toEqual({ provider: "anthropic", modelId: "claude-3-opus" });
  });

  it("creates model from gpt model with inferred provider", () => {
    const result = createModelFromString("gpt-4-turbo", testApiKey);
    expect(result).toEqual({ provider: "openai", modelId: "gpt-4-turbo" });
  });

  it("creates OpenRouter model with slash in model ID", () => {
    const result = createModelFromString("openrouter/meta/llama-3", testApiKey);
    expect(result).toEqual({ provider: "openrouter", modelId: "meta/llama-3" });
  });

  it("creates OpenRouter model with multiple slashes in model ID", () => {
    const result = createModelFromString(
      "openrouter/anthropic/claude-3.5-sonnet",
      testApiKey,
    );
    expect(result).toEqual({
      provider: "openrouter",
      modelId: "anthropic/claude-3.5-sonnet",
    });
  });
});
