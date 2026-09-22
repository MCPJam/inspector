import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useChatSession } from "../use-chat-session";
import {
  getTrackedTasks,
  setTrackedTaskScope,
} from "@/lib/task-tracker";

/**
 * Finding 4 (MCP Tasks): a task created by a chat turn belongs to the scope
 * the turn was SUBMITTED under. The `data-task-created` part can arrive after
 * the user switched projects mid-stream; before the fix the handler let
 * `trackTask` stamp the live active scope, filing the task under the NEW
 * project. The hook now captures the scope once, at submit (in the transport
 * body builder), and passes it explicitly.
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

const mockApplyToolCallStepUp = vi.hoisted(() => vi.fn());
vi.mock("@/state/oauth-orchestrator", () => ({
  applyToolCallStepUp: (...args: unknown[]) => mockApplyToolCallStepUp(...args),
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
  // Captures the transport options so a test can run the request-time `body`
  // builder — the point where the hook snapshots the turn's task scope.
  DefaultChatTransport: class MockTransport {
    constructor(options: { body?: () => unknown }) {
      mockState.transportOptions.push(options);
    }
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

function taskCreatedPart(taskId: string) {
  return {
    type: "data-task-created",
    data: {
      taskId,
      serverId: "convex-doc-id",
      serverName: "server-1",
      wire: "extension" as const,
      createdAt: new Date().toISOString(),
      status: "working",
    },
  };
}

describe("useChatSession task-created scope capture", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    setTrackedTaskScope(undefined);
    mockState.chatOnData = null;
    mockState.transportOptions = [];
    mockState.chatStatus = "ready";
    mockState.idCounter = 0;
    mockState.messages = [];
  });

  it("files a part delivered after a mid-stream scope switch under the turn-start scope", async () => {
    setTrackedTaskScope("proj-a");
    await renderChatSession();

    // Submit: the transport body builder runs at request time and snapshots
    // the scope the turn starts under.
    const transport = mockState.transportOptions.at(-1);
    expect(transport?.body).toBeTypeOf("function");
    act(() => {
      transport!.body!();
    });

    // The user switches projects while the turn is still streaming.
    setTrackedTaskScope("proj-b");
    act(() => {
      mockState.chatOnData?.(taskCreatedPart("task-1"));
    });

    // Not filed under the now-active scope...
    expect(getTrackedTasks()).toHaveLength(0);
    // ...but under the scope the turn was submitted in, keyed by server NAME.
    setTrackedTaskScope("proj-a");
    expect(
      getTrackedTasks().map((t) => ({
        taskId: t.taskId,
        serverId: t.serverId,
        scope: t.scope,
      }))
    ).toEqual([{ taskId: "task-1", serverId: "server-1", scope: "proj-a" }]);
  });

  it("keeps filing under the ACTIVE scope when no submit preceded the part", async () => {
    // Defensive: a part with no captured turn scope (nothing ran the body
    // builder) falls back to trackTask's own active-scope stamping.
    setTrackedTaskScope("proj-a");
    await renderChatSession();

    act(() => {
      mockState.chatOnData?.(taskCreatedPart("task-2"));
    });

    expect(getTrackedTasks().map((t) => t.scope)).toEqual(["proj-a"]);
  });
});
