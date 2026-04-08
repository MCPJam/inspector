import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useChatSession } from "../use-chat-session";

const mockState = vi.hoisted(() => ({
  chatOnData: null as ((part: unknown) => void) | null,
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
  convexAuth: {
    isAuthenticated: true,
    isLoading: false,
  },
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

function tracePart(data: unknown) {
  return {
    type: "data-trace-event" as const,
    data,
  };
}

vi.mock("@/lib/config", () => ({
  HOSTED_MODE: false,
}));

vi.mock("@/components/chat-v2/shared/model-helpers", () => ({
  buildAvailableModels: vi.fn(() => [mcpJamModel]),
  getDefaultModel: vi.fn(() => mcpJamModel),
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
  useAuth: () => ({
    getAccessToken: mockState.getAccessToken,
  }),
}));

vi.mock("convex/react", () => ({
  useConvexAuth: () => mockState.convexAuth,
}));

vi.mock("@ai-sdk/react", () => ({
  useChat: vi.fn((options: { onData?: (part: unknown) => void }) => {
    mockState.chatOnData = options.onData ?? null;
    return {
      messages: [],
      sendMessage: mockState.sendMessage,
      stop: mockState.stop,
      status: "ready",
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

describe("useChatSession live trace state", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockState.chatOnData = null;
    mockState.idCounter = 0;
    mockState.convexAuth.isAuthenticated = true;
    mockState.convexAuth.isLoading = false;
  });

  it("accumulates streamed snapshots into a rebased trace envelope", async () => {
    const { result } = renderHook(() =>
      useChatSession({
        selectedServers: ["server-1"],
      }),
    );

    expect(result.current.traceViewsSupported).toBe(true);
    await waitFor(() => {
      expect(result.current.isSessionBootstrapComplete).toBe(true);
      expect(mockState.chatOnData).not.toBeNull();
    });

    act(() => {
      mockState.chatOnData?.(
        tracePart({
          type: "turn_start",
          turnId: "turn-1",
          promptIndex: 0,
          startedAtMs: 1000,
        }),
      );
      mockState.chatOnData?.(
        tracePart({
          type: "trace_snapshot",
          turnId: "turn-1",
          promptIndex: 0,
          snapshot: {
            traceVersion: 1,
            promptIndex: 0,
            messages: [
              { role: "user", content: "First prompt" },
              { role: "assistant", content: "First answer" },
            ],
            spans: [
              {
                id: "turn-1-step-0",
                name: "Step 1",
                category: "step",
                startMs: 0,
                endMs: 100,
                promptIndex: 0,
                stepIndex: 0,
                status: "ok",
              },
            ],
            usage: {
              totalTokens: 5,
            },
          },
        }),
      );
      mockState.chatOnData?.(
        tracePart({
          type: "turn_finish",
          turnId: "turn-1",
          promptIndex: 0,
          usage: {
            totalTokens: 5,
          },
        }),
      );
      mockState.chatOnData?.(
        tracePart({
          type: "turn_start",
          turnId: "turn-2",
          promptIndex: 1,
          startedAtMs: 2000,
        }),
      );
      mockState.chatOnData?.(
        tracePart({
          type: "trace_snapshot",
          turnId: "turn-2",
          promptIndex: 1,
          snapshot: {
            traceVersion: 1,
            promptIndex: 1,
            messages: [
              { role: "user", content: "First prompt" },
              { role: "assistant", content: "First answer" },
              { role: "user", content: "Second prompt" },
              { role: "assistant", content: "Second answer" },
            ],
            spans: [
              {
                id: "turn-2-step-0",
                name: "Step 1",
                category: "step",
                startMs: 0,
                endMs: 50,
                promptIndex: 1,
                stepIndex: 0,
                status: "ok",
              },
            ],
            usage: {
              totalTokens: 3,
            },
          },
        }),
      );
    });

    let envelope = result.current.liveTraceEnvelope;
    await waitFor(() => {
      envelope = result.current.liveTraceEnvelope;
      expect(envelope?.spans).toHaveLength(2);
    });

    expect(envelope?.spans?.[0]).toMatchObject({
      id: "turn-1-step-0",
      startMs: 0,
      endMs: 100,
    });
    expect(envelope?.spans?.[1]).toMatchObject({
      id: "turn-2-step-0",
      startMs: 100,
      endMs: 150,
    });
    expect(envelope?.turns).toEqual([
      expect.objectContaining({
        turnId: "turn-1",
        durationMs: 100,
      }),
      expect.objectContaining({
        turnId: "turn-2",
        durationMs: 50,
      }),
    ]);
    expect(envelope?.usage).toMatchObject({
      totalTokens: 8,
    });
    expect(envelope?.traceStartedAtMs).toBe(1000);
    expect(envelope?.traceEndedAtMs).toBe(1150);
    await waitFor(() => {
      expect(result.current.hasTraceSnapshot).toBe(true);
    });
  });

  it("marks a new active turn as pending until its first snapshot arrives", async () => {
    const { result } = renderHook(() =>
      useChatSession({
        selectedServers: ["server-1"],
      }),
    );

    await waitFor(() => {
      expect(result.current.isSessionBootstrapComplete).toBe(true);
      expect(mockState.chatOnData).not.toBeNull();
    });

    act(() => {
      mockState.chatOnData?.(
        tracePart({
          type: "turn_start",
          turnId: "turn-1",
          promptIndex: 0,
          startedAtMs: 1000,
        }),
      );
      mockState.chatOnData?.(
        tracePart({
          type: "trace_snapshot",
          turnId: "turn-1",
          promptIndex: 0,
          snapshot: {
            traceVersion: 1,
            promptIndex: 0,
            messages: [
              { role: "user", content: "First prompt" },
              { role: "assistant", content: "First answer" },
            ],
            spans: [
              {
                id: "turn-1-step-0",
                name: "Step 1",
                category: "step",
                startMs: 0,
                endMs: 100,
                promptIndex: 0,
                stepIndex: 0,
                status: "ok",
              },
            ],
          },
        }),
      );
      mockState.chatOnData?.(
        tracePart({
          type: "turn_finish",
          turnId: "turn-1",
          promptIndex: 0,
        }),
      );
      mockState.chatOnData?.(
        tracePart({
          type: "turn_start",
          turnId: "turn-2",
          promptIndex: 1,
          startedAtMs: 2000,
        }),
      );
    });

    let envelope = result.current.liveTraceEnvelope;
    await waitFor(() => {
      envelope = result.current.liveTraceEnvelope;
      expect(envelope?.spans?.length).toBeGreaterThanOrEqual(3);
    });

    expect(result.current.hasTraceSnapshot).toBe(false);
    expect(result.current.hasLiveTimelineContent).toBe(true);
    expect(envelope?.spans?.[0]).toMatchObject({
      id: "turn-1-step-0",
    });
    expect(envelope?.spans?.some((s) => s.id.startsWith("pv-"))).toBe(true);

    act(() => {
      mockState.chatOnData?.(
        tracePart({
          type: "trace_snapshot",
          turnId: "turn-2",
          promptIndex: 1,
          snapshot: {
            traceVersion: 1,
            promptIndex: 1,
            messages: [
              { role: "user", content: "First prompt" },
              { role: "assistant", content: "First answer" },
              { role: "user", content: "Second prompt" },
              { role: "assistant", content: "Second answer" },
            ],
            spans: [
              {
                id: "turn-2-step-0",
                name: "Step 1",
                category: "step",
                startMs: 0,
                endMs: 25,
                promptIndex: 1,
                stepIndex: 0,
                status: "ok",
              },
            ],
          },
        }),
      );
    });

    await waitFor(() => {
      expect(result.current.hasTraceSnapshot).toBe(true);
    });
  });

  it("does not report live timeline content when snapshot has no spans", async () => {
    const { result } = renderHook(() =>
      useChatSession({
        selectedServers: ["server-1"],
      }),
    );

    await waitFor(() => {
      expect(result.current.isSessionBootstrapComplete).toBe(true);
      expect(mockState.chatOnData).not.toBeNull();
    });

    act(() => {
      mockState.chatOnData?.(
        tracePart({
          type: "turn_start",
          turnId: "turn-1",
          promptIndex: 0,
          startedAtMs: 1000,
        }),
      );
      mockState.chatOnData?.(
        tracePart({
          type: "trace_snapshot",
          turnId: "turn-1",
          promptIndex: 0,
          snapshot: {
            traceVersion: 1,
            promptIndex: 0,
            messages: [
              { role: "user", content: "Hi" },
              { role: "assistant", content: "Hello" },
            ],
            spans: [],
          },
        }),
      );
    });

    await waitFor(() => {
      expect(result.current.hasTraceSnapshot).toBe(true);
    });

    expect(result.current.hasLiveTimelineContent).toBe(false);
  });

  it("clears live trace state when the chat session resets", async () => {
    const { result } = renderHook(() =>
      useChatSession({
        selectedServers: ["server-1"],
      }),
    );

    await waitFor(() => {
      expect(result.current.isSessionBootstrapComplete).toBe(true);
      expect(mockState.chatOnData).not.toBeNull();
    });

    act(() => {
      mockState.chatOnData?.(
        tracePart({
          type: "turn_start",
          turnId: "turn-1",
          promptIndex: 0,
          startedAtMs: 1000,
        }),
      );
      mockState.chatOnData?.(
        tracePart({
          type: "trace_snapshot",
          turnId: "turn-1",
          promptIndex: 0,
          snapshot: {
            traceVersion: 1,
            promptIndex: 0,
            messages: [
              { role: "user", content: "First prompt" },
              { role: "assistant", content: "First answer" },
            ],
            spans: [
              {
                id: "turn-1-step-0",
                name: "Step 1",
                category: "step",
                startMs: 0,
                endMs: 100,
                promptIndex: 0,
                stepIndex: 0,
                status: "ok",
              },
            ],
          },
        }),
      );
    });

    await waitFor(() => {
      expect(result.current.liveTraceEnvelope?.spans).toHaveLength(1);
    });

    const initialSessionId = result.current.chatSessionId;

    act(() => {
      result.current.resetChat();
    });

    await waitFor(() => {
      expect(result.current.chatSessionId).not.toBe(initialSessionId);
      expect(result.current.liveTraceEnvelope).toBeNull();
      expect(result.current.hasTraceSnapshot).toBe(false);
      expect(result.current.hasLiveTimelineContent).toBe(false);
    });
  });

  it("exposes preview waterfall spans before the first trace_snapshot", async () => {
    const { result } = renderHook(() =>
      useChatSession({
        selectedServers: ["server-1"],
      }),
    );

    await waitFor(() => {
      expect(result.current.isSessionBootstrapComplete).toBe(true);
      expect(mockState.chatOnData).not.toBeNull();
    });

    act(() => {
      mockState.chatOnData?.(
        tracePart({
          type: "turn_start",
          turnId: "turn-pre",
          promptIndex: 0,
          startedAtMs: 5000,
        }),
      );
    });

    await waitFor(() => {
      expect(result.current.hasLiveTimelineContent).toBe(true);
      expect(result.current.hasTraceSnapshot).toBe(false);
    });

    const env = result.current.liveTraceEnvelope;
    expect(env?.spans?.length).toBeGreaterThanOrEqual(2);
    expect(env?.spans?.some((s) => s.category === "llm")).toBe(true);

    act(() => {
      mockState.chatOnData?.(
        tracePart({
          type: "text_delta",
          turnId: "turn-pre",
          promptIndex: 0,
          stepIndex: 0,
          delta: "hello",
        }),
      );
    });

    await waitFor(() => {
      const llm = result.current.liveTraceEnvelope?.spans?.find(
        (s) => s.category === "llm" && s.id.startsWith("pv-"),
      );
      expect(llm && llm.endMs > llm.startMs).toBe(true);
    });
  });
});
