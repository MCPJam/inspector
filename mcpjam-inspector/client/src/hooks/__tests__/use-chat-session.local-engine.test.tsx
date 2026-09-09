import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useChatSession } from "../use-chat-session";
import { LOCAL_CONSENT_HEADER } from "@/lib/local-computer-consent";
import {
  __resetPageToolDispatchForTests,
  setAdvertisedPageTools,
} from "@/lib/webmcp-inspector/chat-dispatch";
import { pageToolAlias } from "@/lib/webmcp-inspector/page-tool-aliases";
import { useWebmcpInspectorStore } from "@/stores/webmcp-inspector-store";

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
  chatOnToolCall: null as
    | ((options: { toolCall: unknown }) => void | Promise<void>)
    | null,
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
  useChat: vi.fn((options: {
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
  extra?: { usePageTools?: boolean; requireToolApproval?: boolean },
) {
  // The switch is STATE seeded from `executionConfig`, not a prop of its own —
  // so a case that needs it on has to seed it the way the app does.
  const { requireToolApproval, ...rest } = extra ?? {};
  const rendered = renderHook(() =>
    useChatSession({
      selectedServers: ["server-1"],
      ...(personalComputerEngine ? { personalComputerEngine } : {}),
      ...(hostedContext ? { hostedContext } : {}),
      ...(requireToolApproval !== undefined
        ? { executionConfig: { requireToolApproval } }
        : {}),
      ...rest,
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
    vi.restoreAllMocks();
    vi.clearAllMocks();
    localStorage.clear();
    mockState.chatOnData = null;
    mockState.chatOnToolCall = null;
    mockState.transportOptions = [];
    mockState.chatStatus = "ready";
    mockState.idCounter = 0;
    mockState.messages = [];
    __resetPageToolDispatchForTests();
    useWebmcpInspectorStore.setState({
      session: undefined,
      tools: [],
      chatEnabled: false,
    });
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

  it("omits page tools when the caller does not opt in", async () => {
    await renderWithEngine(undefined, undefined, { usePageTools: false });
    expect(lastTransport().body.pageTools).toBeUndefined();
  });

  it("sends an empty page-tool snapshot when opted in without a live page", async () => {
    await renderWithEngine(undefined, undefined, { usePageTools: true });
    expect(lastTransport().body.pageTools).toEqual([]);
  });

  it("defers page calls until approval, then returns the browser result", async () => {
    const pageTool = {
      alias: pageToolAlias("session-1", "https://shop.test::add_to_cart"),
      sessionId: "session-1",
      toolKey: "https://shop.test::add_to_cart",
      rawName: "add_to_cart",
      origin: "https://shop.test",
    };
    mockState.messages = [
      {
        id: "page-message",
        role: "assistant",
        parts: [
          {
            type: "dynamic-tool",
            toolName: pageTool.alias,
            toolCallId: "page-call-1",
            state: "approval-requested",
            input: { sku: "ABC-123" },
            approval: { id: "page-approval-1" },
          },
        ],
      },
    ];
    useWebmcpInspectorStore.setState({
      session: { sessionId: pageTool.sessionId, status: "ready" } as never,
      tools: [
        {
          toolKey: pageTool.toolKey,
          name: pageTool.rawName,
          origin: pageTool.origin,
          fromSubframe: false,
          registrationKind: "imperative",
        } as never,
      ],
      chatEnabled: true,
    });
    const invoke = vi.fn(async () => ({ state: "succeeded", output: "added" }));
    const initialStore = useWebmcpInspectorStore.getState();
    vi.spyOn(useWebmcpInspectorStore, "getState").mockReturnValue({
      ...initialStore,
      session: { sessionId: pageTool.sessionId, status: "ready" } as never,
      invokeToolForResult: invoke as never,
    });

    // Switch ON, which is what makes the server emit the pill this test waits
    // for. With it off there is no pill coming and the call runs immediately
    // — see the case below.
    const rendered = await renderWithEngine(undefined, undefined, {
      usePageTools: true,
      requireToolApproval: true,
    });
    const advertised = lastTransport().body.pageTools as Array<{
      alias: string;
    }>;
    expect(advertised).toHaveLength(1);
    setAdvertisedPageTools(advertised as never);
    expect(mockState.chatOnToolCall).not.toBeNull();

    await mockState.chatOnToolCall!({
      toolCall: {
        toolName: advertised[0]!.alias,
        toolCallId: "page-call-1",
        input: { sku: "ABC-123" },
      },
    });
    expect(invoke).not.toHaveBeenCalled();
    expect(mockState.addToolOutput).not.toHaveBeenCalled();

    rendered.result.current.addToolApprovalResponse({
      id: "page-approval-1",
      approved: true,
    });
    await waitFor(() => expect(mockState.addToolOutput).toHaveBeenCalled());

    expect(invoke).toHaveBeenCalledWith(pageTool.toolKey, { sku: "ABC-123" });
    expect(mockState.addToolOutput).toHaveBeenCalledWith(
      expect.objectContaining({
        tool: advertised[0]!.alias,
        toolCallId: "page-call-1",
        output: expect.objectContaining({
          content: [{ type: "text", text: "added" }],
        }),
      }),
    );
  });

  it("runs a page call immediately when approval is off, instead of stalling", async () => {
    // The client claims every owned `page_*` call so it can hold it until the
    // user decides. With the switch off the server declares no approval and
    // sends no pill, so a claim with nothing to release it waits forever: the
    // model's call never resolves and the turn stops with no error and no
    // result. It has to run the call itself.
    const pageTool = {
      alias: pageToolAlias("session-1", "https://shop.test::add_to_cart"),
      sessionId: "session-1",
      toolKey: "https://shop.test::add_to_cart",
      rawName: "add_to_cart",
      origin: "https://shop.test",
    };
    useWebmcpInspectorStore.setState({
      session: { sessionId: pageTool.sessionId, status: "ready" } as never,
      tools: [
        {
          toolKey: pageTool.toolKey,
          name: pageTool.rawName,
          origin: pageTool.origin,
          fromSubframe: false,
          registrationKind: "imperative",
        } as never,
      ],
      chatEnabled: true,
    });
    const invoke = vi.fn(async () => ({ state: "succeeded", output: "added" }));
    const initialStore = useWebmcpInspectorStore.getState();
    vi.spyOn(useWebmcpInspectorStore, "getState").mockReturnValue({
      ...initialStore,
      session: { sessionId: pageTool.sessionId, status: "ready" } as never,
      invokeToolForResult: invoke as never,
    });

    await renderWithEngine(undefined, undefined, {
      usePageTools: true,
      requireToolApproval: false,
    });
    const advertised = lastTransport().body.pageTools as Array<{
      alias: string;
    }>;
    setAdvertisedPageTools(advertised as never);

    await mockState.chatOnToolCall!({
      toolCall: {
        toolName: advertised[0]!.alias,
        toolCallId: "page-call-ungated",
        input: { sku: "ABC-123" },
      },
    });

    // No pill was requested and none is coming, so the result has to arrive
    // from here.
    await waitFor(() => expect(mockState.addToolOutput).toHaveBeenCalled());
    expect(invoke).toHaveBeenCalledWith(pageTool.toolKey, { sku: "ABC-123" });
    expect(mockState.addToolOutput).toHaveBeenCalledWith(
      expect.objectContaining({
        tool: advertised[0]!.alias,
        toolCallId: "page-call-ungated",
      }),
    );
  });

  // The switch is a live control and the response is a stream, so a user can
  // move it while a turn is in flight. The SERVER decided each tool's
  // `needsApproval` from the value in that turn's request and cannot be told
  // otherwise, so the client has to answer the same question the server
  // answered — the value the turn was SENT with, not the one showing now.
  // Reading it live breaks in both directions, and each break is silent.
  describe.each([
    {
      name: "OFF at send, flipped ON mid-turn: still runs, no stall",
      sentWith: false,
      flippedTo: true,
      // The server declared it ungated and will never emit a pill. Deferring
      // on the new value waits for a decision nobody will be asked for.
      expectRun: true,
    },
    {
      name: "ON at send, flipped OFF mid-turn: still defers, no bypass",
      sentWith: true,
      flippedTo: false,
      // The server declared it gated and its pill is already on the way.
      // Running on the new value executes a page tool the user was meant to
      // see first, and then the pill arrives for a call already spent.
      expectRun: false,
    },
  ])("approval flipped mid-turn — $name", ({ sentWith, flippedTo, expectRun }) => {
    it("honours the value the turn was sent with", async () => {
      const pageTool = {
        alias: pageToolAlias("session-1", "https://shop.test::add_to_cart"),
        sessionId: "session-1",
        toolKey: "https://shop.test::add_to_cart",
        rawName: "add_to_cart",
        origin: "https://shop.test",
      };
      useWebmcpInspectorStore.setState({
        session: { sessionId: pageTool.sessionId, status: "ready" } as never,
        tools: [
          {
            toolKey: pageTool.toolKey,
            name: pageTool.rawName,
            origin: pageTool.origin,
            fromSubframe: false,
            registrationKind: "imperative",
          } as never,
        ],
        chatEnabled: true,
      });
      const invoke = vi.fn(async () => ({
        state: "succeeded",
        output: "added",
      }));
      const initialStore = useWebmcpInspectorStore.getState();
      vi.spyOn(useWebmcpInspectorStore, "getState").mockReturnValue({
        ...initialStore,
        session: { sessionId: pageTool.sessionId, status: "ready" } as never,
        invokeToolForResult: invoke as never,
      });

      const rendered = await renderWithEngine(undefined, undefined, {
        usePageTools: true,
        requireToolApproval: sentWith,
      });
      // Sending the turn is what stamps the value; the body closure runs here.
      const advertised = lastTransport().body.pageTools as Array<{
        alias: string;
      }>;
      setAdvertisedPageTools(advertised as never);

      // The user moves the switch while the response is still streaming.
      act(() => rendered.result.current.setRequireToolApproval(flippedTo));

      await mockState.chatOnToolCall!({
        toolCall: {
          toolName: advertised[0]!.alias,
          toolCallId: `page-call-flip-${String(sentWith)}`,
          input: { sku: "ABC-123" },
        },
      });

      if (expectRun) {
        await waitFor(() => expect(invoke).toHaveBeenCalled());
      } else {
        expect(invoke).not.toHaveBeenCalled();
        expect(mockState.addToolOutput).not.toHaveBeenCalled();
      }
    });
  });
});
