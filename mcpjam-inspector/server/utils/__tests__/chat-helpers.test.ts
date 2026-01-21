import { describe, it, expect, vi } from "vitest";
import { createLlmModel, type BaseUrls } from "../chat-helpers";

// Mock the SDK's createModel to avoid actual API calls
vi.mock("@/sdk/evals", () => ({
  createModel: vi.fn((modelDef, apiKey, baseUrls) => {
    // Return a mock model that captures the input for verification
    return {
      __mock: true,
      modelId: modelDef.id,
      provider: modelDef.provider,
      apiKey,
      baseUrls,
    };
  }),
}));

describe("chat-helpers", () => {
  describe("createLlmModel re-export", () => {
    it("re-exports createModel from SDK as createLlmModel", () => {
      // Verify the function is exported and callable
      expect(typeof createLlmModel).toBe("function");
    });

    it("passes model definition to SDK createModel", () => {
      const modelDef = { id: "gpt-4o", provider: "openai" as const };
      const apiKey = "test-api-key";

      const result = createLlmModel(modelDef, apiKey) as any;

      expect(result.__mock).toBe(true);
      expect(result.modelId).toBe("gpt-4o");
      expect(result.provider).toBe("openai");
      expect(result.apiKey).toBe("test-api-key");
    });

    it("passes baseUrls to SDK createModel", () => {
      const modelDef = {
        id: "claude-3-opus-20240229",
        provider: "anthropic" as const,
      };
      const apiKey = "test-api-key";
      const baseUrls: BaseUrls = {
        anthropic: "https://custom-anthropic.example.com",
      };

      const result = createLlmModel(modelDef, apiKey, baseUrls) as any;

      expect(result.baseUrls).toEqual(baseUrls);
    });

    it("works with extended ModelDefinition from shared types", () => {
      // The server uses ModelDefinition from @/shared/types which has additional fields
      // This test verifies that the extended type is compatible with SDK's simpler type
      const extendedModelDef = {
        id: "gpt-4o",
        name: "GPT-4o", // Extra field from shared's ModelDefinition
        provider: "openai" as const,
        description: "OpenAI's GPT-4o model", // Another extra field
      };
      const apiKey = "test-api-key";

      // Should not throw - TypeScript structural typing allows this
      const result = createLlmModel(extendedModelDef, apiKey) as any;

      expect(result.modelId).toBe("gpt-4o");
      expect(result.provider).toBe("openai");
    });

    it("supports all provider types", () => {
      const providers = [
        "anthropic",
        "openai",
        "deepseek",
        "google",
        "ollama",
        "mistral",
        "litellm",
        "openrouter",
        "xai",
        "azure",
      ] as const;

      for (const provider of providers) {
        const modelDef = { id: `test-model-${provider}`, provider };
        const result = createLlmModel(modelDef, "api-key") as any;

        expect(result.provider).toBe(provider);
      }
    });
  });

  describe("BaseUrls type re-export", () => {
    it("exports BaseUrls type with correct structure", () => {
      // TypeScript compile-time check - this test verifies the type is exported
      const baseUrls: BaseUrls = {
        ollama: "http://localhost:11434/api",
        litellm: "http://localhost:4000",
        azure: "https://my-azure.openai.azure.com",
        anthropic: "https://custom.anthropic.com",
        openai: "https://custom.openai.com",
      };

      // All fields should be optional
      const minimalBaseUrls: BaseUrls = {};
      const partialBaseUrls: BaseUrls = {
        ollama: "http://localhost:11434/api",
      };

      expect(baseUrls.ollama).toBe("http://localhost:11434/api");
      expect(minimalBaseUrls).toEqual({});
      expect(partialBaseUrls.ollama).toBe("http://localhost:11434/api");
    });
  });
});
