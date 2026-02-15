import { describe, it, expect, vi } from "vitest";

// Mock all SDK dependencies that chat-helpers.ts imports
vi.mock("@ai-sdk/anthropic", () => ({ createAnthropic: vi.fn() }));
vi.mock("@ai-sdk/azure", () => ({ createAzure: vi.fn() }));
vi.mock("@ai-sdk/deepseek", () => ({ createDeepSeek: vi.fn() }));
vi.mock("@ai-sdk/google", () => ({ createGoogleGenerativeAI: vi.fn() }));
vi.mock("@ai-sdk/mistral", () => ({ createMistral: vi.fn() }));
vi.mock("@ai-sdk/openai", () => ({ createOpenAI: vi.fn() }));
vi.mock("@ai-sdk/xai", () => ({ createXai: vi.fn() }));
vi.mock("@openrouter/ai-sdk-provider", () => ({ createOpenRouter: vi.fn() }));
vi.mock("ollama-ai-provider-v2", () => ({ createOllama: vi.fn() }));
vi.mock("@mcpjam/sdk", () => ({
  isChatGPTAppTool: vi.fn(),
  isMcpAppTool: vi.fn(),
  scrubMetaFromToolResult: vi.fn(),
  scrubMetaAndStructuredContentFromToolResult: vi.fn(),
}));

import {
  isAnthropicCompatibleModel,
  getInvalidAnthropicToolNames,
} from "../chat-helpers";

describe("isAnthropicCompatibleModel", () => {
  it("returns true for provider 'anthropic'", () => {
    expect(
      isAnthropicCompatibleModel({
        id: "claude-sonnet-4-0",
        name: "Claude Sonnet 4",
        provider: "anthropic",
      }),
    ).toBe(true);
  });

  it("returns false for non-anthropic providers", () => {
    for (const provider of [
      "openai",
      "google",
      "deepseek",
      "mistral",
      "xai",
      "ollama",
      "openrouter",
      "azure",
    ] as const) {
      expect(
        isAnthropicCompatibleModel({
          id: "some-model",
          name: "Some Model",
          provider,
        }),
      ).toBe(false);
    }
  });

  it("returns true for custom provider with anthropic-compatible protocol", () => {
    expect(
      isAnthropicCompatibleModel(
        {
          id: "custom:my-provider:my-model",
          name: "My Model",
          provider: "custom",
          customProviderName: "my-provider",
        },
        [
          {
            name: "my-provider",
            protocol: "anthropic-compatible",
            baseUrl: "https://example.com",
            modelIds: ["my-model"],
          },
        ],
      ),
    ).toBe(true);
  });

  it("returns false for custom provider with openai-compatible protocol", () => {
    expect(
      isAnthropicCompatibleModel(
        {
          id: "custom:my-provider:my-model",
          name: "My Model",
          provider: "custom",
          customProviderName: "my-provider",
        },
        [
          {
            name: "my-provider",
            protocol: "openai-compatible",
            baseUrl: "https://example.com",
            modelIds: ["my-model"],
          },
        ],
      ),
    ).toBe(false);
  });

  it("returns false when custom provider is not found", () => {
    expect(
      isAnthropicCompatibleModel(
        {
          id: "custom:missing:model",
          name: "Missing",
          provider: "custom",
          customProviderName: "missing",
        },
        [],
      ),
    ).toBe(false);
  });

  it("returns false when customProviderName is undefined", () => {
    expect(
      isAnthropicCompatibleModel({
        id: "custom:x:model",
        name: "X",
        provider: "custom",
      }),
    ).toBe(false);
  });

  it("returns false when customProviders is undefined", () => {
    expect(
      isAnthropicCompatibleModel({
        id: "custom:x:model",
        name: "X",
        provider: "custom",
        customProviderName: "x",
      }),
    ).toBe(false);
  });
});

describe("getInvalidAnthropicToolNames", () => {
  it("returns empty array when all names are valid", () => {
    expect(
      getInvalidAnthropicToolNames(["read_file", "list-items", "search123"]),
    ).toEqual([]);
  });

  it("flags names with dots", () => {
    expect(getInvalidAnthropicToolNames(["server.tool"])).toEqual([
      "server.tool",
    ]);
  });

  it("flags names with slashes", () => {
    expect(getInvalidAnthropicToolNames(["namespace/tool"])).toEqual([
      "namespace/tool",
    ]);
  });

  it("flags names with spaces", () => {
    expect(getInvalidAnthropicToolNames(["my tool"])).toEqual(["my tool"]);
  });

  it("flags names exceeding 64 characters", () => {
    const longName = "a".repeat(65);
    expect(getInvalidAnthropicToolNames([longName])).toEqual([longName]);
  });

  it("accepts names exactly 64 characters long", () => {
    expect(getInvalidAnthropicToolNames(["a".repeat(64)])).toEqual([]);
  });

  it("flags empty string", () => {
    expect(getInvalidAnthropicToolNames([""])).toEqual([""]);
  });

  it("returns only the invalid names from a mixed list", () => {
    const result = getInvalidAnthropicToolNames([
      "valid_name",
      "bad.name",
      "another-valid",
      "also/bad",
    ]);
    expect(result).toEqual(["bad.name", "also/bad"]);
  });

  it("returns empty array for empty input", () => {
    expect(getInvalidAnthropicToolNames([])).toEqual([]);
  });
});
