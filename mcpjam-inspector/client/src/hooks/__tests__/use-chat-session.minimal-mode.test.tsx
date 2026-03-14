import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { useChatSession } from "../use-chat-session";

const mockGetToolsMetadata = vi.fn();
const mockCountTextTokens = vi.fn();
const mockSetMessages = vi.fn();
const mockStop = vi.fn();
const mockAddToolApprovalResponse = vi.fn();
const mockAuthFetch = vi.fn();
const mockGetSessionAuthHeaders = vi.fn(() => ({}));
const mockGetAccessToken = vi.fn(async () => null);
const mockTransportInstances: Array<{
  options: any;
  sendMessages: ReturnType<typeof vi.fn>;
}> = [];

const baseModel = {
  id: "gpt-4",
  name: "GPT-4",
  provider: "openai" as const,
};
const mcpJamModel = {
  id: "openai/gpt-5-mini",
  name: "GPT-5 Mini",
  provider: "openai" as const,
};
const nonGuestMcpJamModel = {
  id: "openai/gpt-oss-120b",
  name: "GPT OSS 120B",
  provider: "openai" as const,
};
const mockModelState = {
  availableModels: [baseModel],
  selectedModelId: "gpt-4",
};

async function resolveConfig<T>(value: T | (() => T | Promise<T>)) {
  return typeof value === "function"
    ? await (value as () => T | Promise<T>)()
    : value;
}

function getUsedTransport() {
  const transport = [...mockTransportInstances]
    .reverse()
    .find((instance) => instance.sendMessages.mock.calls.length > 0);
  expect(transport).toBeDefined();
  return transport!;
}

vi.mock("@/lib/config", () => ({
  HOSTED_MODE: false,
}));

vi.mock("@/components/chat-v2/shared/model-helpers", () => ({
  buildAvailableModels: vi.fn(() => mockModelState.availableModels),
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
    selectedModelId: mockModelState.selectedModelId,
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
  authFetch: (...args: unknown[]) => mockAuthFetch(...args),
  getAuthHeaders: () => mockGetSessionAuthHeaders(),
}));

vi.mock("@/hooks/useSharedChatWidgetCapture", () => ({
  useSharedChatWidgetCapture: vi.fn(),
}));

vi.mock("@workos-inc/authkit-react", () => ({
  useAuth: () => ({
    getAccessToken: mockGetAccessToken,
  }),
}));

vi.mock("convex/react", () => ({
  useConvexAuth: () => ({
    isAuthenticated: true,
    isLoading: false,
  }),
}));

vi.mock("@ai-sdk/react", async () => {
  const React = await import("react");

  return {
    useChat: vi.fn(
      ({
        id,
        transport,
      }: {
        id: string;
        transport: {
          sendMessages: (options: any) => Promise<unknown>;
        };
      }) => {
        const latchedIdRef = React.useRef(id);
        const latchedTransportRef = React.useRef(transport);

        if (latchedIdRef.current !== id) {
          latchedIdRef.current = id;
          latchedTransportRef.current = transport;
        }

        return {
          messages: [],
          sendMessage: async (message: any) => {
            await latchedTransportRef.current.sendMessages({
              chatId: latchedIdRef.current,
              messages: [
                {
                  id: "user-1",
                  role: "user",
                  parts:
                    "text" in message
                      ? [{ type: "text", text: message.text }]
                      : [],
                },
              ],
              abortSignal: new AbortController().signal,
              metadata: undefined,
              headers: undefined,
              body: undefined,
              trigger: "submit-message",
              messageId: undefined,
            });
          },
          stop: mockStop,
          status: "ready",
          error: undefined,
          setMessages: mockSetMessages,
          addToolApprovalResponse: mockAddToolApprovalResponse,
        };
      },
    ),
  };
});

vi.mock("ai", () => ({
  DefaultChatTransport: class MockTransport {
    options: any;
    sendMessages: ReturnType<typeof vi.fn>;

    constructor(options: any) {
      this.options = options;
      this.sendMessages = vi.fn(async (requestOptions: any) => {
        const resolvedBody = await resolveConfig(this.options.body);
        const resolvedHeaders = await resolveConfig(this.options.headers);
        const requestBody = {
          ...resolvedBody,
          id: requestOptions.chatId,
          messages: requestOptions.messages,
          trigger: requestOptions.trigger,
          messageId: requestOptions.messageId,
        };
        await this.options.fetch?.(this.options.api, {
          method: "POST",
          headers: resolvedHeaders,
          body: JSON.stringify(requestBody),
        });
        return new ReadableStream();
      });
      mockTransportInstances.push(this);
    }
  },
  generateId: vi.fn(() => "chat-session-id"),
  lastAssistantMessageIsCompleteWithApprovalResponses: vi.fn(),
}));

describe("useChatSession minimal mode parity", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockModelState.availableModels = [baseModel];
    mockModelState.selectedModelId = "gpt-4";
    mockGetSessionAuthHeaders.mockReturnValue({});
    mockGetAccessToken.mockResolvedValue(null);
    mockAuthFetch.mockResolvedValue(new Response(null, { status: 200 }));
    mockTransportInstances.length = 0;
    mockGetToolsMetadata.mockResolvedValue({
      metadata: { create_view: { title: "Create view" } },
      toolServerMap: { create_view: "server-1" },
      tokenCounts: { "server-1": 17 },
    });
    mockCountTextTokens.mockResolvedValue(123);
  });

  it("still prefetches tools metadata when minimalMode is true", async () => {
    const selectedServers = ["server-1"];
    renderHook(() =>
      useChatSession({
        selectedServers,
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
    const selectedServers = ["server-1"];
    renderHook(() =>
      useChatSession({
        selectedServers,
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
    const selectedServers = ["server-1"];

    const { result } = renderHook(() =>
      useChatSession({
        selectedServers,
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

  it("keeps non-hosted chat off authFetch and omits transport headers by default", async () => {
    const selectedServers = ["server-1"];
    const { result } = renderHook(() =>
      useChatSession({
        selectedServers,
        minimalMode: true,
        initialSystemPrompt: "Prompt",
      }),
    );

    await waitFor(() => {
      expect(mockTransportInstances.length).toBeGreaterThan(0);
    });

    const latestTransport = mockTransportInstances.at(-1)!;
    expect(latestTransport.options.api).toBe("/api/mcp/chat-v2");
    expect(latestTransport.options.fetch).toBeUndefined();
    expect(
      await resolveConfig(latestTransport.options.headers),
    ).toBeUndefined();

    act(() => {
      result.current.sendMessage({ text: "hello" });
    });

    await waitFor(() => {
      expect(
        mockTransportInstances.some(
          (instance) => instance.sendMessages.mock.calls.length === 1,
        ),
      ).toBe(true);
    });
    expect(getUsedTransport().options.api).toBe("/api/mcp/chat-v2");
    expect(mockAuthFetch).not.toHaveBeenCalled();
  });

  it("adds explicit Authorization transport headers for the non-hosted non-guest MCPJam model path", async () => {
    mockModelState.availableModels = [nonGuestMcpJamModel];
    mockModelState.selectedModelId = nonGuestMcpJamModel.id;
    mockGetAccessToken.mockResolvedValue("convex-token");
    const selectedServers = ["server-1"];

    const { result } = renderHook(() =>
      useChatSession({
        selectedServers,
        minimalMode: true,
        initialSystemPrompt: "Prompt",
      }),
    );

    await waitFor(() => {
      expect(result.current.isAuthReady).toBe(true);
    });

    const latestTransport = mockTransportInstances.at(-1)!;
    expect(latestTransport.options.api).toBe("/api/mcp/chat-v2");
    expect(await resolveConfig(latestTransport.options.headers)).toEqual({
      Authorization: "Bearer convex-token",
    });

    expect(await resolveConfig(latestTransport.options.headers)).toEqual({
      Authorization: "Bearer convex-token",
    });
    expect(
      await resolveConfig(latestTransport.options.headers),
    ).not.toHaveProperty("X-MCP-Session-Auth");
    expect(mockAuthFetch).not.toHaveBeenCalled();
  });
});
