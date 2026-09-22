import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { useChatSession } from "../use-chat-session";
import { AppStateProvider } from "@/state/app-state-context";
import type { AppState, ServerWithName } from "@/state/app-types";

const mockState = vi.hoisted(() => ({
  chatOnData: null as ((part: unknown) => void) | null,
  chatStatus: "ready" as string,
  convexMutation: vi.fn(async () => ({ ok: true })),
  setMessages: vi.fn(),
  sendMessage: vi.fn(),
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

const mcpJamModel = {
  id: "openai/gpt-5-mini",
  name: "GPT-5 Mini",
  provider: "openai" as const,
};

function nextSessionId() {
  mockState.idCounter += 1;
  return `chat-session-${mockState.idCounter}`;
}

function elicitationPart(data: unknown) {
  return { type: "data-elicitation" as const, data };
}

function formRequest(overrides: Record<string, unknown> = {}) {
  return {
    kind: "request",
    rendezvousId: "rv-1",
    serverId: "srv-1",
    serverName: "GitHub",
    mode: "form",
    message: "Pick a branch",
    requestedSchema: { type: "object", properties: {} },
    expiresAt: Date.now() + 300_000,
    ...overrides,
  };
}

const mockApplyToolCallStepUp = vi.hoisted(() => vi.fn());
vi.mock("@/state/oauth-orchestrator", () => ({
  applyToolCallStepUp: (...args: unknown[]) => mockApplyToolCallStepUp(...args),
}));

vi.mock("@/lib/config", () => ({ HOSTED_MODE: false }));

vi.mock("@/components/chat-v2/shared/model-helpers", () => ({
  buildAvailableModels: vi.fn(() => [mcpJamModel]),
  getDefaultModel: vi.fn(() => mcpJamModel),
  isMCPJamProvidedModelMenuItem: vi.fn((model: { id: string }) =>
    String(model.id).includes("/")
  ),
}));

// The hosted-model catalog hook fetches `/api/mcp/models` for everyone now;
// stub it so it doesn't run a real fetch in this hook test.
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
    selectedModelId: "openai/gpt-5-mini",
    setSelectedModelId: mockState.setSelectedModelId,
    selectedModelIds: ["openai/gpt-5-mini"],
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

vi.mock("convex/react", () => ({
  useConvexAuth: () => mockState.convexAuth,
  useQuery: () => undefined,
  useConvex: () => ({ mutation: mockState.convexMutation }),
}));

vi.mock("@ai-sdk/react", () => ({
  useChat: vi.fn((options: { onData?: (part: unknown) => void }) => {
    mockState.chatOnData = options.onData ?? null;
    return {
      messages: [],
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
    constructor(_options: unknown) {}
  },
  generateId: vi.fn(() => nextSessionId()),
  lastAssistantMessageIsCompleteWithApprovalResponses: vi.fn(),
  convertToModelMessages: vi.fn(async () => []),
}));

async function renderChatSession() {
  const rendered = renderHook(() =>
    useChatSession({ selectedServers: ["server-1"] }),
  );
  await waitFor(() => {
    expect(mockState.chatOnData).not.toBeNull();
  });
  return rendered;
}

// Variant that wraps the hook in an AppStateProvider so the SEP-2350 chat
// step-up can resolve a live server entry (the un-wrapped variant leaves
// appState null, which the branch treats as "no issuer to widen — skip").
async function renderChatSessionWithServers(
  servers: Record<string, ServerWithName>,
) {
  const appState = {
    servers,
    projects: {},
    activeProjectId: "",
  } as unknown as AppState;
  const rendered = renderHook(
    () => useChatSession({ selectedServers: ["server-1"] }),
    {
      wrapper: ({ children }: { children: React.ReactNode }) =>
        createElement(AppStateProvider, { appState }, children),
    },
  );
  await waitFor(() => {
    expect(mockState.chatOnData).not.toBeNull();
  });
  return rendered;
}

describe("useChatSession elicitation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockState.chatOnData = null;
    mockState.chatStatus = "ready";
    mockState.idCounter = 0;
    mockState.convexMutation.mockResolvedValue({ ok: true } as never);
    // Default: step-up settles immediately so the per-server in-flight guard
    // clears. The dedupe test overrides this with a never-resolving promise.
    mockApplyToolCallStepUp.mockResolvedValue({ action: "throw" });
  });

  it("queues a streamed request", async () => {
    const { result } = await renderChatSession();

    act(() => {
      mockState.chatOnData?.(elicitationPart(formRequest()));
    });

    expect(result.current.pendingElicitations).toHaveLength(1);
    expect(result.current.pendingElicitations[0]).toMatchObject({
      rendezvousId: "rv-1",
      serverId: "srv-1",
      mode: "form",
    });
  });

  it("ignores a re-delivered request for the same rendezvous", async () => {
    // A duplicate part must not stack a second dialog over one blocked call.
    const { result } = await renderChatSession();

    act(() => {
      mockState.chatOnData?.(elicitationPart(formRequest()));
      mockState.chatOnData?.(elicitationPart(formRequest()));
    });

    expect(result.current.pendingElicitations).toHaveLength(1);
  });

  it("queues distinct rendezvous ids independently", async () => {
    const { result } = await renderChatSession();

    act(() => {
      mockState.chatOnData?.(elicitationPart(formRequest()));
      mockState.chatOnData?.(
        elicitationPart(formRequest({ rendezvousId: "rv-2" })),
      );
    });

    expect(result.current.pendingElicitations).toHaveLength(2);
  });

  it("drops a request the server resolved on its own", async () => {
    // TTL expiry server-side: the dialog must close, not submit into a dead row.
    const { result } = await renderChatSession();

    act(() => {
      mockState.chatOnData?.(elicitationPart(formRequest()));
    });
    expect(result.current.pendingElicitations).toHaveLength(1);

    act(() => {
      mockState.chatOnData?.(
        elicitationPart({
          kind: "resolved",
          rendezvousId: "rv-1",
          outcome: "expired",
        }),
      );
    });
    expect(result.current.pendingElicitations).toHaveLength(0);
  });

  it("collects url_required notices", async () => {
    const { result } = await renderChatSession();

    act(() => {
      mockState.chatOnData?.(
        elicitationPart({
          kind: "url_required",
          serverId: "srv-1",
          toolCallId: "call-1",
          elicitations: [
            { url: "https://example.com/auth", elicitationId: "e1" },
          ],
        }),
      );
    });

    expect(result.current.urlElicitationRequired).toHaveLength(1);
    expect(result.current.urlElicitationRequired[0]).toMatchObject({
      toolCallId: "call-1",
    });
  });

  it("ignores malformed elicitation parts", async () => {
    const { result } = await renderChatSession();

    act(() => {
      mockState.chatOnData?.(elicitationPart({ kind: "request" }));
      mockState.chatOnData?.(elicitationPart({ kind: "bogus" }));
      mockState.chatOnData?.({ type: "data-elicitation" });
    });

    expect(result.current.pendingElicitations).toHaveLength(0);
    expect(result.current.urlElicitationRequired).toHaveLength(0);
  });

  it("drives step-up on a SEP-2350 insufficient_scope part when the server resolves", async () => {
    const server = {
      name: "GitHub",
      connectionStatus: "connected",
    } as unknown as ServerWithName;
    await renderChatSessionWithServers({ GitHub: server });

    act(() => {
      mockState.chatOnData?.(
        elicitationPart({
          kind: "insufficient_scope",
          serverId: "srv-1",
          serverName: "GitHub",
          toolCallId: "call-7",
          requiredScope: "read write admin",
          resourceMetadataUrl: "https://rs.example/.well-known",
        }),
      );
    });

    expect(mockApplyToolCallStepUp).toHaveBeenCalledTimes(1);
    expect(mockApplyToolCallStepUp).toHaveBeenCalledWith(server, {
      requiredScope: "read write admin",
      resourceMetadataUrl: "https://rs.example/.well-known",
    });
  });

  it("dedupes a re-delivered insufficient_scope part per server", async () => {
    const server = {
      name: "GitHub",
      connectionStatus: "connected",
    } as unknown as ServerWithName;
    // Never resolve, so the in-flight guard stays held across both deliveries.
    mockApplyToolCallStepUp.mockReturnValue(new Promise(() => {}));
    await renderChatSessionWithServers({ GitHub: server });

    const part = elicitationPart({
      kind: "insufficient_scope",
      serverId: "srv-1",
      serverName: "GitHub",
      requiredScope: "read",
    });
    act(() => {
      mockState.chatOnData?.(part);
      mockState.chatOnData?.(part);
    });

    expect(mockApplyToolCallStepUp).toHaveBeenCalledTimes(1);
  });

  it("does not drive step-up when no server resolves (challenge still safe)", async () => {
    const { result } = await renderChatSession();

    act(() => {
      mockState.chatOnData?.(
        elicitationPart({
          kind: "insufficient_scope",
          serverId: "srv-unknown",
          requiredScope: "read",
        }),
      );
    });

    expect(mockApplyToolCallStepUp).not.toHaveBeenCalled();
    expect(result.current.urlElicitationRequired).toHaveLength(0);
  });

  it("submits the answer to Convex and clears the queue", async () => {
    const { result } = await renderChatSession();

    act(() => {
      mockState.chatOnData?.(elicitationPart(formRequest()));
    });

    await act(async () => {
      await result.current.respondToElicitation({
        rendezvousId: "rv-1",
        action: "accept",
        content: { branch: "main" },
      });
    });

    expect(mockState.convexMutation).toHaveBeenCalledWith(
      "elicitations:respondToElicitation",
      { rendezvousId: "rv-1", action: "accept", content: { branch: "main" } },
    );
    expect(result.current.pendingElicitations).toHaveLength(0);
  });

  it("omits content for a non-form answer", async () => {
    // The backend rejects content outside a form accept; sending an empty
    // object would be inventing data the user never supplied.
    const { result } = await renderChatSession();

    await act(async () => {
      await result.current.respondToElicitation({
        rendezvousId: "rv-9",
        action: "decline",
      });
    });

    expect(mockState.convexMutation).toHaveBeenCalledWith(
      "elicitations:respondToElicitation",
      { rendezvousId: "rv-9", action: "decline" },
    );
  });

  it("closes the dialog when the answer loses a race", async () => {
    mockState.convexMutation.mockResolvedValue({
      ok: false,
      reason: "expired",
    } as never);
    const { result } = await renderChatSession();

    act(() => {
      mockState.chatOnData?.(elicitationPart(formRequest()));
    });
    await act(async () => {
      await result.current.respondToElicitation({
        rendezvousId: "rv-1",
        action: "accept",
      });
    });

    // The row is terminal either way — keeping it open invites a doomed retry.
    expect(result.current.pendingElicitations).toHaveLength(0);
  });

  it("keeps the dialog closed when the mutation throws", async () => {
    mockState.convexMutation.mockRejectedValue(new Error("offline") as never);
    const { result } = await renderChatSession();

    act(() => {
      mockState.chatOnData?.(elicitationPart(formRequest()));
    });
    await act(async () => {
      await result.current.respondToElicitation({
        rendezvousId: "rv-1",
        action: "accept",
      });
    });

    expect(result.current.elicitationResponding).toBe(false);
  });

  it("clears pending requests once the stream ends", async () => {
    // The blocked tool call cannot outlive the stream; the server has already
    // cancelled everything by this point.
    mockState.chatStatus = "streaming";
    const { result, rerender } = await renderChatSession();

    act(() => {
      mockState.chatOnData?.(elicitationPart(formRequest()));
    });
    expect(result.current.pendingElicitations).toHaveLength(1);

    mockState.chatStatus = "ready";
    rerender();

    await waitFor(() => {
      expect(result.current.pendingElicitations).toHaveLength(0);
    });
  });
});
