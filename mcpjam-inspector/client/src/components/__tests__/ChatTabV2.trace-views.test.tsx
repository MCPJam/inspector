import type { CSSProperties, ReactNode } from "react";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ChatTabV2 } from "../ChatTabV2";

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
  useQuery: (_name: string, args: unknown) =>
    args === "skip" ? undefined : null,
}));

vi.mock("posthog-js/react", () => ({
  usePostHog: () => ({
    capture: vi.fn(),
  }),
  useFeatureFlagEnabled: () => false,
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
    serversByName: new Map(),
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
    workspaces: {},
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
  CollapsedPanelStrip: () => <div data-testid="collapsed-panel-strip" />,
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

const mockChatInput = vi.fn();

vi.mock("@/components/chat-v2/chat-input", () => ({
  ChatInput: (props: Record<string, unknown>) => {
    mockChatInput(props);
    return <div data-testid="chat-input" />;
  },
}));

vi.mock("@/components/chat-v2/thread", () => ({
  Thread: ({ messages }: { messages: any[] }) => (
    <div data-testid="thread" data-message-count={messages.length} />
  ),
}));

const mockMultiModelChatCard = vi.fn();

vi.mock("@/components/chat-v2/multi-model-chat-card", () => ({
  MultiModelChatCard: (props: { model: { name: string } }) => {
    mockMultiModelChatCard(props);
    return <div data-testid="multi-model-card">{props.model.name}</div>;
  },
}));

vi.mock("@/components/evals/trace-viewer", () => ({
  TraceViewer: ({
    forcedViewMode,
    trace,
  }: {
    forcedViewMode?: "timeline" | "raw" | "chat";
    trace?: unknown;
  }) => (
    <div
      data-testid="trace-viewer"
      data-mode={forcedViewMode ?? "timeline"}
      data-trace={JSON.stringify(trace ?? null)}
    />
  ),
}));

vi.mock("@/components/evals/trace-view-mode-tabs", () => ({
  TraceViewModeTabs: ({
    mode,
    onModeChange,
  }: {
    mode: "chat" | "timeline" | "raw";
    onModeChange: (mode: "chat" | "timeline" | "raw") => void;
  }) => (
    <div data-testid="trace-view-tabs" data-mode={mode}>
      <button onClick={() => onModeChange("chat")}>Chat</button>
      <button onClick={() => onModeChange("timeline")}>Trace</button>
      <button onClick={() => onModeChange("raw")}>Raw</button>
    </div>
  ),
  ChatTraceViewModeHeaderBar: ({
    mode,
    onModeChange,
  }: {
    mode: "chat" | "timeline" | "raw";
    onModeChange: (mode: "chat" | "timeline" | "raw") => void;
  }) => (
    <div data-testid="trace-view-tabs" data-mode={mode}>
      <button onClick={() => onModeChange("chat")}>Chat</button>
      <button onClick={() => onModeChange("timeline")}>Trace</button>
      <button onClick={() => onModeChange("raw")}>Raw</button>
    </div>
  ),
}));

const mockUseChatSession = {
  messages: [],
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
  isMcpJamModel: true,
  isAuthenticated: true,
  isAuthLoading: false,
  authHeaders: undefined,
  isAuthReady: true,
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
  useChatSession: () => mockUseChatSession,
}));

const sampleLiveTraceEnvelope = {
  traceVersion: 1 as const,
  messages: [
    { role: "user", content: "First prompt" },
    { role: "assistant", content: "First answer" },
  ],
  spans: [
    {
      id: "turn-1-step-0",
      name: "Step 1",
      category: "step" as const,
      startMs: 0,
      endMs: 100,
      promptIndex: 0,
      stepIndex: 0,
      status: "ok" as const,
    },
  ],
};

describe("ChatTabV2 trace views", () => {
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
    vi.clearAllMocks();
    mockChatInput.mockClear();
    Object.assign(mockUseChatSession, {
      messages: [],
      status: "ready",
      error: undefined,
      chatSessionId: "chat-session-1",
      availableModels: [],
      selectedModelIds: [],
      multiModelEnabled: false,
      liveTraceEnvelope: null,
      requestPayloadHistory: [],
      hasTraceSnapshot: false,
      hasLiveTimelineContent: false,
      traceViewsSupported: false,
      isStreaming: false,
    });
  });

  it("shows trace tabs only when explicitly enabled for a supported MCPJam session", () => {
    mockUseChatSession.messages = [
      { id: "1", role: "user", parts: [{ type: "text", text: "Hello" }] },
    ];
    mockUseChatSession.traceViewsSupported = true;

    const { rerender } = render(
      <ChatTabV2 {...defaultProps} enableTraceViews={true} />,
    );

    expect(screen.getByTestId("trace-view-tabs")).toBeInTheDocument();

    mockUseChatSession.traceViewsSupported = false;
    rerender(<ChatTabV2 {...defaultProps} enableTraceViews={true} />);

    expect(screen.queryByTestId("trace-view-tabs")).not.toBeInTheDocument();
  });

  it("shows trace tabs on an empty thread when trace views are supported", () => {
    mockUseChatSession.messages = [];
    mockUseChatSession.traceViewsSupported = true;

    render(<ChatTabV2 {...defaultProps} enableTraceViews={true} />);

    expect(screen.getByTestId("trace-view-tabs")).toBeInTheDocument();
  });

  it("shows the sample raw JSON empty state on an empty thread when Raw is selected", () => {
    mockUseChatSession.messages = [];
    mockUseChatSession.traceViewsSupported = true;

    render(<ChatTabV2 {...defaultProps} enableTraceViews={true} />);

    fireEvent.click(screen.getByRole("button", { name: "Raw" }));

    const pending = screen.getByTestId("chat-live-raw-pending");
    expect(pending).toBeInTheDocument();
    expect(
      within(pending).getByTestId("chat-live-raw-pending-sample-preview"),
    ).toBeInTheDocument();
    expect(within(pending).getByTestId("trace-raw-view")).toBeInTheDocument();
    expect(screen.getByText(/Sample raw request/i)).toBeInTheDocument();
    expect(screen.getByTestId("chat-input")).toBeInTheDocument();
  });

  it("shows the Runs-style timeline empty state before the first streamed snapshot while keeping the thread mounted", () => {
    mockUseChatSession.messages = [
      { id: "1", role: "user", parts: [{ type: "text", text: "Hello" }] },
    ];
    mockUseChatSession.traceViewsSupported = true;
    mockUseChatSession.hasTraceSnapshot = false;
    mockUseChatSession.hasLiveTimelineContent = false;
    mockUseChatSession.liveTraceEnvelope = null;

    render(<ChatTabV2 {...defaultProps} enableTraceViews={true} />);

    fireEvent.click(screen.getByRole("button", { name: "Trace" }));

    const pending = screen.getByTestId("chat-live-trace-pending");
    expect(pending).toBeInTheDocument();
    expect(
      within(pending).getByTestId("chat-live-trace-pending-sample-preview"),
    ).toBeInTheDocument();
    expect(within(pending).getByTestId("trace-viewer")).toBeInTheDocument();
    expect(screen.getByTestId("thread")).toBeInTheDocument();
  });

  it("shows the timeline trace viewer when preview spans exist without a snapshot", () => {
    mockUseChatSession.messages = [
      { id: "1", role: "user", parts: [{ type: "text", text: "Hello" }] },
    ];
    mockUseChatSession.traceViewsSupported = true;
    mockUseChatSession.hasTraceSnapshot = false;
    mockUseChatSession.hasLiveTimelineContent = true;
    mockUseChatSession.liveTraceEnvelope = {
      traceVersion: 1 as const,
      messages: [],
      spans: [
        {
          id: "pv-st-preview-0",
          name: "Step 1",
          category: "step" as const,
          startMs: 0,
          endMs: 80,
          promptIndex: 0,
          stepIndex: 0,
          status: "ok" as const,
        },
        {
          id: "pv-llm-preview-0",
          parentId: "pv-st-preview-0",
          name: "Agent",
          category: "llm" as const,
          startMs: 0,
          endMs: 80,
          promptIndex: 0,
          stepIndex: 0,
          status: "ok" as const,
        },
      ],
    };

    render(<ChatTabV2 {...defaultProps} enableTraceViews={true} />);

    fireEvent.click(screen.getByRole("button", { name: "Trace" }));

    expect(
      screen.queryByTestId("chat-live-trace-pending"),
    ).not.toBeInTheDocument();
    expect(screen.getByTestId("trace-viewer")).toBeInTheDocument();
  });

  it("snaps back to chat mode when the chat session changes", async () => {
    mockUseChatSession.messages = [
      { id: "1", role: "user", parts: [{ type: "text", text: "Hello" }] },
    ];
    mockUseChatSession.traceViewsSupported = true;
    mockUseChatSession.hasTraceSnapshot = true;
    mockUseChatSession.hasLiveTimelineContent = true;
    mockUseChatSession.liveTraceEnvelope = sampleLiveTraceEnvelope;

    const { rerender } = render(
      <ChatTabV2 {...defaultProps} enableTraceViews={true} />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Raw" }));

    expect(screen.getByTestId("trace-viewer")).toBeInTheDocument();
    expect(screen.getByTestId("thread")).toBeInTheDocument();

    mockUseChatSession.chatSessionId = "chat-session-2";
    rerender(<ChatTabV2 {...defaultProps} enableTraceViews={true} />);

    await waitFor(() => {
      expect(screen.queryByTestId("trace-viewer")).not.toBeInTheDocument();
    });
    expect(screen.getByTestId("thread")).toBeInTheDocument();
  });

  it("stops an active single-model chat when Escape is pressed", () => {
    mockUseChatSession.isStreaming = true;

    render(<ChatTabV2 {...defaultProps} />);

    window.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true,
        cancelable: true,
      }),
    );

    expect(mockUseChatSession.stop).toHaveBeenCalledTimes(1);
  });

  it("does not stop an idle single-model chat when Escape is pressed", () => {
    render(<ChatTabV2 {...defaultProps} />);

    window.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true,
        cancelable: true,
      }),
    );

    expect(mockUseChatSession.stop).not.toHaveBeenCalled();
  });

  it("increments stopRequestId for an active multi-model chat when Escape is pressed", async () => {
    mockUseChatSession.availableModels = [
      {
        id: "openai/gpt-5-mini",
        name: "GPT-5 Mini",
        provider: "openai",
      },
      {
        id: "anthropic/claude-sonnet-4-5",
        name: "Claude Sonnet 4.5",
        provider: "anthropic",
      },
    ];
    mockUseChatSession.selectedModelIds = [
      "openai/gpt-5-mini",
      "anthropic/claude-sonnet-4-5",
    ];
    mockUseChatSession.multiModelEnabled = true;

    render(<ChatTabV2 {...defaultProps} enableMultiModelChat={true} />);

    const firstCardProps = mockMultiModelChatCard.mock.calls[0]?.[0];
    expect(firstCardProps).toBeTruthy();

    act(() => {
      firstCardProps.onSummaryChange({
        modelId: "openai/gpt-5-mini",
        durationMs: null,
        tokens: 0,
        toolCount: 0,
        status: "running",
        hasMessages: true,
      });
    });

    window.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true,
        cancelable: true,
      }),
    );

    await waitFor(() => {
      expect(
        mockMultiModelChatCard.mock.calls.some(
          ([props]) => props.stopRequestId === 1,
        ),
      ).toBe(true);
    });
  });

  it("does not stop when Escape was already handled elsewhere", () => {
    mockUseChatSession.isStreaming = true;
    const preventEscape = (event: KeyboardEvent) => {
      event.preventDefault();
    };

    window.addEventListener("keydown", preventEscape, true);
    render(<ChatTabV2 {...defaultProps} />);

    window.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true,
        cancelable: true,
      }),
    );

    window.removeEventListener("keydown", preventEscape, true);

    expect(mockUseChatSession.stop).not.toHaveBeenCalled();
  });

  it("keeps the composer editable while streaming and only blocks sending", () => {
    mockUseChatSession.messages = [
      { id: "1", role: "user", parts: [{ type: "text", text: "Hello" }] },
    ];
    mockUseChatSession.isStreaming = true;

    render(<ChatTabV2 {...defaultProps} />);

    const chatInputProps = mockChatInput.mock.calls.at(-1)?.[0];
    expect(chatInputProps).toMatchObject({
      disabled: false,
      isLoading: true,
      submitDisabled: false,
    });
  });

  it("passes the host style selector props through to ChatInput when enabled", () => {
    const onHostStyleChange = vi.fn();

    render(
      <ChatTabV2
        {...defaultProps}
        showHostStyleSelector={true}
        hostStyle="chatgpt"
        onHostStyleChange={onHostStyleChange}
      />,
    );

    const chatInputProps = mockChatInput.mock.calls.at(-1)?.[0];
    expect(chatInputProps).toMatchObject({
      showHostStyleSelector: true,
      hostStyle: "chatgpt",
      onHostStyleChange,
    });
  });

  it("renders compare cards when multi-model chat is enabled on the main chat surface", () => {
    mockUseChatSession.availableModels = [
      {
        id: "openai/gpt-5-mini",
        name: "GPT-5 Mini",
        provider: "openai",
      },
      {
        id: "anthropic/claude-sonnet-4-5",
        name: "Claude Sonnet 4.5",
        provider: "anthropic",
      },
    ];
    mockUseChatSession.selectedModelIds = [
      "openai/gpt-5-mini",
      "anthropic/claude-sonnet-4-5",
    ];
    mockUseChatSession.multiModelEnabled = true;
    mockUseChatSession.traceViewsSupported = true;

    render(
      <ChatTabV2
        {...defaultProps}
        enableTraceViews={true}
        enableMultiModelChat={true}
      />,
    );

    expect(screen.getAllByTestId("multi-model-card")).toHaveLength(2);
    expect(screen.getByTestId("trace-view-tabs")).toBeInTheDocument();
  });
});
