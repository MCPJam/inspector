import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { useChatSession } from "../use-chat-session";

const mockGetToolsMetadata = vi.fn();
const mockCountTextTokens = vi.fn();
const mockSetMessages = vi.fn();
const mockSendMessage = vi.fn();
const mockStop = vi.fn();
const mockAddToolApprovalResponse = vi.fn();

const baseModel = {
  id: "gpt-4",
  name: "GPT-4",
  provider: "openai" as const,
};

vi.mock("@/lib/config", () => ({
  HOSTED_MODE: false,
}));

vi.mock("@/components/chat-v2/shared/model-helpers", () => ({
  buildAvailableModels: vi.fn(() => [baseModel]),
  getDefaultModel: vi.fn(() => baseModel),
}));

vi.mock("@/hooks/use-ai-provider-keys", () => ({
  useAiProviderKeys: () => ({
    hasToken: vi.fn(() => false),
    getToken: vi.fn(() => ""),
    getOpenRouterSelectedModels: vi.fn(() => []),
    getOllamaBaseUrl: vi.fn(() => "http://127.0.0.1:11434"),
    getAzureBaseUrl: vi.fn(() => ""),
  }),
}));

vi.mock("@/hooks/use-custom-providers", () => ({
  useCustomProviders: () => ({
    customProviders: [],
    getCustomProviderByName: vi.fn(),
  }),
}));

vi.mock("@/hooks/use-persisted-model", () => ({
  usePersistedModel: () => ({
    selectedModelId: "gpt-4",
    setSelectedModelId: vi.fn(),
  }),
}));

vi.mock("@/lib/ollama-utils", () => ({
  detectOllamaModels: vi.fn(async () => ({
    isRunning: false,
    availableModels: [],
  })),
  detectOllamaToolCapableModels: vi.fn(async () => []),
}));

vi.mock("@/lib/apis/mcp-tools-api", () => ({
  getToolsMetadata: (...args: unknown[]) => mockGetToolsMetadata(...args),
}));

vi.mock("@/lib/apis/mcp-tokenizer-api", () => ({
  countTextTokens: (...args: unknown[]) => mockCountTextTokens(...args),
}));

vi.mock("@/lib/session-token", () => ({
  getAuthHeaders: vi.fn(() => ({})),
}));

vi.mock("@workos-inc/authkit-react", () => ({
  useAuth: () => ({
    getAccessToken: vi.fn(async () => null),
  }),
}));

vi.mock("convex/react", () => ({
  useConvexAuth: () => ({
    isAuthenticated: true,
    isLoading: false,
  }),
}));

vi.mock("@ai-sdk/react", () => ({
  useChat: vi.fn(() => ({
    messages: [],
    sendMessage: mockSendMessage,
    stop: mockStop,
    status: "ready",
    error: undefined,
    setMessages: mockSetMessages,
    addToolApprovalResponse: mockAddToolApprovalResponse,
  })),
}));

vi.mock("ai", () => ({
  DefaultChatTransport: class MockTransport {
    constructor(_: unknown) {}
  },
  generateId: vi.fn(() => "chat-session-id"),
  lastAssistantMessageIsCompleteWithApprovalResponses: vi.fn(),
}));

describe("useChatSession minimal mode parity", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetToolsMetadata.mockResolvedValue({
      metadata: { create_view: { title: "Create view" } },
      toolServerMap: { create_view: "server-1" },
      tokenCounts: { "server-1": 17 },
    });
    mockCountTextTokens.mockResolvedValue(123);
  });

  it("still prefetches tools metadata when minimalMode is true", async () => {
    renderHook(() =>
      useChatSession({
        selectedServers: ["server-1"],
        minimalMode: true,
        initialSystemPrompt: "You are a helpful assistant.",
      }),
    );

    await waitFor(() => {
      expect(mockGetToolsMetadata).toHaveBeenCalled();
    });
    expect(mockGetToolsMetadata).toHaveBeenCalledWith(
      ["server-1"],
      "openai/gpt-4",
    );
  });

  it("still counts system prompt tokens when minimalMode is true", async () => {
    renderHook(() =>
      useChatSession({
        selectedServers: ["server-1"],
        minimalMode: true,
        initialSystemPrompt: "Custom prompt",
      }),
    );

    await waitFor(() => {
      expect(mockCountTextTokens).toHaveBeenCalledWith(
        "Custom prompt",
        "openai/gpt-4",
      );
    });
  });

  it("soft-fails shared metadata auth denial without noisy warning", async () => {
    mockGetToolsMetadata.mockRejectedValue({
      status: 403,
      message: "Forbidden",
    });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const { result } = renderHook(() =>
      useChatSession({
        selectedServers: ["server-1"],
        minimalMode: true,
        hostedShareToken: "share-token",
        initialSystemPrompt: "Prompt",
      }),
    );

    await waitFor(() => {
      expect(mockGetToolsMetadata).toHaveBeenCalled();
    });
    await waitFor(() => {
      expect(result.current.mcpToolsTokenCountLoading).toBe(false);
    });

    expect(result.current.toolsMetadata).toEqual({});
    expect(result.current.toolServerMap).toEqual({});
    expect(result.current.mcpToolsTokenCount).toBeNull();
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});
