import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useChatSession } from "../use-chat-session";
import { useTrafficLogStore } from "@/stores/traffic-log-store";

const mockState = vi.hoisted(() => ({
  sendMessage: vi.fn(),
  stop: vi.fn(),
  setMessages: vi.fn(),
  addToolApprovalResponse: vi.fn(),
  authFetch: vi.fn(),
  buildHostedServerRequest: vi.fn(),
  getAccessToken: vi.fn(async () => "access-token"),
  getGuestBearerToken: vi.fn(async () => "guest-token"),
  hasToken: vi.fn(() => false),
  getToken: vi.fn(() => ""),
  getOpenRouterSelectedModels: vi.fn(() => []),
  getOllamaBaseUrl: vi.fn(() => "http://127.0.0.1:11434"),
  getAzureBaseUrl: vi.fn(() => ""),
  getCustomProviderByName: vi.fn(),
  setSelectedModelId: vi.fn(),
  useSharedChatWidgetCapture: vi.fn(),
  latestOnData: undefined as ((part: unknown) => void) | undefined,
  convexAuth: {
    isAuthenticated: true,
    isLoading: false,
  },
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
  selectedModelId: "anthropic/claude-haiku-4.5",
}));
let lastTransportOptions: any;

async function resolveConfig<T>(value: T | (() => T | Promise<T>)) {
  return typeof value === "function"
    ? await (value as () => T | Promise<T>)()
    : value;
}

const guestModel = {
  id: "anthropic/claude-haiku-4.5",
  name: "Claude Haiku 4.5",
  provider: "anthropic" as const,
};
const gatedAnthropicModel = {
  id: "anthropic/claude-opus-4.6",
  name: "Claude Opus 4.6",
  provider: "anthropic" as const,
};
const allowedHostedModel = {
  id: "qwen/qwen3.6-plus",
  name: "Qwen 3.6 Plus",
  provider: "qwen" as const,
};
const allowedOpenAiModel = {
  id: "openai/gpt-4o-mini",
  name: "GPT-4o Mini",
  provider: "openai" as const,
};
const gatedOpenAiModel = {
  id: "openai/gpt-5.4-pro",
  name: "GPT-5.4 Pro",
  provider: "openai" as const,
};
const gatedGoogleModel = {
  id: "google/gemini-3.1-pro-preview",
  name: "Gemini 3.1 Pro Preview",
  provider: "google" as const,
};

vi.mock("@/lib/config", () => ({
  HOSTED_MODE: true,
}));

vi.mock("@/components/chat-v2/shared/model-helpers", () => ({
  buildAvailableModels: vi.fn(() => [
    gatedAnthropicModel,
    gatedGoogleModel,
    gatedOpenAiModel,
    allowedHostedModel,
    allowedOpenAiModel,
    guestModel,
  ]),
  getDefaultModel: vi.fn((models: Array<typeof guestModel>) => models[0]),
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
    selectedModelId: mockState.selectedModelId,
    setSelectedModelId: mockState.setSelectedModelId,
    selectedModelIds: [mockState.selectedModelId],
    setSelectedModelIds: vi.fn(),
    multiModelEnabled: false,
    setMultiModelEnabled: vi.fn(),
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
  authFetch: (...args: unknown[]) => mockState.authFetch(...args),
  getAuthHeaders: vi.fn(() => ({})),
  addTokenToUrl: vi.fn((url: string) => url),
}));

vi.mock("@/lib/guest-session", () => ({
  getGuestBearerToken: mockState.getGuestBearerToken,
}));

vi.mock("@/lib/apis/web/context", () => ({
  buildHostedServerRequest: mockState.buildHostedServerRequest,
}));

vi.mock("@workos-inc/authkit-react", () => ({
  useAuth: () => ({
    getAccessToken: mockState.getAccessToken,
  }),
}));

vi.mock("convex/react", () => ({
  useConvexAuth: () => mockState.convexAuth,
}));

vi.mock("@ai-sdk/react", async () => {
  const React = await import("react");

  return {
    useChat: vi.fn(
      ({
        id,
        transport,
        onData,
      }: {
        id: string;
        transport: {
          sendMessages: (options: any) => Promise<unknown>;
        };
        onData?: (part: unknown) => void;
      }) => {
        const latchedIdRef = React.useRef(id);
        const latchedTransportRef = React.useRef(transport);
        mockState.latestOnData = onData;

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
          stop: mockState.stop,
          status: "ready",
          error: undefined,
          setMessages: mockState.setMessages,
          addToolApprovalResponse: mockState.addToolApprovalResponse,
        };
      },
    ),
  };
});

vi.mock("ai", () => ({
  DefaultChatTransport: class MockTransport {
    options: any;
    sendMessages: ReturnType<typeof vi.fn>;

    constructor(options: unknown) {
      lastTransportOptions = options;
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
    }
  },
  generateId: vi.fn(() => "chat-session-id"),
  lastAssistantMessageIsCompleteWithApprovalResponses: vi.fn(),
}));

describe("useChatSession hosted mode", () => {
  beforeEach(() => {
    mockState.convexAuth.isAuthenticated = true;
    mockState.convexAuth.isLoading = false;
    mockState.authFetch.mockReset();
    mockState.authFetch.mockResolvedValue(new Response(null, { status: 200 }));
    mockState.buildHostedServerRequest.mockReset();
    mockState.getAccessToken.mockReset();
    mockState.getAccessToken.mockResolvedValue("access-token");
    mockState.getGuestBearerToken.mockReset();
    mockState.getGuestBearerToken.mockResolvedValue("guest-token");
    mockState.selectedModelId = "anthropic/claude-haiku-4.5";
    mockState.latestOnData = undefined;
    useTrafficLogStore.getState().clear();
  });

  it("includes chatSessionId in the hosted transport body", async () => {
    const { result, unmount } = renderHook(() =>
      useChatSession({
        selectedServers: ["server-1"],
        hostedContext: {
          workspaceId: "workspace-1",
          selectedServerIds: ["server-id-1"],
          shareToken: "share-token",
        },
      }),
    );

    const body = lastTransportOptions.body();
    expect(result.current.chatSessionId).toBe("chat-session-id");
    expect(body).toMatchObject({
      workspaceId: "workspace-1",
      chatSessionId: "chat-session-id",
      selectedServerIds: ["server-id-1"],
      selectedServerNames: ["server-1"],
      shareToken: "share-token",
      accessScope: "chat_v2",
    });
    unmount();
  });

  it("includes chatboxToken in the hosted transport body", async () => {
    const { result, unmount } = renderHook(() =>
      useChatSession({
        selectedServers: ["server-1"],
        hostedContext: {
          workspaceId: "workspace-1",
          selectedServerIds: ["server-id-1"],
          chatboxToken: "chatbox-token",
        },
      }),
    );

    const body = lastTransportOptions.body();
    expect(result.current.chatSessionId).toBe("chat-session-id");
    expect(body).toMatchObject({
      workspaceId: "workspace-1",
      chatSessionId: "chat-session-id",
      selectedServerIds: ["server-id-1"],
      selectedServerNames: ["server-1"],
      chatboxToken: "chatbox-token",
      accessScope: "chat_v2",
    });
    unmount();
  });

  it("includes chatbox surface in the hosted transport body", async () => {
    const { unmount } = renderHook(() =>
      useChatSession({
        selectedServers: ["server-1"],
        hostedContext: {
          workspaceId: "workspace-1",
          selectedServerIds: ["server-id-1"],
          chatboxToken: "chatbox-token",
          chatboxSurface: "preview",
        },
      }),
    );

    const body = lastTransportOptions.body();
    expect(body).toMatchObject({
      chatboxToken: "chatbox-token",
      surface: "preview",
    });
    unmount();
  });

  it("marks session bootstrap complete only after auth setup finishes", async () => {
    let resolveAccessToken: (value: string) => void = () => {};
    mockState.getAccessToken.mockImplementation(
      () =>
        new Promise<string>((resolve) => {
          resolveAccessToken = resolve;
        }),
    );

    const { result } = renderHook(() =>
      useChatSession({
        selectedServers: ["server-1"],
        hostedContext: {
          workspaceId: "workspace-1",
          selectedServerIds: ["server-id-1"],
        },
      }),
    );

    expect(result.current.isSessionBootstrapComplete).toBe(false);

    resolveAccessToken("access-token");

    await waitFor(() => {
      expect(result.current.isSessionBootstrapComplete).toBe(true);
    });
  });

  it("includes the selected direct-guest server in hosted chat bodies", async () => {
    mockState.convexAuth.isAuthenticated = false;
    mockState.buildHostedServerRequest.mockReturnValue({
      serverName: "Excalidraw (App)",
      serverUrl: "https://mcp.excalidraw.com/mcp",
      serverHeaders: { "X-Api-Key": "guest-key" },
      oauthAccessToken: "guest-oauth-token",
      clientCapabilities: { roots: { listChanged: true } },
    });

    const { result, unmount } = renderHook(() =>
      useChatSession({
        selectedServers: ["Excalidraw (App)"],
      }),
    );

    const body = lastTransportOptions.body();

    expect(result.current.chatSessionId).toBe("chat-session-id");
    expect(mockState.buildHostedServerRequest).toHaveBeenCalledWith(
      "Excalidraw (App)",
    );
    expect(body).toMatchObject({
      chatSessionId: "chat-session-id",
      serverName: "Excalidraw (App)",
      serverUrl: "https://mcp.excalidraw.com/mcp",
      serverHeaders: { "X-Api-Key": "guest-key" },
      oauthAccessToken: "guest-oauth-token",
      clientCapabilities: { roots: { listChanged: true } },
    });
    unmount();
  });

  it("uses the latest hosted selectedServerIds on the next send without changing chatSessionId", async () => {
    const { result, rerender } = renderHook(
      ({
        selectedServers,
        hostedSelectedServerIds,
      }: {
        selectedServers: string[];
        hostedSelectedServerIds: string[];
      }) =>
        useChatSession({
          selectedServers,
          hostedContext: {
            workspaceId: "workspace-1",
            selectedServerIds: hostedSelectedServerIds,
          },
        }),
      {
        initialProps: {
          selectedServers: ["server-1"],
          hostedSelectedServerIds: ["server-id-1"],
        },
      },
    );

    await waitFor(() => {
      expect(result.current.isSessionBootstrapComplete).toBe(true);
    });

    const initialChatSessionId = result.current.chatSessionId;
    mockState.authFetch.mockClear();

    act(() => {
      result.current.sendMessage({ text: "first" });
    });

    await waitFor(() => {
      expect(mockState.authFetch).toHaveBeenCalledTimes(1);
    });

    expect(
      JSON.parse(
        String(
          (
            mockState.authFetch.mock.calls.at(-1)?.[1] as
              | RequestInit
              | undefined
          )?.body ?? "{}",
        ),
      ),
    ).toMatchObject({
      chatSessionId: initialChatSessionId,
      selectedServerIds: ["server-id-1"],
    });

    rerender({
      selectedServers: ["server-2"],
      hostedSelectedServerIds: ["server-id-2"],
    });

    expect(result.current.chatSessionId).toBe(initialChatSessionId);

    act(() => {
      result.current.sendMessage({ text: "second" });
    });

    await waitFor(() => {
      expect(mockState.authFetch).toHaveBeenCalledTimes(2);
    });

    expect(
      JSON.parse(
        String(
          (
            mockState.authFetch.mock.calls.at(-1)?.[1] as
              | RequestInit
              | undefined
          )?.body ?? "{}",
        ),
      ),
    ).toMatchObject({
      chatSessionId: initialChatSessionId,
      selectedServerIds: ["server-id-2"],
    });
  });

  it("uses the latest direct-guest server request on the next send without changing chatSessionId", async () => {
    mockState.convexAuth.isAuthenticated = false;
    mockState.buildHostedServerRequest.mockImplementation(
      (serverName: string) =>
        serverName === "Excalidraw (App)"
          ? {
              serverName: "Excalidraw (App)",
              serverUrl: "https://mcp.excalidraw.com/mcp",
              serverHeaders: { "X-Api-Key": "guest-key-1" },
              oauthAccessToken: "guest-oauth-token-1",
            }
          : {
              serverName: "Learn (App)",
              serverUrl: "https://mcp.learn.com/mcp",
              serverHeaders: { "X-Api-Key": "guest-key-2" },
              oauthAccessToken: "guest-oauth-token-2",
            },
    );

    const { result, rerender } = renderHook(
      ({ selectedServers }: { selectedServers: string[] }) =>
        useChatSession({
          selectedServers,
        }),
      {
        initialProps: {
          selectedServers: ["Excalidraw (App)"],
        },
      },
    );

    await waitFor(() => {
      expect(result.current.isSessionBootstrapComplete).toBe(true);
    });

    const initialChatSessionId = result.current.chatSessionId;
    mockState.authFetch.mockClear();

    act(() => {
      result.current.sendMessage({ text: "first" });
    });

    await waitFor(() => {
      expect(mockState.authFetch).toHaveBeenCalledTimes(1);
    });

    expect(
      JSON.parse(
        String(
          (
            mockState.authFetch.mock.calls.at(-1)?.[1] as
              | RequestInit
              | undefined
          )?.body ?? "{}",
        ),
      ),
    ).toMatchObject({
      chatSessionId: initialChatSessionId,
      serverName: "Excalidraw (App)",
      serverUrl: "https://mcp.excalidraw.com/mcp",
      serverHeaders: { "X-Api-Key": "guest-key-1" },
      oauthAccessToken: "guest-oauth-token-1",
    });

    rerender({
      selectedServers: ["Learn (App)"],
    });

    expect(result.current.chatSessionId).toBe(initialChatSessionId);

    act(() => {
      result.current.sendMessage({ text: "second" });
    });

    await waitFor(() => {
      expect(mockState.authFetch).toHaveBeenCalledTimes(2);
    });

    expect(
      JSON.parse(
        String(
          (
            mockState.authFetch.mock.calls.at(-1)?.[1] as
              | RequestInit
              | undefined
          )?.body ?? "{}",
        ),
      ),
    ).toMatchObject({
      chatSessionId: initialChatSessionId,
      serverName: "Learn (App)",
      serverUrl: "https://mcp.learn.com/mcp",
      serverHeaders: { "X-Api-Key": "guest-key-2" },
      oauthAccessToken: "guest-oauth-token-2",
    });
  });

  it("keeps plain hosted guest chat bodies when no server is selected", async () => {
    mockState.convexAuth.isAuthenticated = false;

    const { result, unmount } = renderHook(() =>
      useChatSession({
        selectedServers: [],
      }),
    );

    const body = lastTransportOptions.body();

    expect(result.current.chatSessionId).toBe("chat-session-id");
    expect(mockState.buildHostedServerRequest).not.toHaveBeenCalled();
    expect(body).toMatchObject({
      chatSessionId: "chat-session-id",
    });
    expect(body.serverUrl).toBeUndefined();
    unmount();
  });

  it("ingests hosted rpc logs from chat error responses", async () => {
    mockState.authFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          code: "INTERNAL_ERROR",
          message: "chat failed",
          _rpcLogs: [
            {
              serverId: "server-id-1",
              serverName: "server-1",
              direction: "send",
              timestamp: "2026-04-10T12:00:00.000Z",
              message: {
                jsonrpc: "2.0",
                id: 1,
                method: "tools/list",
              },
            },
          ],
        }),
        {
          status: 500,
          headers: { "Content-Type": "application/json" },
        },
      ),
    );

    const { result } = renderHook(() =>
      useChatSession({
        selectedServers: ["server-1"],
        hostedContext: {
          workspaceId: "workspace-1",
          selectedServerIds: ["server-id-1"],
        },
      }),
    );

    await waitFor(() => {
      expect(result.current.isSessionBootstrapComplete).toBe(true);
    });

    act(() => {
      result.current.sendMessage({ text: "hello" });
    });

    await waitFor(() => {
      expect(useTrafficLogStore.getState().mcpServerItems).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            serverId: "server-id-1",
            serverName: "server-1",
            method: "tools/list",
          }),
        ]),
      );
    });
  });

  it("ingests hosted rpc log data parts from the chat stream", async () => {
    renderHook(() =>
      useChatSession({
        selectedServers: ["server-1"],
        hostedContext: {
          workspaceId: "workspace-1",
          selectedServerIds: ["server-id-1"],
        },
      }),
    );

    act(() => {
      mockState.latestOnData?.({
        type: "data-rpc-log",
        data: {
          serverId: "server-id-1",
          serverName: "server-1",
          direction: "receive",
          timestamp: "2026-04-10T12:00:00.000Z",
          message: {
            jsonrpc: "2.0",
            id: 1,
            result: { tools: [] },
          },
        },
      });
    });

    expect(useTrafficLogStore.getState().mcpServerItems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          serverId: "server-id-1",
          serverName: "server-1",
          direction: "RECEIVE",
          method: "result",
        }),
      ]),
    );
  });

  it("keeps only the three premium hosted models disabled for anonymous hosted viewers", async () => {
    mockState.convexAuth.isAuthenticated = false;
    mockState.getAccessToken.mockRejectedValue(new Error("LoginRequiredError"));

    const { result, unmount } = renderHook(() =>
      useChatSession({
        selectedServers: ["server-1"],
        hostedContext: {
          workspaceId: "workspace-1",
          selectedServerIds: ["server-id-1"],
          shareToken: "share-token",
        },
      }),
    );

    await waitFor(() => {
      expect(result.current.disableForAuthentication).toBe(false);
    });

    expect(result.current.availableModels.map((model) => model.id)).toEqual([
      "anthropic/claude-opus-4.6",
      "google/gemini-3.1-pro-preview",
      "openai/gpt-5.4-pro",
      "qwen/qwen3.6-plus",
      "openai/gpt-4o-mini",
      "anthropic/claude-haiku-4.5",
    ]);
    expect(
      result.current.availableModels.find(
        (model) => model.id === "anthropic/claude-haiku-4.5",
      )?.disabled,
    ).toBeUndefined();
    expect(
      result.current.availableModels.find(
        (model) => model.id === "anthropic/claude-opus-4.6",
      ),
    ).toMatchObject({
      disabled: true,
      disabledReason: "Sign in to use MCPJam provided models",
    });
    expect(
      result.current.availableModels.find(
        (model) => model.id === "google/gemini-3.1-pro-preview",
      ),
    ).toMatchObject({
      disabled: true,
      disabledReason: "Sign in to use MCPJam provided models",
    });
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
        (model) => model.id === "qwen/qwen3.6-plus",
      )?.disabled,
    ).toBeUndefined();
    expect(
      result.current.availableModels.find(
        (model) => model.id === "openai/gpt-4o-mini",
      )?.disabled,
    ).toBeUndefined();
    unmount();
  });

  it("falls back when an anonymous hosted viewer has a gated model persisted", async () => {
    mockState.convexAuth.isAuthenticated = false;
    mockState.getAccessToken.mockRejectedValue(new Error("LoginRequiredError"));
    mockState.selectedModelId = "google/gemini-3.1-pro-preview";

    const { result, unmount } = renderHook(() =>
      useChatSession({
        selectedServers: ["server-1"],
        hostedContext: {
          workspaceId: "workspace-1",
          selectedServerIds: ["server-id-1"],
          shareToken: "share-token",
        },
      }),
    );

    await waitFor(() => {
      expect(result.current.disableForAuthentication).toBe(false);
    });

    expect(result.current.selectedModel.id).toBe("qwen/qwen3.6-plus");
    unmount();
  });
  it("treats anonymous shared-chat viewers as guest users", async () => {
    mockState.convexAuth.isAuthenticated = false;
    mockState.getAccessToken.mockRejectedValue(new Error("LoginRequiredError"));

    const { result, unmount } = renderHook(() =>
      useChatSession({
        selectedServers: ["server-1"],
        hostedContext: {
          workspaceId: "workspace-1",
          selectedServerIds: ["server-id-1"],
          shareToken: "share-token",
        },
      }),
    );

    await waitFor(() => {
      expect(result.current.disableForAuthentication).toBe(false);
    });

    expect(
      result.current.availableModels
        .filter((model) => !model.disabled)
        .map((model) => model.id),
    ).toEqual([
      "qwen/qwen3.6-plus",
      "openai/gpt-4o-mini",
      "anthropic/claude-haiku-4.5",
    ]);
    expect(result.current.isAuthReady).toBe(true);
    unmount();
  });

  it("passes persisted widget snapshot tool call ids to the capture hook after loading history", async () => {
    mockState.useSharedChatWidgetCapture.mockClear();
    const { result, unmount } = renderHook(() =>
      useChatSession({
        selectedServers: ["server-1"],
        hostedContext: {
          workspaceId: "workspace-1",
          selectedServerIds: ["server-id-1"],
        },
      }),
    );

    await waitFor(() => {
      expect(result.current.isSessionBootstrapComplete).toBe(true);
    });

    await result.current.loadChatSession({
      chatSessionId: "history-session-1",
      messagesBlobUrl: null,
      version: 3,
      widgetSnapshots: [
        {
          toolCallId: "tool-call-1",
          toolName: "search",
          serverId: "server-id-1",
          uiType: "mcp-apps",
          widgetCsp: null,
          widgetPermissions: null,
          widgetPermissive: false,
          prefersBorder: false,
        },
      ],
    });

    await waitFor(() => {
      expect(mockState.useSharedChatWidgetCapture).toHaveBeenLastCalledWith(
        expect.objectContaining({
          chatSessionId: "history-session-1",
          persistedSnapshotToolCallIds: ["tool-call-1"],
        }),
      );
    });

    unmount();
  });

  it("hydrates persisted widget snapshot tool output for replayed widgets", async () => {
    const toolOutput = {
      content: [{ type: "text", text: "rendered" }],
      structuredContent: { checkpointId: "checkpoint-1" },
      _meta: {
        ui: { resourceUri: "ui://excalidraw/mcp-app.html" },
        _serverId: "server-id-1",
      },
    };
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(JSON.stringify(toolOutput), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );

    const { result, unmount } = renderHook(() =>
      useChatSession({
        selectedServers: ["server-1"],
        hostedContext: {
          workspaceId: "workspace-1",
          selectedServerIds: ["server-id-1"],
        },
      }),
    );

    await waitFor(() => {
      expect(result.current.isSessionBootstrapComplete).toBe(true);
    });

    await result.current.loadChatSession({
      chatSessionId: "history-session-2",
      messagesBlobUrl: null,
      version: 4,
      widgetSnapshots: [
        {
          toolCallId: "tool-call-1",
          toolName: "create_view",
          serverId: "server-id-1",
          uiType: "mcp-apps",
          resourceUri: "ui://excalidraw/mcp-app.html",
          widgetCsp: null,
          widgetPermissions: null,
          widgetPermissive: false,
          prefersBorder: false,
          toolOutputUrl: "https://storage.example.com/tool-output.json",
        },
      ],
    });

    await waitFor(() => {
      expect(
        result.current.restoredToolRenderOverrides["tool-call-1"]?.toolOutput,
      ).toEqual(toolOutput);
    });

    fetchSpy.mockRestore();
    unmount();
  });

  it("keeps even gated hosted models available for authenticated viewers", async () => {
    const { result, unmount } = renderHook(() =>
      useChatSession({
        selectedServers: ["server-1"],
        hostedContext: {
          workspaceId: "workspace-1",
          selectedServerIds: ["server-id-1"],
          shareToken: "share-token",
        },
      }),
    );

    await waitFor(() => {
      expect(result.current.availableModels.map((model) => model.id)).toContain(
        "openai/gpt-5.4-pro",
      );
    });
    expect(
      result.current.availableModels.find(
        (model) => model.id === "openai/gpt-5.4-pro",
      )?.disabled,
    ).toBeUndefined();
    unmount();
  });
});
