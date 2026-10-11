import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useChatSession } from "../use-chat-session";
import { isMCPJamProvidedModelMenuItem } from "@/components/chat-v2/shared/model-helpers";

/**
 * The hidden environment on THIS machine. Only the web chat route resolves an
 * environment, so a chat carries its plugins through one only when that route
 * can run the turn: the turn is forced there, exactly as environment mode
 * forces it. A turn that has to stay on the local route — a model keyed on
 * this machine, a local-only server, a client run here, this machine's browser
 * or shell — runs as the plain client turn it would have been, and says why.
 */
const mockState = vi.hoisted(() => ({
  chatOnData: null as ((part: unknown) => void) | null,
  chatOnToolCall: null as
    ((options: { toolCall: unknown }) => void | Promise<void>) | null,
  transportOptions: [] as Array<{
    body?: () => Record<string, unknown>;
    headers?: Record<string, string>;
  }>,
  chatStatus: "ready" as string,
  messages: [] as unknown[],
  convexMutation: vi.fn(async () => ({ ok: true })),
  setMessages: vi.fn(),
  sendMessage: vi.fn(async () => {}),
  stop: vi.fn(),
  addToolApprovalResponse: vi.fn(),
  addToolOutput: vi.fn(),
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
  appState: null as unknown,
}));

const byokModel = { id: "gpt-4", name: "GPT-4", provider: "openai" as const };

function nextSessionId() {
  mockState.idCounter += 1;
  return `chat-session-${mockState.idCounter}`;
}

vi.mock("@/state/oauth-orchestrator", () => ({
  applyToolCallStepUp: vi.fn(),
}));
vi.mock("@/lib/config", () => ({
  HOSTED_MODE: false,
}));
vi.mock("@/state/app-state-context", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/state/app-state-context")>()),
  useOptionalSharedAppState: () => mockState.appState,
}));
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
  useChat: vi.fn(
    (options: {
      onData?: (part: unknown) => void;
      onToolCall?: (options: { toolCall: unknown }) => void | Promise<void>;
    }) => {
      mockState.chatOnData = options.onData ?? null;
      mockState.chatOnToolCall = options.onToolCall ?? null;
      return {
        messages: mockState.messages,
        sendMessage: mockState.sendMessage,
        stop: mockState.stop,
        status: mockState.chatStatus,
        error: undefined,
        setMessages: mockState.setMessages,
        addToolApprovalResponse: mockState.addToolApprovalResponse,
        addToolOutput: mockState.addToolOutput,
      };
    },
  ),
}));
vi.mock("ai", () => ({
  DefaultChatTransport: class MockTransport {
    constructor(options: {
      body?: () => Record<string, unknown>;
      headers?: Record<string, string>;
    }) {
      mockState.transportOptions.push(options);
    }
  },
  generateId: vi.fn(() => nextSessionId()),
  lastAssistantMessageIsCompleteWithApprovalResponses: vi.fn(),
  convertToModelMessages: vi.fn(async () => []),
}));

const hiddenContext = {
  projectId: "project-1",
  selectedServerIds: ["server-id-1"],
  hostId: "host_1",
  hiddenEnvironment: {
    environmentId: "env_hidden",
    pluginServerIds: ["srv_plugin"],
  },
};

async function renderHidden(extra: Record<string, unknown> = {}) {
  const rendered = renderHook(() =>
    useChatSession({
      selectedServers: ["server-1"],
      hostedContext: hiddenContext,
      ...extra,
    } as never),
  );
  await waitFor(() => expect(mockState.chatOnData).not.toBeNull());
  await waitFor(() =>
    expect(mockState.transportOptions.length).toBeGreaterThan(1),
  );
  return rendered;
}

function lastTransport() {
  const t = mockState.transportOptions.at(-1) as
    { api?: string; body?: () => Record<string, unknown> } | undefined;
  return { api: t?.api, body: t?.body?.() ?? {} };
}

describe("useChatSession — hidden environment on this machine", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    mockState.chatOnData = null;
    mockState.transportOptions = [];
    mockState.idCounter = 0;
    mockState.messages = [];
    mockState.appState = null;
    // An MCPJam-provided model: one the web chat route can run.
    vi.mocked(isMCPJamProvidedModelMenuItem).mockReturnValue(true);
  });

  it("forces the web chat route and sends the environment, as environment mode does", async () => {
    const { result } = await renderHidden();
    expect(result.current.hiddenEnvironmentActive).toBe(true);
    expect(result.current.hiddenEnvironmentOffReason).toBeNull();
    const { api, body } = lastTransport();
    expect(api).toBe("/api/web/chat-v2");
    expect(body).toMatchObject({
      executionTarget: { kind: "environment", environmentId: "env_hidden" },
      environmentOverrides: { serverIds: ["server-id-1", "srv_plugin"] },
    });
    expect(body).not.toHaveProperty("hostId");
  });

  it("keeps a model keyed on this machine on the local route, without plugins", async () => {
    vi.mocked(isMCPJamProvidedModelMenuItem).mockReturnValue(false);
    const { result } = await renderHidden();
    expect(result.current.hiddenEnvironmentActive).toBe(false);
    expect(result.current.hiddenEnvironmentOffReason).toBe("local_model");
    const { api, body } = lastTransport();
    expect(api).toBe("/api/mcp/chat-v2");
    expect(body.hostId).toBe("host_1");
    expect(body).not.toHaveProperty("executionTarget");
    // Nothing held back waiting for a composition this turn won't use.
    expect(result.current.submitBlocked).toBe(false);
  });

  it("keeps a turn with a local-only server on the local route", async () => {
    mockState.appState = {
      projects: {},
      servers: {
        "server-1": { config: { command: "node", args: ["server.js"] } },
      },
    };
    const { result } = await renderHidden();
    expect(result.current.hiddenEnvironmentOffReason).toBe("local_server");
    expect(lastTransport().api).toBe("/api/mcp/chat-v2");
  });

  it("keeps an explicit run-on-this-machine client turn local", async () => {
    const { result } = await renderHidden({
      localHarnessExecution: {
        requested: true,
        resolveSendTarget: () => null,
      },
    });
    expect(result.current.hiddenEnvironmentOffReason).toBe("local_harness");
    expect(lastTransport().body).not.toHaveProperty("executionTarget");
  });

  it("keeps a turn using this machine's shell local", async () => {
    const { result } = await renderHidden({
      personalComputerEngine: { engine: "local", consentToken: "consent" },
    });
    expect(result.current.hiddenEnvironmentOffReason).toBe("local_tools");
    expect(lastTransport().api).toBe("/api/mcp/chat-v2");
  });

  it("without a hidden environment the route choice is untouched", async () => {
    const rendered = renderHook(() =>
      useChatSession({
        selectedServers: ["server-1"],
        hostedContext: { ...hiddenContext, hiddenEnvironment: undefined },
      } as never),
    );
    await waitFor(() =>
      expect(mockState.transportOptions.length).toBeGreaterThan(1),
    );
    expect(rendered.result.current.hiddenEnvironmentOffReason).toBeNull();
    expect(lastTransport().api).toBe("/api/mcp/chat-v2");
    expect(lastTransport().body.hostId).toBe("host_1");
  });
});
