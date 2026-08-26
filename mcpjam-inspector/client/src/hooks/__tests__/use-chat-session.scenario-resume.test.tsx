import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useChatSession } from "../use-chat-session";
import { invalidateChatHistoryPrefetch } from "@/components/chat-v2/history/chat-history-prefetch";
import {
  readScenarioChatTranscript,
  scenarioChatTranscriptStorageKey,
  writeScenarioChatTranscript,
} from "@/lib/scenario-chat-transcript";

/**
 * BB-51: the tester (scenario) surface must survive a refresh. A refresh is a
 * remount with the same sessionStorage, so that is exactly what these tests
 * do — render, converse, unmount, render again — and assert the second mount
 * comes back with the transcript AND the same `chatSessionId`, so the resumed
 * turns keep appending to one server-side thread instead of forking one per
 * refresh.
 */

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
  // Which `Chat` instance each send landed on, keyed by the session id the
  // instance was created for. Real `useChat` recreates its `Chat` on every `id`
  // change and returns that instance's own `sendMessage`, so a send always
  // appends to the store of the instance it came from. A send routed to a stale
  // instance therefore posts the ORIGINAL untruncated history — invisible if
  // the mock hands every id the same spy. See the mock below.
  sendsBySession: new Map<string, any[]>(),
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
  isMCPJamProvidedModelMenuItem: vi.fn((model: { id: string }) =>
    String(model.id).includes("/")
  ),
}));

// The hosted-model catalog hook fetches `/api/mcp/models` for everyone now;
// stub it so it doesn't pollute this test's fetch assertions.
vi.mock("@/hooks/use-hosted-model-catalog", () => ({
  useHostedModelCatalog: () => ({ hostedCatalog: [], status: "fallback" }),
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
  // useChatSession resolves the Convex client to submit elicitation answers
  // straight to the rendezvous table (the blocked replica isn't addressable).
  useConvex: () => ({ mutation: vi.fn().mockResolvedValue({ ok: true }) }),
  useConvexAuth: () => ({
    isAuthenticated: true,
    isLoading: false,
  }),
  // useChatSession reads the credit balance (to lock free models at 0
  // credits); no balance in these tests → outOfCredits resolves false.
  useQuery: () => undefined,
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
        [id]
      );
      const subscribe = React.useCallback(
        (listener: () => void) => {
          const listeners = getListeners(id);
          listeners.add(listener);
          return () => {
            listeners.delete(listener);
          };
        },
        [id]
      );
      const messages = React.useSyncExternalStore(
        subscribe,
        getSnapshot,
        getSnapshot
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
        []
      );

      // Bound to THIS render's `id`, mirroring the real hook: `useChat` returns
      // `chatRef.current.sendMessage`, a per-instance arrow property
      // (`node_modules/ai/dist/index.mjs`) on a `Chat` that is recreated
      // whenever `id` changes (`node_modules/@ai-sdk/react/dist/index.mjs`).
      // A single identity-stable spy shared across ids would make it impossible
      // to tell "sent on the branch" from "sent on the pre-branch instance" —
      // the failure mode `rewindToMessage`'s `sendMessageRef` exists to prevent.
      const sendMessage = React.useCallback(
        (payload: any) => {
          const sends = mockState.sendsBySession.get(id);
          if (sends) {
            sends.push(payload);
          } else {
            mockState.sendsBySession.set(id, [payload]);
          }
          return mockState.sendMessage({ sessionId: id, ...payload });
        },
        [id]
      );

      return {
        messages,
        sendMessage,
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

describe("useChatSession scenario transcript resume", () => {
  const SCENARIO_ID = "scn_1";

  const userMessage = {
    id: "user-1",
    role: "user",
    parts: [{ type: "text", text: "hello from the tester" }],
  } as any;
  const assistantMessage = {
    id: "assistant-1",
    role: "assistant",
    parts: [{ type: "text", text: "hi back" }],
  } as any;

  const scenarioOptions = {
    selectedServers: [] as string[],
    hostedContext: {
      projectId: "project-1",
      scenarioId: SCENARIO_ID,
      selectedServerIds: [] as string[],
    },
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    invalidateChatHistoryPrefetch();
    mockState.sendMessage.mockReset();
    mockState.sessionMessages.clear();
    mockState.sessionListeners.clear();
    mockState.sendsBySession.clear();
    mockState.nextSessionNumber = 1;
    mockState.lastTransportOptions = null;
    mockState.status = "ready";
    sessionStorage.clear();
  });

  it("restores the transcript and the chat session id on the next mount", async () => {
    const first = renderHook(() => useChatSession(scenarioOptions));
    const originalChatSessionId = first.result.current.chatSessionId;

    act(() => {
      first.result.current.setMessages([userMessage, assistantMessage]);
    });
    await waitFor(() => {
      expect(
        readScenarioChatTranscript(SCENARIO_ID)?.messages
      ).toHaveLength(2);
    });
    first.unmount();

    // The AI SDK store is per-`Chat`-instance and does not survive a reload;
    // clearing it is what makes this a refresh rather than a re-render.
    mockState.sessionMessages.clear();
    mockState.sessionListeners.clear();

    const second = renderHook(() => useChatSession(scenarioOptions));
    expect(second.result.current.chatSessionId).toBe(originalChatSessionId);
    await waitFor(() => {
      expect(second.result.current.messages).toEqual([
        userMessage,
        assistantMessage,
      ]);
    });
  });

  it("does not resume on a surface that is not a scenario", async () => {
    // Same storage, no scenarioId: the dashboard resumes through its own
    // history rail, and inheriting a tester transcript there would be a leak.
    writeScenarioChatTranscript(SCENARIO_ID, {
      chatSessionId: "chat-session-stored",
      messages: [userMessage, assistantMessage],
    });

    const { result } = renderHook(() =>
      useChatSession({
        selectedServers: [],
        hostedContext: { projectId: "project-1", selectedServerIds: [] },
      })
    );

    expect(result.current.chatSessionId).not.toBe("chat-session-stored");
    expect(result.current.messages).toEqual([]);
  });

  it("clears the stored transcript when the tester resets the chat", async () => {
    const { result } = renderHook(() => useChatSession(scenarioOptions));

    act(() => {
      result.current.setMessages([userMessage, assistantMessage]);
    });
    await waitFor(() => {
      expect(readScenarioChatTranscript(SCENARIO_ID)).not.toBeNull();
    });

    act(() => {
      result.current.resetChat();
    });

    await waitFor(() => {
      expect(readScenarioChatTranscript(SCENARIO_ID)).toBeNull();
    });
  });

  it("does not store a turn that is still streaming", async () => {
    mockState.status = "streaming";
    const { result } = renderHook(() => useChatSession(scenarioOptions));

    act(() => {
      result.current.setMessages([userMessage]);
    });

    // Nothing written at all — a half-streamed assistant turn must never be
    // what a refresh brings back.
    await waitFor(() => {
      expect(result.current.messages).toEqual([userMessage]);
    });
    expect(
      sessionStorage.getItem(scenarioChatTranscriptStorageKey(SCENARIO_ID))
    ).toBeNull();
  });
});
