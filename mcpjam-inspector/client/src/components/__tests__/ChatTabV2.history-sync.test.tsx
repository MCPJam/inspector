import type { CSSProperties, ReactNode } from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatTabV2 } from "../ChatTabV2";

const mockToastError = vi.hoisted(() => vi.fn());
const mockGetChatHistoryDetail = vi.hoisted(() => vi.fn());
const mockChatHistoryAction = vi.hoisted(() => vi.fn());
const mockUpsertChatHistoryDraft = vi.hoisted(() => vi.fn());
const mockReactiveHistoryState = vi.hoisted(() => ({
  session: undefined as any,
  widgetSnapshots: undefined as any,
}));
const chatSessionOnResetRef = vi.hoisted(() => ({
  current: undefined as undefined | ((reason?: string) => void),
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
    return undefined;
  },
}));

vi.mock("posthog-js/react", () => ({
  usePostHog: () => ({
    capture: vi.fn(),
  }),
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
  useWorkspaceServers: () => ({
    serversById: new Map([["server-1", "server-1"]]),
    serversByName: new Map([["server-1", "server-1"]]),
  }),
}));

vi.mock("@/hooks/use-debounced-x-ray-payload", () => ({
  useDebouncedXRayPayload: () => null,
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
    workspaces: {
      "workspace-1": {
        sharedWorkspaceId: "workspace-1",
      },
    },
    activeWorkspaceId: "workspace-1",
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
  const actual =
    await importOriginal<
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
    onNewChat,
    onSelectThread,
  }: {
    activeSessionId?: string | null;
    onNewChat: (options?: { shared?: boolean }) => void;
    onSelectThread: (session: typeof mockHistorySession) => void;
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
  hasTraceSnapshot: false,
  hasLiveTimelineContent: false,
  traceViewsSupported: false,
  isStreaming: false,
  disableForAuthentication: false,
  submitBlocked: false,
} as any;

vi.mock("@/hooks/use-chat-session", () => ({
  useChatSession: (options: { onReset?: (reason?: string) => void }) => {
    chatSessionOnResetRef.current = options.onReset;

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
  upsertChatHistoryDraft: (...args: unknown[]) =>
    mockUpsertChatHistoryDraft(...args),
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
    vi.stubGlobal("confirm", vi.fn(() => true));
    chatSessionOnResetRef.current = undefined;
    mockReactiveHistoryState.session = undefined;
    mockReactiveHistoryState.widgetSnapshots = undefined;
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
    mockUpsertChatHistoryDraft.mockImplementation(
      async (payload: { directVisibility?: "private" | "workspace" }) => ({
        ok: true,
        session: {
          ...mockHistorySession,
          _id: "draft-session-1",
          chatSessionId: "chat-session-1",
          directVisibility: payload.directVisibility ?? "private",
          messageCount: 0,
          version: 1,
          messagesBlobUrl: "https://storage.test/blob",
          resumeConfig: {
            draftInput: "Draft title",
          },
        },
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("asks before discarding a draft when switching threads", async () => {
    const confirmSpy = vi.fn(() => false);
    vi.stubGlobal("confirm", confirmSpy);

    render(<ChatTabV2 {...defaultProps} />);

    fireEvent.change(screen.getByRole("textbox", { name: "Chat input" }), {
      target: { value: "Unsaved draft" },
    });

    fireEvent.click(screen.getByRole("button", { name: "Show threads" }));
    fireEvent.click(screen.getByRole("button", { name: "Select thread" }));
    await flushMicrotasks();

    expect(confirmSpy).toHaveBeenCalledWith(
      "Discard your current draft and switch chats?",
    );
    expect(mockGetChatHistoryDetail).not.toHaveBeenCalled();
    expect(screen.getByRole("textbox", { name: "Chat input" })).toHaveValue(
      "Unsaved draft",
    );
  });

  it("asks before discarding a draft when starting a new chat", async () => {
    const confirmSpy = vi.fn(() => false);
    vi.stubGlobal("confirm", confirmSpy);

    render(<ChatTabV2 {...defaultProps} />);

    fireEvent.change(screen.getByRole("textbox", { name: "Chat input" }), {
      target: { value: "Unsaved draft" },
    });

    fireEvent.click(screen.getByRole("button", { name: "Show threads" }));
    fireEvent.click(
      screen.getByRole("button", { name: "New personal thread" }),
    );
    await flushMicrotasks();

    expect(confirmSpy).toHaveBeenCalledWith(
      "Discard your current draft and switch chats?",
    );
    expect(mockUseChatSession.resetChat).not.toHaveBeenCalled();
    expect(screen.getByRole("textbox", { name: "Chat input" })).toHaveValue(
      "Unsaved draft",
    );
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

    fireEvent.click(screen.getByRole("button", { name: "Show threads" }));
    fireEvent.click(screen.getByRole("button", { name: "Select thread" }));

    await flushMicrotasks();

    expect(mockUseChatSession.loadChatSession).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("history-rail")).toHaveAttribute(
      "data-active-session-id",
      "history-1",
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
      "none",
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
      },
    );
    expect(mockUseChatSession.syncResumedVersion).toHaveBeenCalledWith(null);
    expect(mockToastError).toHaveBeenCalledWith(
      "This chat changed elsewhere. This reply stayed local, and your next send will continue in a new thread.",
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

    fireEvent.click(screen.getByRole("button", { name: "Show threads" }));
    fireEvent.click(screen.getByRole("button", { name: "Select thread" }));
    await flushMicrotasks();

    expect(screen.getByTestId("history-rail")).toHaveAttribute(
      "data-active-session-id",
      "history-1",
    );

    view.rerender(
      <ChatTabV2
        {...defaultProps}
        selectedServerNames={[]}
      />,
    );
    await flushMicrotasks();

    expect(screen.getByTestId("history-rail")).toHaveAttribute(
      "data-active-session-id",
      "history-1",
    );
    expect(mockUseChatSession.startChatWithMessages).not.toHaveBeenCalled();
    expect(mockUseChatSession.syncResumedVersion).not.toHaveBeenCalledWith(
      null,
    );
    expect(mockToastError).not.toHaveBeenCalled();
  });

  it("persists shared drafts with workspace visibility after Shared Threads new chat", async () => {
    mockUseChatSession.messages = [];

    render(<ChatTabV2 {...defaultProps} />);

    fireEvent.click(screen.getByRole("button", { name: "Show threads" }));
    fireEvent.click(screen.getByRole("button", { name: "New shared thread" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Chat input" }), {
      target: { value: "Shared draft" },
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    await flushMicrotasks();

    expect(mockUpsertChatHistoryDraft).toHaveBeenCalledWith(
      expect.objectContaining({
        chatSessionId: "chat-session-1",
        firstMessagePreview: "Shared draft",
        directVisibility: "workspace",
        resumeConfig: expect.objectContaining({
          draftInput: "Shared draft",
        }),
      }),
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
          draftInput: "Original remote draft",
        },
      },
      widgetSnapshots: [],
    };

    mockGetChatHistoryDetail.mockResolvedValue(initialDetailResponse);

    const view = render(<ChatTabV2 {...defaultProps} />);

    fireEvent.click(screen.getByRole("button", { name: "Show threads" }));
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
        draftInput: "Updated remote draft",
      },
    };
    mockReactiveHistoryState.widgetSnapshots = [];

    view.rerender(<ChatTabV2 {...defaultProps} />);
    await flushMicrotasks();

    expect(mockUseChatSession.loadChatSession).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("textbox", { name: "Chat input" })).toHaveValue(
      "Local draft reply",
    );
  });

  it("archives an empty draft when starting a new personal thread", async () => {
    mockUseChatSession.messages = [];

    const emptyDraftDetail = {
      ok: true,
      session: {
        ...mockHistorySession,
        messageCount: 0,
        messagesBlobUrl: "https://storage.test/blob",
        resumeConfig: {
          selectedServers: ["server-1"],
          draftInput: "Draft title",
        },
      },
      widgetSnapshots: [],
    };

    mockGetChatHistoryDetail.mockResolvedValue(emptyDraftDetail);

    render(<ChatTabV2 {...defaultProps} />);

    fireEvent.click(screen.getByRole("button", { name: "Show threads" }));
    fireEvent.click(screen.getByRole("button", { name: "Select thread" }));
    await flushMicrotasks();

    mockChatHistoryAction.mockClear();

    fireEvent.click(
      screen.getByRole("button", { name: "New personal thread" }),
    );
    await flushMicrotasks();

    expect(mockChatHistoryAction).toHaveBeenCalledWith("archive", "history-1");
    expect(screen.getByTestId("history-rail")).toHaveAttribute(
      "data-active-session-id",
      "none",
    );
  });

  it("archives an empty draft when auth bootstrap replaces the session", async () => {
    mockUseChatSession.messages = [];

    const emptyDraftDetail = {
      ok: true,
      session: {
        ...mockHistorySession,
        messageCount: 0,
        messagesBlobUrl: "https://storage.test/blob",
        resumeConfig: {
          selectedServers: ["server-1"],
          draftInput: "Draft title",
        },
      },
      widgetSnapshots: [],
    };

    mockGetChatHistoryDetail.mockResolvedValue(emptyDraftDetail);

    render(<ChatTabV2 {...defaultProps} />);

    fireEvent.click(screen.getByRole("button", { name: "Show threads" }));
    fireEvent.click(screen.getByRole("button", { name: "Select thread" }));
    await flushMicrotasks();

    mockChatHistoryAction.mockClear();

    act(() => {
      chatSessionOnResetRef.current?.("auth-bootstrap");
    });
    await flushMicrotasks();

    expect(mockChatHistoryAction).toHaveBeenCalledWith("archive", "history-1");
    expect(screen.getByTestId("history-rail")).toHaveAttribute(
      "data-active-session-id",
      "none",
    );
  });
});
