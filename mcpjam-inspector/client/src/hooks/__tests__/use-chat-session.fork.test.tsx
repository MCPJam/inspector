import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useChatSession } from "../use-chat-session";

const mockState = vi.hoisted(() => ({
  sendMessage: vi.fn(),
  stop: vi.fn(),
  status: "ready" as "submitted" | "streaming" | "ready" | "error",
  addToolApprovalResponse: vi.fn(),
  getAccessToken: vi.fn(() => new Promise<string | null>(() => {})),
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
  toolsMetadataResult: {
    metadata: {},
    toolServerMap: {},
    tokenCounts: null,
  },
  sessionMessages: new Map<string, any[]>(),
  sessionListeners: new Map<string, Set<() => void>>(),
  nextSessionNumber: 1,
  lastTransportOptions: null as any,
}));

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
    selectedModelIds: ["gpt-4.1-mini"],
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
  getToolsMetadata: vi.fn(async () => mockState.toolsMetadataResult),
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

vi.mock("@ai-sdk/react", async () => {
  const React = await import("react");
  const EMPTY_MESSAGES: any[] = [];

  const getListeners = (id: string) => {
    const listeners = mockState.sessionListeners.get(id);
    if (listeners) {
      return listeners;
    }

    const nextListeners = new Set<() => void>();
    mockState.sessionListeners.set(id, nextListeners);
    return nextListeners;
  };

  return {
    useChat: vi.fn(({ id }: { id: string }) => {
      const currentIdRef = React.useRef(id);
      currentIdRef.current = id;
      const getSnapshot = React.useCallback(
        () => mockState.sessionMessages.get(id) ?? EMPTY_MESSAGES,
        [id],
      );
      const subscribe = React.useCallback(
        (listener: () => void) => {
          const listeners = getListeners(id);
          listeners.add(listener);
          return () => {
            listeners.delete(listener);
          };
        },
        [id],
      );
      const messages = React.useSyncExternalStore(
        subscribe,
        getSnapshot,
        getSnapshot,
      );
      const setMessages = React.useCallback(
        (updater: any[] | ((messages: any[]) => any[])) => {
          const activeId = currentIdRef.current;
          const previousMessages =
            mockState.sessionMessages.get(activeId) ?? [];
          const nextMessages =
            typeof updater === "function" ? updater(previousMessages) : updater;
          mockState.sessionMessages.set(activeId, nextMessages);
          for (const listener of getListeners(activeId)) {
            listener();
          }
        },
        [],
      );

      return {
        messages,
        sendMessage: mockState.sendMessage,
        stop: mockState.stop,
        status: mockState.status,
        error: undefined,
        setMessages,
        addToolApprovalResponse: mockState.addToolApprovalResponse,
      };
    }),
  };
});

vi.mock("ai", () => ({
  DefaultChatTransport: class MockTransport {
    constructor(options: unknown) {
      mockState.lastTransportOptions = options;
    }
  },
  generateId: vi.fn(() => `chat-session-${mockState.nextSessionNumber++}`),
  lastAssistantMessageIsCompleteWithApprovalResponses: vi.fn(),
  convertToModelMessages: vi.fn(async () => []),
}));

describe("useChatSession fork preservation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    mockState.sessionMessages.clear();
    mockState.sessionListeners.clear();
    mockState.nextSessionNumber = 1;
    mockState.lastTransportOptions = null;
    mockState.status = "ready";
  });

  it("preserves trimmed messages across a fork and updates the hosted transport body", async () => {
    const selectedServers: string[] = [];
    const hostedSelectedServerIds: string[] = [];
    const { result } = renderHook(() =>
      useChatSession({
        selectedServers,
        hostedContext: {
          workspaceId: "workspace-1",
          selectedServerIds: hostedSelectedServerIds,
        },
      }),
    );
    const initialChatSessionId = result.current.chatSessionId;

    const firstMessage = {
      id: "user-1",
      role: "user",
      parts: [{ type: "text", text: "hello" }],
    } as any;
    const secondMessage = {
      id: "assistant-1",
      role: "assistant",
      parts: [{ type: "text", text: "world" }],
    } as any;

    act(() => {
      result.current.setMessages([firstMessage, secondMessage]);
    });

    expect(result.current.chatSessionId).toBe(initialChatSessionId);
    expect(result.current.messages).toEqual([firstMessage, secondMessage]);

    act(() => {
      result.current.setMessages([firstMessage]);
    });

    await waitFor(() => {
      expect(result.current.chatSessionId).not.toBe(initialChatSessionId);
    });
    const forkedChatSessionId = result.current.chatSessionId;
    expect(result.current.messages).toEqual([firstMessage]);
    expect(mockState.lastTransportOptions.body()).toMatchObject({
      workspaceId: "workspace-1",
      chatSessionId: forkedChatSessionId,
      selectedServerIds: [],
      accessScope: "chat_v2",
    });
  });

  it("does not fork when only transient messages are removed", async () => {
    const selectedServers: string[] = [];
    const hostedSelectedServerIds: string[] = [];
    const { result } = renderHook(() =>
      useChatSession({
        selectedServers,
        hostedContext: {
          workspaceId: "workspace-1",
          selectedServerIds: hostedSelectedServerIds,
        },
      }),
    );
    const initialChatSessionId = result.current.chatSessionId;

    const persistentMessage = {
      id: "user-1",
      role: "user",
      parts: [{ type: "text", text: "hello" }],
    } as any;
    const transientMessage = {
      id: "widget-state-call-1",
      role: "assistant",
      parts: [{ type: "text", text: "internal state" }],
    } as any;

    act(() => {
      result.current.setMessages([persistentMessage, transientMessage]);
    });

    act(() => {
      result.current.setMessages([persistentMessage]);
    });

    expect(result.current.chatSessionId).toBe(initialChatSessionId);
    expect(result.current.messages).toEqual([persistentMessage]);
  });

  it("keeps resetChat as an intentional clear after changing session IDs", async () => {
    const selectedServers: string[] = [];
    const hostedSelectedServerIds: string[] = [];
    const { result } = renderHook(() =>
      useChatSession({
        selectedServers,
        hostedContext: {
          workspaceId: "workspace-1",
          selectedServerIds: hostedSelectedServerIds,
        },
      }),
    );
    const initialChatSessionId = result.current.chatSessionId;

    const message = {
      id: "user-1",
      role: "user",
      parts: [{ type: "text", text: "hello" }],
    } as any;

    act(() => {
      result.current.setMessages([message]);
    });

    expect(result.current.messages).toEqual([message]);

    act(() => {
      result.current.resetChat();
    });

    await waitFor(() => {
      expect(result.current.chatSessionId).not.toBe(initialChatSessionId);
    });
    expect(result.current.messages).toEqual([]);
  });

  it("starts a fresh session with seeded messages for handoff flows", async () => {
    const { result } = renderHook(() =>
      useChatSession({
        selectedServers: [],
        hostedContext: {
          workspaceId: "workspace-1",
          selectedServerIds: [],
        },
      }),
    );
    const initialChatSessionId = result.current.chatSessionId;

    act(() => {
      result.current.setMessages([
        {
          id: "old-user",
          role: "user",
          parts: [{ type: "text", text: "old" }],
        } as any,
      ]);
    });

    act(() => {
      result.current.startChatWithMessages([
        {
          id: "seed-user",
          role: "user",
          parts: [{ type: "text", text: "seeded prompt" }],
        } as any,
        {
          id: "seed-assistant",
          role: "assistant",
          parts: [{ type: "text", text: "seeded reply" }],
        } as any,
      ]);
    });

    await waitFor(() => {
      expect(result.current.chatSessionId).not.toBe(initialChatSessionId);
    });

    expect(result.current.messages).toEqual([
      {
        id: "seed-user",
        role: "user",
        parts: [{ type: "text", text: "seeded prompt" }],
      },
      {
        id: "seed-assistant",
        role: "assistant",
        parts: [{ type: "text", text: "seeded reply" }],
      },
    ]);
  });

  it("hydrates restored history into the new session store when loading a chat", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify([
            { id: "restored-user", role: "user", content: "restored question" },
            {
              id: "restored-assistant",
              role: "assistant",
              content: "restored answer",
            },
          ]),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() =>
      useChatSession({
        selectedServers: [],
        hostedContext: {
          workspaceId: "workspace-1",
          selectedServerIds: [],
        },
      }),
    );

    act(() => {
      result.current.setMessages([
        {
          id: "current-user",
          role: "user",
          parts: [{ type: "text", text: "current thread" }],
        } as any,
      ]);
    });

    act(() => {
      void result.current.loadChatSession({
        chatSessionId: "restored-session",
        messagesBlobUrl: "https://storage.test/restored.json",
        resumeConfig: {
          systemPrompt: "Restored prompt",
        },
        version: 7,
      });
    });

    await waitFor(() => {
      expect(result.current.chatSessionId).toBe("restored-session");
    });

    expect(result.current.messages).toEqual([
      {
        id: "restored-user",
        role: "user",
        parts: [{ type: "text", text: "restored question" }],
      },
      {
        id: "restored-assistant",
        role: "assistant",
        parts: [{ type: "text", text: "restored answer" }],
      },
    ]);
    expect(result.current.resumedVersion).toBe(7);
    expect(result.current.systemPrompt).toBe("Restored prompt");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://storage.test/restored.json",
    );
  });

  it("preserves a restored thread when selected servers change afterward", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify([
            {
              id: "restored-user",
              role: "user",
              content: "restored question",
            },
          ]),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const { result, rerender } = renderHook(
      ({ selectedServers }: { selectedServers: string[] }) =>
        useChatSession({
          selectedServers,
          hostedContext: {
            workspaceId: "workspace-1",
            selectedServerIds: [],
          },
        }),
      {
        initialProps: {
          selectedServers: ["server-1"],
        },
      },
    );

    act(() => {
      void result.current.loadChatSession({
        chatSessionId: "restored-session",
        messagesBlobUrl: "https://storage.test/restored.json",
        version: 7,
      });
    });

    await waitFor(() => {
      expect(result.current.chatSessionId).toBe("restored-session");
    });

    rerender({
      selectedServers: ["server-2"],
    });

    await waitFor(() => {
      expect(result.current.chatSessionId).toBe("restored-session");
    });

    expect(result.current.messages).toEqual([
      {
        id: "restored-user",
        role: "user",
        parts: [{ type: "text", text: "restored question" }],
      },
    ]);
    expect(result.current.resumedVersion).toBe(7);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("preserves a fresh thread and leaves in-flight responses alone when selected servers change", async () => {
    const onReset = vi.fn();
    const { result, rerender } = renderHook(
      ({ selectedServers }: { selectedServers: string[] }) =>
        useChatSession({
          selectedServers,
          hostedContext: {
            workspaceId: "workspace-1",
            selectedServerIds: [],
          },
          onReset,
        }),
      {
        initialProps: {
          selectedServers: ["server-1"],
        },
      },
    );
    const initialChatSessionId = result.current.chatSessionId;
    const message = {
      id: "user-1",
      role: "user",
      parts: [{ type: "text", text: "keep this thread" }],
    } as any;

    act(() => {
      result.current.setMessages([message]);
    });

    mockState.status = "streaming";
    rerender({
      selectedServers: ["server-2"],
    });

    await waitFor(() => {
      expect(onReset).toHaveBeenCalledWith("servers-changed");
    });

    expect(mockState.stop).not.toHaveBeenCalled();
    expect(result.current.chatSessionId).toBe(initialChatSessionId);
    expect(result.current.messages).toEqual([message]);
  });

  it("restores empty sessions even when the transcript blob URL is missing", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() =>
      useChatSession({
        selectedServers: [],
        hostedContext: {
          workspaceId: "workspace-1",
          selectedServerIds: [],
        },
      }),
    );

    act(() => {
      result.current.setMessages([
        {
          id: "current-user",
          role: "user",
          parts: [{ type: "text", text: "current thread" }],
        } as any,
      ]);
    });

    act(() => {
      void result.current.loadChatSession({
        chatSessionId: "restored-empty-session",
        messagesBlobUrl: null,
        resumeConfig: {
          systemPrompt: "Restored prompt",
        },
        version: 3,
      });
    });

    await waitFor(() => {
      expect(result.current.chatSessionId).toBe("restored-empty-session");
    });

    expect(result.current.messages).toEqual([]);
    expect(result.current.resumedVersion).toBe(3);
    expect(result.current.systemPrompt).toBe("Restored prompt");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
