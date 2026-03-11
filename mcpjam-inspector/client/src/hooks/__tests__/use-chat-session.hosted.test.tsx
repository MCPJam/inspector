import { describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import { useChatSession } from "../use-chat-session";

const mockState = vi.hoisted(() => ({
  sendMessage: vi.fn(),
  stop: vi.fn(),
  setMessages: vi.fn(),
  addToolApprovalResponse: vi.fn(),
  getAccessToken: vi.fn(async () => "access-token"),
  hasToken: vi.fn(() => false),
  getToken: vi.fn(() => ""),
  getOpenRouterSelectedModels: vi.fn(() => []),
  getOllamaBaseUrl: vi.fn(() => "http://127.0.0.1:11434"),
  getAzureBaseUrl: vi.fn(() => ""),
  getCustomProviderByName: vi.fn(),
  setSelectedModelId: vi.fn(),
  useSharedChatWidgetCapture: vi.fn(),
  detectOllamaModels: vi.fn(async () => ({
    isRunning: false,
    availableModels: [],
  })),
  detectOllamaToolCapableModels: vi.fn(async () => []),
  getToolsMetadata: vi.fn(async () => ({
    metadata: {},
    toolServerMap: {},
    tokenCounts: null,
  })),
  countTextTokens: vi.fn(async () => null),
}));
let lastTransportOptions: any;

const baseModel = {
  id: "gpt-4.1-mini",
  name: "GPT-4.1 Mini",
  provider: "openai" as const,
};

vi.mock("@/lib/config", () => ({
  HOSTED_MODE: true,
}));

vi.mock("@/components/chat-v2/shared/model-helpers", () => ({
  buildAvailableModels: vi.fn(() => [baseModel]),
  getDefaultModel: vi.fn(() => baseModel),
}));

vi.mock("@/hooks/use-ai-provider-keys", () => ({
  useAiProviderKeys: () => ({
    hasToken: mockState.hasToken,
    getToken: mockState.getToken,
    getOpenRouterSelectedModels: mockState.getOpenRouterSelectedModels,
    getOllamaBaseUrl: mockState.getOllamaBaseUrl,
    getAzureBaseUrl: mockState.getAzureBaseUrl,
  }),
}));

vi.mock("@/hooks/use-custom-providers", () => ({
  useCustomProviders: () => ({
    customProviders: [],
    getCustomProviderByName: mockState.getCustomProviderByName,
  }),
}));

vi.mock("@/hooks/use-persisted-model", () => ({
  usePersistedModel: () => ({
    selectedModelId: "gpt-4.1-mini",
    setSelectedModelId: mockState.setSelectedModelId,
  }),
}));

vi.mock("@/hooks/useSharedChatWidgetCapture", () => ({
  useSharedChatWidgetCapture: mockState.useSharedChatWidgetCapture,
}));

vi.mock("@/lib/ollama-utils", () => ({
  detectOllamaModels: mockState.detectOllamaModels,
  detectOllamaToolCapableModels: mockState.detectOllamaToolCapableModels,
}));

vi.mock("@/lib/apis/mcp-tools-api", () => ({
  getToolsMetadata: mockState.getToolsMetadata,
}));

vi.mock("@/lib/apis/mcp-tokenizer-api", () => ({
  countTextTokens: mockState.countTextTokens,
}));

vi.mock("@/lib/session-token", () => ({
  authFetch: vi.fn(),
  getAuthHeaders: vi.fn(() => ({})),
}));

vi.mock("@workos-inc/authkit-react", () => ({
  useAuth: () => ({
    getAccessToken: mockState.getAccessToken,
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
    sendMessage: mockState.sendMessage,
    stop: mockState.stop,
    status: "ready",
    error: undefined,
    setMessages: mockState.setMessages,
    addToolApprovalResponse: mockState.addToolApprovalResponse,
  })),
}));

vi.mock("ai", () => ({
  DefaultChatTransport: class MockTransport {
    constructor(options: unknown) {
      lastTransportOptions = options;
    }
  },
  generateId: vi.fn(() => "chat-session-id"),
  lastAssistantMessageIsCompleteWithApprovalResponses: vi.fn(),
}));

describe("useChatSession hosted mode", () => {
  it("includes chatSessionId in the hosted transport body", async () => {
    const { result, unmount } = renderHook(() =>
      useChatSession({
        selectedServers: ["server-1"],
        hostedWorkspaceId: "workspace-1",
        hostedSelectedServerIds: ["server-id-1"],
        hostedShareToken: "share-token",
      }),
    );

    const body = lastTransportOptions.body();
    expect(result.current.chatSessionId).toBe("chat-session-id");
    expect(body).toMatchObject({
      workspaceId: "workspace-1",
      chatSessionId: "chat-session-id",
      selectedServerIds: ["server-id-1"],
      shareToken: "share-token",
      accessScope: "chat_v2",
    });
    unmount();
  });
});
