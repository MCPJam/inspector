import { act, renderHook, waitFor } from "@testing-library/react";
import { useRef } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DefaultChatTransport, UIMessageChunk } from "ai";
import { useChatSession } from "../use-chat-session";
import { useResumedThreadPersistence } from "../use-resumed-thread-persistence";

const mockState = vi.hoisted(() => ({
  empty: [] as never[],
  appState: { servers: {} },
  getAccessToken: vi.fn(async () => "member"),
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

vi.mock("@/lib/config", async () => ({
  ...(await vi.importActual("@/lib/config")),
  HOSTED_MODE: false,
}));

vi.mock("@/components/chat-v2/shared/model-helpers", () => ({
  buildAvailableModels: vi.fn(() => [mcpJamModel]),
  getDefaultModel: vi.fn(() => mcpJamModel),
  isMCPJamProvidedModelMenuItem: vi.fn((model: { id: string }) =>
    String(model.id).includes("/"),
  ),
}));

// The hosted-model catalog hook fetches `/api/mcp/models` for everyone now;
// stub it so it doesn't run a real fetch in this hook test.
vi.mock("@/hooks/use-hosted-model-catalog", () => ({
  useHostedModelCatalog: () => ({
    hostedCatalog: mockState.empty,
    status: "fallback",
  }),
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
    customProviders: mockState.empty,
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

// Soft reads (billing, credits, quota, notifications) go through useQueries;
// withUseQueries answers them from this mock's useQuery.
vi.mock("convex/react", async () =>
  (await import("@/test/mocks/convex-use-queries")).withUseQueries({
    // useChatSession resolves the Convex client to submit elicitation answers
    // straight to the rendezvous table (the blocked replica isn't addressable).
    useConvex: () => ({ mutation: vi.fn().mockResolvedValue({ ok: true }) }),
    useConvexAuth: () => mockState.convexAuth,
    // useChatSession reads the credit balance (to lock free models at 0
    // credits); no balance in these tests → outOfCredits resolves false.
    useQuery: () => undefined,
  }),
);

const scenario = vi.hoisted(() => ({
  baseVersion: 4,
  staleReceipt: false,
  continuationConflict: false,
  bodies: [] as Record<string, unknown>[],
  firstOutcome: "saved" as "saved" | "duplicate" | "conflict",
  onConflict: vi.fn(),
  onUnsaved: vi.fn(),
}));

vi.mock("ai", async () => ({
  ...(await vi.importActual<typeof import("ai")>("ai")),
  generateId: () => nextSessionId(),
  DefaultChatTransport: class {
    constructor(
      private options: ConstructorParameters<typeof DefaultChatTransport>[0],
    ) {}
    async sendMessages() {
      const configured = this.options?.body;
      const body =
        typeof configured === "function" ? await configured() : configured;
      scenario.bodies.push(body ?? {});
      const request = scenario.bodies.length;
      if (request > 2) throw new Error("Unexpected third transport request");
      const sessionId = String(body?.chatSessionId);
      const turnId = `turn-${request}`;
      const outcome =
        request === 2 && scenario.continuationConflict
          ? "conflict"
          : request === 1
            ? scenario.firstOutcome
            : body?.expectedVersion === scenario.baseVersion + 1 ||
                body?.expectedVersion === undefined
              ? "saved"
              : "conflict";
      const chunks: UIMessageChunk[] = [
        { type: "start", messageId: `assistant-${scenario.baseVersion}` },
        { type: "start-step" },
        {
          type: "data-trace-event",
          transient: true,
          data: {
            type: "turn_start",
            turnId,
            promptIndex: 0,
            startedAtMs: Date.now(),
          },
        },
        ...(request === 1 && outcome !== "conflict" && !scenario.staleReceipt
          ? [
              {
                type: "tool-input-available" as const,
                toolCallId: `app-call-${scenario.baseVersion}`,
                toolName: "app_deadbeef",
                input: {},
              },
            ]
          : [
              { type: "text-start" as const, id: "text" },
              {
                type: "text-delta" as const,
                id: "text",
                delta: "Move complete",
              },
              { type: "text-end" as const, id: "text" },
            ]),
        { type: "finish-step" },
        { type: "finish" },
        {
          type: "data-persist-receipt",
          transient: true,
          data: {
            outcome,
            chatSessionId: scenario.staleReceipt
              ? "previously-open-chat"
              : sessionId,
            turnId,
            ...(outcome === "conflict"
              ? { currentVersion: 9 }
              : { version: request + scenario.baseVersion }),
          },
        },
      ];
      return new ReadableStream<UIMessageChunk>({
        start(controller) {
          for (const chunk of chunks) controller.enqueue(chunk);
          controller.close();
        },
      });
    }
    async reconnectToStream() {
      return null;
    }
  },
}));

const selectedServers: string[] = [];
function useHarness() {
  const chat = useChatSession({ selectedServers });
  const sendBaselineRef = useRef<{ sessionId: string; version: number } | null>(
    null,
  );
  useResumedThreadPersistence({
    sendBaselineRef,
    enabled: true,
    status: chat.status,
    activeHistorySessionId: chat.chatSessionId,
    resumedVersion: chat.resumedVersion,
    consumePersistReceipt: chat.consumePersistReceipt,
    consumeTurnAborted: chat.consumeTurnAborted,
    reactiveSessionVersion: undefined,
    syncResumedVersion: chat.syncResumedVersion,
    markHistorySessionRead: () => {},
    refreshAfterStream: () => {},
    onConflict: scenario.onConflict,
    onUnsaved: scenario.onUnsaved,
  });
  return chat;
}

beforeEach(() => {
  scenario.staleReceipt = false;
  scenario.continuationConflict = false;
  scenario.baseVersion = 4;
  scenario.bodies = [];
  scenario.firstOutcome = "saved";
  scenario.onConflict.mockClear();
  scenario.onUnsaved.mockClear();
});

describe("client-tool continuation with the real AI SDK", () => {
  it.each(["saved", "duplicate"] as const)(
    "advances a %s receipt before the automatic continuation",
    async (outcome) => {
      scenario.firstOutcome = outcome;
      const { result } = renderHook(useHarness);
      act(() => result.current.syncResumedVersion(4));
      const sessionId = result.current.chatSessionId;
      await act(async () => {
        await result.current.sendMessage({ text: "play e4" });
      });
      expect(scenario.bodies.map((body) => body.expectedVersion)).toEqual([
        4, 5,
      ]);
      await waitFor(() => expect(result.current.resumedVersion).toBe(6));
      expect(scenario.onConflict).not.toHaveBeenCalled();
      expect(result.current.chatSessionId).toBe(sessionId);
      // A later user turn must start from the final continuation's commit.
      scenario.bodies = [];
      scenario.baseVersion = 6;
      await act(async () => {
        await result.current.sendMessage({ text: "play e5" });
      });
      expect(scenario.bodies.map((body) => body.expectedVersion)).toEqual([
        6, 7,
      ]);
      await waitFor(() => expect(result.current.resumedVersion).toBe(8));
      expect(scenario.onConflict).not.toHaveBeenCalled();
      expect(result.current.chatSessionId).toBe(sessionId);
    },
  );

  it("keeps unversioned surfaces unversioned during the continuation", async () => {
    const { result } = renderHook(useHarness);
    await act(async () => {
      await result.current.sendMessage({ text: "play e4" });
    });
    expect(scenario.bodies).toHaveLength(2);
    expect(scenario.bodies.every((body) => !("expectedVersion" in body))).toBe(
      true,
    );
    expect(scenario.onConflict).not.toHaveBeenCalled();
  });

  it("still reports a genuine concurrent write exactly once", async () => {
    scenario.firstOutcome = "conflict";
    const { result } = renderHook(useHarness);
    act(() => result.current.syncResumedVersion(4));
    await act(async () => {
      await result.current.sendMessage({ text: "play e4" });
    });
    await waitFor(() => expect(scenario.onConflict).toHaveBeenCalledTimes(1));
    expect(result.current.resumedVersion).toBe(4);
    expect(scenario.bodies).toHaveLength(1);
  });
  it("reports a concurrent write during the continuation without advancing past it", async () => {
    scenario.continuationConflict = true;
    const { result } = renderHook(useHarness);
    act(() => result.current.syncResumedVersion(4));
    await act(async () => {
      await result.current.sendMessage({ text: "play e4" });
    });
    expect(scenario.bodies.map((body) => body.expectedVersion)).toEqual([4, 5]);
    expect(scenario.onConflict).toHaveBeenCalledTimes(1);
    expect(result.current.resumedVersion).toBe(5);
  });

  it("ignores a saved receipt belonging to a previously open chat", async () => {
    scenario.staleReceipt = true;
    const { result } = renderHook(useHarness);
    act(() => result.current.syncResumedVersion(4));
    await act(async () => {
      await result.current.sendMessage({ text: "play e4" });
    });
    expect(result.current.resumedVersion).toBe(4);
    expect(scenario.onConflict).not.toHaveBeenCalled();
    expect(scenario.bodies).toHaveLength(1);
  });
});
