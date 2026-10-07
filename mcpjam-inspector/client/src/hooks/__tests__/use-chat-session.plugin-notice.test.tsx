import { renderHook, waitFor, act } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useChatSession } from "../use-chat-session";
import { useTrafficLogStore } from "@/stores/traffic-log-store";
import { resetShownPluginNotices } from "@/lib/plugins/plugin-notice-display";

/**
 * A `data-plugin-notice` part (installed plugins a turn did not load) shows
 * one plain line per chat and one Logs entry, however many turns repeat it.
 */

const toastInfo = vi.hoisted(() => vi.fn());
vi.mock("@/lib/toast", () => ({
  toast: { info: toastInfo, error: vi.fn(), success: vi.fn() },
}));

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

// Soft reads (billing, credits, quota, notifications) go through useQueries;
// withUseQueries answers them from this mock's useQuery.
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

async function renderChatSession() {
  const rendered = renderHook(() =>
    useChatSession({ selectedServers: ["server-1"] }),
  );
  await waitFor(() => {
    expect(mockState.chatOnData).not.toBeNull();
  });
  return rendered;
}

const notice = {
  type: "data-plugin-notice",
  transient: true,
  data: {
    kind: "skipped",
    plugins: [
      {
        pluginId: "plg_bits",
        name: "bits-and-bolts",
        displayName: "Bits & Bolts",
        reason: "needs_auth",
      },
    ],
  },
};

describe("useChatSession plugin notice", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    resetShownPluginNotices();
    useTrafficLogStore.getState().clear();
    mockState.chatOnData = null;
    mockState.transportOptions = [];
    mockState.chatStatus = "ready";
    mockState.idCounter = 0;
    mockState.messages = [];
  });

  it("shows the notice once per chat and logs it once", async () => {
    await renderChatSession();

    act(() => {
      mockState.chatOnData?.(notice);
    });
    act(() => {
      // The next turn of the same chat skips the same plugin again.
      mockState.chatOnData?.(notice);
    });

    expect(toastInfo).toHaveBeenCalledTimes(1);
    expect(toastInfo).toHaveBeenCalledWith(
      "Bits & Bolts was skipped: sign in to its server first.",
    );
    const logs = useTrafficLogStore
      .getState()
      .mcpServerItems.filter((item) => item.serverId === "plugins");
    expect(logs).toHaveLength(1);
  });

  it("ignores a malformed part", async () => {
    await renderChatSession();
    act(() => {
      mockState.chatOnData?.({
        type: "data-plugin-notice",
        data: { kind: "something_else", plugins: [] },
      });
    });
    expect(toastInfo).not.toHaveBeenCalled();
  });
});
