import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useChatSession } from "../use-chat-session";
import { useHostedMrtrStore } from "@/stores/hosted-mrtr-store";
import { HOSTED_MRTR_DATA_PART_TYPE } from "@/shared/mrtr-continuation";

/**
 * Hosted MRTR browser consumer leg (MCP 2026-07-28 §12.5): the chat hook
 * consumes `data-mrtr-input-required`, renders the round on the shared dialog
 * rail, and resumes by RE-DRIVING the turn with an `mrtrResume` descriptor.
 */

const mockState = vi.hoisted(() => ({
  chatOnData: null as ((part: unknown) => void) | null,
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
  cancelContinuation: vi.fn(async () => ({
    ok: true as const,
    continuationStatus: "cancelled",
  })),
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

function mrtrPart(data: unknown) {
  return { type: HOSTED_MRTR_DATA_PART_TYPE, data };
}

function inputRequired(overrides: Record<string, unknown> = {}) {
  return {
    kind: "input_required",
    continuationId: "cont-1",
    version: 1,
    serverId: "srv-1",
    serverName: "GitHub",
    method: "tools/call",
    operationLabel: "create_issue",
    round: 0,
    inputRequests: [
      {
        key: "branch",
        mode: "form",
        message: "Pick a branch",
        requestedSchema: { type: "object", properties: {} },
      },
    ],
    expiresAt: Date.now() + 300_000,
    ...overrides,
  };
}

const openToolCallMessage = {
  id: "assistant-1",
  role: "assistant",
  parts: [
    {
      type: "tool-create_issue",
      toolCallId: "call-1",
      state: "input-available",
    },
  ],
};

vi.mock("@/lib/apis/web/mrtr-api", async () => {
  const actual = await vi.importActual<
    typeof import("@/lib/apis/web/mrtr-api")
  >("@/lib/apis/web/mrtr-api");
  return {
    ...actual,
    cancelHostedMrtrContinuation: mockState.cancelContinuation,
  };
});

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
    constructor(_options: unknown) {}
  },
  generateId: vi.fn(() => nextSessionId()),
  lastAssistantMessageIsCompleteWithApprovalResponses: vi.fn(),
  convertToModelMessages: vi.fn(async () => []),
}));

async function renderChatSession() {
  const rendered = renderHook(() =>
    useChatSession({ selectedServers: ["server-1"] })
  );
  await waitFor(() => {
    expect(mockState.chatOnData).not.toBeNull();
  });
  return rendered;
}

function activeRoundKey(): string {
  const round = useHostedMrtrStore.getState().rounds[0];
  if (!round) throw new Error("expected a queued MRTR round");
  return round.key;
}

const answers = {
  branch: { action: "accept" as const, content: { b: "main" } },
};

describe("useChatSession hosted MRTR", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockState.chatOnData = null;
    mockState.chatStatus = "ready";
    mockState.idCounter = 0;
    mockState.messages = [openToolCallMessage];
    mockState.sendMessage.mockResolvedValue(undefined as never);
    mockState.cancelContinuation.mockResolvedValue({
      ok: true,
      continuationStatus: "cancelled",
    } as never);
    useHostedMrtrStore.getState().__reset();
    mockApplyToolCallStepUp.mockResolvedValue({ action: "throw" });
  });

  it("queues a streamed input_required round on the dialog rail", async () => {
    await renderChatSession();

    act(() => {
      mockState.chatOnData?.(mrtrPart(inputRequired()));
    });

    const rounds = useHostedMrtrStore.getState().rounds;
    expect(rounds).toHaveLength(1);
    expect(rounds[0]).toMatchObject({
      continuationId: "cont-1",
      round: 0,
      serverId: "srv-1",
      operationLabel: "create_issue",
    });
  });

  it("dedupes a re-delivered part for the same continuation round", async () => {
    await renderChatSession();

    act(() => {
      mockState.chatOnData?.(mrtrPart(inputRequired()));
      mockState.chatOnData?.(mrtrPart(inputRequired()));
    });

    expect(useHostedMrtrStore.getState().rounds).toHaveLength(1);
  });

  it("resumes the turn with the ElicitResult and the suspended tool call", async () => {
    await renderChatSession();
    act(() => {
      mockState.chatOnData?.(mrtrPart(inputRequired()));
    });

    await act(async () => {
      await useHostedMrtrStore.getState().submit(activeRoundKey(), answers);
    });

    expect(mockState.sendMessage).toHaveBeenCalledWith(undefined, {
      body: {
        mrtrResume: {
          toolCallId: "call-1",
          serverId: "srv-1",
          continuationId: "cont-1",
          round: 0,
          responses: answers,
        },
      },
    });
    expect(useHostedMrtrStore.getState().rounds).toHaveLength(0);
  });

  it("replaces the round when the resumed turn asks for another one", async () => {
    await renderChatSession();
    act(() => {
      mockState.chatOnData?.(mrtrPart(inputRequired()));
    });
    await act(async () => {
      await useHostedMrtrStore.getState().submit(activeRoundKey(), answers);
    });

    act(() => {
      mockState.chatOnData?.(mrtrPart(inputRequired({ round: 1 })));
    });

    const rounds = useHostedMrtrStore.getState().rounds;
    expect(rounds).toHaveLength(1);
    expect(rounds[0]).toMatchObject({ round: 1 });

    await act(async () => {
      await useHostedMrtrStore.getState().submit(activeRoundKey(), answers);
    });
    expect(mockState.sendMessage).toHaveBeenLastCalledWith(undefined, {
      body: { mrtrResume: expect.objectContaining({ round: 1 }) },
    });
  });

  it("fails fast on a version this bundle does not speak", async () => {
    // Mixed-version rollout: withdraw instead of rendering a round we could
    // never resume (which would leave the user staring at a dead dialog).
    await renderChatSession();

    act(() => {
      mockState.chatOnData?.(mrtrPart(inputRequired({ version: 99 })));
    });

    expect(useHostedMrtrStore.getState().rounds).toHaveLength(0);
    expect(mockState.cancelContinuation).toHaveBeenCalledWith({
      continuationId: "cont-1",
      reason: "client hosted-MRTR version mismatch",
    });
    expect(mockState.sendMessage).not.toHaveBeenCalled();
  });

  it("clears the rail when the continuation resolves server-side", async () => {
    await renderChatSession();
    act(() => {
      mockState.chatOnData?.(mrtrPart(inputRequired()));
    });
    expect(useHostedMrtrStore.getState().rounds).toHaveLength(1);

    act(() => {
      mockState.chatOnData?.(
        mrtrPart({
          kind: "resolved",
          continuationId: "cont-1",
          version: 1,
          outcome: "expired",
        })
      );
    });

    expect(useHostedMrtrStore.getState().rounds).toHaveLength(0);
  });

  it("withdraws pending rounds when the user aborts the turn", async () => {
    const { result } = await renderChatSession();
    act(() => {
      mockState.chatOnData?.(mrtrPart(inputRequired()));
    });

    await act(async () => {
      result.current.stop();
    });

    expect(useHostedMrtrStore.getState().rounds).toHaveLength(0);
    expect(mockState.cancelContinuation).toHaveBeenCalledWith({
      continuationId: "cont-1",
      reason: "dismissed by user",
    });
    expect(mockState.stop).toHaveBeenCalled();
  });

  it("withdraws instead of resuming when the tool call is gone from history", async () => {
    // Reset/fork under an open dialog: there is no slot left to splice the
    // driven result into, so a resume would be consumed for nothing.
    mockState.messages = [];
    await renderChatSession();
    act(() => {
      mockState.chatOnData?.(mrtrPart(inputRequired()));
    });

    await act(async () => {
      await useHostedMrtrStore.getState().submit(activeRoundKey(), answers);
    });

    expect(mockState.sendMessage).not.toHaveBeenCalled();
    expect(mockState.cancelContinuation).toHaveBeenCalledWith({
      continuationId: "cont-1",
      reason: "no unresolved tool call to resume",
    });
  });

  it("ignores malformed MRTR parts", async () => {
    await renderChatSession();

    act(() => {
      mockState.chatOnData?.(mrtrPart({ kind: "input_required" }));
      mockState.chatOnData?.(mrtrPart({ kind: "bogus" }));
      mockState.chatOnData?.({ type: HOSTED_MRTR_DATA_PART_TYPE });
    });

    expect(useHostedMrtrStore.getState().rounds).toHaveLength(0);
    expect(mockState.cancelContinuation).not.toHaveBeenCalled();
  });
});
