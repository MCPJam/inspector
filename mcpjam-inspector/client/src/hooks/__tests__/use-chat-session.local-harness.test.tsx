import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useChatSession } from "../use-chat-session";
import { LOCAL_HARNESS_GRANT_HEADER } from "@/lib/local-harness-consent";

/**
 * Local Claude Code execution, as the TRANSPORT sees it.
 *
 * Two properties, and the second is the one this rewrite exists for:
 *
 *  1. a scoped, requested, authorized turn carries the opaque ids in the body
 *     and the capability in the header, both taken from ONE fresh snapshot at
 *     send time;
 *  2. a turn that asks for local and cannot have it FAILS. Before this, an
 *     expired grant, a sign-out or a false member check each simply omitted
 *     the target — and the server, seeing none, ran the turn hosted. A user
 *     who deliberately scoped work to their machine got a cloud sandbox and no
 *     indication of it.
 *
 * The controller is caller-provided on purpose: the central chat hook must not
 * run an availability fetch, an install poll and a consent lifecycle, because
 * every chat surface in the app mounts it.
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
// Spread `actual`, unlike the sibling local-engine suite: this file drives an
// ORG-managed model, which sends `composeAvailableModels` down the org branch
// and into exports a wholesale replacement would leave `undefined`.
vi.mock("@/components/chat-v2/shared/model-helpers", async () => {
  const actual = await vi.importActual<
    typeof import("@/components/chat-v2/shared/model-helpers")
  >("@/components/chat-v2/shared/model-helpers");
  return {
    ...actual,
    buildAvailableModels: vi.fn(() => [byokModel]),
    getDefaultModel: vi.fn(() => byokModel),
    isMCPJamProvidedModelMenuItem: vi.fn(() => false),
  };
});
vi.mock("@/hooks/use-hosted-model-catalog", () => ({
  useHostedModelCatalog: () => ({ hostedCatalog: [], status: "fallback" }),
}));
// The model LIST is pinned so `selectedModel` resolves to the BYOK entry
// whichever branch `composeAvailableModels` would otherwise take. Which model
// is selected is not what these tests are about; whether an ORG-managed one
// keeps a local turn on the local route is.
vi.mock("@/components/chat-v2/shared/available-models", async () => {
  const actual = await vi.importActual<
    typeof import("@/components/chat-v2/shared/available-models")
  >("@/components/chat-v2/shared/available-models");
  return { ...actual, composeAvailableModels: vi.fn(() => [byokModel]) };
});
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
    constructor(options: Record<string, unknown>) {
      mockState.transportOptions.push(options as never);
    }
  },
  generateId: vi.fn(() => nextSessionId()),
  lastAssistantMessageIsCompleteWithApprovalResponses: vi.fn(),
  convertToModelMessages: vi.fn(async () => []),
}));

const LOCAL_TARGET = {
  kind: "local-native" as const,
  harnessId: "claude-code",
  machineId: "mach_1",
  workspaceGrantId: "ws_1",
  runtimeId: "rt_1",
  permissionProfile: "workspace-edits",
  policyVersion: "local-harness-policy-2026-09-01",
};

type HarnessOption = {
  requested: boolean;
  resolveSendTarget: () => { target: typeof LOCAL_TARGET; token: string } | null;
};

function grantedController(token = "grant-token-value"): HarnessOption {
  return {
    requested: true,
    resolveSendTarget: () => ({ target: LOCAL_TARGET, token }),
  };
}

async function renderWithHarness(
  localHarnessExecution?: HarnessOption,
  hostedContext?: Record<string, unknown>,
  extra?: Record<string, unknown>,
) {
  const rendered = renderHook(() =>
    useChatSession({
      selectedServers: ["server-1"],
      ...(localHarnessExecution ? { localHarnessExecution } : {}),
      ...(hostedContext ? { hostedContext } : {}),
      ...(extra ?? {}),
    } as never),
  );
  await waitFor(() => expect(mockState.chatOnData).not.toBeNull());
  await waitFor(() =>
    expect(mockState.transportOptions.length).toBeGreaterThan(1),
  );
  return rendered;
}

const TURN_MESSAGES = [
  { id: "m1", role: "user", parts: [{ type: "text", text: "draw a dog" }] },
];

type TransportUnderTest = {
  api?: string;
  body?: () => Record<string, unknown>;
  headers?: Record<string, string>;
  prepareSendMessagesRequest?: (args: {
    api: string;
    id: string;
    messages: typeof TURN_MESSAGES;
    body: Record<string, unknown>;
    headers: HeadersInit | undefined;
    credentials: undefined;
    requestMetadata: undefined;
    trigger: "submit-message";
    messageId: string;
  }) => { body: Record<string, unknown>; headers?: HeadersInit };
};

function latestTransport(): TransportUnderTest {
  return mockState.transportOptions.at(-1) as unknown as TransportUnderTest;
}

/**
 * Drive the transport the way `HttpChatTransport.sendMessages` does: resolve
 * `body` and `headers`, hand the hook the SDK's full argument set, and take
 * what it returns — or, with no hook installed, compose the SDK's own default
 * (custom fields + `id`/`messages`/`trigger`/`messageId`). The hook's returned
 * body REPLACES that default, which is why every path asserts `messages`
 * below: `lib/__tests__/chat-send-request.test.ts` proves the same against the
 * real transport.
 *
 * Exercised through that seam rather than by reading the two separately,
 * because the property under test is that they come from one snapshot.
 */
function sendRequest() {
  const t = latestTransport();
  const custom = t?.body?.() ?? {};
  const headers = (t?.headers ?? {}) as Record<string, string>;
  const prepared = t?.prepareSendMessagesRequest?.({
    api: t.api ?? "",
    id: "chat_1",
    messages: TURN_MESSAGES,
    body: custom,
    headers,
    credentials: undefined,
    requestMetadata: undefined,
    trigger: "submit-message",
    messageId: "m1",
  });
  const body =
    prepared?.body ??
    ({
      ...custom,
      id: "chat_1",
      messages: TURN_MESSAGES,
      trigger: "submit-message",
      messageId: "m1",
    } as Record<string, unknown>);
  expect(body.messages).toEqual(TURN_MESSAGES);
  return {
    body,
    headers: (prepared?.headers ?? headers) as Record<string, string>,
    api: t?.api,
  };
}

function chatApi() {
  return (mockState.transportOptions.at(-1) as unknown as { api?: string })?.api;
}

describe("useChatSession — local Claude Code transmission", () => {
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
  });

  it("carries the ids in the body and the capability in the header", async () => {
    await renderWithHarness(grantedController());
    const { body, headers } = sendRequest();
    expect(body.harnessTarget).toEqual(LOCAL_TARGET);
    expect(headers[LOCAL_HARNESS_GRANT_HEADER]).toBe("grant-token-value");
  });

  it("keeps the capability out of the body, which is persisted", async () => {
    await renderWithHarness(grantedController("secret-capability"));
    const { body } = sendRequest();
    expect(JSON.stringify(body)).not.toContain("secret-capability");
  });

  it("takes ids and token from ONE snapshot, read at send time", async () => {
    // The transport is memoized long before Allow. Reading the two halves from
    // a closure built then produced a body claiming a target with no
    // capability to authorize it.
    let current: { target: typeof LOCAL_TARGET; token: string } | null = null;
    await renderWithHarness({
      requested: true,
      resolveSendTarget: () => current,
    });
    // Nothing authorized yet: the send refuses rather than degrading.
    expect(() => sendRequest()).toThrow(/not authorized/i);

    // Allow happens; the SAME transport now sends the fresh values.
    current = { target: LOCAL_TARGET, token: "minted-after-allow" };
    const { body, headers } = sendRequest();
    expect(body.harnessTarget).toEqual(LOCAL_TARGET);
    expect(headers[LOCAL_HARNESS_GRANT_HEADER]).toBe("minted-after-allow");
  });

  it("REFUSES a requested turn it cannot authorize", async () => {
    // Expiry, sign-out, a revoked grant in another tab. Each used to omit the
    // target and hand the user a cloud sandbox they never asked for.
    await renderWithHarness({ requested: true, resolveSendTarget: () => null });
    expect(() => sendRequest()).toThrow(
      "Local execution is not authorized for this turn",
    );
  });

  it("leaves the SDK's own body composition alone unless local was requested", async () => {
    // The hook exists to rewrite the body on a local turn. Installed on every
    // turn it once replaced the SDK's default body — `messages` included —
    // with the custom fields alone, and every chat turn 400'd.
    await renderWithHarness(undefined, { projectId: "proj-1" });
    expect(latestTransport().prepareSendMessagesRequest).toBeUndefined();
    await renderWithHarness(grantedController(), { projectId: "proj-1" });
    expect(latestTransport().prepareSendMessagesRequest).toBeDefined();
  });

  it("still sends the turn's messages on a local turn", async () => {
    await renderWithHarness(grantedController(), { projectId: "proj-1" });
    const { body } = sendRequest();
    expect(body.messages).toEqual(TURN_MESSAGES);
    expect(body.id).toBe("chat_1");
    expect(body.trigger).toBe("submit-message");
    expect(body.harnessTarget).toEqual(LOCAL_TARGET);
  });

  it("sends nothing when the caller did not request local", async () => {
    await renderWithHarness({
      requested: false,
      resolveSendTarget: () => ({ target: LOCAL_TARGET, token: "t" }),
    });
    const { body, headers } = sendRequest();
    expect(body.harnessTarget).toBeUndefined();
    expect(headers[LOCAL_HARNESS_GRANT_HEADER]).toBeUndefined();
  });

  it("is byte-identical to before when no controller is passed", async () => {
    await renderWithHarness();
    const { body, headers } = sendRequest();
    expect("harnessTarget" in body).toBe(false);
    expect(headers[LOCAL_HARNESS_GRANT_HEADER]).toBeUndefined();
  });

  it("never sends local on a scenario (share-link) session", async () => {
    // Not one attended member running their own turn, which is what the grant
    // is bound to. The hook re-applies the surface half of the scope predicate
    // even though the caller answered the host half.
    await renderWithHarness(grantedController(), {
      projectId: "proj-1",
      scenarioId: "cbx-1",
      accessVersion: 1,
    });
    const { body, headers } = sendRequest();
    expect(body.harnessTarget).toBeUndefined();
    expect(headers[LOCAL_HARNESS_GRANT_HEADER]).toBeUndefined();
  });

  it("never sends local on a surface forced onto the web route", async () => {
    await renderWithHarness(grantedController(), {
      projectId: "proj-1",
      requiresWebChatApi: true,
    });
    const { body, headers } = sendRequest();
    expect(body.harnessTarget).toBeUndefined();
    expect(headers[LOCAL_HARNESS_GRANT_HEADER]).toBeUndefined();
  });
});

describe("useChatSession — routing an org-runtime model that asks for local", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
    localStorage.clear();
    mockState.chatOnData = null;
    mockState.transportOptions = [];
    mockState.idCounter = 0;
    mockState.messages = [];
  });

  // Makes `isOrgManagedModel` true for the `gpt-4` this suite selects: an
  // enabled `openai` provider that holds a secret is exactly what the hook's
  // own predicate looks for.
  const ORG_CONFIG = {
    providers: [{ providerKey: "openai", enabled: true, hasSecret: true }],
  } as never;

  it("routes an org-runtime model to the web API when nothing asks for local", async () => {
    // The control. Without this the assertion below would pass whether or not
    // the carve-out exists.
    await renderWithHarness(undefined, { projectId: "proj-1" }, {
      hostedOrgModelConfig: ORG_CONFIG,
    });
    expect(chatApi()).toBe("/api/web/chat-v2");
  });

  it("keeps a requested local turn on the route that can run it", async () => {
    // `/api/web/chat-v2` parses the target only to refuse it, so routing there
    // would turn an explicit local ask into a 400 — or, before the refusal
    // existed, into a silent hosted turn.
    await renderWithHarness(grantedController(), { projectId: "proj-1" }, {
      hostedOrgModelConfig: ORG_CONFIG,
    });
    expect(chatApi()).toBe("/api/mcp/chat-v2");
  });

  it("tells the local route to resolve MCP servers locally too", async () => {
    // The agent runs here, so the servers it reaches have to resolve here.
    await renderWithHarness(grantedController(), { projectId: "proj-1" }, {
      hostedOrgModelConfig: ORG_CONFIG,
    });
    expect(sendRequest().body.localMcpRuntimeRequired).toBe(true);
  });

  it("does not claim a local MCP runtime for a plain BYOK local turn", async () => {
    // `localMcpRuntimeRequired` is about an ORG-runtime model's server
    // resolution. A BYOK model never routed away in the first place.
    await renderWithHarness(grantedController(), { projectId: "proj-1" });
    expect(sendRequest().body.localMcpRuntimeRequired).toBeUndefined();
  });
});
