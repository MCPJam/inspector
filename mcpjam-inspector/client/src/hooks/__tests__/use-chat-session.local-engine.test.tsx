import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useChatSession } from "../use-chat-session";
import { LOCAL_CONSENT_HEADER } from "@/lib/local-computer-consent";

/**
 * Local computer engine transmission: when the CALLER (Playground) passes a
 * resolved `personalComputerEngine` of `local` + a consent token, a direct
 * /api/mcp/chat-v2 turn forwards `computerEngine:"local"` in the body and the
 * consent capability in the `X-MCPJam-Local-Consent` HEADER (never the body).
 * Absent / cloud ⇒ the turn is byte-identical to before.
 *
 * The engine is caller-provided on purpose: the central chat hook must not run
 * the `useComputerEngine` config fetch (it would perturb every chat surface).
 */
const mockState = vi.hoisted(() => ({
  chatOnData: null as ((part: unknown) => void) | null,
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

type EnginePref = { engine: "local" | "cloud"; consentToken: string | null };

async function renderWithEngine(
  personalComputerEngine?: EnginePref,
  hostedContext?: Record<string, unknown>,
) {
  const rendered = renderHook(() =>
    useChatSession({
      selectedServers: ["server-1"],
      ...(personalComputerEngine ? { personalComputerEngine } : {}),
      ...(hostedContext ? { hostedContext } : {}),
    } as never),
  );
  await waitFor(() => expect(mockState.chatOnData).not.toBeNull());
  // Wait for the async auth effect to settle (it re-renders → rebuilds the
  // transport) so the member-gated header/body reflect the resolved auth,
  // not the pre-effect default.
  await waitFor(() =>
    expect(mockState.transportOptions.length).toBeGreaterThan(1),
  );
  return rendered;
}

function lastTransport() {
  const t = mockState.transportOptions.at(-1);
  return {
    body: t?.body?.() ?? {},
    headers: (t?.headers ?? {}) as Record<string, string>,
  };
}

describe("useChatSession — local computer engine transmission", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    mockState.chatOnData = null;
    mockState.transportOptions = [];
    mockState.chatStatus = "ready";
    mockState.idCounter = 0;
    mockState.messages = [];
  });

  it("forwards computerEngine:local in the body and the consent header when local + consented", async () => {
    await renderWithEngine({ engine: "local", consentToken: "cap-token-123" });
    const { body, headers } = lastTransport();
    expect(body.computerEngine).toBe("local");
    expect(headers[LOCAL_CONSENT_HEADER]).toBe("cap-token-123");
  });

  it("the token rides the HEADER, never the body (kept out of transcripts)", async () => {
    await renderWithEngine({ engine: "local", consentToken: "cap-token-123" });
    const { body } = lastTransport();
    expect(JSON.stringify(body)).not.toContain("cap-token-123");
  });

  it("sends nothing extra when the engine resolves cloud", async () => {
    await renderWithEngine({ engine: "cloud", consentToken: "cap-token-123" });
    const { body, headers } = lastTransport();
    expect(body.computerEngine).toBeUndefined();
    expect(headers[LOCAL_CONSENT_HEADER]).toBeUndefined();
  });

  it("sends nothing when local is selected but there is no consent token", async () => {
    await renderWithEngine({ engine: "local", consentToken: null });
    const { body, headers } = lastTransport();
    expect(body.computerEngine).toBeUndefined();
    expect(headers[LOCAL_CONSENT_HEADER]).toBeUndefined();
  });

  it("never sends the local engine when the turn routes to the org-aware web API", async () => {
    // The local engine only exists on the local /api/mcp path. A turn forced
    // to /api/web/chat-v2 (org-runtime model, environment mode, etc.) must NOT
    // carry the field or leak the consent header onto the web route.
    await renderWithEngine(
      { engine: "local", consentToken: "cap-token-123" },
      { projectId: "proj-1", requiresWebChatApi: true },
    );
    const { body, headers } = lastTransport();
    expect(body.computerEngine).toBeUndefined();
    expect(headers[LOCAL_CONSENT_HEADER]).toBeUndefined();
  });

  it("never sends the local engine on a scenario (share-link) session", async () => {
    await renderWithEngine(
      { engine: "local", consentToken: "cap-token-123" },
      { projectId: "proj-1", scenarioId: "cbx-1", accessVersion: 1 },
    );
    const { body, headers } = lastTransport();
    expect(body.computerEngine).toBeUndefined();
    expect(headers[LOCAL_CONSENT_HEADER]).toBeUndefined();
  });

  it("never sends the local engine on a GUEST turn (signed out, stale token)", async () => {
    // A previously-signed-in user's consent token can outlive sign-out. The
    // guest turn attaches a guest bearer, not a member one — the local engine
    // must not be forwarded even though a token is present.
    mockState.getAccessToken.mockResolvedValue(null);
    await renderWithEngine({ engine: "local", consentToken: "cap-token-123" });
    const { body, headers } = lastTransport();
    expect(body.computerEngine).toBeUndefined();
    expect(headers[LOCAL_CONSENT_HEADER]).toBeUndefined();
  });

  it("omits the field entirely when no engine is provided (byte-identical legacy)", async () => {
    await renderWithEngine();
    const { body, headers } = lastTransport();
    expect("computerEngine" in body).toBe(false);
    expect(headers[LOCAL_CONSENT_HEADER]).toBeUndefined();
  });
});
