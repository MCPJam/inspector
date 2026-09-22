import type { CSSProperties, ReactNode } from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { errorToastMessage } from "@/test/utils";
import { track } from "@/lib/analytics";
import { ChatTabV2 } from "../ChatTabV2";
import {
  NO_RECEIPT_RECONCILE_WINDOW_MS,
  RECEIPT_RECONCILE_WINDOW_MS,
} from "@/hooks/use-resumed-thread-persistence";

const mockToastError = vi.hoisted(() => vi.fn());
const mockGetChatHistoryDetail = vi.hoisted(() => vi.fn());
const mockChatHistoryAction = vi.hoisted(() => vi.fn());
const mockUseFeatureFlagEnabled = vi.hoisted(() => vi.fn(() => true));
const mockReactiveHistoryState = vi.hoisted(() => ({
  session: undefined as any,
  widgetSnapshots: undefined as any,
}));
const chatSessionOnResetRef = vi.hoisted(() => ({
  current: undefined as undefined | ((reason?: string) => void),
}));
const lastUseChatSessionOptionsRef = vi.hoisted(() => ({
  current: undefined as any,
}));
const convexQueryCallsRef = vi.hoisted(() => ({
  current: [] as Array<{ name: string; args: unknown }>,
}));
const mockHistorySession = vi.hoisted(() => ({
  _id: "history-1",
  chatSessionId: "chat-session-1",
  firstMessagePreview: "Hello",
  status: "active" as const,
  directVisibility: "private" as const,
  modelId: "openai/gpt-5-mini",
  modelSource: "mcpjam",
  messageCount: 2,
  version: 4,
  startedAt: 1,
  lastActivityAt: 1,
  isPinned: false,
  manualUnread: false,
  isUnread: false,
}));

async function flushMicrotasks() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

vi.mock("@workos-inc/authkit-react", () => ({
  useAuth: () => ({
    signUp: vi.fn(),
  }),
}));

vi.mock("convex/react", () => ({
  // useChatSession resolves the Convex client to submit elicitation answers
  // straight to the rendezvous table (the blocked replica isn't addressable).
  useConvex: () => ({ mutation: vi.fn().mockResolvedValue({ ok: true }) }),
  useConvexAuth: () => ({
    isAuthenticated: true,
    isLoading: false,
  }),
  useQuery: (name: string, args: unknown) => {
    convexQueryCallsRef.current.push({ name, args });
    if (args === "skip") {
      return undefined;
    }
    if (name === "directChatHistory:getCurrentSession") {
      return mockReactiveHistoryState.session;
    }
    if (name === "directChatHistory:getCurrentSessionWidgetSnapshots") {
      return mockReactiveHistoryState.widgetSnapshots;
    }
    return undefined;
  },
}));

vi.mock("posthog-js/react", () => ({
  usePostHog: () => ({
    capture: vi.fn(),
  }),
  useFeatureFlagEnabled: (...args: unknown[]) =>
    mockUseFeatureFlagEnabled(...args),
}));

vi.mock("@/lib/analytics", () => ({
  track: vi.fn(),
}));

vi.mock("sonner", () => ({
  toast: {
    error: (...args: unknown[]) => mockToastError(...args),
    success: vi.fn(),
  },
}));

vi.mock("@/lib/PosthogUtils", () => ({
  detectEnvironment: vi.fn(() => "test"),
  detectPlatform: vi.fn(() => "web"),
}));

vi.mock("@/hooks/use-json-rpc-panel", () => ({
  useJsonRpcPanelVisibility: () => ({
    isVisible: false,
    toggle: vi.fn(),
  }),
}));

vi.mock("@/hooks/useViews", () => ({
  useProjectServers: () => ({
    serversById: new Map([["server-1", "server-1"]]),
    serversByName: new Map([["server-1", "server-1"]]),
  }),
}));

vi.mock("@/lib/config", () => ({
  HOSTED_MODE: true,
}));

vi.mock("@/contexts/db-user-ready-context", () => ({
  useDbUserReady: () => true,
}));

vi.mock("@/lib/session-token", () => ({
  addTokenToUrl: (url: string) => url,
  authFetch: vi.fn(),
}));

vi.mock("@/lib/oauth/oauth-tokens", () => ({
  buildOAuthTokensByServerId: vi.fn(() => ({})),
}));

vi.mock("@/state/app-state-context", () => ({
  useSharedAppState: () => ({
    servers: {
      "server-1": {
        connectionStatus: "connected",
      },
    },
    projects: {
      "project-1": {
        sharedProjectId: "project-1",
      },
    },
    activeProjectId: "project-1",
  }),
}));

vi.mock("@/components/ui/resizable", () => ({
  ResizablePanelGroup: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  ResizablePanel: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  ResizableHandle: () => <div data-testid="resizable-handle" />,
}));

vi.mock("../logger-view", () => ({
  LoggerView: () => <div data-testid="logger-view" />,
}));

vi.mock("@/components/ElicitationDialog", () => ({
  ElicitationDialog: () => null,
}));

vi.mock("@/components/ui/collapsed-panel-strip", () => ({
  CollapsedPanelStrip: ({
    onOpen,
    tooltipText,
  }: {
    onOpen?: () => void;
    tooltipText?: string;
  }) => (
    <button type="button" data-testid="collapsed-panel-strip" onClick={onOpen}>
      {tooltipText ?? "Open panel"}
    </button>
  ),
}));

vi.mock("@/components/chat-v2/mcpjam-free-models-prompt", () => ({
  MCPJamFreeModelsPrompt: () => <div data-testid="upsell-prompt" />,
}));

vi.mock("@/components/chat-v2/error", () => ({
  // `onRetry` is forwarded so the concurrency-throttle retry path (which
  // reads `lastSentUserMessageRef`) is reachable from a test without
  // reaching into ChatTabV2 internals.
  ErrorBox: ({
    message,
    onRetry,
  }: {
    message: string;
    onRetry?: () => void;
  }) => (
    <div data-testid="error-box">
      {message}
      {onRetry && <button onClick={onRetry}>Retry</button>}
    </div>
  ),
}));

vi.mock("@/components/chat-v2/shared/chat-helpers", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("@/components/chat-v2/shared/chat-helpers")
  >();
  return {
    ...actual,
    STARTER_PROMPTS: [],
    // Tests that need `errorMessage.code`/`limitKind` (e.g. to reach the
    // concurrency-throttle retry path) attach a `formatted` bag to the
    // Error they hand to `mockUseChatSession.error`; everything else keeps
    // getting the old bare `{ message }` shape.
    formatErrorMessage: (
      error: (Error & { formatted?: Record<string, unknown> }) | null
    ) => (error ? { message: error.message, ...error.formatted } : null),
    buildMcpPromptMessages: () => [],
    buildSkillToolMessages: () => [],
  };
});

vi.mock("@/components/chat-v2/chat-input/attachments/file-utils", () => ({
  attachmentsToFileUIParts: vi.fn(async () => []),
  revokeFileAttachmentUrls: vi.fn(),
}));

vi.mock("use-stick-to-bottom", () => {
  const StickToBottomComponent = ({
    children,
    style,
  }: {
    children: ReactNode;
    style?: CSSProperties;
  }) => (
    <div data-testid="stick-to-bottom" style={style}>
      {children}
    </div>
  );
  StickToBottomComponent.Content = ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  );

  return {
    StickToBottom: StickToBottomComponent,
    useStickToBottomContext: () => ({
      isAtBottom: true,
      scrollToBottom: vi.fn(),
    }),
  };
});

vi.mock("@/components/chat-v2/chat-input", () => ({
  ChatInput: ({
    value,
    onChange,
    enableMultiModel,
  }: {
    value: string;
    onChange: (value: string) => void;
    enableMultiModel?: boolean;
  }) => (
    <input
      aria-label="Chat input"
      data-testid="chat-input"
      data-enable-multi-model={enableMultiModel ? "true" : "false"}
      value={value}
      onChange={(event) => onChange(event.target.value)}
    />
  ),
}));

vi.mock("@/components/chat-v2/thread", () => ({
  Thread: ({
    messages,
    onEditUserMessage,
  }: {
    messages: any[];
    onEditUserMessage?: (message: any, text: string) => void;
  }) => (
    <div data-testid="thread" data-message-count={messages.length}>
      {onEditUserMessage && (
        <button
          onClick={() =>
            onEditUserMessage(messages[0], "Edited text should not leak")
          }
        >
          Edit first message
        </button>
      )}
    </div>
  ),
}));

vi.mock("@/components/chat-v2/history/ChatHistoryRail", () => ({
  ChatHistoryRail: ({
    activeSessionId,
    onNewChat,
    onSelectThread,
    onSessionAction,
  }: {
    activeSessionId?: string | null;
    onNewChat: (options?: { shared?: boolean }) => void;
    onSelectThread: (session: typeof mockHistorySession) => void;
    onSessionAction?: (event: {
      action: "share";
      session: typeof mockHistorySession;
    }) => void | Promise<void>;
  }) => (
    <div
      data-testid="history-rail"
      data-active-session-id={activeSessionId ?? "none"}
    >
      <button onClick={() => onSelectThread({ ...mockHistorySession })}>
        Select thread
      </button>
      <button onClick={() => onNewChat()}>New personal thread</button>
      <button onClick={() => onNewChat({ shared: true })}>
        New shared thread
      </button>
      <button
        onClick={() =>
          void onSessionAction?.({
            action: "share",
            session: { ...mockHistorySession },
          })
        }
      >
        Share active thread
      </button>
    </div>
  ),
}));

vi.mock("@/components/chat-v2/multi-model-chat-card", () => ({
  MultiModelChatCard: ({ model }: { model: { name: string } }) => (
    <div data-testid="multi-model-card">{model.name}</div>
  ),
}));

vi.mock("@/components/evals/trace-viewer", () => ({
  TraceViewer: () => <div data-testid="trace-viewer" />,
}));

vi.mock("@/components/evals/trace-view-mode-tabs", () => ({
  ChatTraceViewModeHeaderBar: () => null,
}));

vi.mock("@/components/evals/live-trace-timeline-empty", () => ({
  LiveTraceTimelineEmptyState: () => null,
}));

vi.mock("@/components/evals/live-trace-raw-empty", () => ({
  LiveTraceRawEmptyState: () => null,
}));

const mockUseChatSession = {
  // Elicitation surface (hosted). These suites never elicit, but the shape
  // must match the hook's contract or the dialog crashes on undefined.
  pendingElicitations: [],
  respondToElicitation: vi.fn(),
  elicitationResponding: false,
  urlElicitationRequired: [],
  dismissUrlElicitationRequired: vi.fn(),
  messages: [
    {
      id: "1",
      role: "user",
      parts: [{ type: "text", text: "Hello" }],
    },
    {
      id: "2",
      role: "assistant",
      parts: [{ type: "text", text: "Hi" }],
    },
  ],
  setMessages: vi.fn(),
  sendMessage: vi.fn(),
  stop: vi.fn(),
  status: "ready",
  error: undefined,
  chatSessionId: "chat-session-1",
  selectedModel: {
    id: "openai/gpt-5-mini",
    name: "GPT-5 Mini",
    provider: "openai",
  },
  setSelectedModel: vi.fn(),
  // The steady state: the persisted lead id has matched `availableModels`.
  // Leaving this undefined would silently disable the selected-model sanitize
  // effect for every case below. See BACK2-628.
  isSelectedModelResolved: true,
  selectedModelIds: [],
  setSelectedModelIds: vi.fn(),
  multiModelEnabled: false,
  setMultiModelEnabled: vi.fn(),
  availableModels: [],
  isAuthLoading: false,
  isSessionBootstrapComplete: true,
  systemPrompt: "",
  setSystemPrompt: vi.fn(),
  temperature: 0.7,
  setTemperature: vi.fn(),
  toolsMetadata: {},
  toolServerMap: {},
  tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
  mcpToolsTokenCount: null,
  mcpToolsTokenCountLoading: false,
  systemPromptTokenCount: null,
  systemPromptTokenCountLoading: false,
  requireToolApproval: false,
  setRequireToolApproval: vi.fn(),
  addToolApprovalResponse: vi.fn(),
  resetChat: vi.fn(),
  startChatWithMessages: vi.fn(),
  detachToLocalFork: vi.fn(async () => ({
    chatSessionId: "forked-session",
  })),
  consumePersistReceipt: vi.fn(() => null as any),
  consumeTurnAborted: vi.fn(() => false),
  loadChatSession: vi.fn(async () => undefined),
  rewindToMessage: vi.fn(),
  syncResumedVersion: vi.fn((version: number | null) => {
    mockUseChatSession.resumedVersion = version;
  }),
  resumedVersion: null as number | null,
  restoredToolRenderOverrides: {
    "tool-call-1": {
      uiType: "mcp-apps",
    },
  },
  liveTraceEnvelope: null,
  requestPayloadHistory: [],
  hasTraceSnapshot: false,
  hasLiveTimelineContent: false,
  traceViewsSupported: false,
  isStreaming: false,
  disableForAuthentication: false,
  submitBlocked: false,
} as any;

vi.mock("@/hooks/use-chat-session", () => ({
  useChatSession: (options: any) => {
    chatSessionOnResetRef.current = options.onReset;
    lastUseChatSessionOptionsRef.current = options;

    return {
      ...mockUseChatSession,
      resetChat: (...args: unknown[]) => {
        mockUseChatSession.resetChat(...args);
        chatSessionOnResetRef.current?.("reset");
      },
      startChatWithMessages: (...args: unknown[]) => {
        mockUseChatSession.startChatWithMessages(...args);
        const options = args[1] as { resetReason?: string } | undefined;
        chatSessionOnResetRef.current?.(options?.resetReason ?? "fork");
      },
      detachToLocalFork: async (...args: unknown[]) => {
        const result = await mockUseChatSession.detachToLocalFork(...args);
        chatSessionOnResetRef.current?.("fork");
        // The real fork's hydration is what drops the optimistic-concurrency
        // guard, so a confirmed fork — and only a confirmed fork — clears it.
        if (result) {
          mockUseChatSession.syncResumedVersion(null);
        }
        return result;
      },
      loadChatSession: async (...args: unknown[]) => {
        const result = await mockUseChatSession.loadChatSession(...args);
        chatSessionOnResetRef.current?.("hydrate");
        return result;
      },
    };
  },
}));

vi.mock("@/lib/apis/web/chat-history-api", () => ({
  getChatHistoryDetail: (...args: unknown[]) =>
    mockGetChatHistoryDetail(...args),
  chatHistoryAction: (...args: unknown[]) => mockChatHistoryAction(...args),
}));

describe("ChatTabV2 history sync", () => {
  const defaultProps = {
    connectedOrConnectingServerConfigs: {
      "server-1": {
        name: "server-1",
        connectionStatus: "connected",
      },
    } as any,
    selectedServerNames: ["server-1"],
  };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    mockUseFeatureFlagEnabled.mockReset();
    mockUseFeatureFlagEnabled.mockReturnValue(true);
    vi.stubGlobal(
      "confirm",
      vi.fn(() => true)
    );
    chatSessionOnResetRef.current = undefined;
    lastUseChatSessionOptionsRef.current = undefined;
    convexQueryCallsRef.current = [];
    mockReactiveHistoryState.session = undefined;
    mockReactiveHistoryState.widgetSnapshots = undefined;
    mockUseChatSession.consumePersistReceipt.mockReset().mockReturnValue(null);
    mockUseChatSession.consumeTurnAborted.mockReset().mockReturnValue(false);
    Object.assign(mockUseChatSession, {
      messages: [
        {
          id: "1",
          role: "user",
          parts: [{ type: "text", text: "Hello" }],
        },
        {
          id: "2",
          role: "assistant",
          parts: [{ type: "text", text: "Hi" }],
        },
      ],
      status: "ready",
      error: undefined,
      chatSessionId: "chat-session-1",
      selectedModelIds: [],
      multiModelEnabled: false,
      availableModels: [],
      liveTraceEnvelope: null,
      hasTraceSnapshot: false,
      hasLiveTimelineContent: false,
      traceViewsSupported: false,
      resumedVersion: null,
      restoredToolRenderOverrides: {
        "tool-call-1": {
          uiType: "mcp-apps",
        },
      },
    });
    mockChatHistoryAction.mockResolvedValue({ ok: true });
    mockUseChatSession.rewindToMessage = vi.fn();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("suppresses hosted OAuth token fallback for scenario contexts", () => {
    render(
      <ChatTabV2
        {...defaultProps}
        hostedContext={{
          scenarioId: "cbx_test",
          accessVersion: 1,
          projectId: "project-1",
          selectedServerIds: ["server-1"],
        }}
      />
    );

    expect(lastUseChatSessionOptionsRef.current?.hostedContext).toMatchObject({
      scenarioId: "cbx_test",
      accessVersion: 1,
    });
    expect(
      lastUseChatSessionOptionsRef.current?.hostedContext?.oauthTokens
    ).toBeUndefined();
  });

  it("loads org model config from the effective hosted project id", () => {
    render(
      <ChatTabV2
        {...defaultProps}
        hostedContext={{
          projectId: "hosted-project-1",
          selectedServerIds: ["server-id-1"],
        }}
      />
    );

    expect(convexQueryCallsRef.current).toContainEqual({
      name: "organizationModelProviders:getVisibleConfigForProject",
      args: { projectId: "hosted-project-1" },
    });
    expect(convexQueryCallsRef.current).toContainEqual({
      name: "organizationModelProviders:getVisibleConfig",
      args: "skip",
    });
  });

  it("does not auto-reconnect project chat when oauth is required", async () => {
    const onReconnectServer = vi.fn().mockResolvedValue(undefined);
    mockUseChatSession.error = new Error(
      JSON.stringify({
        details: {
          oauthRequired: true,
          serverId: "server-1",
          serverName: "server-1",
          serverUrl: "https://server-1.example.com/mcp",
        },
      })
    );

    render(
      <ChatTabV2 {...defaultProps} onReconnectServer={onReconnectServer} />
    );

    await flushMicrotasks();

    expect(onReconnectServer).not.toHaveBeenCalled();
  });

  it("asks before discarding a draft when switching threads", async () => {
    render(<ChatTabV2 {...defaultProps} />);

    fireEvent.change(screen.getByRole("textbox", { name: "Chat input" }), {
      target: { value: "Unsaved draft" },
    });

    fireEvent.click(screen.getByRole("button", { name: "Show sessions" }));
    fireEvent.click(screen.getByRole("button", { name: "Select thread" }));
    await flushMicrotasks();

    expect(screen.getByText("Discard unsaved draft?")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await flushMicrotasks();

    expect(mockGetChatHistoryDetail).not.toHaveBeenCalled();
    expect(screen.getByRole("textbox", { name: "Chat input" })).toHaveValue(
      "Unsaved draft"
    );
  });

  it("asks before discarding a draft when starting a new chat", async () => {
    render(<ChatTabV2 {...defaultProps} />);

    fireEvent.change(screen.getByRole("textbox", { name: "Chat input" }), {
      target: { value: "Unsaved draft" },
    });

    fireEvent.click(screen.getByRole("button", { name: "Show sessions" }));
    fireEvent.click(
      screen.getByRole("button", { name: "New personal thread" })
    );
    await flushMicrotasks();

    expect(screen.getByText("Discard unsaved draft?")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await flushMicrotasks();

    expect(mockUseChatSession.resetChat).not.toHaveBeenCalled();
    expect(screen.getByRole("textbox", { name: "Chat input" })).toHaveValue(
      "Unsaved draft"
    );
  });

  it("clears the loading scrim when a pending thread selection is canceled", async () => {
    const deferred = createDeferred<{
      ok: true;
      session: typeof mockHistorySession & {
        messagesBlobUrl: string;
        resumeConfig: { selectedServers: string[] };
      };
      widgetSnapshots: [];
    }>();
    mockGetChatHistoryDetail.mockImplementationOnce(() => deferred.promise);

    render(<ChatTabV2 {...defaultProps} />);

    fireEvent.click(screen.getByRole("button", { name: "Show sessions" }));
    fireEvent.click(screen.getByRole("button", { name: "Select thread" }));
    await flushMicrotasks();

    expect(screen.getByLabelText("Loading chat")).toBeInTheDocument();

    fireEvent.click(
      screen.getByRole("button", { name: "New personal thread" })
    );
    await flushMicrotasks();

    expect(screen.queryByLabelText("Loading chat")).not.toBeInTheDocument();

    await act(async () => {
      deferred.resolve({
        ok: true,
        session: {
          ...mockHistorySession,
          messagesBlobUrl: "https://storage.test/blob",
          resumeConfig: {
            selectedServers: ["server-1"],
          },
        },
        widgetSnapshots: [],
      });
      await Promise.resolve();
    });
    await flushMicrotasks();

    expect(screen.queryByLabelText("Loading chat")).not.toBeInTheDocument();
    expect(mockUseChatSession.loadChatSession).not.toHaveBeenCalled();
  });

  /**
   * Post-stream outcome handling. These replace a suite that pinned the old
   * REST version poll — four detail fetches inside a 1s window, then a detach
   * whenever the version had not moved. That poll could not tell a failed save
   * from a real concurrent edit, so it reported the far commoner failure as a
   * concurrency alarm and took the user's thread away over it.
   */
  describe("post-stream persist outcome", () => {
    const detailResponse = {
      ok: true,
      session: {
        ...mockHistorySession,
        messagesBlobUrl: "https://storage.test/blob",
        resumeConfig: { selectedServers: ["server-1"] },
      },
      widgetSnapshots: [],
    };

    /** Select the history thread, then run a turn to completion. */
    async function resumeThreadAndStream() {
      mockGetChatHistoryDetail
        .mockResolvedValueOnce(detailResponse)
        .mockResolvedValue(detailResponse);

      const view = render(<ChatTabV2 {...defaultProps} />);
      fireEvent.click(screen.getByRole("button", { name: "Show sessions" }));
      fireEvent.click(screen.getByRole("button", { name: "Select thread" }));
      await flushMicrotasks();

      expect(mockUseChatSession.loadChatSession).toHaveBeenCalledTimes(1);

      mockUseChatSession.status = "submitted";
      view.rerender(<ChatTabV2 {...defaultProps} />);
      mockUseChatSession.status = "ready";
      view.rerender(<ChatTabV2 {...defaultProps} />);
      await flushMicrotasks();
      return view;
    }

    it("syncs the version from a saved receipt and stays attached", async () => {
      mockUseChatSession.consumePersistReceipt.mockReturnValue({
        outcome: "saved",
        chatSessionId: "chat-session-1",
        version: 5,
      });

      await resumeThreadAndStream();

      // The NEXT send's expectedVersion comes from here.
      expect(mockUseChatSession.syncResumedVersion).toHaveBeenCalledWith(5);
      expect(mockUseChatSession.detachToLocalFork).not.toHaveBeenCalled();
      expect(mockToastError).not.toHaveBeenCalled();
      expect(screen.getByTestId("history-rail")).toHaveAttribute(
        "data-active-session-id",
        "history-1"
      );
    });

    it("treats a duplicate receipt as saved", async () => {
      // A retried ingest the backend recognized. The turn IS committed.
      mockUseChatSession.consumePersistReceipt.mockReturnValue({
        outcome: "duplicate",
        chatSessionId: "chat-session-1",
        version: 6,
      });

      await resumeThreadAndStream();

      expect(mockUseChatSession.syncResumedVersion).toHaveBeenCalledWith(6);
      expect(mockUseChatSession.detachToLocalFork).not.toHaveBeenCalled();
      expect(mockToastError).not.toHaveBeenCalled();
    });

    it("detaches with accurate copy only on a real conflict", async () => {
      mockUseChatSession.consumePersistReceipt.mockReturnValue({
        outcome: "conflict",
        chatSessionId: "chat-session-1",
        currentVersion: 9,
      });

      await resumeThreadAndStream();

      expect(mockUseChatSession.detachToLocalFork).toHaveBeenCalled();
      expect(mockToastError).toHaveBeenCalledWith(
        errorToastMessage(
          "Someone else updated this chat while you were replying. Your reply stayed here; your next message will start a new thread."
        ),
        { duration: 8000 }
      );
      expect(screen.getByTestId("history-rail")).toHaveAttribute(
        "data-active-session-id",
        "none"
      );
    });

    it("reports an unsaved reply honestly and keeps the thread attached", async () => {
      mockUseChatSession.consumePersistReceipt.mockReturnValue({
        outcome: "failed",
        chatSessionId: "chat-session-1",
        failureKind: "timeout",
      });

      const view = await resumeThreadAndStream();

      // Ambiguous until reconciliation gives up: a timed-out ingest may still
      // have committed, so nothing is said yet.
      expect(mockToastError).not.toHaveBeenCalled();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(RECEIPT_RECONCILE_WINDOW_MS + 500);
      });
      view.rerender(<ChatTabV2 {...defaultProps} />);
      await flushMicrotasks();

      expect(mockToastError).toHaveBeenCalledWith(
        errorToastMessage(
          "This reply couldn't be saved to your chat history. It's still visible here."
        ),
        { duration: 8000 }
      );
      // The whole point: no forced new thread over a save failure.
      expect(mockUseChatSession.detachToLocalFork).not.toHaveBeenCalled();
      expect(screen.getByTestId("history-rail")).toHaveAttribute(
        "data-active-session-id",
        "history-1"
      );
    });

    it("reconciles a failed receipt to saved when the version advances", async () => {
      // The write landed after the ingest call gave up on it.
      mockUseChatSession.consumePersistReceipt.mockReturnValue({
        outcome: "failed",
        chatSessionId: "chat-session-1",
        failureKind: "timeout",
      });

      const view = await resumeThreadAndStream();

      mockReactiveHistoryState.session = {
        ...mockHistorySession,
        version: 5,
        messagesBlobUrl: null,
      };
      mockReactiveHistoryState.widgetSnapshots = [];
      view.rerender(<ChatTabV2 {...defaultProps} />);
      await flushMicrotasks();

      expect(mockUseChatSession.syncResumedVersion).toHaveBeenCalledWith(5);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(RECEIPT_RECONCILE_WINDOW_MS + 2_000);
      });
      view.rerender(<ChatTabV2 {...defaultProps} />);
      await flushMicrotasks();

      expect(mockToastError).not.toHaveBeenCalled();
      expect(mockUseChatSession.detachToLocalFork).not.toHaveBeenCalled();
    });

    it("falls back to the subscription when no receipt arrives", async () => {
      // Deploy skew: this bundle against an inspector server that predates the
      // receipt part. Never auto-detach without positive evidence.
      mockUseChatSession.consumePersistReceipt.mockReturnValue(null);

      const view = await resumeThreadAndStream();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(
          NO_RECEIPT_RECONCILE_WINDOW_MS - 1_000
        );
      });
      view.rerender(<ChatTabV2 {...defaultProps} />);
      await flushMicrotasks();

      // Past the receipt window but still inside the longer no-receipt one —
      // silence from an old server is not evidence of anything yet.
      expect(mockToastError).not.toHaveBeenCalled();

      mockReactiveHistoryState.session = {
        ...mockHistorySession,
        version: 5,
        messagesBlobUrl: null,
      };
      mockReactiveHistoryState.widgetSnapshots = [];
      view.rerender(<ChatTabV2 {...defaultProps} />);
      await flushMicrotasks();

      expect(mockUseChatSession.syncResumedVersion).toHaveBeenCalledWith(5);
      expect(mockToastError).not.toHaveBeenCalled();
      expect(mockUseChatSession.detachToLocalFork).not.toHaveBeenCalled();
    });
  });

  it("keeps the active resumed thread selected when servers change", async () => {
    const detailResponse = {
      ok: true,
      session: {
        ...mockHistorySession,
        messagesBlobUrl: "https://storage.test/blob",
        resumeConfig: {
          selectedServers: ["server-1"],
        },
      },
      widgetSnapshots: [],
    };

    mockGetChatHistoryDetail.mockResolvedValue(detailResponse);

    const view = render(<ChatTabV2 {...defaultProps} />);

    fireEvent.click(screen.getByRole("button", { name: "Show sessions" }));
    fireEvent.click(screen.getByRole("button", { name: "Select thread" }));
    await flushMicrotasks();

    expect(screen.getByTestId("history-rail")).toHaveAttribute(
      "data-active-session-id",
      "history-1"
    );

    view.rerender(<ChatTabV2 {...defaultProps} selectedServerNames={[]} />);
    await flushMicrotasks();

    expect(screen.getByTestId("history-rail")).toHaveAttribute(
      "data-active-session-id",
      "history-1"
    );
    expect(mockUseChatSession.startChatWithMessages).not.toHaveBeenCalled();
    expect(mockUseChatSession.detachToLocalFork).not.toHaveBeenCalled();
    expect(mockUseChatSession.syncResumedVersion).not.toHaveBeenCalledWith(
      null
    );
    expect(mockToastError).not.toHaveBeenCalled();
  });

  it("switches new shared threads to project visibility without persisting a draft", async () => {
    render(<ChatTabV2 {...defaultProps} />);

    fireEvent.click(screen.getByRole("button", { name: "Show sessions" }));
    fireEvent.click(screen.getByRole("button", { name: "New shared thread" }));
    await flushMicrotasks();

    expect(lastUseChatSessionOptionsRef.current?.directVisibility).toBe(
      "project"
    );
    expect(mockGetChatHistoryDetail).not.toHaveBeenCalled();
  });

  it("hides the multi-model toggle when the active thread is shared", async () => {
    mockUseChatSession.availableModels = [
      { id: "openai/gpt-5-mini", name: "GPT-5 Mini", provider: "openai" },
      {
        id: "anthropic/claude-sonnet-4-5",
        name: "Claude Sonnet 4.5",
        provider: "anthropic",
      },
    ];
    const privateDetailResponse = {
      ok: true,
      session: {
        ...mockHistorySession,
        directVisibility: "private" as const,
        messagesBlobUrl: "https://storage.test/blob",
        resumeConfig: { selectedServers: ["server-1"] },
      },
      widgetSnapshots: [],
    };
    const sharedDetailResponse = {
      ...privateDetailResponse,
      session: {
        ...privateDetailResponse.session,
        directVisibility: "project" as const,
        version: 5,
      },
    };
    mockGetChatHistoryDetail
      .mockResolvedValueOnce(privateDetailResponse)
      .mockResolvedValueOnce(sharedDetailResponse);

    render(<ChatTabV2 {...defaultProps} enableMultiModelChat={true} />);

    expect(screen.getByTestId("chat-input")).toHaveAttribute(
      "data-enable-multi-model",
      "true"
    );

    fireEvent.click(screen.getByRole("button", { name: "Show sessions" }));
    fireEvent.click(screen.getByRole("button", { name: "Select thread" }));
    await flushMicrotasks();

    expect(screen.getByTestId("chat-input")).toHaveAttribute(
      "data-enable-multi-model",
      "true"
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Share active thread" })
    );
    await flushMicrotasks();

    expect(screen.getByTestId("chat-input")).toHaveAttribute(
      "data-enable-multi-model",
      "false"
    );
  });

  it("keeps direct visibility in sync when the active thread is shared", async () => {
    const privateDetailResponse = {
      ok: true,
      session: {
        ...mockHistorySession,
        directVisibility: "private" as const,
        messagesBlobUrl: "https://storage.test/blob",
        resumeConfig: {
          selectedServers: ["server-1"],
        },
      },
      widgetSnapshots: [],
    };
    const sharedDetailResponse = {
      ...privateDetailResponse,
      session: {
        ...privateDetailResponse.session,
        directVisibility: "project" as const,
        version: 5,
      },
    };

    mockGetChatHistoryDetail
      .mockResolvedValueOnce(privateDetailResponse)
      .mockResolvedValueOnce(sharedDetailResponse);

    render(<ChatTabV2 {...defaultProps} />);

    fireEvent.click(screen.getByRole("button", { name: "Show sessions" }));
    fireEvent.click(screen.getByRole("button", { name: "Select thread" }));
    await flushMicrotasks();

    expect(lastUseChatSessionOptionsRef.current?.directVisibility).toBe(
      "private"
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Share active thread" })
    );
    await flushMicrotasks();

    expect(lastUseChatSessionOptionsRef.current?.directVisibility).toBe(
      "project"
    );
  });

  it("preserves a local draft while applying a reactive history refresh", async () => {
    const initialDetailResponse = {
      ok: true,
      session: {
        ...mockHistorySession,
        messagesBlobUrl: "https://storage.test/blob",
        resumeConfig: {
          selectedServers: ["server-1"],
        },
      },
      widgetSnapshots: [],
    };

    mockGetChatHistoryDetail.mockResolvedValue(initialDetailResponse);

    const view = render(<ChatTabV2 {...defaultProps} />);

    fireEvent.click(screen.getByRole("button", { name: "Show sessions" }));
    fireEvent.click(screen.getByRole("button", { name: "Select thread" }));
    await flushMicrotasks();

    mockUseChatSession.loadChatSession.mockClear();

    fireEvent.change(screen.getByRole("textbox", { name: "Chat input" }), {
      target: { value: "Local draft reply" },
    });

    mockReactiveHistoryState.session = {
      ...initialDetailResponse.session,
      version: 5,
      resumeConfig: {
        selectedServers: ["server-1"],
      },
    };
    mockReactiveHistoryState.widgetSnapshots = [];

    view.rerender(<ChatTabV2 {...defaultProps} />);
    await flushMicrotasks();

    expect(mockUseChatSession.loadChatSession).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("textbox", { name: "Chat input" })).toHaveValue(
      "Local draft reply"
    );
  });

  it("preserves a local draft across auth bootstrap resets", async () => {
    render(<ChatTabV2 {...defaultProps} />);

    fireEvent.change(screen.getByRole("textbox", { name: "Chat input" }), {
      target: { value: "Unsaved local draft" },
    });

    act(() => {
      chatSessionOnResetRef.current?.("auth-bootstrap");
    });
    await flushMicrotasks();

    expect(screen.getByRole("textbox", { name: "Chat input" })).toHaveValue(
      "Unsaved local draft"
    );
    expect(mockChatHistoryAction).not.toHaveBeenCalledWith(
      "archive",
      "history-1"
    );
  });

  it("tracks the edit and arms the resend ref when a rewind succeeds", async () => {
    // The positive half of the ordering fix — the refusal test below pins only
    // the negative half. On a successful branch both effects must fire: the
    // analytics event and the shared resend ref. Nothing is shown to the user;
    // the branch is deliberately silent.
    mockUseChatSession.rewindToMessage.mockResolvedValue({
      previousChatSessionId: "prev-session-1",
    });
    // Attach `formatted` so the mocked `formatErrorMessage` surfaces
    // `code`/`limitKind`, which is what makes the concurrency-throttle "Retry"
    // button appear — the only reachable reader of `lastSentUserMessageRef`.
    mockUseChatSession.error = Object.assign(
      new Error("Too many concurrent requests"),
      { formatted: { code: "user_rate_limit", limitKind: "concurrency" } }
    );

    render(<ChatTabV2 {...defaultProps} />);

    fireEvent.click(screen.getByRole("button", { name: "Edit first message" }));
    await flushMicrotasks();

    expect(mockUseChatSession.rewindToMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        messageId: "1",
        text: "Edited text should not leak",
      })
    );
    expect(track).toHaveBeenCalledWith("edit_message", {
      location: "chat_tab",
      model_id: "openai/gpt-5-mini",
      model_name: "GPT-5 Mini",
      model_provider: "openai",
    });

    // The edited text IS what a later resend should carry now that it actually
    // went out — the mirror image of the refusal case, where it must not.
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await flushMicrotasks();

    expect(mockUseChatSession.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ text: "Edited text should not leak" })
    );
  });

  it("asks before discarding an unsent draft on edit, and does not rewind until confirmed", async () => {
    // A rewind ends in `onReset("fork")`, which wipes the composer. New Chat
    // and thread selection both confirm first; editing has to as well, or a
    // typed-but-unsent draft vanishes when the user clicks the pencil.
    mockUseChatSession.rewindToMessage.mockResolvedValue({
      previousChatSessionId: "prev-session-1",
    });

    render(<ChatTabV2 {...defaultProps} />);

    fireEvent.change(screen.getByRole("textbox", { name: "Chat input" }), {
      target: { value: "Draft the user has not sent yet" },
    });

    fireEvent.click(screen.getByRole("button", { name: "Edit first message" }));
    await flushMicrotasks();

    // The dialog is the load-bearing assertion: it appears ONLY because the
    // edit path awaits `ensureDiscardDraftConfirmed`. Asserting merely that
    // `rewindToMessage` has not fired yet would pass on timing alone, with or
    // without the gate — verified by removing the gate and watching that
    // weaker assertion still pass.
    expect(screen.getByText("Discard unsaved draft?")).toBeInTheDocument();
    expect(mockUseChatSession.rewindToMessage).not.toHaveBeenCalled();
  });

  it("withholds the edit affordance on the scenario surface, which has no history", async () => {
    // `ChatTabV2` is also the published scenario runtime (`ScenarioChatPage`
    // renders it with `minimalMode` + `hostedContext.scenarioId`), so
    // `showHistoryRail` is false there. Editing BRANCHES and leaves the
    // original behind; with no history surface to reach it through, that
    // discards the original thread with no way back, and the notice's promise
    // ("still in your history") would be false. The pencil must not render.
    render(
      <ChatTabV2
        {...defaultProps}
        minimalMode
        hostedContext={{
          scenarioId: "cbx_test",
          accessVersion: 1,
          projectId: "project-1",
          selectedServerIds: ["server-1"],
        }}
      />
    );

    // The Thread mock only renders this button when `onEditUserMessage` is
    // provided, so its absence is the absence of the affordance.
    expect(
      screen.queryByRole("button", { name: "Edit first message" })
    ).not.toBeInTheDocument();
  });

  it("does not fire edit_message analytics or corrupt the resend ref when a rewind is refused", async () => {
    // `rewindToMessage` resolving `null` means the rewind was refused (a
    // turn started in the gap after `ensureThreadReadyForSend`'s network
    // round trip, or the target message is gone). Nothing branched, so
    // neither the analytics event nor the shared resend ref should be
    // touched.
    mockUseChatSession.rewindToMessage.mockResolvedValue(null);
    // Attach `formatted` so the mocked `formatErrorMessage` (see the
    // chat-helpers mock above) surfaces `code`/`limitKind`, which is what
    // makes the concurrency-throttle "Retry" button appear — the only
    // reachable reader of `lastSentUserMessageRef` in this test file.
    mockUseChatSession.error = Object.assign(
      new Error("Too many concurrent requests"),
      { formatted: { code: "user_rate_limit", limitKind: "concurrency" } }
    );
    mockGetChatHistoryDetail.mockResolvedValue({
      ok: true,
      session: {
        ...mockHistorySession,
        messagesBlobUrl: "https://storage.test/blob",
        resumeConfig: { selectedServers: ["server-1"] },
      },
      widgetSnapshots: [],
    });

    render(<ChatTabV2 {...defaultProps} />);

    fireEvent.click(screen.getByRole("button", { name: "Edit first message" }));
    await flushMicrotasks();

    expect(mockUseChatSession.rewindToMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        messageId: "1",
        text: "Edited text should not leak",
      })
    );
    expect(
      vi.mocked(track).mock.calls.some(([event]) => event === "edit_message")
    ).toBe(false);

    // The refused edit must not have stomped `lastSentUserMessageRef`: the
    // concurrency-throttle retry reads that same ref, and if the edited
    // text had leaked into it, clicking "Retry" here would resend it.
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await flushMicrotasks();

    expect(mockUseChatSession.sendMessage).not.toHaveBeenCalled();
  });

  it("detaches from the resumed thread before the branch's turn is dispatched", async () => {
    // The post-stream conflict check captures its baseline the instant the
    // stream starts — and that happens INSIDE `rewindToMessage`, just after the
    // branch is minted. If the surface is still attached to the ORIGINAL thread
    // at that moment, the baseline names the original, the completed stream is
    // compared against it, and a deliberate branch is reported as a phantom
    // "this chat changed elsewhere". That path also re-forks, so the user's NEXT
    // message lands in a third session. Detaching has to happen BEFORE the
    // rewind is dispatched; doing it after `rewindToMessage` returns is already
    // too late, which is why this asserts on state as observed from inside it.
    mockGetChatHistoryDetail.mockResolvedValue({
      ok: true,
      session: {
        ...mockHistorySession,
        messagesBlobUrl: "https://storage.test/blob",
        resumeConfig: { selectedServers: ["server-1"] },
      },
      widgetSnapshots: [],
    });

    let resumedVersionWhenRewound: number | null | undefined = undefined;
    // The real hook fires `onBeforeBranch` as the branch is minted, just
    // before the turn dispatches; observing after it is what makes this an
    // ordering assertion rather than a no-op.
    mockUseChatSession.rewindToMessage.mockImplementation(async (options) => {
      options?.onBeforeBranch?.();
      resumedVersionWhenRewound = mockUseChatSession.resumedVersion;
      return { previousChatSessionId: "prev-session-1" };
    });

    render(<ChatTabV2 {...defaultProps} />);

    fireEvent.click(screen.getByRole("button", { name: "Show sessions" }));
    fireEvent.click(screen.getByRole("button", { name: "Select thread" }));
    await flushMicrotasks();

    // Guard against a vacuous pass: the thread has to really be resumed here,
    // or "it was null at rewind time" would prove nothing.
    expect(mockUseChatSession.resumedVersion).toBe(4);
    expect(screen.getByTestId("history-rail")).toHaveAttribute(
      "data-active-session-id",
      "history-1"
    );

    fireEvent.click(screen.getByRole("button", { name: "Edit first message" }));
    await flushMicrotasks();

    expect(resumedVersionWhenRewound).toBeNull();
    expect(screen.getByTestId("history-rail")).toHaveAttribute(
      "data-active-session-id",
      "none"
    );
  });
});
