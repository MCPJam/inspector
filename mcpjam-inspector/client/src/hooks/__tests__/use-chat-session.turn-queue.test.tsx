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

const toastError = vi.hoisted(() => vi.fn());
vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), {
    error: toastError,
    success: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
    message: vi.fn(),
    dismiss: vi.fn(),
  }),
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

// A send waits here before dispatch; a test can hold it to open a window in
// which another turn starts.
const browserRelease = vi.hoisted(() => ({
  hold: null as Promise<void> | null,
}));
vi.mock("@/lib/browser-shell/chat-handoff", async () => ({
  ...(await vi.importActual("@/lib/browser-shell/chat-handoff")),
  releaseBrowserForChat: vi.fn(async () => {
    await browserRelease.hold;
  }),
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

// PLB-475: one chat turn at a time. Each request's stream stays open until the
// test releases it, so a second send can arrive while the first is streaming.
const scenario = vi.hoisted(() => ({
  bodies: [] as Record<string, unknown>[],
  releases: [] as Array<() => void>,
  firstCallsAppTool: false,
  firstAsksApproval: false,
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
      const turnId = `turn-${request}`;
      const expected = body?.expectedVersion;
      const version = typeof expected === "number" ? expected + 1 : undefined;
      let release!: () => void;
      const released = new Promise<void>((done) => {
        release = done;
      });
      scenario.releases.push(release);
      return new ReadableStream<UIMessageChunk>({
        async start(controller) {
          controller.enqueue({
            type: "start",
            messageId: `assistant-${request}`,
          });
          controller.enqueue({ type: "start-step" });
          controller.enqueue({
            type: "data-trace-event",
            transient: true,
            data: {
              type: "turn_start",
              turnId,
              promptIndex: 0,
              startedAtMs: Date.now(),
            },
          });
          const appTool = request === 1 && scenario.firstCallsAppTool;
          if (appTool) {
            // A client-fulfilled App tool: the SDK sends the continuation.
            controller.enqueue({
              type: "tool-input-available",
              toolCallId: "app-call-1",
              toolName: "app_deadbeef",
              input: {},
            });
          } else if (request === 1 && scenario.firstAsksApproval) {
            controller.enqueue({
              type: "tool-input-available",
              toolCallId: "call-1",
              toolName: "delete_file",
              input: {},
            });
            controller.enqueue({
              type: "tool-approval-request",
              approvalId: "approval-1",
              toolCallId: "call-1",
            });
          } else {
            controller.enqueue({ type: "text-start", id: "text" });
            controller.enqueue({
              type: "text-delta",
              id: "text",
              delta: `reply ${request}`,
            });
          }
          await released;
          const textOpen =
            !appTool && !(request === 1 && scenario.firstAsksApproval);
          if (textOpen) controller.enqueue({ type: "text-end", id: "text" });
          controller.enqueue({ type: "finish-step" });
          controller.enqueue({ type: "finish" });
          controller.enqueue({
            type: "data-persist-receipt",
            transient: true,
            data: {
              outcome: "saved",
              chatSessionId: String(body?.chatSessionId),
              turnId,
              ...(version === undefined ? {} : { version }),
            },
          });
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
  toastError.mockClear();
  browserRelease.hold = null;
  scenario.bodies = [];
  scenario.releases = [];
  scenario.firstCallsAppTool = false;
  scenario.firstAsksApproval = false;
  scenario.onConflict.mockClear();
  scenario.onUnsaved.mockClear();
});

describe("one chat turn at a time (real AI SDK)", () => {
  it("starts a send that arrives during a streaming turn only after that turn, with its saved version", async () => {
    const { result } = renderHook(useHarness);
    act(() => result.current.syncResumedVersion(4));

    await act(async () => {
      void result.current.sendMessage({ text: "count to 150" });
    });
    await waitFor(() => expect(result.current.status).toBe("streaming"));

    // An App message arrives while the reply streams.
    await act(async () => {
      void result.current.sendMessage({ text: "App follow-up" });
    });
    await act(async () => {});
    expect(scenario.bodies).toHaveLength(1);

    await act(async () => scenario.releases[0]());
    await waitFor(() => expect(scenario.bodies).toHaveLength(2));
    expect(scenario.bodies.map((body) => body.expectedVersion)).toEqual([4, 5]);

    await act(async () => scenario.releases[1]());
    await waitFor(() => expect(result.current.resumedVersion).toBe(6));
    expect(scenario.onConflict).not.toHaveBeenCalled();
  });

  it("drops a queued send when the user stops the running turn, with one notice", async () => {
    const { result } = renderHook(useHarness);
    act(() => result.current.syncResumedVersion(4));
    await act(async () => {
      void result.current.sendMessage({ text: "count to 150" });
    });
    await waitFor(() => expect(result.current.status).toBe("streaming"));

    let queued: Promise<boolean> | undefined;
    await act(async () => {
      queued = result.current.sendMessage({ text: "App follow-up" });
    });
    await act(async () => result.current.stop());
    await act(async () => scenario.releases[0]());

    await expect(queued).resolves.toBe(false);
    await act(async () => {});
    expect(scenario.bodies).toHaveLength(1);
    expect(
      toastError.mock.calls.filter(
        ([, options]) => options?.id === "chat-turn-dropped",
      ),
    ).toHaveLength(1);
  });

  it("adds a queued send's prompt and skill messages right before its own user message", async () => {
    const { result } = renderHook(useHarness);
    await act(async () => {
      void result.current.sendMessage({ text: "count to 150" });
    });
    await waitFor(() => expect(result.current.status).toBe("streaming"));

    const skill = {
      id: "skill-context",
      role: "user" as const,
      parts: [{ type: "text" as const, text: "skill context" }],
    };
    await act(async () => {
      void result.current.sendMessage({
        text: "App follow-up",
        prependMessages: [skill],
      });
    });
    expect(result.current.messages.map((m) => m.id)).not.toContain(
      "skill-context",
    );

    await act(async () => scenario.releases[0]());
    await waitFor(() => expect(scenario.bodies).toHaveLength(2));
    const texts = result.current.messages.map((m) =>
      m.parts.map((part) => ("text" in part ? part.text : "")).join(""),
    );
    expect(texts.slice(-3)).toEqual([
      "skill context",
      "App follow-up",
      "reply 2",
    ]);
  });

  it("waits for the SDK's automatic follow-up request, not only for the first stream", async () => {
    scenario.firstCallsAppTool = true;
    const { result } = renderHook(useHarness);
    act(() => result.current.syncResumedVersion(4));
    await act(async () => {
      void result.current.sendMessage({ text: "play e4" });
    });
    await waitFor(() => expect(scenario.bodies).toHaveLength(1));

    let queuedSent = false;
    await act(async () => {
      void result.current
        .sendMessage({ text: "App follow-up" })
        .then((sent) => (queuedSent = sent));
    });

    await act(async () => scenario.releases[0]());
    // The App tool's continuation goes first; it is still the first turn.
    await waitFor(() => expect(scenario.bodies).toHaveLength(2));
    await act(async () => {});
    expect(queuedSent).toBe(false);
    expect(scenario.bodies).toHaveLength(2);

    await act(async () => scenario.releases[1]());
    await waitFor(() => expect(scenario.bodies).toHaveLength(3));
    expect(queuedSent).toBe(true);
    expect(scenario.bodies.map((body) => body.expectedVersion)).toEqual([
      4, 5, 6,
    ]);
    await act(async () => scenario.releases[2]());
    expect(scenario.onConflict).not.toHaveBeenCalled();
  });
  it("drops a queued send when the chat changes before its turn, with one notice", async () => {
    const { result } = renderHook(useHarness);
    await act(async () => {
      void result.current.sendMessage({ text: "count to 150" });
    });
    await waitFor(() => expect(result.current.status).toBe("streaming"));

    let queued: Promise<boolean> | undefined;
    await act(async () => {
      queued = result.current.sendMessage({ text: "App follow-up" });
    });
    act(() => result.current.resetChat());
    await act(async () => scenario.releases[0]());

    await expect(queued).resolves.toBe(false);
    expect(scenario.bodies).toHaveLength(1);
    expect(
      toastError.mock.calls.filter(
        ([, options]) => options?.id === "chat-turn-dropped",
      ),
    ).toHaveLength(1);
  });

  it("holds a queued send until a pending approval is answered and its step ends", async () => {
    scenario.firstAsksApproval = true;
    const { result } = renderHook(useHarness);
    act(() => result.current.syncResumedVersion(4));
    await act(async () => {
      void result.current.sendMessage({ text: "delete the file" });
    });
    await waitFor(() => expect(result.current.status).toBe("streaming"));

    let queuedSent = false;
    await act(async () => {
      void result.current
        .sendMessage({ text: "App follow-up" })
        .then((sent) => (queuedSent = sent));
    });
    await act(async () => scenario.releases[0]());
    await waitFor(() => expect(result.current.status).toBe("ready"));
    await act(async () => {});
    expect(scenario.bodies).toHaveLength(1);

    await act(async () => {
      await result.current.addToolApprovalResponse({
        id: "approval-1",
        approved: true,
      });
    });
    // The approved step goes first; the App message waits for it.
    await waitFor(() => expect(scenario.bodies).toHaveLength(2));
    await act(async () => {});
    expect(queuedSent).toBe(false);
    expect(scenario.bodies).toHaveLength(2);

    await act(async () => scenario.releases[1]());
    await waitFor(() => expect(scenario.bodies).toHaveLength(3));
    expect(queuedSent).toBe(true);
    expect(scenario.bodies.map((body) => body.expectedVersion)).toEqual([
      4, 5, 6,
    ]);
    await act(async () => scenario.releases[2]());
  });

  it("gives a queued send's widget context to its own request, not to the running turn's follow-up", async () => {
    scenario.firstCallsAppTool = true;
    const { result } = renderHook(useHarness);
    await act(async () => {
      void result.current.sendMessage({ text: "play e4" });
    });
    await waitFor(() => expect(scenario.bodies).toHaveLength(1));

    const context = [
      {
        toolCallId: "app-call-1",
        context: { structuredContent: { board: "e4" } },
      },
    ];
    await act(async () => {
      void result.current.sendMessage({
        text: "App follow-up",
        widgetModelContext: context,
      });
    });
    await act(async () => scenario.releases[0]());
    await waitFor(() => expect(scenario.bodies).toHaveLength(2));
    expect(scenario.bodies[1]).not.toHaveProperty("widgetModelContext");

    await act(async () => scenario.releases[1]());
    await waitFor(() => expect(scenario.bodies).toHaveLength(3));
    expect(scenario.bodies[2].widgetModelContext).toEqual(context);
    await act(async () => scenario.releases[2]());
  });
  it("waits for an approved step that started while the send was being prepared", async () => {
    scenario.firstAsksApproval = true;
    const { result } = renderHook(useHarness);
    act(() => result.current.syncResumedVersion(4));
    await act(async () => {
      void result.current.sendMessage({ text: "delete the file" });
    });
    await act(async () => scenario.releases[0]());
    await waitFor(() => expect(result.current.status).toBe("ready"));

    // Nothing is queued, so this send starts at once and waits in preparation.
    let releaseBrowser!: () => void;
    browserRelease.hold = new Promise<void>((done) => {
      releaseBrowser = done;
    });
    let sent = false;
    await act(async () => {
      void result.current
        .sendMessage({ text: "App follow-up" })
        .then((value) => (sent = value));
    });
    await act(async () => {
      await result.current.addToolApprovalResponse({
        id: "approval-1",
        approved: true,
      });
    });
    await waitFor(() => expect(scenario.bodies).toHaveLength(2));

    await act(async () => releaseBrowser());
    await act(async () => {});
    expect(sent).toBe(false);
    expect(scenario.bodies).toHaveLength(2);

    await act(async () => scenario.releases[1]());
    await waitFor(() => expect(scenario.bodies).toHaveLength(3));
    expect(scenario.bodies.map((body) => body.expectedVersion)).toEqual([
      4, 5, 6,
    ]);
    await act(async () => scenario.releases[2]());
  });
});
