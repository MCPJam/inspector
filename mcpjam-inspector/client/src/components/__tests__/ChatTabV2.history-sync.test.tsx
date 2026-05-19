import type { CSSProperties, ReactNode } from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatTabV2 } from "../ChatTabV2";

const mockToastError = vi.hoisted(() => vi.fn());
const mockGetChatHistoryDetail = vi.hoisted(() => vi.fn());
const mockChatHistoryAction = vi.hoisted(() => vi.fn());
const mockUseFeatureFlagEnabled = vi.hoisted(() => vi.fn(() => true));
const mockReactiveHistoryState = vi.hoisted(() => ({
  session: undefined as any,
  widgetSnapshots: undefined as any,
  liveTurn: undefined as any,
}));
const chatSessionOnResetRef = vi.hoisted(() => ({
  current: undefined as undefined | ((reason?: string) => void),
}));
const lastUseChatSessionOptionsRef = vi.hoisted(() => ({
  current: undefined as any,
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
  useConvexAuth: () => ({
    isAuthenticated: true,
    isLoading: false,
  }),
  useQuery: (name: string, args: unknown) => {
    if (args === "skip") {
      return undefined;
    }
    if (name === "directChatHistory:getCurrentSession") {
      return mockReactiveHistoryState.session;
    }
    if (name === "directChatHistory:getCurrentSessionWidgetSnapshots") {
      return mockReactiveHistoryState.widgetSnapshots;
    }
    if (name === "directChatHistory:getCurrentSessionLiveTurn") {
      return mockReactiveHistoryState.liveTurn;
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
  ErrorBox: ({ message }: { message: string }) => (
    <div data-testid="error-box">{message}</div>
  ),
}));

vi.mock("@/components/chat-v2/shared/chat-helpers", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("@/components/chat-v2/shared/chat-helpers")
  >();
  return {
    ...actual,
    STARTER_PROMPTS: [],
    formatErrorMessage: (error: Error | null) =>
      error ? { message: error.message } : null,
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
  }: {
    value: string;
    onChange: (value: string) => void;
  }) => (
    <input
      aria-label="Chat input"
      data-testid="chat-input"
      value={value}
      onChange={(event) => onChange(event.target.value)}
    />
  ),
}));

vi.mock("@/components/chat-v2/thread", () => ({
  Thread: ({ messages }: { messages: any[] }) => (
    <div data-testid="thread" data-message-count={messages.length} />
  ),
}));

vi.mock("@/components/chat-v2/history/ChatHistoryRail", () => ({
  ChatHistoryRail: ({
    activeSessionId,
    sharedThreadsEnabled = true,
    onNewChat,
    onSelectThread,
    onSessionAction,
  }: {
    activeSessionId?: string | null;
    sharedThreadsEnabled?: boolean;
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
      data-shared-threads-enabled={sharedThreadsEnabled ? "true" : "false"}
    >
      <button onClick={() => onSelectThread({ ...mockHistorySession })}>
        Select thread
      </button>
      <button onClick={() => onNewChat()}>New personal thread</button>
      {sharedThreadsEnabled ? (
        <button onClick={() => onNewChat({ shared: true })}>
          New shared thread
        </button>
      ) : null}
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
  loadChatSession: vi.fn(async () => undefined),
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
    mockReactiveHistoryState.session = undefined;
    mockReactiveHistoryState.widgetSnapshots = undefined;
    mockReactiveHistoryState.liveTurn = undefined;
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
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("suppresses hosted OAuth token fallback for chatbox contexts", () => {
    render(
      <ChatTabV2
        {...defaultProps}
        hostedContext={{
          chatboxId: "cbx_test", accessVersion: 1,
          projectId: "project-1",
          selectedServerIds: ["server-1"],
        }}
      />
    );

    expect(lastUseChatSessionOptionsRef.current?.hostedContext).toMatchObject({
      chatboxId: "cbx_test", accessVersion: 1,
    });
    expect(
      lastUseChatSessionOptionsRef.current?.hostedContext?.oauthTokens
    ).toBeUndefined();
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

  it("detaches a resumed thread after the refreshed version never advances", async () => {
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

    mockGetChatHistoryDetail
      .mockResolvedValueOnce(detailResponse)
      .mockResolvedValue(detailResponse);

    const view = render(<ChatTabV2 {...defaultProps} />);

    fireEvent.click(screen.getByRole("button", { name: "Show sessions" }));
    fireEvent.click(screen.getByRole("button", { name: "Select thread" }));

    await flushMicrotasks();

    expect(mockUseChatSession.loadChatSession).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("history-rail")).toHaveAttribute(
      "data-active-session-id",
      "history-1"
    );

    mockUseChatSession.status = "submitted";
    view.rerender(<ChatTabV2 {...defaultProps} />);

    mockUseChatSession.status = "ready";
    view.rerender(<ChatTabV2 {...defaultProps} />);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    await flushMicrotasks();

    expect(mockGetChatHistoryDetail).toHaveBeenCalledTimes(4);
    expect(screen.getByTestId("history-rail")).toHaveAttribute(
      "data-active-session-id",
      "none"
    );

    expect(mockUseChatSession.startChatWithMessages).toHaveBeenCalledWith(
      [
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
      {
        toolRenderOverrides: {
          "tool-call-1": {
            uiType: "mcp-apps",
          },
        },
      }
    );
    expect(mockUseChatSession.syncResumedVersion).toHaveBeenCalledWith(null);
    expect(mockToastError).toHaveBeenCalledWith(
      "This chat changed elsewhere. This reply stayed local, and your next send will continue in a new thread."
    );
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

  it("keeps the history rail visible while hiding shared-thread affordances when the flag is off", async () => {
    mockUseFeatureFlagEnabled.mockImplementation((flag: string) =>
      flag === "shared-threads-enabled" ? false : true
    );

    render(<ChatTabV2 {...defaultProps} />);

    fireEvent.click(screen.getByRole("button", { name: "Show sessions" }));

    expect(screen.getByTestId("history-rail")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "New personal thread" })
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "New shared thread" })
    ).not.toBeInTheDocument();
    expect(screen.getByTestId("history-rail")).toHaveAttribute(
      "data-shared-threads-enabled",
      "false"
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

  it("renders a collaborator live turn into the active shared thread", async () => {
    const initialDetailResponse = {
      ok: true,
      session: {
        ...mockHistorySession,
        directVisibility: "project" as const,
        messagesBlobUrl: "https://storage.test/blob",
      },
      widgetSnapshots: [],
    };

    mockGetChatHistoryDetail.mockResolvedValue(initialDetailResponse);
    const view = render(<ChatTabV2 {...defaultProps} />);

    fireEvent.click(screen.getByRole("button", { name: "Show sessions" }));
    fireEvent.click(screen.getByRole("button", { name: "Select thread" }));
    await flushMicrotasks();

    mockUseChatSession.setMessages.mockClear();
    mockReactiveHistoryState.liveTurn = {
      _id: "live-1",
      sessionId: "history-1",
      chatSessionId: "chat-session-1",
      turnId: "turn-1",
      promptIndex: 1,
      promptText: "what did you find?",
      assistantText: "Here is the live answer",
      status: "streaming",
      startedAt: 10,
      updatedAt: 20,
    };

    view.rerender(<ChatTabV2 {...defaultProps} />);
    await flushMicrotasks();

    expect(mockUseChatSession.setMessages).toHaveBeenCalledTimes(1);
    const updater = mockUseChatSession.setMessages.mock.calls[0]?.[0] as (
      messages: any[],
    ) => any[];
    const nextMessages = updater(mockUseChatSession.messages);
    expect(nextMessages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "remote-live-user-turn-1",
          role: "user",
          parts: [{ type: "text", text: "what did you find?" }],
        }),
        expect.objectContaining({
          id: "remote-live-assistant-turn-1",
          role: "assistant",
          parts: [{ type: "text", text: "Here is the live answer" }],
        }),
      ])
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
});
