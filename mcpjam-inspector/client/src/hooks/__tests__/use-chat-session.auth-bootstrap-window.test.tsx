import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useChatSession } from "../use-chat-session";

/**
 * Regression coverage for the auth-bootstrap window behind the `Bearer ` 502.
 *
 * `useChatSession` resolves its Authorization header ASYNCHRONOUSLY
 * (`getAccessToken()` → guest fallback). Until that settles, `authHeaders` is
 * undefined. The transport must not snapshot that state; its fetch resolves
 * the bearer through authFetch at the moment the request is sent.
 */
const mockState = vi.hoisted(() => ({
  chatOnData: null as ((part: unknown) => void) | null,
  transportOptions: [] as Array<{
    body?: () => Record<string, unknown>;
    headers?: Record<string, string>;
    fetch?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  }>,
  chatStatus: "ready" as string,
  messages: [] as unknown[],
  convexMutation: vi.fn(async () => ({ ok: true })),
  setMessages: vi.fn(),
  sendMessage: vi.fn(async () => {}),
  stop: vi.fn(),
  addToolApprovalResponse: vi.fn(),
  authFetch: vi.fn(),
  // A member (WorkOS) bearer by default → authIsMemberRef true. Individual
  // tests flip it to null to model a signed-out guest.
  getAccessToken: vi.fn(async () => "workos-jwt"),
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

const byokModel = { id: "gpt-4", name: "GPT-4", provider: "openai" as const };

function nextSessionId() {
  mockState.idCounter += 1;
  return `chat-session-${mockState.idCounter}`;
}

vi.mock("@/state/oauth-orchestrator", () => ({
  applyToolCallStepUp: vi.fn(),
}));
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
  authFetch: mockState.authFetch,
  getAuthHeaders: vi.fn(() => ({})),
}));
vi.mock("@workos-inc/authkit-react", () => ({
  useAuth: () => ({ getAccessToken: mockState.getAccessToken }),
}));
vi.mock("convex/react", () => ({
  useConvexAuth: () => mockState.convexAuth,
  useQuery: () => undefined,
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
    constructor(options: {
      body?: () => Record<string, unknown>;
      headers?: Record<string, string>;
      fetch?: (
        input: RequestInfo | URL,
        init?: RequestInit
      ) => Promise<Response>;
    }) {
      mockState.transportOptions.push(options);
    }
  },
  generateId: vi.fn(() => nextSessionId()),
  lastAssistantMessageIsCompleteWithApprovalResponses: vi.fn(),
  convertToModelMessages: vi.fn(async () => []),
}));

/** A token fetch that never settles — models the in-flight bootstrap. */
function pendingAccessToken() {
  return new Promise<string>(() => {});
}

function transportAt(index: number) {
  const t = mockState.transportOptions[index];
  return (t?.headers ?? {}) as Record<string, string>;
}

describe("useChatSession — request-time chat Authorization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    mockState.chatOnData = null;
    mockState.transportOptions = [];
    mockState.chatStatus = "ready";
    mockState.idCounter = 0;
    mockState.messages = [];
    mockState.getAccessToken.mockResolvedValue("workos-jwt");
    mockState.authFetch.mockResolvedValue(new Response("", { status: 200 }));
  });

  it("delegates a pre-bootstrap local chat request to authFetch", async () => {
    mockState.getAccessToken.mockImplementation(pendingAccessToken);

    renderHook(() =>
      useChatSession({ selectedServers: ["server-1"] } as never)
    );
    await waitFor(() => expect(mockState.chatOnData).not.toBeNull());

    const transport = mockState.transportOptions.at(-1)!;
    const headers = transportAt(mockState.transportOptions.length - 1);
    expect(headers.Authorization).toBeUndefined();

    const init = { method: "POST" };
    await transport.fetch?.("/api/mcp/chat-v2", init);

    expect(mockState.authFetch).toHaveBeenCalledWith("/api/mcp/chat-v2", init);
  });

  it("never snapshots Authorization into transport headers", async () => {
    renderHook(() =>
      useChatSession({ selectedServers: ["server-1"] } as never)
    );
    await waitFor(() =>
      expect(mockState.transportOptions.length).toBeGreaterThan(1)
    );
    for (const transport of mockState.transportOptions) {
      expect(transport.headers?.Authorization).toBeUndefined();
    }
  });

  it("propagates bearer lookup failures without restoring cached Authorization", async () => {
    const error = new Error("bearer lookup failed");
    mockState.authFetch.mockRejectedValueOnce(error);

    renderHook(() =>
      useChatSession({ selectedServers: ["server-1"] } as never)
    );
    await waitFor(() =>
      expect(mockState.transportOptions.length).toBeGreaterThan(0)
    );

    const transport = mockState.transportOptions.at(-1)!;
    await expect(
      transport.fetch?.("/api/mcp/chat-v2", { method: "POST" })
    ).rejects.toBe(error);
    for (const option of mockState.transportOptions) {
      expect(option.headers?.Authorization).toBeUndefined();
    }
  });
});
