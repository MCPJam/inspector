import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAvailableEvalModels } from "../use-available-eval-models";

const {
  mockBuildAvailableModels,
  mockDetectOllamaModels,
  mockDetectOllamaToolCapableModels,
} = vi.hoisted(() => ({
  mockBuildAvailableModels: vi.fn(),
  mockDetectOllamaModels: vi.fn(),
  mockDetectOllamaToolCapableModels: vi.fn(),
}));

vi.mock("@/hooks/use-ai-provider-keys", () => ({
  useAiProviderKeys: () => ({
    hasToken: vi.fn().mockReturnValue(true),
    getOpenRouterSelectedModels: vi.fn().mockReturnValue(["openrouter/model"]),
    getOllamaBaseUrl: vi.fn().mockReturnValue("http://127.0.0.1:11434/api"),
    getAzureBaseUrl: vi.fn().mockReturnValue(""),
  }),
}));

vi.mock("@/hooks/use-custom-providers", () => ({
  useCustomProviders: () => ({
    customProviders: [],
  }),
}));

vi.mock("@/lib/ollama-utils", () => ({
  detectOllamaModels: (...args: unknown[]) => mockDetectOllamaModels(...args),
  detectOllamaToolCapableModels: (...args: unknown[]) =>
    mockDetectOllamaToolCapableModels(...args),
}));

vi.mock("@/components/chat-v2/shared/model-helpers", () => ({
  buildAvailableModels: (...args: unknown[]) =>
    mockBuildAvailableModels(...args),
}));

describe("useAvailableEvalModels", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDetectOllamaModels.mockResolvedValue({
      isRunning: true,
      availableModels: ["llama3.2"],
    });
    mockDetectOllamaToolCapableModels.mockResolvedValue(["llama3.2"]);
    mockBuildAvailableModels.mockReturnValue([
      {
        id: "openai/gpt-5-mini",
        name: "GPT-5 mini",
        provider: "openai",
      },
    ]);
  });

  it("builds eval models without instantiating chat state", async () => {
    const { result } = renderHook(() => useAvailableEvalModels());

    await waitFor(() => {
      expect(result.current.availableModels).toEqual([
        {
          id: "openai/gpt-5-mini",
          name: "GPT-5 mini",
          provider: "openai",
        },
      ]);
    });

    expect(mockDetectOllamaModels).toHaveBeenCalledWith(
      "http://127.0.0.1:11434/api",
    );
    expect(mockDetectOllamaToolCapableModels).toHaveBeenCalledWith(
      "http://127.0.0.1:11434/api",
    );
    expect(mockBuildAvailableModels).toHaveBeenCalledWith(
      expect.objectContaining({
        isOllamaRunning: true,
        ollamaModels: [
          {
            id: "llama3.2",
            name: "llama3.2",
            provider: "ollama",
            disabled: false,
            disabledReason: undefined,
          },
        ],
      }),
    );
  });
});
