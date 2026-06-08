import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { useChatSession } from "../use-chat-session";
import { useMCPJamLimitDialogStore } from "@/stores/mcpjam-limit-dialog-store";
import { DEFAULT_SYSTEM_PROMPT } from "@/components/chat-v2/shared/chat-helpers";

const mockGetToolsMetadata = vi.fn();
const mockCountTextTokens = vi.fn();
const mockSetMessages = vi.fn();
const mockStop = vi.fn();
const mockAddToolApprovalResponse = vi.fn();
const mockAuthFetch = vi.fn();
const mockWindowFetch = vi.fn();
const mockGetSessionAuthHeaders = vi.fn(() => ({}));
const mockGetAccessToken = vi.fn(async () => null);
const mockGetGuestBearerToken = vi.fn(async () => "guest-token");
const mockHasToken = vi.fn(() => false);
const mockGetToken = vi.fn(() => "");
const mockGetOpenRouterSelectedModels = vi.fn(() => []);
const mockGetOllamaBaseUrl = vi.fn(() => "http://127.0.0.1:11434");
const mockGetAzureBaseUrl = vi.fn(() => "");
const mockGetCustomProviderByName = vi.fn();
const mockConvexAuth = {
  isAuthenticated: true,
  isLoading: false,
};
const mockTransportInstances: Array<{
  options: any;
  sendMessages: ReturnType<typeof vi.fn>;
  requests: any[];
}> = [];
const mockUseChatErrorHandlers: Array<(error: Error) => void> = [];

const baseModel = {
  id: "gpt-4",
  name: "GPT-4",
  provider: "openai" as const,
};
const orgAnthropicModel = {
  id: "claude-sonnet-4-6",
  name: "Claude Sonnet 4.6",
  provider: "anthropic" as const,
};
const mcpJamModel = {
  id: "openai/gpt-5-mini",
  name: "GPT-5 Mini",
  provider: "openai" as const,
};
const gatedMcpJamModel = {
  id: "openai/gpt-5.4-pro",
  name: "GPT-5.4 Pro",
  provider: "openai" as const,
};
const guestAllowedMcpJamModel = {
  id: "anthropic/claude-haiku-4.5",
  name: "Claude Haiku 4.5",
  provider: "anthropic" as const,
};
const mockModelState = {
  availableModels: [baseModel],
  selectedModelId: "gpt-4",
};
const mockAiProviderKeysState = {
  hasToken: mockHasToken,
  getToken: mockGetToken,
  getOpenRouterSelectedModels: mockGetOpenRouterSelectedModels,
  getOllamaBaseUrl: mockGetOllamaBaseUrl,
  getAzureBaseUrl: mockGetAzureBaseUrl,
};
const mockCustomProvidersState = {
  customProviders: [],
  getCustomProviderByName: mockGetCustomProviderByName,
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

function getTransportRequests() {
  return mockTransportInstances.flatMap((instance) => instance.requests);
}

vi.mock("@/lib/config", () => ({
  HOSTED_MODE: false,
}));

vi.mock("@/components/chat-v2/shared/model-helpers", () => ({
  buildAvailableModels: vi.fn(() => mockModelState.availableModels),
  buildAvailableModelsFromOrgConfig: vi.fn((orgConfig: any) => {
    if (
      orgConfig?.providers?.some(
        (provider: any) =>
          provider.providerKey === "anthropic" &&
          provider.enabled &&
          provider.hasSecret,
      )
    ) {
      return [mcpJamModel, orgAnthropicModel];
    }
    return [mcpJamModel];
  }),
  getDefaultModel: vi.fn(() => baseModel),
}));

vi.mock("@/hooks/use-ai-provider-keys", () => ({
  useAiProviderKeys: () => mockAiProviderKeysState,
}));

vi.mock("@/hooks/use-custom-providers", () => ({
  useCustomProviders: () => mockCustomProvidersState,
}));

vi.mock("@/hooks/use-persisted-model", () => ({
  usePersistedModel: () => ({
    selectedModelId: mockModelState.selectedModelId,
    setSelectedModelId: vi.fn(),
    selectedModelIds: [mockModelState.selectedModelId],
    setSelectedModelIds: vi.fn(),
    multiModelEnabled: false,
    setMultiModelEnabled: vi.fn(),
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

vi.mock("@/lib/guest-session", () => ({
  getGuestBearerToken: (...args: unknown[]) => mockGetGuestBearerToken(...args),
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
  useConvexAuth: () => mockConvexAuth,
  // Layer C cross-surface checks subscription — not exercised by these
  // tests; return undefined so the consumer sees "loading" semantics
  // without firing real queries.
  useQuery: () => undefined,
}));

vi.mock("@ai-sdk/react", async () => {
  const React = await import("react");

  return {
    useChat: vi.fn(
      ({
        id,
        transport,
        onError,
      }: {
        id: string;
        transport: {
          sendMessages: (options: any) => Promise<unknown>;
        };
        onError?: (error: Error) => void;
      }) => {
        const latchedIdRef = React.useRef(id);
        const latchedTransportRef = React.useRef(transport);

        if (onError) {
          mockUseChatErrorHandlers.push(onError);
        }

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
    requests: any[];

    constructor(options: any) {
      this.options = options;
      this.requests = [];
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
        this.requests.push(requestBody);
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
    mockConvexAuth.isAuthenticated = true;
    mockConvexAuth.isLoading = false;
    mockModelState.availableModels = [baseModel];
    mockModelState.selectedModelId = "gpt-4";
    mockGetSessionAuthHeaders.mockReturnValue({});
    mockGetAccessToken.mockResolvedValue(null);
    mockGetGuestBearerToken.mockReset();
    mockGetGuestBearerToken.mockResolvedValue("guest-token");
    mockAuthFetch.mockResolvedValue(new Response(null, { status: 200 }));
    mockWindowFetch.mockReset();
    mockWindowFetch.mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", mockWindowFetch);
    useMCPJamLimitDialogStore.setState({
      authStatus: "guest",
      hasPendingLimit: false,
      isOpen: false,
      intent: null,
      organizationId: null,
      pendingInput: null,
    });
    mockTransportInstances.length = 0;
    mockUseChatErrorHandlers.length = 0;
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
        executionConfig: {
          systemPrompt: "You are a helpful assistant.",
        },
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
        executionConfig: {
          systemPrompt: "Custom prompt",
        },
      }),
    );

    await waitFor(() => {
      expect(mockCountTextTokens).toHaveBeenCalledWith(
        "Custom prompt",
        "openai/gpt-4",
      );
    });
  });

  it("uses the default system prompt when execution config has a blank prompt", async () => {
    const selectedServers = ["server-1"];
    const { result } = renderHook(() =>
      useChatSession({
        selectedServers,
        minimalMode: true,
        executionConfig: {
          systemPrompt: "",
          temperature: 0.7,
          requireToolApproval: false,
        },
      }),
    );

    expect(result.current.systemPrompt).toBe(DEFAULT_SYSTEM_PROMPT);

    await waitFor(() => {
      expect(mockCountTextTokens).toHaveBeenCalledWith(
        DEFAULT_SYSTEM_PROMPT,
        "openai/gpt-4",
      );
    });

    act(() => {
      result.current.sendMessage({ text: "hello" });
    });

    await waitFor(() => {
      expect(getTransportRequests()).toContainEqual(
        expect.objectContaining({
          systemPrompt: DEFAULT_SYSTEM_PROMPT,
        }),
      );
    });
  });

  it("sends host-level respectToolVisibility overrides from uncontrolled callers", async () => {
    const selectedServers = ["server-1"];
    const { result, rerender } = renderHook(
      ({ respectToolVisibility }: { respectToolVisibility: boolean }) =>
        useChatSession({
          selectedServers,
          minimalMode: true,
          respectToolVisibility,
        }),
      { initialProps: { respectToolVisibility: false } },
    );

    act(() => {
      result.current.sendMessage({ text: "hello" });
    });

    await waitFor(() => {
      expect(getTransportRequests()).toContainEqual(
        expect.objectContaining({
          respectToolVisibility: false,
        }),
      );
    });

    rerender({ respectToolVisibility: true });

    act(() => {
      result.current.sendMessage({ text: "hello again" });
    });

    await waitFor(() => {
      expect(getTransportRequests()).toContainEqual(
        expect.objectContaining({
          respectToolVisibility: true,
        }),
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
        hostedContext: {
          chatboxId: "cbx_test", accessVersion: 1,
        },
        executionConfig: {
          systemPrompt: "Prompt",
        },
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

  it("keeps non-hosted chat off authFetch while using modal-aware fetch", async () => {
    const selectedServers = ["server-1"];
    const { result } = renderHook(() =>
      useChatSession({
        selectedServers,
        minimalMode: true,
        executionConfig: {
          systemPrompt: "Prompt",
        },
      }),
    );

    await waitFor(() => {
      expect(mockTransportInstances.length).toBeGreaterThan(0);
    });

    const latestTransport = mockTransportInstances.at(-1)!;
    expect(latestTransport.options.api).toBe("/api/mcp/chat-v2");
    expect(latestTransport.options.fetch).toEqual(expect.any(Function));
    expect(await resolveConfig(latestTransport.options.headers)).toEqual({
      Authorization: "Bearer guest-token",
    });

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
    expect(mockWindowFetch).toHaveBeenCalledWith(
      "/api/mcp/chat-v2",
      expect.objectContaining({
        method: "POST",
        headers: { Authorization: "Bearer guest-token" },
      }),
    );
    expect(mockAuthFetch).not.toHaveBeenCalled();
  });

  it("attaches widget model context to the next request only", async () => {
    const selectedServers = ["server-1"];
    const widgetModelContext = [
      {
        toolCallId: "call-1",
        context: {
          content: [{ type: "text", text: "board: X________" }],
          structuredContent: { board: ["X", "", "", "", "", "", "", "", ""] },
        },
      },
    ];
    const { result } = renderHook(() =>
      useChatSession({
        selectedServers,
        minimalMode: true,
        executionConfig: {
          systemPrompt: "Prompt",
        },
      }),
    );

    act(() => {
      result.current.sendMessage({
        text: "hello",
        widgetModelContext,
      });
    });

    await waitFor(() => {
      expect(getTransportRequests()).toHaveLength(1);
    });

    expect(getTransportRequests().at(-1)).toMatchObject({
      widgetModelContext,
    });

    act(() => {
      result.current.sendMessage({ text: "hello again" });
    });

    await waitFor(() => {
      expect(getTransportRequests()).toHaveLength(2);
    });

    expect(getTransportRequests().at(-1)).not.toHaveProperty(
      "widgetModelContext",
    );
  });

  it("opens the mcpjam-limit dialog for non-hosted chat-v2 limit responses", async () => {
    mockWindowFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          ok: false,
          code: "user_rate_limit",
          error:
            "Daily MCPJam model limit reached. Use BYOK or try again tomorrow.",
          isRetryable: true,
          retryAfter: 86400000,
          details: "Try again in 1440 minutes.",
        }),
        {
          status: 429,
          headers: { "Content-Type": "application/json" },
        },
      ),
    );

    const { result } = renderHook(() =>
      useChatSession({
        selectedServers: ["server-1"],
        minimalMode: true,
        executionConfig: {
          systemPrompt: "Prompt",
        },
      }),
    );

    await waitFor(() => {
      expect(mockTransportInstances.length).toBeGreaterThan(0);
    });

    act(() => {
      result.current.sendMessage({ text: "hello" });
    });

    await waitFor(() => {
      expect(useMCPJamLimitDialogStore.getState().isOpen).toBe(true);
    });
    expect(mockAuthFetch).not.toHaveBeenCalled();
  });

  it("opens the mcpjam-limit dialog for chat-v2 stream limit errors", async () => {
    renderHook(() =>
      useChatSession({
        selectedServers: ["server-1"],
        minimalMode: true,
        executionConfig: {
          systemPrompt: "Prompt",
        },
      }),
    );

    await waitFor(() => {
      expect(mockUseChatErrorHandlers.length).toBeGreaterThan(0);
    });

    act(() => {
      mockUseChatErrorHandlers.at(-1)?.(
        new Error(
          "Daily MCPJam model limit reached. Use BYOK or try again tomorrow.",
        ),
      );
    });

    expect(useMCPJamLimitDialogStore.getState().isOpen).toBe(true);
  });

  it("opens the topup variant for signed-in user_rate_limit responses", async () => {
    useMCPJamLimitDialogStore.setState({
      authStatus: "signedIn",
      hasPendingLimit: false,
      isOpen: false,
      intent: null,
      organizationId: null,
      pendingInput: null,
    });
    mockWindowFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          ok: false,
          code: "user_rate_limit",
          error: "Daily credit limit reached.",
          limitKind: "total",
        }),
        {
          status: 429,
          headers: { "Content-Type": "application/json" },
        },
      ),
    );

    const { result } = renderHook(() =>
      useChatSession({
        selectedServers: ["server-1"],
        minimalMode: true,
        executionConfig: {
          systemPrompt: "Prompt",
        },
      }),
    );

    await waitFor(() => {
      expect(mockTransportInstances.length).toBeGreaterThan(0);
    });

    act(() => {
      result.current.sendMessage({ text: "hello" });
    });

    await waitFor(() => {
      expect(useMCPJamLimitDialogStore.getState().intent).toBe("topup");
    });
    expect(useMCPJamLimitDialogStore.getState().isOpen).toBe(true);
  });

  it("does not open the modal for signed-in concurrency-throttle responses", async () => {
    useMCPJamLimitDialogStore.setState({
      authStatus: "signedIn",
      hasPendingLimit: false,
      isOpen: false,
      intent: null,
      organizationId: null,
      pendingInput: null,
    });
    mockWindowFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          ok: false,
          code: "user_rate_limit",
          error: "Another credit-funded chat is finishing.",
          limitKind: "concurrency",
        }),
        {
          status: 429,
          headers: { "Content-Type": "application/json" },
        },
      ),
    );

    const { result } = renderHook(() =>
      useChatSession({
        selectedServers: ["server-1"],
        minimalMode: true,
        executionConfig: {
          systemPrompt: "Prompt",
        },
      }),
    );

    await waitFor(() => {
      expect(mockTransportInstances.length).toBeGreaterThan(0);
    });

    act(() => {
      result.current.sendMessage({ text: "hello" });
    });

    // Give the error path a chance to run.
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(useMCPJamLimitDialogStore.getState().isOpen).toBe(false);
    expect(useMCPJamLimitDialogStore.getState().intent).toBeNull();
  });

  it("keeps only the three premium MCPJam models gated on the unauthenticated non-hosted path", async () => {
    mockModelState.availableModels = [
      baseModel,
      gatedMcpJamModel,
      mcpJamModel,
      guestAllowedMcpJamModel,
    ];
    mockModelState.selectedModelId = mcpJamModel.id;

    mockConvexAuth.isAuthenticated = false;
    mockGetAccessToken.mockResolvedValue(null);
    const selectedServers = ["server-1"];

    const { result } = renderHook(() =>
      useChatSession({
        selectedServers,
        minimalMode: true,
        executionConfig: {
          systemPrompt: "Prompt",
        },
      }),
    );

    await waitFor(() => {
      expect(result.current.isAuthReady).toBe(true);
    });

    const latestTransport = mockTransportInstances.at(-1)!;
    expect(latestTransport.options.api).toBe("/api/mcp/chat-v2");
    expect(await resolveConfig(latestTransport.options.headers)).toEqual({
      Authorization: "Bearer guest-token",
    });
    expect(result.current.disableForAuthentication).toBe(false);
    expect(result.current.availableModels.map((model) => model.id)).toEqual([
      "gpt-4",
      "openai/gpt-5.4-pro",
      "openai/gpt-5-mini",
      "anthropic/claude-haiku-4.5",
    ]);
    expect(
      result.current.availableModels.find((model) => model.id === "gpt-4")
        ?.disabled,
    ).toBeUndefined();
    expect(
      result.current.availableModels.find(
        (model) => model.id === "openai/gpt-5.4-pro",
      ),
    ).toMatchObject({
      disabled: true,
      disabledReason: "Sign in to use MCPJam provided models",
    });
    expect(
      result.current.availableModels.find(
        (model) => model.id === "openai/gpt-5-mini",
      )?.disabled,
    ).toBeUndefined();
    expect(
      result.current.availableModels.find(
        (model) => model.id === "anthropic/claude-haiku-4.5",
      )?.disabled,
    ).toBeUndefined();
    expect(result.current.selectedModel.id).toBe("openai/gpt-5-mini");
    expect(mockAuthFetch).not.toHaveBeenCalled();
  });

  it("uses org config and the org-aware route for BYOK in non-hosted local dev", async () => {
    mockModelState.selectedModelId = orgAnthropicModel.id;
    mockGetAccessToken.mockResolvedValue(null);

    const { result } = renderHook(() =>
      useChatSession({
        selectedServers: ["server-1"],
        hostedOrgModelConfig: {
          providers: [
            {
              providerKey: "anthropic",
              enabled: true,
              hasSecret: true,
            },
          ],
        },
        hostedContext: {
          projectId: "project-1",
          selectedServerIds: ["server-id-1"],
        },
      }),
    );

    await waitFor(() => {
      expect(result.current.isAuthReady).toBe(true);
    });

    expect(result.current.availableModels.map((model) => model.id)).toEqual([
      mcpJamModel.id,
      orgAnthropicModel.id,
    ]);
    expect(result.current.selectedModel.id).toBe(orgAnthropicModel.id);

    await act(async () => {
      await result.current.sendMessage({ text: "hello" });
    });

    const transport = getUsedTransport();
    expect(transport.options.api).toBe("/api/web/chat-v2");
    expect(transport.requests[0]).toMatchObject({
      model: orgAnthropicModel,
      projectId: "project-1",
      selectedServerIds: ["server-id-1"],
      selectedServerNames: ["server-1"],
      accessScope: "chat_v2",
    });
    expect(transport.requests[0]).not.toHaveProperty("apiKey");
    expect(mockWindowFetch).toHaveBeenCalledWith(
      "/api/web/chat-v2",
      expect.objectContaining({
        headers: { Authorization: "Bearer guest-token" },
      }),
    );
    expect(mockAuthFetch).not.toHaveBeenCalled();
  });

  it("falls back to local provider keys when non-hosted org config is empty", async () => {
    mockModelState.availableModels = [baseModel];
    mockModelState.selectedModelId = baseModel.id;
    mockGetToken.mockReturnValue("sk-local");

    const { result } = renderHook(() =>
      useChatSession({
        selectedServers: ["server-1"],
        hostedOrgModelConfig: { providers: [] },
        hostedContext: {
          projectId: "project-1",
          selectedServerIds: ["server-id-1"],
        },
      }),
    );

    await waitFor(() => {
      expect(result.current.isAuthReady).toBe(true);
    });

    await act(async () => {
      await result.current.sendMessage({ text: "hello" });
    });

    const transport = getUsedTransport();
    expect(transport.options.api).toBe("/api/mcp/chat-v2");
    expect(transport.requests[0]).toMatchObject({
      model: baseModel,
      apiKey: "sk-local",
      projectId: "project-1",
      selectedServerIds: ["server-id-1"],
    });
  });

  it("keeps an initialModelId authoritative even when that model is guest-locked", async () => {
    mockModelState.availableModels = [
      baseModel,
      gatedMcpJamModel,
      mcpJamModel,
      guestAllowedMcpJamModel,
    ];
    mockModelState.selectedModelId = mcpJamModel.id;
    mockConvexAuth.isAuthenticated = false;
    mockGetAccessToken.mockResolvedValue(null);

    const { result } = renderHook(() =>
      useChatSession({
        selectedServers: ["server-1"],
        minimalMode: true,
        executionConfig: {
          systemPrompt: "Prompt",
          modelId: gatedMcpJamModel.id,
        },
      }),
    );

    await waitFor(() => {
      expect(result.current.selectedModel.id).toBe("openai/gpt-5.4-pro");
    });

    expect(result.current.selectedModel).toMatchObject({
      id: "openai/gpt-5.4-pro",
      disabled: true,
      disabledReason: "Sign in to use MCPJam provided models",
    });
    expect(result.current.isAuthReady).toBe(false);
    expect(result.current.disableForAuthentication).toBe(true);
  });

  it("creates a locked placeholder when initialModelId is missing from availableModels", async () => {
    mockModelState.availableModels = [
      baseModel,
      mcpJamModel,
      guestAllowedMcpJamModel,
    ];
    mockModelState.selectedModelId = mcpJamModel.id;
    mockConvexAuth.isAuthenticated = false;
    mockGetAccessToken.mockResolvedValue(null);

    const { result } = renderHook(() =>
      useChatSession({
        selectedServers: ["server-1"],
        minimalMode: true,
        executionConfig: {
          systemPrompt: "Prompt",
          modelId: gatedMcpJamModel.id,
        },
      }),
    );

    await waitFor(() => {
      expect(result.current.selectedModel.id).toBe("openai/gpt-5.4-pro");
    });

    expect(result.current.selectedModel).toMatchObject({
      id: "openai/gpt-5.4-pro",
      name: "openai/gpt-5.4-pro",
      provider: "openai",
      disabled: true,
      disabledReason: "Sign in to use MCPJam provided models",
    });
    expect(result.current.isAuthReady).toBe(false);
    expect(result.current.disableForAuthentication).toBe(true);
  });

  it("uses the latest selectedServers on the next non-hosted send without changing chatSessionId", async () => {
    const { result, rerender } = renderHook(
      ({ selectedServers }: { selectedServers: string[] }) =>
        useChatSession({
          selectedServers,
          minimalMode: true,
          executionConfig: {
            systemPrompt: "Prompt",
          },
        }),
      {
        initialProps: {
          selectedServers: ["server-1"],
        },
      },
    );

    await waitFor(() => {
      expect(mockTransportInstances.length).toBeGreaterThan(0);
    });

    const initialChatSessionId = result.current.chatSessionId;

    act(() => {
      result.current.sendMessage({ text: "hello" });
    });

    await waitFor(() => {
      expect(getTransportRequests()).toHaveLength(1);
    });

    expect(getTransportRequests().at(-1)).toMatchObject({
      selectedServers: ["server-1"],
      chatSessionId: initialChatSessionId,
    });

    rerender({
      selectedServers: ["server-2"],
    });

    await waitFor(() => {
      expect(mockTransportInstances.length).toBeGreaterThan(1);
    });

    expect(result.current.chatSessionId).toBe(initialChatSessionId);
    const requestsBeforeSecondSend = getTransportRequests().length;

    act(() => {
      result.current.sendMessage({ text: "hello again" });
    });

    await waitFor(() => {
      expect(getTransportRequests()).toHaveLength(requestsBeforeSecondSend + 1);
    });

    expect(getTransportRequests().at(-1)).toMatchObject({
      selectedServers: ["server-2"],
      chatSessionId: initialChatSessionId,
    });
  });
});
