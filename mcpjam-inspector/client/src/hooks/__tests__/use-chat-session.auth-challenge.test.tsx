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
import { readPendingChatScopeStepUp } from "@/lib/scope-step-up-pending";

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
  getAccessToken: vi.fn(async () => null),
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
  useAuth: () => ({ getAccessToken: mockState.getAccessToken }),
}));

vi.mock("convex/react", async () =>
  (await import("@/test/mocks/convex-use-queries")).withUseQueries({
    useConvexAuth: () => mockState.convexAuth,
    useQuery: () => undefined,
    useConvex: () => ({ mutation: mockState.convexMutation }),
  }),
);

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
const appState = {
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
    orchestrator.applyToolCallAuthChallenge.mockResolvedValue({
      kind: "pendingConnect",
    });
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
      expect(Object.values(useAuthChallengeCardStore.getState().cards)).toEqual(
        [
          expect.objectContaining({
            serverName: "orders",
            toolCallId: "call-1",
            action: "prompt",
            surface: "chat",
          }),
        ],
      );
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
        data: authRequiredEvent({
          action: "notify",
          continuationId: undefined,
        }),
        transient: true,
      });
    });
    await waitFor(() =>
      expect(Object.values(useAuthChallengeCardStore.getState().cards)).toEqual(
        [expect.objectContaining({ action: "notify" })],
      ),
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
    expect(
      useAuthChallengeNoticeStore.getState().notices["call-9"],
    ).toMatchObject({
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
      expect(Object.values(useAuthChallengeCardStore.getState().cards)).toEqual(
        [expect.objectContaining({ toolCallId: "call-1" })],
      ),
    );
  });
});
