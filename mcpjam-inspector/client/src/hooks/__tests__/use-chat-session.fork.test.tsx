import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useChatSession } from "../use-chat-session";
import { invalidateChatHistoryPrefetch } from "@/components/chat-v2/history/chat-history-prefetch";

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
  onFinish: null as null | ((event: any) => void),
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
    String(model.id).includes("/"),
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
    useChat: vi.fn(
      ({ id, onFinish }: { id: string; onFinish?: (event: any) => void }) => {
        mockState.onFinish = onFinish ?? null;
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
              typeof updater === "function"
                ? updater(previousMessages)
                : updater;
            mockState.sessionMessages.set(activeId, nextMessages);
            for (const listener of getListeners(activeId)) {
              listener();
            }
          },
          [],
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
          [id],
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
      },
    ),
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
    // The blob/detail caches are module-level; clear between tests that reuse
    // URLs like "https://storage.test/restored.json" with different responses.
    invalidateChatHistoryPrefetch();
    // `clearAllMocks` clears calls but NOT implementations, so a
    // `mockImplementation` set inside one test would otherwise still be
    // installed for every test after it. Reset the send spy explicitly.
    mockState.sendMessage.mockReset();
    mockState.sessionMessages.clear();
    mockState.sessionListeners.clear();
    mockState.sendsBySession.clear();
    mockState.nextSessionNumber = 1;
    mockState.lastTransportOptions = null;
    mockState.onFinish = null;
    mockState.status = "ready";
  });

  it("timestamps a completed assistant without dropping its metadata", async () => {
    const { result } = renderHook(() =>
      useChatSession({
        selectedServers: [],
        hostedContext: {
          projectId: "project-1",
          selectedServerIds: [],
        },
      }),
    );
    const assistant = {
      id: "assistant-complete",
      role: "assistant",
      parts: [{ type: "text", text: "done" }],
      metadata: { totalTokens: 12 },
    } as any;

    act(() => result.current.setMessages([assistant]));
    act(() => {
      mockState.onFinish?.({ isAbort: false, message: assistant });
    });

    await waitFor(() => {
      expect(result.current.messages[0]?.metadata).toMatchObject({
        totalTokens: 12,
        timestampMs: expect.any(Number),
      });
    });
  });

  it("preserves trimmed messages across a fork and updates the hosted transport body", async () => {
    const selectedServers: string[] = [];
    const hostedSelectedServerIds: string[] = [];
    const { result } = renderHook(() =>
      useChatSession({
        selectedServers,
        hostedContext: {
          projectId: "project-1",
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
      projectId: "project-1",
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
          projectId: "project-1",
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
          projectId: "project-1",
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
          projectId: "project-1",
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
          projectId: "project-1",
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
            projectId: "project-1",
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
            projectId: "project-1",
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

  it("populates liveTraceEnvelope.messages from the restored transcript so trace timeline can resolve tool input/output", async () => {
    // Transcript with one tool call so the trace timeline can resolve its
    // input/output. The same shape we read from a real session blob via
    // transcriptToUIMessages → dynamic-tool part.
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify([
            { role: "user", content: "show me barca" },
            {
              role: "assistant",
              content: [
                {
                  type: "tool-call",
                  toolCallId: "call-1",
                  toolName: "show-squad",
                  input: { team: "Barcelona" },
                },
              ],
            },
            {
              role: "tool",
              content: [
                {
                  type: "tool-result",
                  toolCallId: "call-1",
                  toolName: "show-squad",
                  output: { type: "json", value: { players: [] } },
                  result: { players: [] },
                },
              ],
            },
          ]),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);

    // Override the module-level stub so traceTranscriptFromUi reflects the
    // loaded messages. The default mock returns [], which would mask the fix
    // because pickTranscriptForLiveTracePreview would have nothing to pick.
    const { convertToModelMessages } = await import("ai");
    vi.mocked(convertToModelMessages).mockImplementation(
      async (messages) =>
        // Pass-through: the rehydrated UIMessages already carry tool-call /
        // tool-result parts in the shape extractToolData expects.
        (messages ?? []) as any,
    );

    const { result } = renderHook(() =>
      useChatSession({
        selectedServers: [],
        hostedContext: {
          projectId: "project-1",
          selectedServerIds: [],
        },
      }),
    );

    act(() => {
      void result.current.loadChatSession({
        chatSessionId: "restored-with-tools",
        messagesBlobUrl: "https://storage.test/restored-with-tools.json",
        version: 1,
        turnTraces: [
          {
            turnId: "turn-1",
            promptIndex: 0,
            startedAt: 1000,
            endedAt: 2000,
          },
        ],
      });
    });

    await waitFor(() => {
      expect(result.current.chatSessionId).toBe("restored-with-tools");
      expect(result.current.messages.length).toBeGreaterThan(0);
    });
    expect(result.current.messages[0]?.metadata).toMatchObject({
      timestampMs: 1000,
    });
    expect(
      result.current.messages.find((message) => message.role === "assistant")
        ?.metadata,
    ).toMatchObject({ timestampMs: 2000 });

    // Trace envelope picks up the rehydrated UI transcript, so timeline lookups
    // by toolCallId hit the tool-call/tool-result parts instead of an empty
    // messages array.
    await waitFor(() => {
      const envelopeMessages = result.current.liveTraceEnvelope?.messages ?? [];
      expect(envelopeMessages.length).toBeGreaterThan(0);
      const assistant = envelopeMessages.find(
        (m: any) => m.role === "assistant",
      );
      const parts = Array.isArray(assistant?.parts) ? assistant.parts : [];
      expect(
        parts.some(
          (p: any) =>
            (p.type === "dynamic-tool" || p.type === "tool-call") &&
            p.toolCallId === "call-1",
        ),
      ).toBe(true);
    });
  });

  it("restores empty sessions even when the transcript blob URL is missing", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() =>
      useChatSession({
        selectedServers: [],
        hostedContext: {
          projectId: "project-1",
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

  it("branches to a new session and only sends once the new id is live", async () => {
    const { result } = renderHook(() =>
      useChatSession({
        selectedServers: [],
        hostedContext: {
          projectId: "project-1",
          selectedServerIds: [],
        },
      }),
    );
    const initialChatSessionId = result.current.chatSessionId;

    const firstUser = {
      id: "user-1",
      role: "user",
      parts: [{ type: "text", text: "first" }],
    } as any;
    const firstAssistant = {
      id: "assistant-1",
      role: "assistant",
      parts: [{ type: "text", text: "reply" }],
    } as any;
    const secondUser = {
      id: "user-2",
      role: "user",
      parts: [{ type: "text", text: "second" }],
    } as any;

    act(() => {
      result.current.setMessages([firstUser, firstAssistant, secondUser]);
    });

    // The race being guarded: the transport `body()` closes over the render's
    // chatSessionId, so a send issued before hydration lands would write the
    // branch's first turn to the ORIGINAL session row.
    let bodyAtSend: Record<string, unknown> | undefined;
    mockState.sendMessage.mockImplementation(() => {
      bodyAtSend = mockState.lastTransportOptions.body();
    });

    // Not wrapped in `act(async () => ...)`: the promise `rewindToMessage`
    // returns only resolves once a `useLayoutEffect` fires after React commits
    // the new `chatSessionId`. An enclosing async `act()` callback defers that
    // very flush until its own promise settles, which is what we're awaiting —
    // a deadlock. Awaiting the hook method directly (as the codebase's
    // `loadChatSession` tests already do for the same hydration machinery)
    // lets React's normal act-environment scheduling flush in between.
    const outcome = await result.current.rewindToMessage({
      messageId: "user-2",
      text: "second, rephrased",
    });

    expect(outcome).toEqual({ previousChatSessionId: initialChatSessionId });
    expect(result.current.chatSessionId).not.toBe(initialChatSessionId);
    const branchChatSessionId = result.current.chatSessionId;
    // Prefix only: the target message and everything after it are dropped.
    expect(result.current.messages).toEqual([firstUser, firstAssistant]);

    await waitFor(() => {
      expect(mockState.sendMessage).toHaveBeenCalled();
    });
    expect(bodyAtSend).toMatchObject({
      chatSessionId: branchChatSessionId,
      rewind: {
        parentChatSessionId: initialChatSessionId,
        rewoundFromMessageId: "user-2",
        reason: "message_edit",
      },
    });

    // THE assertion for the second half of the race. `bodyAtSend` above
    // reads the transport, which is a stable proxy over a ref — it says the
    // branch id, whether or not the send ran on the branch's own `Chat`. This
    // says WHICH instance's `sendMessage` was invoked. A `rewindToMessage` that
    // closes over the pre-await `sendMessage` sends on the pre-branch instance,
    // whose message state is the full untruncated transcript, so the POST would
    // carry the branch id with the original history and the response would
    // stream into a store nothing renders.
    expect(mockState.sendsBySession.get(branchChatSessionId)).toEqual([
      {
        text: "second, rephrased",
        metadata: { timestampMs: expect.any(Number) },
      },
    ]);
    expect(mockState.sendsBySession.has(initialChatSessionId)).toBe(false);
    expect(mockState.sendMessage).toHaveBeenCalledWith({
      sessionId: branchChatSessionId,
      text: "second, rephrased",
      metadata: { timestampMs: expect.any(Number) },
    });

    // The feature's central claim: the original session's transcript is intact.
    // Branching means the original row is never rewritten, so the discarded
    // messages survive in the backend rather than being overwritten by the
    // truncated prefix.
    expect(mockState.sessionMessages.get(initialChatSessionId)).toEqual([
      firstUser,
      firstAssistant,
      secondUser,
    ]);
  });

  it("clears resumedVersion so the branch's first ingest carries no expectedVersion", async () => {
    const { result } = renderHook(() =>
      useChatSession({
        selectedServers: [],
        hostedContext: {
          projectId: "project-1",
          selectedServerIds: [],
        },
      }),
    );

    const user = {
      id: "user-1",
      role: "user",
      parts: [{ type: "text", text: "hello" }],
    } as any;

    act(() => {
      result.current.setMessages([user]);
      result.current.syncResumedVersion(7);
    });
    expect(result.current.resumedVersion).toBe(7);

    // Not wrapped in `act(async () => ...)` — see the comment in the previous
    // test: this call resolves via a `useLayoutEffect` after a commit, and an
    // enclosing async `act()` callback would defer that flush until its own
    // promise settles, deadlocking against the very thing it's awaiting.
    await result.current.rewindToMessage({
      messageId: "user-1",
      text: "hello again",
    });

    expect(result.current.resumedVersion).toBeNull();
  });

  it("refuses to rewind while a turn is in flight", async () => {
    const { result, rerender } = renderHook(() =>
      useChatSession({
        selectedServers: [],
        hostedContext: {
          projectId: "project-1",
          selectedServerIds: [],
        },
      }),
    );
    const initialChatSessionId = result.current.chatSessionId;

    act(() => {
      result.current.setMessages([
        {
          id: "user-1",
          role: "user",
          parts: [{ type: "text", text: "hello" }],
        } as any,
      ]);
    });

    // statusRef is assigned during render, so the new status needs a re-render
    // before the guard can observe it.
    mockState.status = "streaming";
    rerender();

    let outcome: { previousChatSessionId: string } | null = null;
    await act(async () => {
      outcome = await result.current.rewindToMessage({
        messageId: "user-1",
        text: "should not send",
      });
    });

    expect(outcome).toBeNull();
    expect(result.current.chatSessionId).toBe(initialChatSessionId);
    expect(mockState.sendMessage).not.toHaveBeenCalled();
  });

  it("allows a rewind after a failed turn", async () => {
    const { result, rerender } = renderHook(() =>
      useChatSession({
        selectedServers: [],
        hostedContext: {
          projectId: "project-1",
          selectedServerIds: [],
        },
      }),
    );
    const initialChatSessionId = result.current.chatSessionId;

    act(() => {
      result.current.setMessages([
        {
          id: "user-1",
          role: "user",
          parts: [{ type: "text", text: "hello" }],
        } as any,
      ]);
    });

    // statusRef is assigned during render, so the new status needs a re-render
    // before the guard can observe it.
    mockState.status = "error";
    rerender();

    // Deliberately NOT refused: rewinding is the natural way to recover from
    // a failed turn, and the prefix excludes the broken tail by construction.
    // Not wrapped in `act(async () => ...)` — see the earlier comment: this
    // call resolves via a `useLayoutEffect` after a commit, and an enclosing
    // async `act()` callback would deadlock against the flush it's waiting on.
    const outcome = await result.current.rewindToMessage({
      messageId: "user-1",
      text: "retry after failure",
    });

    expect(outcome).toEqual({ previousChatSessionId: initialChatSessionId });
    expect(result.current.chatSessionId).not.toBe(initialChatSessionId);

    await waitFor(() => {
      expect(mockState.sendMessage).toHaveBeenCalled();
    });
    // Sent on the BRANCH's own Chat instance, not the pre-branch one.
    expect(mockState.sendMessage).toHaveBeenCalledWith({
      sessionId: result.current.chatSessionId,
      text: "retry after failure",
      metadata: { timestampMs: expect.any(Number) },
    });
  });

  it("reports failure when the send's own preflight fails closed after the branch is minted", async () => {
    // `sendMessage` has an async preflight (hosted server-id resolution) that
    // returns early with its own error toast and never calls `baseSendMessage`.
    // It runs AFTER the branch has been minted, so a fire-and-forget send would
    // let `rewindToMessage` report "New branch created" while the edited turn
    // never ran — an orphan branch, with the original thread detached and the
    // user sitting on a truncated prefix. Awaiting the send makes the outcome
    // honest: `null`, so callers stay silent.
    const ensureServerIds = vi
      .fn()
      .mockRejectedValue(new Error("could not resolve servers"));
    const { result } = renderHook(() =>
      useChatSession({
        selectedServers: ["server-1"],
        hostedContext: {
          projectId: "project-1",
          selectedServerIds: [],
          ensureServerIds,
        },
      }),
    );
    const initialChatSessionId = result.current.chatSessionId;

    act(() => {
      result.current.setMessages([
        {
          id: "user-1",
          role: "user",
          parts: [{ type: "text", text: "hello" }],
        } as any,
      ]);
    });

    // Not wrapped in `act(async () => ...)` — see the earlier comment: this
    // call resolves via a `useLayoutEffect` after a commit, and an enclosing
    // async `act()` callback would deadlock against the flush it awaits.
    const outcome = await result.current.rewindToMessage({
      messageId: "user-1",
      text: "edited but undeliverable",
    });

    expect(ensureServerIds).toHaveBeenCalled();
    // The preflight swallowed the send, so no turn was dispatched anywhere.
    expect(mockState.sendMessage).not.toHaveBeenCalled();
    // The branch itself did commit — that is unavoidable, the mint happens
    // before the send. What must NOT happen is reporting it as a success the
    // caller then announces and offers a way back from.
    expect(result.current.chatSessionId).not.toBe(initialChatSessionId);
    expect(outcome).toBeNull();
  });

  it("is a no-op when the target message is no longer in the thread", async () => {
    const { result } = renderHook(() =>
      useChatSession({
        selectedServers: [],
        hostedContext: {
          projectId: "project-1",
          selectedServerIds: [],
        },
      }),
    );
    const initialChatSessionId = result.current.chatSessionId;

    act(() => {
      result.current.setMessages([
        {
          id: "user-1",
          role: "user",
          parts: [{ type: "text", text: "hello" }],
        } as any,
      ]);
    });

    let outcome: { previousChatSessionId: string } | null = null;
    await act(async () => {
      outcome = await result.current.rewindToMessage({
        messageId: "user-does-not-exist",
        text: "should not send",
      });
    });

    expect(outcome).toBeNull();
    expect(result.current.chatSessionId).toBe(initialChatSessionId);
    expect(mockState.sendMessage).not.toHaveBeenCalled();
  });

  it("detachToLocalFork points subsequent sends at the NEW session, not the detached one", async () => {
    // The exact production failure this exists to stop: the detach path used to
    // fire-and-forget `startChatWithMessages`, and post-detach turns kept
    // writing to the OLD chatSessionId — which is how they reached the ingest
    // replay heuristic on the old row and got silently dropped.
    const { result } = renderHook(() =>
      useChatSession({
        selectedServers: [],
        hostedContext: {
          projectId: "project-1",
          selectedServerIds: [],
        },
      }),
    );
    const detachedChatSessionId = result.current.chatSessionId;

    const user = {
      id: "user-1",
      role: "user",
      parts: [{ type: "text", text: "hello" }],
    } as any;
    const assistant = {
      id: "assistant-1",
      role: "assistant",
      parts: [{ type: "text", text: "reply" }],
    } as any;

    act(() => {
      result.current.setMessages([user, assistant]);
      result.current.syncResumedVersion(7);
    });

    let bodyAtSend: Record<string, unknown> | undefined;
    mockState.sendMessage.mockImplementation(() => {
      bodyAtSend = mockState.lastTransportOptions.body();
    });

    // Not wrapped in `act(async () => ...)` — resolution rides a
    // `useLayoutEffect` after commit, which an enclosing async act() would
    // defer until its own promise settles. See the rewind tests above.
    const fork = await result.current.detachToLocalFork([user, assistant]);

    expect(fork).not.toBeNull();
    expect(fork!.chatSessionId).not.toBe(detachedChatSessionId);
    expect(result.current.chatSessionId).toBe(fork!.chatSessionId);
    // The transcript rides across so the user keeps seeing their conversation.
    expect(result.current.messages).toEqual([user, assistant]);
    // The fork's hydration drops the guard, so its first ingest carries no
    // expectedVersion against a row it has never written to.
    expect(result.current.resumedVersion).toBeNull();

    await act(async () => {
      await result.current.sendMessage({ text: "after the detach" });
    });

    expect(bodyAtSend).toMatchObject({ chatSessionId: fork!.chatSessionId });
    // Says WHICH Chat instance ran the send — a stale instance would post the
    // detached session's own store. The transport body alone cannot show this.
    expect(mockState.sendsBySession.has(detachedChatSessionId)).toBe(false);
    expect(mockState.sendsBySession.get(fork!.chatSessionId)).toEqual([
      {
        text: "after the detach",
        metadata: { timestampMs: expect.any(Number) },
      },
    ]);
  });

  it("detachToLocalFork returns null and leaves the interloper's resumedVersion alone", async () => {
    // A superseded hydration resolves the same promise as a committed one, so
    // resolution is not proof. When a history-thread load wins the race the
    // live session is now that thread — clearing ITS optimistic-concurrency
    // guard would let the next send clobber whatever another tab wrote.
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify([
            { id: "restored-user", role: "user", content: "restored question" },
          ]),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() =>
      useChatSession({
        selectedServers: [],
        hostedContext: {
          projectId: "project-1",
          selectedServerIds: [],
        },
      }),
    );

    const user = {
      id: "user-1",
      role: "user",
      parts: [{ type: "text", text: "hello" }],
    } as any;

    act(() => {
      result.current.setMessages([user]);
    });

    let fork: { chatSessionId: string } | null = null;
    const detachPromise = result.current.detachToLocalFork([user]).then((r) => {
      fork = r;
    });
    void result.current.loadChatSession({
      chatSessionId: "restored-session",
      messagesBlobUrl: "https://storage.test/detach-race.json",
      version: 7,
    });
    await detachPromise;

    await waitFor(() => {
      expect(result.current.chatSessionId).toBe("restored-session");
    });

    expect(fork).toBeNull();
    // Not null: the detach must not tear down the guard belonging to the
    // session that actually went live.
    expect(result.current.resumedVersion).toBe(7);
  });

  it("refuses to send when a concurrent session switch wins the race", async () => {
    const { result } = renderHook(() =>
      useChatSession({
        selectedServers: [],
        hostedContext: {
          projectId: "project-1",
          selectedServerIds: [],
        },
      }),
    );

    act(() => {
      result.current.setMessages([
        {
          id: "user-1",
          role: "user",
          parts: [{ type: "text", text: "hello" }],
        } as any,
      ]);
    });

    // This guards against silent cross-session contamination: a session
    // switch (here, `resetChat`) racing the branch's own commit must refuse
    // the send rather than redirect the edited message into whatever session
    // the interloper installed. `startChatWithMessages`'s hydration promise
    // resolves via `clearPendingSessionHydration` either way — normal commit
    // or superseded — so `rewindToMessage` must not treat resolution alone as
    // proof its own branch id went live.
    //
    // Both calls run synchronously, in the same tick, with no `await` in
    // between: React's automatic-batching flush (scheduled at the FIRST
    // `setChatSessionId` call, i.e. this rewind's own mint) settles on
    // whichever id was set LAST — `resetChat`'s fresh id — before either
    // promise continuation gets a turn. That fresh id is neither
    // `previousChatSessionId` nor the id `rewindToMessage` minted, which is
    // exactly the case the old "still equals the original" check missed.
    let outcome: { previousChatSessionId: string } | null = null;
    const rewindPromise = result.current
      .rewindToMessage({ messageId: "user-1", text: "edited" })
      .then((r) => {
        outcome = r;
      });
    result.current.resetChat();
    await rewindPromise;

    expect(outcome).toBeNull();
    expect(mockState.sendMessage).not.toHaveBeenCalled();
  });
});
