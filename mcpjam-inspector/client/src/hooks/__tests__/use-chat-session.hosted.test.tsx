import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, beforeEach, vi } from "vitest";
import { useChatSession } from "../use-chat-session";

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const mockState = vi.hoisted(() => ({
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
  authFetch: vi.fn(async () => new Response(null, { status: 200 })),
  getHostedAuthorizationHeader: vi.fn(async () => "Bearer hosted-token"),
  transportInstances: [] as Array<{
    options: any;
    sendMessages: ReturnType<typeof vi.fn>;
  }>,
  renderTransports: [] as any[],
  sendCalls: [] as Array<{ id: string; transport: any; message: any }>,
}));

const baseModel = {
  id: "openai/gpt-5-mini",
  name: "GPT-5 Mini",
  provider: "openai" as const,
};

async function resolveConfig<T>(value: T | (() => T | Promise<T>)) {
  return typeof value === "function"
    ? await (value as () => T | Promise<T>)()
    : value;
}

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
    selectedModelId: "openai/gpt-5-mini",
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
  authFetch: mockState.authFetch,
}));

vi.mock("@/lib/apis/web/context", () => ({
  getHostedAuthorizationHeader: mockState.getHostedAuthorizationHeader,
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

        mockState.renderTransports.push({ id, transport });

        return {
          messages: [],
          sendMessage: async (message: any) => {
            mockState.sendCalls.push({
              id: latchedIdRef.current,
              transport: latchedTransportRef.current,
              message,
            });
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
      mockState.transportInstances.push(this);
    }
  },
  generateId: vi.fn(() => "chat-session-id"),
  lastAssistantMessageIsCompleteWithApprovalResponses: vi.fn(),
}));

describe("useChatSession hosted mode", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockState.authFetch.mockResolvedValue(new Response(null, { status: 200 }));
    mockState.getHostedAuthorizationHeader.mockResolvedValue(
      "Bearer hosted-token",
    );
    mockState.transportInstances = [];
    mockState.renderTransports = [];
    mockState.sendCalls = [];
  });

  it("keeps the initial transport latched and resolves hosted auth at request time", async () => {
    const authBootstrap = createDeferred<string | null>();
    mockState.getHostedAuthorizationHeader.mockImplementationOnce(
      () => authBootstrap.promise,
    );
    const selectedServers = ["server-1"];
    const hostedSelectedServerIds = ["server-id-1"];

    const { result } = renderHook(() =>
      useChatSession({
        selectedServers,
        hostedWorkspaceId: "workspace-1",
        hostedSelectedServerIds,
        hostedShareToken: "share-token",
      }),
    );

    expect(mockState.transportInstances).toHaveLength(1);
    const initialTransport = mockState.transportInstances[0];

    authBootstrap.resolve("Bearer hosted-token");

    await waitFor(() => {
      expect(result.current.isAuthReady).toBe(true);
    });

    expect(mockState.transportInstances).toHaveLength(1);

    act(() => {
      result.current.sendMessage({ text: "hello" });
    });

    await waitFor(() => {
      expect(initialTransport.sendMessages).toHaveBeenCalledTimes(1);
    });
    await waitFor(() => {
      expect(mockState.authFetch).toHaveBeenCalledTimes(1);
    });

    const [api, init] = mockState.authFetch.mock.calls[0];
    expect(api).toBe("/api/web/chat-v2");
    expect(init.headers).toBeUndefined();

    const requestBody = JSON.parse(String(init.body));
    expect(result.current.chatSessionId).toBe("chat-session-id");
    expect(requestBody).toMatchObject({
      workspaceId: "workspace-1",
      chatSessionId: "chat-session-id",
      selectedServerIds: ["server-id-1"],
      shareToken: "share-token",
      accessScope: "chat_v2",
    });
    expect(mockState.sendCalls[0]?.transport).toBe(initialTransport);
  });

  it("includes sandbox token in the hosted transport body", () => {
    const selectedServers = ["server-1"];
    const hostedSelectedServerIds = ["server-id-2"];

    renderHook(() =>
      useChatSession({
        selectedServers,
        hostedWorkspaceId: "workspace-2",
        hostedSelectedServerIds,
        hostedSandboxToken: "sandbox-token",
      }),
    );

    expect(mockState.transportInstances).toHaveLength(1);
    const body = mockState.transportInstances[0].options.body();
    expect(body).toMatchObject({
      workspaceId: "workspace-2",
      chatSessionId: "chat-session-id",
      selectedServerIds: ["server-id-2"],
      sandboxToken: "sandbox-token",
      accessScope: "chat_v2",
    });
  });
});
