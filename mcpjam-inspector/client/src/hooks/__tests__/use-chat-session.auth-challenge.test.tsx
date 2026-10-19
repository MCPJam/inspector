import { useChatAuthRecoveryFailures } from "@/lib/chat-auth-recovery";
import { renderHook, waitFor, act } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useChatSession } from "../use-chat-session";
import { AppStateProvider } from "@/state/app-state-context";
import {
  useAuthChallengeCardStore,
  useAuthChallengeNoticeStore,
} from "@/lib/auth-challenge-lifecycle";
import {
  AUTH_CHALLENGE_NOTICE_DATA_PART_TYPE,
  AUTH_REQUIRED_DATA_PART_TYPE,
  type AuthRequiredEvent,
} from "@/shared/auth-challenge";
import { isScopeStepUpDataPart } from "@/shared/scope-step-up";
import { listPendingChatScopeStepUps, savePendingChatScopeStepUp, markPendingChatScopeStepUpReady, readPendingChatScopeStepUp } from "@/lib/scope-step-up-pending";

/**
 * Mid-session sign-in in chat (client): the card arrives with no side
 * effects, a send without clicking cancels the suspended call in the same
 * request, and a reload rebuilds the card from the saved marker.
 */

const mockState = vi.hoisted(() => ({
  chatOnData: null as ((part: unknown) => void) | null,
  transportOptions: [] as Array<{ body?: () => unknown }>,
  chatStatus: "ready" as string,
  messages: [] as unknown[],
  convexMutation: vi.fn(async () => ({ ok: true })),
  setMessages: vi.fn(),
  sendMessage: vi.fn(async () => {}),
  stop: vi.fn(),
  addToolApprovalResponse: vi.fn(),
  getAccessToken: vi.fn(async (): Promise<string | null> => null),
  user: undefined as { id: string } | undefined,
  hasToken: vi.fn(() => false),
  getToken: vi.fn(() => ""),
  getOpenRouterSelectedModels: vi.fn(() => []),
  getOllamaBaseUrl: vi.fn(() => "http://127.0.0.1:11434"),
  getAzureBaseUrl: vi.fn(() => ""),
  getCustomProviderByName: vi.fn(),
  setSelectedModelId: vi.fn(),
  getToolsMetadata: vi.fn(async () => ({
    metadata: {},
    toolServerMap: {},
    tokenCounts: null,
  })),
  countTextTokens: vi.fn(async () => null),
  convexAuth: { isAuthenticated: true, isLoading: false },
  detectOllamaModels: vi.fn(async () => ({
    isRunning: false,
    availableModels: [],
  })),
  detectOllamaToolCapableModels: vi.fn(async () => []),
  idCounter: 0,
}));

// A BYOK model that does NOT route through the org runtime, so the transport
// body takes the non-hosted branch (no hosted project id is required).
const byokModel = {
  id: "gpt-4",
  name: "GPT-4",
  provider: "openai" as const,
};

function nextSessionId() {
  mockState.idCounter += 1;
  return `chat-session-${mockState.idCounter}`;
}

const orchestrator = vi.hoisted(() => ({
  applyToolCallStepUp: vi.fn(),
  applyToolCallAuthChallenge: vi.fn(async () => ({ kind: "pendingConnect" })),
  resetToolCallStepUp: vi.fn(),
  resetAuthChallenge: vi.fn(),
  markAuthChallengeSignedIn: vi.fn(() => 0),
  hasAuthChallengeAwaitingCallback: vi.fn(() => false),
}));
vi.mock("@/state/oauth-orchestrator", () => orchestrator);

vi.mock("@/lib/config", () => ({ HOSTED_MODE: false }));
vi.mock("@/lib/guest-session", async (importOriginal) => ({ ...await importOriginal<typeof import("@/lib/guest-session")>(), getGuestBearerToken: vi.fn(async () => null) }));

vi.mock("@/components/chat-v2/shared/model-helpers", () => ({
  buildAvailableModels: vi.fn(() => [byokModel]),
  getDefaultModel: vi.fn(() => byokModel),
  isMCPJamProvidedModelMenuItem: vi.fn(() => false),
}));

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
    selectedModelId: "gpt-4",
    setSelectedModelId: mockState.setSelectedModelId,
    selectedModelIds: ["gpt-4"],
    setSelectedModelIds: vi.fn(),
    multiModelEnabled: false,
    setMultiModelEnabled: vi.fn(),
  }),
}));

vi.mock("@/hooks/useSharedChatWidgetCapture", () => ({
  useSharedChatWidgetCapture: vi.fn(),
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
  useAuth: () => ({ getAccessToken: mockState.getAccessToken, user: mockState.user }),
}));

vi.mock("convex/react", () => ({
  useConvexAuth: () => mockState.convexAuth,
  useQuery: () => undefined,
  useQueries: () => ({}),
  useConvex: () => ({ mutation: mockState.convexMutation }),
}));

vi.mock("@ai-sdk/react", () => ({
  useChat: vi.fn((options: { onData?: (part: unknown) => void }) => {
    mockState.chatOnData = options.onData ?? null;
    return {
      messages: mockState.messages,
      sendMessage: mockState.sendMessage,
      stop: mockState.stop,
      status: mockState.chatStatus,
      error: undefined,
      setMessages: mockState.setMessages,
      addToolApprovalResponse: mockState.addToolApprovalResponse,
    };
  }),
}));

vi.mock("ai", () => ({
  DefaultChatTransport: class MockTransport {
    constructor(options: { body?: () => unknown }) {
      mockState.transportOptions.push(options);
    }
  },
  generateId: vi.fn(() => nextSessionId()),
  lastAssistantMessageIsCompleteWithApprovalResponses: vi.fn(),
  convertToModelMessages: vi.fn(async () => []),
}));


const server = {
  name: "orders",
  config: { type: "http", url: "https://orders.example/mcp" },
  connectionStatus: "connected",
  lastConnectionTime: new Date(),
  retryCount: 0,
  enabled: true,
};
let appState = {
  servers: { orders: server },
  projects: {},
  activeProjectId: "none",
} as never;

function wrapper({ children }: { children: ReactNode }) {
  return <AppStateProvider appState={appState}>{children}</AppStateProvider>;
}

function authRequiredEvent(
  overrides: Partial<AuthRequiredEvent> = {},
): AuthRequiredEvent {
  return {
    version: 1,
    kind: "auth_required",
    continuationId: "cont-1",
    serverId: "orders",
    serverName: "orders",
    toolCallId: "call-1",
    operation: { method: "tools/call", operation: "orders__list_orders" },
    source: "http_401",
    effectiveAuth: "discover",
    action: "prompt",
    readOnly: true,
    requiredScope: "orders:read",
    expiresAt: Date.now() + 600_000,
    ...overrides,
  };
}

async function renderChatSession() {
  const rendered = renderHook(
    () => useChatSession({ selectedServers: ["orders"] }),
    { wrapper },
  );
  await waitFor(() => {
    expect(mockState.chatOnData).not.toBeNull();
  });
  return rendered;
}

describe("useChatSession mid-session sign-in", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    sessionStorage.clear();
    useAuthChallengeCardStore.setState({ cards: {} });
    useAuthChallengeNoticeStore.setState({ notices: {} });
    mockState.chatOnData = null;
    mockState.transportOptions = [];
    mockState.chatStatus = "ready";
    mockState.idCounter = 0;
    mockState.messages = [];
    server.connectionStatus = "connected";
    mockState.user = undefined;
    mockState.getAccessToken.mockReset().mockResolvedValue(null);
    mockState.sendMessage.mockReset().mockResolvedValue(undefined);
    orchestrator.applyToolCallAuthChallenge.mockResolvedValue({
      kind: "pendingConnect",
    });
  });

  it("keeps the pending chat when the same member gets a refreshed token", async () => {
    const token = (iat: number) => `e30.${btoa(JSON.stringify({
      iss: "https://api.workos.com", sub: "member-1", iat, exp: iat + 3600,
    })).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_")}.signature`;
    mockState.user = { id: "member-1" };
    mockState.getAccessToken.mockResolvedValue(token(1000));
    const { result, rerender } = await renderChatSession();
    await waitFor(() =>
      expect(result.current.isSessionBootstrapComplete).toBe(true),
    );
    const originalId = result.current.chatSessionId;
    act(() =>
      mockState.chatOnData?.({
        type: AUTH_REQUIRED_DATA_PART_TYPE,
        data: authRequiredEvent(),
        transient: true,
      }),
    );
    mockState.setMessages.mockClear();
    mockState.user = { id: "member-1" };
    mockState.getAccessToken.mockResolvedValue(token(1100));
    rerender();
    await waitFor(() =>
      expect(result.current.isSessionBootstrapComplete).toBe(true),
    );
    expect(result.current.chatSessionId).toBe(originalId);
    expect(mockState.setMessages).not.toHaveBeenCalled();
    expect(readPendingChatScopeStepUp()?.chatSessionId).toBe(originalId);
  });

  it("resets the chat when the signed-in member changes", async () => {
    mockState.user = { id: "member-1" };
    mockState.getAccessToken.mockResolvedValue("first-token");
    const { result, rerender } = await renderChatSession();
    await waitFor(() =>
      expect(result.current.isSessionBootstrapComplete).toBe(true),
    );
    const originalId = result.current.chatSessionId;
    mockState.user = { id: "member-2" };
    // Identity changes must reset even before the token provider updates.
    mockState.getAccessToken.mockResolvedValue("first-token");
    rerender();
    await waitFor(() =>
      expect(result.current.chatSessionId).not.toBe(originalId),
    );
  });

  it("resets the chat when the member signs out", async () => {
    mockState.user = { id: "member-1" };
    mockState.getAccessToken.mockResolvedValue("first-token");
    const { result, rerender } = await renderChatSession();
    await waitFor(() =>
      expect(result.current.isSessionBootstrapComplete).toBe(true),
    );
    const originalId = result.current.chatSessionId;
    mockState.user = undefined;
    mockState.getAccessToken.mockResolvedValue(null);
    rerender();
    await waitFor(() =>
      expect(result.current.chatSessionId).not.toBe(originalId),
    );
  });

  it("shows the card and saves the marker, with no sign-in started", async () => {
    const { result } = await renderChatSession();
    act(() => {
      mockState.chatOnData?.({
        type: AUTH_REQUIRED_DATA_PART_TYPE,
        data: authRequiredEvent(),
        transient: true,
      });
    });
    await waitFor(() => {
      expect(
        Object.values(useAuthChallengeCardStore.getState().cards),
      ).toEqual([
        expect.objectContaining({
          serverName: "orders",
          toolCallId: "call-1",
          action: "prompt",
          surface: "chat",
        }),
      ]);
    });
    expect(readPendingChatScopeStepUp()).toMatchObject({
      phase: "awaiting_click",
      chatSessionId: result.current.chatSessionId,
      event: { continuationId: "cont-1" },
    });
    // Only the side-effect-free presentation ran.
    expect(orchestrator.applyToolCallAuthChallenge).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ confirmed: false }),
    );
    expect(orchestrator.applyToolCallStepUp).not.toHaveBeenCalled();
  });

  it("a stale client's step-up validator ignores the new part", () => {
    expect(
      isScopeStepUpDataPart({
        type: AUTH_REQUIRED_DATA_PART_TYPE,
        data: authRequiredEvent(),
      }),
    ).toBe(false);
  });

  it("a send without clicking cancels the suspended call in the same request", async () => {
    const { result } = await renderChatSession();
    act(() => {
      mockState.chatOnData?.({
        type: AUTH_REQUIRED_DATA_PART_TYPE,
        data: authRequiredEvent(),
        transient: true,
      });
    });
    await waitFor(() =>
      expect(readPendingChatScopeStepUp()?.phase).toBe("awaiting_click"),
    );

    await act(async () => {
      await result.current.sendMessage({ text: "never mind, list my profile" });
    });

    expect(mockState.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ text: "never mind, list my profile" }),
      {
        body: {
          scopeStepUpCancel: { continuationId: "cont-1", toolCallId: "call-1" },
        },
      },
    );
    expect(readPendingChatScopeStepUp()).toBeUndefined();
    expect(useAuthChallengeCardStore.getState().cards).toEqual({});
  });

  it("an ordinary send carries no cancel", async () => {
    const { result } = await renderChatSession();
    await act(async () => {
      await result.current.sendMessage({ text: "hello" });
    });
    expect(mockState.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ text: "hello" }),
      undefined,
    );
  });

  it("a notify card has no continuation and saves no marker", async () => {
    await renderChatSession();
    act(() => {
      mockState.chatOnData?.({
        type: AUTH_REQUIRED_DATA_PART_TYPE,
        data: authRequiredEvent({ action: "notify", continuationId: undefined }),
        transient: true,
      });
    });
    await waitFor(() =>
      expect(
        Object.values(useAuthChallengeCardStore.getState().cards),
      ).toEqual([expect.objectContaining({ action: "notify" })]),
    );
    expect(readPendingChatScopeStepUp()).toBeUndefined();
  });

  it("records a display-only notice", async () => {
    await renderChatSession();
    act(() => {
      mockState.chatOnData?.({
        type: AUTH_CHALLENGE_NOTICE_DATA_PART_TYPE,
        data: {
          version: 1,
          kind: "auth_challenge_notice",
          serverId: "orders",
          toolCallId: "call-9",
          operation: { method: "tools/call", operation: "orders__list_orders" },
          source: "tool_result_meta",
          action: "passthrough",
          reason: "not-honored",
          explanation: "This host ignores _meta challenges.",
        },
        transient: true,
      });
    });
    expect(useAuthChallengeNoticeStore.getState().notices["call-9"]).toMatchObject({
      explanation: "This host ignores _meta challenges.",
    });
    expect(orchestrator.applyToolCallAuthChallenge).not.toHaveBeenCalled();
  });

  it("rebuilds the card from the saved marker after a reload", async () => {
    sessionStorage.setItem(
      "mcp-scope-step-up-chat-v1",
      JSON.stringify({
        version: 1,
        phase: "awaiting_click",
        event: authRequiredEvent(),
        serverName: "orders",
        chatSessionId: "chat-session-1",
        returnPath: "/",
        createdAt: Date.now(),
      }),
    );
    mockState.messages = [
      {
        id: "assistant-1",
        role: "assistant",
        parts: [
          {
            type: "tool-orders__list_orders",
            toolCallId: "call-1",
            state: "input-available",
            input: {},
          },
        ],
      },
    ];
    await renderChatSession();
    await waitFor(() =>
      expect(
        Object.values(useAuthChallengeCardStore.getState().cards),
      ).toEqual([expect.objectContaining({ toolCallId: "call-1" })]),
    );
  });
  it("keeps another model lane's call when a fresh chat shows its first card", async () => {
    const first = await renderChatSession();
    const firstOnData = mockState.chatOnData;
    const second = await renderChatSession();
    act(() => {
      firstOnData?.({ type: AUTH_REQUIRED_DATA_PART_TYPE, data: authRequiredEvent(), transient: true });
      mockState.chatOnData?.({ type: AUTH_REQUIRED_DATA_PART_TYPE, data: authRequiredEvent({ continuationId: "cont-2", toolCallId: "call-2" }), transient: true });
    });
    expect(listPendingChatScopeStepUps()).toHaveLength(2);
    expect(readPendingChatScopeStepUp({ continuationId: "cont-1" })?.chatSessionId).toBe(first.result.current.chatSessionId);
    expect(readPendingChatScopeStepUp({ continuationId: "cont-2" })?.chatSessionId).toBe(second.result.current.chatSessionId);
    await waitFor(() => expect(Object.values(useAuthChallengeCardStore.getState().cards)).toHaveLength(2));
  });

  function unresolvedMessages() {
    return [{ id: "assistant-1", role: "assistant", parts: [{ type: "tool-orders__list_orders", toolCallId: "call-1", state: "input-available", input: {} }] }];
  }
  async function readyResume() {
    mockState.messages = unresolvedMessages();
    const hook = await renderChatSession();
    act(() => {
      savePendingChatScopeStepUp({ event: authRequiredEvent() as AuthRequiredEvent & { continuationId: string }, serverName: "orders", chatSessionId: hook.result.current.chatSessionId });
      markPendingChatScopeStepUpReady("orders", "cont-1");
    });
    return hook;
  }
  it("resumes once and cleans up only after the tool result arrives", async () => {
    mockState.sendMessage.mockImplementation(async () => {
      mockState.messages = [{ id: "assistant-1", role: "assistant", parts: [{ type: "tool-orders__list_orders", toolCallId: "call-1", state: "output-available", input: {}, output: { content: [] } }] }];
    });
    await readyResume();
    await waitFor(() => expect(readPendingChatScopeStepUp({ continuationId: "cont-1" })).toBeUndefined());
    expect(mockState.sendMessage).toHaveBeenCalledTimes(1);
    expect(mockState.sendMessage).toHaveBeenCalledWith(undefined, { body: { scopeStepUpResume: { continuationId: "cont-1", toolCallId: "call-1" } } });
  });
  it("shows a lasting failure when resume and cancellation both fail, without looping", async () => {
    mockState.sendMessage.mockRejectedValue(new Error("connection lost"));
    await readyResume();
    const notices = renderHook(useChatAuthRecoveryFailures);
    await waitFor(() => expect(notices.result.current).toEqual(expect.arrayContaining([
      expect.objectContaining({ reason: "resume_failed", toolCallId: "call-1" }),
      expect.objectContaining({ reason: "cancel_failed", toolCallId: "call-1" }),
    ])));
    expect(mockState.sendMessage).toHaveBeenCalledTimes(2);
    expect(readPendingChatScopeStepUp({ continuationId: "cont-1" })).toBeUndefined();
  });
  it("does not mistake a finished stream with no tool result for successful recovery", async () => {
    await readyResume();
    const notices = renderHook(useChatAuthRecoveryFailures);
    await waitFor(() => expect(notices.result.current.some(item => item.reason === "resume_incomplete")).toBe(true));
    await waitFor(() => expect(readPendingChatScopeStepUp({ continuationId: "cont-1" })).toBeUndefined());
    expect(mockState.sendMessage).toHaveBeenCalledTimes(2);
  });

  it("does not retry a call already claimed before a reload", async () => {
    sessionStorage.setItem("mcp-scope-step-up-chat-v1", JSON.stringify({
      version: 1, phase: "resuming", resumeAttempted: true, event: authRequiredEvent(), serverName: "orders",
      chatSessionId: "chat-session-1", returnPath: "/", createdAt: Date.now(),
    }));
    mockState.messages = unresolvedMessages();
    await renderChatSession();
    await waitFor(() => expect(mockState.sendMessage).toHaveBeenCalledTimes(1));
    expect(mockState.sendMessage).toHaveBeenCalledWith(undefined, { body: { scopeStepUpCancel: { continuationId: "cont-1", toolCallId: "call-1" } } });
    const notices = renderHook(useChatAuthRecoveryFailures);
    expect(notices.result.current.some(item => item.reason === "resume_interrupted")).toBe(true);
  });

  it("fails an ambiguous legacy attempt locally without dispatching either request", async () => {
    sessionStorage.setItem("mcp-scope-step-up-chat-v1", JSON.stringify({
      version: 1, phase: "resuming", event: authRequiredEvent(), serverName: "orders",
      chatSessionId: "chat-session-1", returnPath: "/", createdAt: Date.now(),
    }));
    mockState.messages = unresolvedMessages();
    await renderChatSession();
    const notices = renderHook(useChatAuthRecoveryFailures);
    await waitFor(() => expect(notices.result.current.some(item => item.recoveryResult === "ambiguous_legacy_attempt")).toBe(true));
    expect(mockState.sendMessage).not.toHaveBeenCalled();
  });

  it("restores an abandoned OAuth card after reload", async () => {
    sessionStorage.setItem("mcp-scope-step-up-chat-v2", JSON.stringify({ version: 2, entries: [{
      version: 1, phase: "awaiting_oauth", event: authRequiredEvent(), serverName: "orders",
      chatSessionId: "chat-session-1", returnPath: "/", createdAt: Date.now(), flowDigest: "old-flow",
    }] }));
    mockState.messages = unresolvedMessages();
    await renderChatSession();
    await waitFor(() => expect(Object.values(useAuthChallengeCardStore.getState().cards)).toHaveLength(1));
    expect(mockState.sendMessage).not.toHaveBeenCalled();
  });
  it("expires abandoned sign-in with one cancellation and a durable notice", async () => {
    sessionStorage.setItem("mcp-scope-step-up-chat-v2", JSON.stringify({ version: 2, entries: [{
      version: 1, phase: "awaiting_oauth", event: authRequiredEvent({ expiresAt: Date.now() - 1 }), serverName: "orders",
      chatSessionId: "chat-session-1", returnPath: "/", createdAt: Date.now() - 600000,
    }] }));
    mockState.messages = unresolvedMessages();
    await renderChatSession();
    const notices = renderHook(useChatAuthRecoveryFailures);
    await waitFor(() => expect(notices.result.current.some(item => item.reason === "expired")).toBe(true));
    await waitFor(() => expect(readPendingChatScopeStepUp({ continuationId: "cont-1" })).toBeUndefined());
    expect(mockState.sendMessage).toHaveBeenCalledTimes(1);
  });
  it("does not send an interrupted cancellation again after reload", async () => {
    sessionStorage.setItem("mcp-scope-step-up-chat-v2", JSON.stringify({ version: 2, entries: [{
      version: 1, phase: "cancelling", cancelAttempted: true, event: authRequiredEvent(), serverName: "orders",
      chatSessionId: "chat-session-1", returnPath: "/", createdAt: Date.now(),
    }] }));
    mockState.messages = unresolvedMessages();
    await renderChatSession();
    await waitFor(() => expect(readPendingChatScopeStepUp({ continuationId: "cont-1" })).toBeUndefined());
    expect(mockState.sendMessage).not.toHaveBeenCalled();
  });

  it("waits for the original local server before claiming the resume", async () => {
    server.connectionStatus = "connecting";
    mockState.messages = unresolvedMessages();
    const hook = await renderChatSession();
    act(() => {
      savePendingChatScopeStepUp({ event: authRequiredEvent() as AuthRequiredEvent & { continuationId: string }, serverName: "orders", chatSessionId: hook.result.current.chatSessionId });
      markPendingChatScopeStepUpReady("orders", "cont-1");
    });
    expect(mockState.sendMessage).not.toHaveBeenCalled();
    expect(readPendingChatScopeStepUp({ continuationId: "cont-1" })?.phase).toBe("ready");
    server.connectionStatus = "connected";
    appState = { servers: { orders: server }, projects: {}, activeProjectId: "none" } as never;
    hook.rerender();
    await waitFor(() => expect(mockState.sendMessage).toHaveBeenCalled());
  });

  it("expires a ready call while its local server is still disconnected", async () => {
    server.connectionStatus = "connecting";
    mockState.messages = unresolvedMessages();
    const hook = await renderChatSession();
    const now = Date.now();
    act(() => {
      savePendingChatScopeStepUp({ event: authRequiredEvent({ expiresAt: now + 1000 }) as AuthRequiredEvent & { continuationId: string }, serverName: "orders", chatSessionId: hook.result.current.chatSessionId });
      markPendingChatScopeStepUpReady("orders", "cont-1");
    });
    expect(mockState.sendMessage).not.toHaveBeenCalled();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now + 2000);
    try {
      act(() => window.dispatchEvent(new Event("focus")));
      await waitFor(() => expect(mockState.sendMessage).toHaveBeenCalledTimes(1));
      expect(mockState.sendMessage).toHaveBeenCalledWith(undefined, {
        body: { scopeStepUpCancel: { continuationId: "cont-1", toolCallId: "call-1" } },
      });
    } finally { clock.mockRestore(); }
  });

  it("resumes an already approved write without a separate OAuth prompt", async () => {
    mockState.messages = unresolvedMessages();
    const hook = await renderChatSession();
    act(() => {
      savePendingChatScopeStepUp({ event: authRequiredEvent({ readOnly: false }) as AuthRequiredEvent & { continuationId: string }, serverName: "orders", chatSessionId: hook.result.current.chatSessionId });
      markPendingChatScopeStepUpReady("orders", "cont-1");
    });
    await waitFor(() => expect(mockState.sendMessage).toHaveBeenCalledWith(undefined, {
      body: { scopeStepUpResume: { continuationId: "cont-1", toolCallId: "call-1" } },
    }));
  });

});
