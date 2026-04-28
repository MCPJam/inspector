import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  render,
  screen,
  fireEvent,
  waitFor,
  act,
  within,
} from "@testing-library/react";
import { PlaygroundMain } from "../PlaygroundMain";
import { DEFAULT_CHAT_COMPOSER_PLACEHOLDER } from "@/components/chat-v2/shared/chat-helpers";
import { useHostContextStore } from "@/stores/host-context-store";

vi.mock("framer-motion", async (importOriginal) => {
  const actual = await importOriginal<typeof import("framer-motion")>();
  return {
    ...actual,
    useReducedMotion: () => false,
  };
});

const mockThread = vi.fn();
const mockFullscreenChatOverlay = vi.fn();
const mockMultiModelPlaygroundCard = vi.fn();
const mockTraceViewer = vi.fn();

// Mock lucide-react icons
vi.mock("lucide-react", () => ({
  ArrowDown: () => <span data-testid="icon-arrow-down" />,
  ArrowUp: () => <span data-testid="icon-arrow-up" />,
  Braces: () => <span data-testid="icon-braces" />,
  Loader2: () => <span data-testid="icon-loader" />,
  Smartphone: () => <span data-testid="icon-smartphone" />,
  Tablet: () => <span data-testid="icon-tablet" />,
  Monitor: () => <span data-testid="icon-monitor" />,
  Trash2: () => <span className="lucide-trash2" data-testid="icon-trash" />,
  Sun: () => <span data-testid="icon-sun" />,
  Moon: () => <span data-testid="icon-moon" />,
  Globe: () => <span data-testid="icon-globe" />,
  Clock: () => <span data-testid="icon-clock" />,
  Shield: () => <span data-testid="icon-shield" />,
  MousePointer2: () => <span data-testid="icon-mouse" />,
  Hand: () => <span data-testid="icon-hand" />,
  Settings2: () => <span data-testid="icon-settings" />,
  // Icons used by JsonEditor component
  Eye: () => <span data-testid="icon-eye" />,
  Pencil: () => <span data-testid="icon-pencil" />,
  AlignLeft: () => <span data-testid="icon-align-left" />,
  Copy: () => <span data-testid="icon-copy" />,
  Check: () => <span data-testid="icon-check" />,
  Undo2: () => <span data-testid="icon-undo" />,
  Redo2: () => <span data-testid="icon-redo" />,
  Maximize2: () => <span data-testid="icon-maximize" />,
  Minimize2: () => <span data-testid="icon-minimize" />,
  ChevronRight: () => <span data-testid="icon-chevron-right" />,
}));

// Mock UI components
vi.mock("@mcpjam/design-system/button", () => ({
  Button: ({ children, onClick, className, ...props }: any) => (
    <button onClick={onClick} className={className} {...props}>
      {children}
    </button>
  ),
}));

vi.mock("@mcpjam/design-system/tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => (
    <div className="tooltip-content">{children}</div>
  ),
  TooltipTrigger: ({
    children,
    asChild: _asChild,
  }: {
    children: React.ReactNode;
    asChild?: boolean;
  }) => <>{children}</>,
}));

vi.mock("@mcpjam/design-system/popover", () => ({
  Popover: ({
    children,
    open: _open,
  }: {
    children: React.ReactNode;
    open?: boolean;
  }) => <>{children}</>,
  PopoverContent: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  PopoverTrigger: ({
    children,
    asChild: _asChild,
  }: {
    children: React.ReactNode;
    asChild?: boolean;
  }) => <>{children}</>,
}));

vi.mock("@mcpjam/design-system/input", () => ({
  Input: (props: any) => <input {...props} />,
}));

vi.mock("@mcpjam/design-system/label", () => ({
  Label: ({ children, ...props }: any) => <label {...props}>{children}</label>,
}));

// Mock mcp-apps-utils
vi.mock("@/lib/mcp-ui/mcp-apps-utils", () => ({
  UIType: {
    OPENAI_SDK: "openai-apps",
    MCP_APPS: "mcp-apps",
    OPENAI_SDK_AND_MCP_APPS: "both",
  },
}));

// Mock posthog
vi.mock("posthog-js/react", () => ({
  usePostHog: () => ({
    capture: vi.fn(),
  }),
}));

// Mock PosthogUtils
vi.mock("@/lib/PosthogUtils", () => ({
  detectEnvironment: vi.fn().mockReturnValue("test"),
  detectPlatform: vi.fn().mockReturnValue("web"),
}));

// Mock authkit
vi.mock("@workos-inc/authkit-react", () => ({
  useAuth: () => ({
    signUp: vi.fn(),
    user: { id: "test-user" },
    isLoading: false,
  }),
}));

// Mock convex/react
vi.mock("convex/react", () => ({
  useConvexAuth: () => ({
    isAuthenticated: false,
    isLoading: false,
  }),
}));

// Mock useViews (useWorkspaceServers)
vi.mock("@/hooks/useViews", () => ({
  useWorkspaceServers: () => ({
    serversByName: new Map(),
  }),
}));

// Mock useChatSession hook
const mockUseChatSession = {
  messages: [],
  setMessages: vi.fn(),
  sendMessage: vi.fn(),
  stop: vi.fn(),
  status: "ready",
  error: null,
  selectedModel: {
    id: "gpt-4",
    name: "GPT-4",
    provider: "openai",
    contextWindow: 8192,
    maxOutputTokens: 4096,
    supportsTools: true,
    supportsVision: false,
    supportsStreaming: true,
  },
  setSelectedModel: vi.fn(),
  selectedModelIds: [],
  setSelectedModelIds: vi.fn(),
  multiModelEnabled: false,
  setMultiModelEnabled: vi.fn(),
  availableModels: [],
  isAuthLoading: false,
  systemPrompt: "",
  setSystemPrompt: vi.fn(),
  temperature: 0.7,
  setTemperature: vi.fn(),
  toolsMetadata: {},
  toolServerMap: {},
  tokenUsage: null,
  resetChat: vi.fn(),
  chatSessionId: "chat-session-1",
  liveTraceEnvelope: null,
  requestPayloadHistory: [],
  hasTraceSnapshot: false,
  hasLiveTimelineContent: false,
  traceViewsSupported: false,
  requireToolApproval: false,
  setRequireToolApproval: vi.fn(),
  addToolApprovalResponse: vi.fn(),
  isStreaming: false,
  disableForAuthentication: false,
  submitBlocked: false,
} as any;
let capturedChatSessionOptions: any = null;

vi.mock("@/hooks/use-chat-session", () => ({
  useChatSession: (options: any) => {
    capturedChatSessionOptions = options;
    return mockUseChatSession;
  },
}));

// Mock use-stick-to-bottom
vi.mock("use-stick-to-bottom", () => {
  const StickToBottomComponent = ({
    children,
  }: {
    children: React.ReactNode;
  }) => <div data-testid="stick-to-bottom">{children}</div>;
  StickToBottomComponent.Content = ({
    children,
  }: {
    children: React.ReactNode;
  }) => <div data-testid="stick-to-bottom-content">{children}</div>;

  return {
    StickToBottom: StickToBottomComponent,
    useStickToBottomContext: () => ({
      isAtBottom: true,
      scrollToBottom: vi.fn(),
    }),
  };
});

// Mock Thread component
vi.mock("@/components/chat-v2/thread", () => ({
  Thread: ({
    messages,
    isLoading,
    loadingIndicatorVariant,
  }: {
    messages: any[];
    isLoading: boolean;
    loadingIndicatorVariant?: string;
  }) =>
    (() => {
      mockThread({ messages, isLoading, loadingIndicatorVariant });
      return (
        <div data-testid="thread">
          <span data-testid="message-count">{messages.length}</span>
          {isLoading && <span data-testid="thread-loading">Loading...</span>}
        </div>
      );
    })(),
}));

// Mock ChatInput component
vi.mock("@/components/chat-v2/chat-input", () => ({
  ChatInput: ({
    value,
    onChange,
    onSubmit,
    disabled,
    submitDisabled,
    isLoading,
    placeholder,
    pulseSubmit,
  }: {
    value: string;
    onChange: (v: string) => void;
    onSubmit: (e: any) => void;
    disabled: boolean;
    submitDisabled?: boolean;
    isLoading?: boolean;
    placeholder: string;
    pulseSubmit?: boolean;
  }) => (
    <form
      data-testid="chat-input"
      data-loading={isLoading ? "true" : "false"}
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit(e);
      }}
    >
      <input
        data-testid="chat-input-field"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        placeholder={placeholder}
      />
      <button
        type="submit"
        disabled={disabled || !!submitDisabled}
        data-testid="chat-submit-button"
        data-pulsing={pulseSubmit ? "true" : "false"}
      >
        Send
      </button>
    </form>
  ),
}));

// Mock ErrorBox
vi.mock("@/components/chat-v2/error", () => ({
  ErrorBox: ({ message }: { message: string }) => (
    <div data-testid="error-box">{message}</div>
  ),
}));

vi.mock("@/components/evals/trace-viewer", () => ({
  TraceViewer: (props: {
    forcedViewMode?: "chat" | "timeline" | "raw";
    trace?: unknown;
    displayMode?: "inline" | "pip" | "fullscreen";
    onDisplayModeChange?: (mode: "inline" | "pip" | "fullscreen") => void;
    traceStartedAtMs?: number | null;
    traceEndedAtMs?: number | null;
  }) => {
    mockTraceViewer(props);
    return (
      <div
        data-testid="trace-viewer"
        data-mode={props.forcedViewMode ?? "timeline"}
        data-trace={JSON.stringify(props.trace ?? null)}
      />
    );
  },
}));

vi.mock("@/components/evals/trace-view-mode-tabs", () => {
  const tabs = ({
    mode,
    onModeChange,
  }: {
    mode: "chat" | "timeline" | "raw";
    onModeChange: (mode: "chat" | "timeline" | "raw" | "tools") => void;
  }) => (
    <div data-testid="trace-view-tabs" data-mode={mode}>
      <button onClick={() => onModeChange("chat")}>Chat</button>
      <button onClick={() => onModeChange("timeline")}>Trace</button>
      <button onClick={() => onModeChange("raw")}>Raw</button>
    </div>
  );

  return {
    TraceViewModeTabs: tabs,
    ChatTraceViewModeHeaderBar: ({
      mode,
      onModeChange,
    }: {
      mode: "chat" | "timeline" | "raw";
      onModeChange: (mode: "chat" | "timeline" | "raw" | "tools") => void;
    }) => (
      <div data-testid="chat-trace-view-mode-header-bar">
        {tabs({ mode, onModeChange })}
      </div>
    ),
  };
});

vi.mock("@/components/ui-playground/multi-model-playground-card", () => ({
  MultiModelPlaygroundCard: (props: { model: { name: string } }) => {
    mockMultiModelPlaygroundCard(props);
    return (
      <div data-testid="multi-model-playground-card">{props.model.name}</div>
    );
  },
}));

// Mock ConfirmChatResetDialog
vi.mock(
  "@/components/chat-v2/chat-input/dialogs/confirm-chat-reset-dialog",
  () => ({
    ConfirmChatResetDialog: ({
      open,
      onConfirm,
      onCancel,
    }: {
      open: boolean;
      onConfirm: () => void;
      onCancel: () => void;
    }) =>
      open ? (
        <div data-testid="confirm-dialog">
          <button onClick={onConfirm}>Confirm</button>
          <button onClick={onCancel}>Cancel</button>
        </div>
      ) : null,
  }),
);

// Mock FullscreenChatOverlay
vi.mock("@/components/chat-v2/fullscreen-chat-overlay", () => ({
  FullscreenChatOverlay: (props: { loadingIndicatorVariant?: string }) => {
    mockFullscreenChatOverlay(props);
    return <div data-testid="fullscreen-overlay">Fullscreen Overlay</div>;
  },
}));

// Mock MCPJamFreeModelsPrompt
vi.mock("@/components/chat-v2/mcpjam-free-models-prompt", () => ({
  MCPJamFreeModelsPrompt: ({ onSignUp }: { onSignUp: () => void }) => (
    <div data-testid="upsell-prompt">
      <button onClick={onSignUp}>Sign Up</button>
    </div>
  ),
}));

// Mock SafeAreaEditor
vi.mock("../SafeAreaEditor", () => ({
  SafeAreaEditor: () => <div data-testid="safe-area-editor">Safe Area</div>,
}));

// Mock playground-helpers
vi.mock("../playground-helpers", () => ({
  createDeterministicToolMessages: vi.fn().mockReturnValue({ messages: [] }),
}));

// Mock preferences store
const mockPreferencesState = {
  themeMode: "light",
  themePreset: "soft-pop",
  hostStyle: "claude",
  setThemeMode: vi.fn(),
  setHostStyle: vi.fn(),
};

vi.mock("@/stores/preferences/preferences-provider", () => ({
  usePreferencesStore: (selector: any) =>
    selector ? selector(mockPreferencesState) : mockPreferencesState,
}));

// Mock UI Playground store
const mockUIPlaygroundStore = {
  deviceType: "mobile",
  customViewport: { width: 375, height: 667 },
  setCustomViewport: vi.fn(),
  setPlaygroundActive: vi.fn(),
  cspMode: "widget-declared",
  setCspMode: vi.fn(),
  mcpAppsCspMode: "widget-declared",
  setMcpAppsCspMode: vi.fn(),
  selectedProtocol: null,
  capabilities: { hover: true, touch: true },
  setCapabilities: vi.fn(),
};

vi.mock("@/stores/ui-playground-store", () => ({
  useUIPlaygroundStore: (selector: any) =>
    selector ? selector(mockUIPlaygroundStore) : mockUIPlaygroundStore,
  DEVICE_VIEWPORT_CONFIGS: {
    mobile: { width: 375, height: 667 },
    tablet: { width: 768, height: 1024 },
    desktop: { width: 1280, height: 800 },
  },
}));

// Mock HostContextHeader which exports PRESET_DEVICE_CONFIGS
vi.mock("@/components/shared/HostContextHeader", () => ({
  HostContextHeader: ({
    showThemeToggle,
  }: {
    showThemeToggle?: boolean;
  }) => (
    <div data-testid="host-context-header">
      {showThemeToggle ? (
        <button data-testid="host-context-theme-toggle">Toggle theme</button>
      ) : null}
    </div>
  ),
  PRESET_DEVICE_CONFIGS: {
    mobile: { width: 375, height: 667, label: "Phone", icon: () => null },
    tablet: { width: 768, height: 1024, label: "Tablet", icon: () => null },
    desktop: { width: 1280, height: 800, label: "Desktop", icon: () => null },
  },
}));

// Mock traffic log store
vi.mock("@/stores/traffic-log-store", () => ({
  useTrafficLogStore: (selector: any) => {
    const state = { clear: vi.fn() };
    return selector ? selector(state) : state;
  },
}));

// Mock shared app state (mutate `connectionStatus` in tests when needed)
const mockSharedAppState = {
  servers: {
    "test-server": { connectionStatus: "connected" },
  } as Record<string, { connectionStatus: string }>,
  workspaces: {},
  activeWorkspaceId: "default",
};

vi.mock("@/state/app-state-context", () => ({
  useSharedAppState: () => mockSharedAppState,
}));

// Mock chat-helpers (keep real placeholders; stub formatError + empty starters for stable tests)
vi.mock("@/components/chat-v2/shared/chat-helpers", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@/components/chat-v2/shared/chat-helpers")
    >();
  return {
    ...actual,
    formatErrorMessage: (error: any) =>
      error ? { message: error.message || "Error", details: null } : null,
    STARTER_PROMPTS: [],
  };
});

// Mock utils
vi.mock("@/lib/utils", () => ({
  cn: (...args: any[]) => args.filter(Boolean).join(" "),
}));

const sampleLiveTraceEnvelope = {
  traceVersion: 1 as const,
  traceStartedAtMs: 1_700_000_000_000,
  traceEndedAtMs: 1_700_000_000_120,
  messages: [
    { role: "user", content: "Draw the diagram" },
    { role: "assistant", content: "Here is the diagram." },
  ],
  spans: [
    {
      id: "turn-1-step-0",
      name: "Step 1",
      category: "step" as const,
      startMs: 0,
      endMs: 120,
      promptIndex: 0,
      stepIndex: 0,
      status: "ok" as const,
    },
  ],
};

describe("PlaygroundMain", () => {
  const defaultProps = {
    serverName: "test-server",
    pendingExecution: null,
    onExecutionInjected: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    capturedChatSessionOptions = null;
    mockPreferencesState.themeMode = "light";
    mockPreferencesState.themePreset = "soft-pop";
    mockPreferencesState.hostStyle = "claude";
    useHostContextStore.setState({
      activeWorkspaceId: null,
      defaultHostContext: {},
      savedHostContext: undefined,
      draftHostContext: {},
      hostContextText: "{}",
      hostContextError: null,
      isSaving: false,
      isDirty: false,
      pendingWorkspaceId: null,
      pendingSavedHostContext: undefined,
      isAwaitingRemoteEcho: false,
    });
    mockSharedAppState.servers["test-server"] = {
      connectionStatus: "connected",
    };
    Object.assign(mockUseChatSession, {
      messages: [],
      status: "ready",
      error: null,
      isAuthLoading: false,
      disableForAuthentication: false,
      submitBlocked: false,
      isStreaming: false,
      chatSessionId: "chat-session-1",
      availableModels: [],
      selectedModelIds: [],
      multiModelEnabled: false,
      liveTraceEnvelope: null,
      requestPayloadHistory: [],
      hasTraceSnapshot: false,
      hasLiveTimelineContent: false,
      traceViewsSupported: false,
    });
    mockThread.mockClear();
    mockFullscreenChatOverlay.mockClear();
    mockMultiModelPlaygroundCard.mockClear();
  });

  describe("rendering", () => {
    it("renders the component", () => {
      render(<PlaygroundMain {...defaultProps} />);

      expect(screen.getByTestId("chat-input")).toBeInTheDocument();
    });

    it("renders the empty-state composer in mobile fullscreen takeover mode", () => {
      render(<PlaygroundMain {...defaultProps} displayMode="fullscreen" />);

      expect(screen.getByTestId("chat-input")).toBeInTheDocument();
      expect(
        screen.queryByTestId("fullscreen-overlay"),
      ).not.toBeInTheDocument();
    });

    it("renders device controls", () => {
      render(<PlaygroundMain {...defaultProps} />);

      // Device controls are rendered by HostContextHeader (mocked)
      expect(screen.getByTestId("host-context-header")).toBeInTheDocument();
    });

    it("renders theme toggle button", () => {
      render(<PlaygroundMain {...defaultProps} />);

      expect(screen.getByTestId("host-context-theme-toggle")).toBeInTheDocument();
    });

    it("passes the requested loading indicator variant to Thread", () => {
      mockUseChatSession.messages = [
        { id: "m1", role: "assistant", parts: [] },
      ];

      render(
        <PlaygroundMain
          {...defaultProps}
          loadingIndicatorVariant="chatgpt-dot"
        />,
      );

      expect(mockThread).toHaveBeenCalledWith(
        expect.objectContaining({
          loadingIndicatorVariant: "chatgpt-dot",
        }),
      );
    });
  });

  describe("thread theme from host context", () => {
    it("scopes hostContext theme changes to the thread shell and composer surface", () => {
      render(<PlaygroundMain {...defaultProps} />);

      const header = screen.getByTestId("playground-main-header");
      const threadShell = screen.getByTestId("playground-thread-shell");

      expect(threadShell).toHaveAttribute("data-host-style", "claude");
      expect(threadShell).toHaveAttribute("data-theme-preset", "soft-pop");
      expect(threadShell).toHaveAttribute("data-thread-theme", "light");
      expect(threadShell).not.toHaveClass("dark");
      expect(header).not.toHaveClass("dark");

      act(() => {
        useHostContextStore.getState().patchHostContext({ theme: "dark" });
      });

      expect(threadShell).toHaveAttribute("data-thread-theme", "dark");
      expect(threadShell).toHaveClass("dark");
      expect(header).not.toHaveClass("dark");
      expect(mockPreferencesState.setThemeMode).not.toHaveBeenCalled();
    });

    it("falls back to the global theme when hostContext.theme is removed", () => {
      render(<PlaygroundMain {...defaultProps} />);

      act(() => {
        useHostContextStore.getState().patchHostContext({ theme: "dark" });
      });
      expect(screen.getByTestId("playground-thread-shell")).toHaveAttribute(
        "data-thread-theme",
        "dark",
      );

      act(() => {
        useHostContextStore.getState().setHostContextText("{}");
      });

      expect(screen.getByTestId("playground-thread-shell")).toHaveAttribute(
        "data-thread-theme",
        "light",
      );
      expect(screen.getByTestId("playground-thread-shell")).not.toHaveClass("dark");
    });
  });

  describe("empty state", () => {
    it("shows welcome message when thread is empty", () => {
      render(<PlaygroundMain {...defaultProps} />);

      expect(screen.getByRole("img", { name: /MCPJam/i })).toBeInTheDocument();
      expect(
        screen.getByRole("heading", {
          name: /This is your playground for MCP./i,
        }),
      ).toBeInTheDocument();
      expect(
        screen.getByText(
          /Test prompts, inspect tools, and debug AI-powered apps/i,
        ),
      ).toBeInTheDocument();
    });

    it("shows sign up prompt when authentication required", () => {
      mockUseChatSession.disableForAuthentication = true;
      mockUseChatSession.isAuthLoading = false;

      render(<PlaygroundMain {...defaultProps} />);

      expect(screen.getByTestId("upsell-prompt")).toBeInTheDocument();
    });

    it("shows loading state when auth is loading", () => {
      mockUseChatSession.isAuthLoading = true;

      render(<PlaygroundMain {...defaultProps} />);

      expect(screen.getByText("Loading...")).toBeInTheDocument();
    });

    it("does not render a skip action in the post-connect guide", () => {
      render(<PlaygroundMain {...defaultProps} showPostConnectGuide={true} />);

      expect(
        screen.queryByRole("button", { name: /Skip onboarding/i }),
      ).not.toBeInTheDocument();
    });

    it("shows the ticket hint copy in the post-connect guide", () => {
      render(<PlaygroundMain {...defaultProps} showPostConnectGuide={true} />);

      expect(
        screen.getByText("Try asking Excalidraw to draw something."),
      ).toBeInTheDocument();
    });
  });

  describe("message thread", () => {
    it("renders thread when messages exist", () => {
      mockUseChatSession.messages = [
        { id: "1", role: "user", parts: [{ type: "text", text: "Hello" }] },
        {
          id: "2",
          role: "assistant",
          parts: [{ type: "text", text: "Hi there!" }],
        },
      ];

      render(<PlaygroundMain {...defaultProps} />);

      expect(screen.getByTestId("thread")).toBeInTheDocument();
      expect(screen.getByTestId("message-count")).toHaveTextContent("2");
    });

    it("shows loading indicator when submitting", () => {
      mockUseChatSession.messages = [
        { id: "1", role: "user", parts: [{ type: "text", text: "Hello" }] },
      ];
      mockUseChatSession.status = "submitted";
      mockUseChatSession.isStreaming = true;

      render(<PlaygroundMain {...defaultProps} />);

      expect(screen.getByTestId("thread-loading")).toBeInTheDocument();
    });
  });

  describe("Escape shortcut", () => {
    it("stops an active single-model chat when Escape is pressed", () => {
      mockUseChatSession.isStreaming = true;

      render(<PlaygroundMain {...defaultProps} />);

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
      render(<PlaygroundMain {...defaultProps} />);

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

      render(<PlaygroundMain {...defaultProps} enableMultiModelChat={true} />);

      const firstCardProps = mockMultiModelPlaygroundCard.mock.calls[0]?.[0];
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
          mockMultiModelPlaygroundCard.mock.calls.some(
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
      render(<PlaygroundMain {...defaultProps} />);

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
  });

  describe("live trace views", () => {
    it("shows trace mode tabs only when enabled for a supported live chat", () => {
      mockUseChatSession.messages = [
        { id: "1", role: "user", parts: [{ type: "text", text: "Hello" }] },
      ];
      mockUseChatSession.traceViewsSupported = true;

      const { rerender } = render(
        <PlaygroundMain {...defaultProps} enableTraceViews={true} />,
      );

      expect(screen.getByTestId("trace-view-tabs")).toBeInTheDocument();

      mockUseChatSession.traceViewsSupported = false;
      rerender(<PlaygroundMain {...defaultProps} enableTraceViews={true} />);

      expect(screen.queryByTestId("trace-view-tabs")).not.toBeInTheDocument();
    });

    it("shows trace mode tabs on an empty thread when trace views are supported", () => {
      mockUseChatSession.messages = [];
      mockUseChatSession.traceViewsSupported = true;

      render(<PlaygroundMain {...defaultProps} enableTraceViews={true} />);

      expect(screen.getByTestId("trace-view-tabs")).toBeInTheDocument();
    });

    it("renders the shared trace header tabs", () => {
      mockUseChatSession.messages = [];
      mockUseChatSession.traceViewsSupported = true;

      render(<PlaygroundMain {...defaultProps} enableTraceViews={true} />);

      expect(
        screen.getByTestId("chat-trace-view-mode-header-bar"),
      ).toBeInTheDocument();
      expect(screen.getByTestId("trace-view-tabs")).toBeInTheDocument();
    });

    it("shows the sample raw JSON empty state on an empty thread when Raw is selected", () => {
      mockUseChatSession.messages = [];
      mockUseChatSession.traceViewsSupported = true;

      render(<PlaygroundMain {...defaultProps} enableTraceViews={true} />);

      fireEvent.click(screen.getByRole("button", { name: "Raw" }));

      const pending = screen.getByTestId("playground-live-raw-pending");
      expect(pending).toBeInTheDocument();
      expect(
        within(pending).getByTestId(
          "playground-live-raw-pending-sample-preview",
        ),
      ).toBeInTheDocument();
      expect(within(pending).getByTestId("trace-raw-view")).toBeInTheDocument();
      expect(screen.getByText(/Sample raw request/i)).toBeInTheDocument();
    });

    it("shows a Runs-style timeline empty state before the first streamed snapshot and keeps the thread mounted", () => {
      mockUseChatSession.messages = [
        { id: "1", role: "user", parts: [{ type: "text", text: "Hello" }] },
      ];
      mockUseChatSession.traceViewsSupported = true;
      mockUseChatSession.hasTraceSnapshot = false;
      mockUseChatSession.hasLiveTimelineContent = false;
      mockUseChatSession.liveTraceEnvelope = null;

      render(<PlaygroundMain {...defaultProps} enableTraceViews={true} />);

      fireEvent.click(screen.getByRole("button", { name: "Trace" }));

      const pending = screen.getByTestId("playground-live-trace-pending");
      expect(pending).toBeInTheDocument();
      expect(
        within(pending).getByTestId(
          "playground-live-trace-pending-sample-preview",
        ),
      ).toBeInTheDocument();
      expect(within(pending).getByTestId("trace-viewer")).toBeInTheDocument();
      expect(
        screen.getByTestId("playground-trace-diagnostics"),
      ).toBeInTheDocument();
      expect(screen.getByTestId("thread")).toBeInTheDocument();
    });

    it("passes controlled display mode props into live trace viewers", () => {
      mockUseChatSession.messages = [
        { id: "1", role: "user", parts: [{ type: "text", text: "Hello" }] },
      ];
      mockUseChatSession.traceViewsSupported = true;
      mockUseChatSession.hasTraceSnapshot = true;
      mockUseChatSession.hasLiveTimelineContent = true;
      mockUseChatSession.liveTraceEnvelope = sampleLiveTraceEnvelope;

      render(<PlaygroundMain {...defaultProps} enableTraceViews={true} />);

      fireEvent.click(screen.getByRole("button", { name: "Trace" }));

      expect(mockTraceViewer).toHaveBeenCalled();
      const props = mockTraceViewer.mock.calls.at(-1)?.[0];
      expect(props.displayMode).toBe("inline");
      expect(props.onDisplayModeChange).toEqual(expect.any(Function));
    });

    it("forwards live trace start/end timestamps into the trace viewer for timeline and raw modes", () => {
      mockUseChatSession.messages = [
        { id: "1", role: "user", parts: [{ type: "text", text: "Hello" }] },
      ];
      mockUseChatSession.traceViewsSupported = true;
      mockUseChatSession.hasTraceSnapshot = true;
      mockUseChatSession.hasLiveTimelineContent = true;
      mockUseChatSession.liveTraceEnvelope = sampleLiveTraceEnvelope;

      render(<PlaygroundMain {...defaultProps} enableTraceViews={true} />);

      fireEvent.click(screen.getByRole("button", { name: "Trace" }));

      const timelineProps = mockTraceViewer.mock.calls.at(-1)?.[0];
      expect(timelineProps.traceStartedAtMs).toBe(
        sampleLiveTraceEnvelope.traceStartedAtMs,
      );
      expect(timelineProps.traceEndedAtMs).toBe(
        sampleLiveTraceEnvelope.traceEndedAtMs,
      );

      fireEvent.click(screen.getByRole("button", { name: "Raw" }));

      const rawProps = mockTraceViewer.mock.calls.at(-1)?.[0];
      expect(rawProps.forcedViewMode).toBe("raw");
      expect(rawProps.traceStartedAtMs).toBe(
        sampleLiveTraceEnvelope.traceStartedAtMs,
      );
      expect(rawProps.traceEndedAtMs).toBe(
        sampleLiveTraceEnvelope.traceEndedAtMs,
      );
    });

    it("prefers the streamed live trace over the prelude trace once a snapshot exists", async () => {
      const pendingExecution = {
        toolName: "create_view",
        params: { prompt: "Draw a flow" },
        result: { ok: true },
        toolMeta: undefined,
        state: "output-available" as const,
        toolCallId: "tool-call-1",
      };

      mockUseChatSession.messages = [
        { id: "1", role: "user", parts: [{ type: "text", text: "Hello" }] },
      ];
      mockUseChatSession.traceViewsSupported = true;
      mockUseChatSession.hasTraceSnapshot = false;
      mockUseChatSession.hasLiveTimelineContent = false;
      mockUseChatSession.liveTraceEnvelope = null;

      const { rerender } = render(
        <PlaygroundMain
          {...defaultProps}
          enableTraceViews={true}
          pendingExecution={pendingExecution}
        />,
      );

      fireEvent.click(screen.getByRole("button", { name: "Raw" }));

      expect(screen.getByTestId("trace-viewer")).toHaveAttribute(
        "data-mode",
        "raw",
      );
      expect(screen.getByTestId("trace-viewer")).toHaveAttribute(
        "data-trace",
        expect.stringContaining("Execute `create_view`"),
      );

      mockUseChatSession.hasTraceSnapshot = true;
      mockUseChatSession.hasLiveTimelineContent = true;
      mockUseChatSession.liveTraceEnvelope = sampleLiveTraceEnvelope;

      rerender(
        <PlaygroundMain
          {...defaultProps}
          enableTraceViews={true}
          pendingExecution={null}
        />,
      );

      await waitFor(() => {
        expect(screen.getByTestId("trace-viewer")).toHaveAttribute(
          "data-mode",
          "raw",
        );
        expect(screen.getByTestId("trace-viewer")).toHaveAttribute(
          "data-trace",
          expect.stringContaining("Draw the diagram"),
        );
      });
      expect(
        screen.queryByTestId("playground-live-trace-pending"),
      ).not.toBeInTheDocument();
    });
  });

  describe("multi-model chat", () => {
    it("shows centered starter layout, hidden compare grid, and composer like Chat tab when multi-model Chat is empty", () => {
      mockUseChatSession.availableModels = [
        {
          id: "gpt-4",
          name: "GPT-4",
          provider: "openai",
        },
        {
          id: "claude-sonnet-4-5",
          name: "Claude Sonnet 4.5",
          provider: "anthropic",
        },
        {
          id: "gemini-2.5-pro",
          name: "Gemini 2.5 Pro",
          provider: "google",
        },
      ];
      mockUseChatSession.selectedModelIds = [
        "gpt-4",
        "claude-sonnet-4-5",
        "gemini-2.5-pro",
      ];
      mockUseChatSession.multiModelEnabled = true;
      mockUseChatSession.traceViewsSupported = true;

      render(
        <PlaygroundMain
          {...defaultProps}
          enableMultiModelChat={true}
          enableTraceViews={true}
        />,
      );

      expect(
        screen.getByText("Try one of these to get started"),
      ).toBeInTheDocument();
      expect(screen.getAllByTestId("multi-model-playground-card")).toHaveLength(
        3,
      );
      expect(
        screen.getByTestId("playground-multi-model-compare-section"),
      ).toHaveClass("hidden");
      const grid = screen.getByTestId("playground-multi-model-grid");
      expect(grid.className.includes("hidden")).toBe(false);
      expect(grid).toHaveClass("xl:grid-cols-3");
      expect(grid).not.toHaveClass("2xl:grid-cols-3");
      expect(screen.getByTestId("trace-view-tabs")).toBeInTheDocument();
      expect(screen.getAllByTestId("chat-input")).not.toHaveLength(0);
      expect(
        screen.queryByText(
          "Send a shared message to start this model’s thread.",
        ),
      ).not.toBeInTheDocument();
      expect(
        screen.getAllByPlaceholderText(DEFAULT_CHAT_COMPOSER_PLACEHOLDER),
      ).not.toHaveLength(0);
    });

    it("shows trace empty diagnostics and hides compare grid when Trace is selected before first message", () => {
      mockUseChatSession.availableModels = [
        {
          id: "gpt-4",
          name: "GPT-4",
          provider: "openai",
        },
        {
          id: "claude-sonnet-4-5",
          name: "Claude Sonnet 4.5",
          provider: "anthropic",
        },
      ];
      mockUseChatSession.selectedModelIds = ["gpt-4", "claude-sonnet-4-5"];
      mockUseChatSession.multiModelEnabled = true;
      mockUseChatSession.traceViewsSupported = true;

      render(
        <PlaygroundMain
          {...defaultProps}
          enableMultiModelChat={true}
          enableTraceViews={true}
        />,
      );

      fireEvent.click(screen.getByText("Trace"));

      expect(
        screen.getByTestId("playground-multi-empty-trace-pending"),
      ).toBeInTheDocument();
      expect(
        screen.getByTestId("playground-multi-model-compare-section"),
      ).toHaveClass("hidden");
      expect(
        screen.queryByText("Try one of these to get started"),
      ).not.toBeInTheDocument();
    });
  });

  describe("chat input", () => {
    it("renders chat input", () => {
      render(<PlaygroundMain {...defaultProps} />);

      expect(screen.getByTestId("chat-input-field")).toBeInTheDocument();
    });

    it("keeps input editable while streaming", () => {
      mockUseChatSession.status = "submitted";
      mockUseChatSession.isStreaming = true;

      render(<PlaygroundMain {...defaultProps} />);

      expect(screen.getByTestId("chat-input-field")).not.toBeDisabled();
      expect(screen.getByTestId("chat-input")).toHaveAttribute(
        "data-loading",
        "true",
      );
    });

    it("disables input when submit is blocked", () => {
      mockUseChatSession.submitBlocked = true;

      render(<PlaygroundMain {...defaultProps} />);

      expect(screen.getByTestId("chat-input-field")).toBeDisabled();
    });

    it("shows correct placeholder", () => {
      render(<PlaygroundMain {...defaultProps} />);

      expect(
        screen.getByPlaceholderText(
          "Try a prompt that could call your tools...",
        ),
      ).toBeInTheDocument();
    });

    it("auto-connects the selected server before sending a message", async () => {
      const ensureServersReady = vi.fn().mockResolvedValue({
        readyServerNames: ["test-server"],
        missingServerNames: [],
        failedServerNames: [],
        reauthServerNames: [],
      });
      mockSharedAppState.servers["test-server"] = {
        connectionStatus: "disconnected",
      };

      render(
        <PlaygroundMain
          {...defaultProps}
          ensureServersReady={ensureServersReady}
        />,
      );

      fireEvent.change(screen.getByTestId("chat-input-field"), {
        target: { value: "Hello from playground" },
      });
      fireEvent.click(screen.getByTestId("chat-submit-button"));

      await waitFor(() => {
        expect(ensureServersReady).toHaveBeenCalledWith(["test-server"]);
      });
      await waitFor(() => {
        expect(mockUseChatSession.sendMessage).toHaveBeenCalledWith(
          expect.objectContaining({ text: "Hello from playground" }),
        );
      });
    });

    it("shows the guided prompt in the input when post-connect onboarding is active", () => {
      render(
        <PlaygroundMain
          {...defaultProps}
          showPostConnectGuide={true}
          initialInput="Draw me an MCP architecture diagram"
        />,
      );

      expect(screen.getByTestId("chat-input-field")).toHaveValue(
        "Draw me an MCP architecture diagram",
      );
    });

    it("types initialInput with a typewriter when initialInputTypewriter is true", () => {
      vi.useFakeTimers();
      const full = "Draw me an MCP architecture diagram";

      render(
        <PlaygroundMain
          {...defaultProps}
          showPostConnectGuide={false}
          initialInput={full}
          initialInputTypewriter={true}
        />,
      );

      const field = screen.getByTestId("chat-input-field");
      expect(field).toHaveValue("");

      act(() => {
        vi.advanceTimersByTime(20);
      });
      expect(field).toHaveValue("D");

      act(() => {
        vi.advanceTimersByTime(20 * full.length);
      });
      expect(field).toHaveValue(full);

      vi.useRealTimers();
    });

    it("pulses submit during first-run typewriter NUX when pulseSubmit is true", () => {
      const full = "Hello world";
      render(
        <PlaygroundMain
          {...defaultProps}
          showPostConnectGuide={false}
          initialInput={full}
          initialInputTypewriter={true}
          pulseSubmit={true}
        />,
      );

      expect(screen.getByTestId("chat-submit-button")).toHaveAttribute(
        "data-pulsing",
        "true",
      );

      fireEvent.change(screen.getByTestId("chat-input-field"), {
        target: { value: "User edit" },
      });

      expect(screen.getByTestId("chat-submit-button")).toHaveAttribute(
        "data-pulsing",
        "false",
      );
    });

    it("disables submit when blockSubmitUntilServerConnected and server is not connected", () => {
      mockSharedAppState.servers["test-server"] = {
        connectionStatus: "connecting",
      };

      render(
        <PlaygroundMain
          {...defaultProps}
          initialInput="Draw me an MCP architecture diagram"
          initialInputTypewriter={false}
          blockSubmitUntilServerConnected={true}
        />,
      );

      expect(screen.getByTestId("chat-submit-button")).toBeDisabled();
    });

    it("enables submit after server connects when blockSubmitUntilServerConnected is true", () => {
      mockSharedAppState.servers["test-server"] = {
        connectionStatus: "connecting",
      };

      const { rerender } = render(
        <PlaygroundMain
          {...defaultProps}
          initialInput="Hello"
          initialInputTypewriter={false}
          blockSubmitUntilServerConnected={true}
        />,
      );

      expect(screen.getByTestId("chat-submit-button")).toBeDisabled();

      mockSharedAppState.servers["test-server"] = {
        connectionStatus: "connected",
      };
      rerender(
        <PlaygroundMain
          {...defaultProps}
          initialInput="Hello"
          initialInputTypewriter={false}
          blockSubmitUntilServerConnected={true}
        />,
      );

      expect(screen.getByTestId("chat-submit-button")).not.toBeDisabled();
    });

    it("shows App Builder send NUX hint outside ChatInput while typewriter NUX is active", () => {
      mockSharedAppState.servers["test-server"] = {
        connectionStatus: "connecting",
      };

      render(
        <PlaygroundMain
          {...defaultProps}
          initialInput="Draw me an MCP architecture diagram"
          initialInputTypewriter={true}
          blockSubmitUntilServerConnected={true}
        />,
      );

      const hint = screen.getByTestId("app-builder-send-nux-hint");
      const chatInput = screen.getByTestId("chat-input");
      expect(hint).toHaveTextContent("Try this prompt with a demo MCP server");
      expect(hint.closest('[data-testid="chat-input"]')).toBeNull();
      expect(
        chatInput.compareDocumentPosition(hint) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
      expect(hint.querySelector("svg")).toBeTruthy();
    });

    it("keeps App Builder send NUX hint visible after server connects", () => {
      mockSharedAppState.servers["test-server"] = {
        connectionStatus: "connected",
      };

      render(
        <PlaygroundMain
          {...defaultProps}
          initialInput="Draw me an MCP architecture diagram"
          initialInputTypewriter={true}
          blockSubmitUntilServerConnected={true}
        />,
      );

      expect(screen.getByTestId("app-builder-send-nux-hint")).toHaveTextContent(
        "Try this prompt with a demo MCP server",
      );
    });

    it("restores the footer composer after the first guided message even without an onboarding callback", () => {
      mockUseChatSession.messages = [
        { id: "1", role: "user", parts: [{ type: "text", text: "Hello" }] },
        {
          id: "2",
          role: "assistant",
          parts: [{ type: "text", text: "Hi there!" }],
        },
      ];

      render(
        <PlaygroundMain
          {...defaultProps}
          showPostConnectGuide={true}
          initialInput="Draw me an MCP architecture diagram"
        />,
      );

      expect(screen.getByTestId("thread")).toBeInTheDocument();
      expect(screen.getByTestId("chat-input-field")).toBeInTheDocument();
    });

    it("preserves the guided prompt if chat reset fires before the first message", () => {
      render(
        <PlaygroundMain
          {...defaultProps}
          showPostConnectGuide={true}
          initialInput="Draw me an MCP architecture diagram"
        />,
      );

      act(() => {
        capturedChatSessionOptions.onReset();
      });

      expect(screen.getByTestId("chat-input-field")).toHaveValue(
        "Draw me an MCP architecture diagram",
      );
    });

    it("stops the onboarding pulse after the user edits the prefilled prompt", () => {
      render(
        <PlaygroundMain
          {...defaultProps}
          showPostConnectGuide={true}
          initialInput="Draw me an MCP architecture diagram"
          pulseSubmit={true}
        />,
      );

      expect(screen.getByTestId("chat-submit-button")).toHaveAttribute(
        "data-pulsing",
        "true",
      );

      fireEvent.change(screen.getByTestId("chat-input-field"), {
        target: { value: "Draw me a sequence diagram instead" },
      });

      expect(screen.getByTestId("chat-submit-button")).toHaveAttribute(
        "data-pulsing",
        "false",
      );
    });

    it("stops preserving the guided prompt once the user edits it", () => {
      render(
        <PlaygroundMain
          {...defaultProps}
          showPostConnectGuide={true}
          initialInput="Draw me an MCP architecture diagram"
        />,
      );

      fireEvent.change(screen.getByTestId("chat-input-field"), {
        target: { value: "Draw me a sequence diagram instead" },
      });

      act(() => {
        capturedChatSessionOptions.onReset();
      });

      expect(screen.getByTestId("chat-input-field")).toHaveValue("");
    });

    it("shows sign in placeholder when auth required", () => {
      mockUseChatSession.disableForAuthentication = true;

      render(<PlaygroundMain {...defaultProps} />);

      expect(
        screen.getByPlaceholderText("Sign in to use chat"),
      ).toBeInTheDocument();
    });

    it("shows free-chat sign-in placeholder in multi-model mode when auth required", () => {
      mockUseChatSession.disableForAuthentication = true;
      mockUseChatSession.availableModels = [
        { id: "gpt-4", name: "GPT-4", provider: "openai" },
        {
          id: "claude-sonnet-4-5",
          name: "Claude Sonnet 4.5",
          provider: "anthropic",
        },
      ];
      mockUseChatSession.selectedModelIds = ["gpt-4", "claude-sonnet-4-5"];
      mockUseChatSession.multiModelEnabled = true;

      render(<PlaygroundMain {...defaultProps} enableMultiModelChat={true} />);

      expect(
        screen.getAllByPlaceholderText("Sign in to use free chat").length,
      ).toBeGreaterThan(0);
    });
  });

  describe("invoking indicator", () => {
    it("shows invoking indicator when executing", () => {
      mockUseChatSession.messages = [
        { id: "1", role: "user", parts: [{ type: "text", text: "Hello" }] },
      ];

      render(
        <PlaygroundMain
          {...defaultProps}
          isExecuting={true}
          executingToolName="read_file"
        />,
      );

      expect(screen.getByText("Invoking")).toBeInTheDocument();
      expect(screen.getByText("read_file")).toBeInTheDocument();
    });

    it("shows custom invoking message when provided", () => {
      mockUseChatSession.messages = [
        { id: "1", role: "user", parts: [{ type: "text", text: "Hello" }] },
      ];

      render(
        <PlaygroundMain
          {...defaultProps}
          isExecuting={true}
          executingToolName="read_file"
          invokingMessage="Reading your file..."
        />,
      );

      expect(screen.getByText("Reading your file...")).toBeInTheDocument();
    });
  });

  describe("error handling", () => {
    it("shows error box when error exists", () => {
      mockUseChatSession.messages = [
        { id: "1", role: "user", parts: [{ type: "text", text: "Hello" }] },
      ];
      mockUseChatSession.error = new Error("Something went wrong");

      render(<PlaygroundMain {...defaultProps} />);

      expect(screen.getByTestId("error-box")).toBeInTheDocument();
      expect(screen.getByTestId("error-box")).toHaveTextContent(
        "Something went wrong",
      );
    });
  });

  describe("clear chat", () => {
    it("shows clear button when thread has messages", () => {
      mockUseChatSession.messages = [
        { id: "1", role: "user", parts: [{ type: "text", text: "Hello" }] },
      ];

      render(<PlaygroundMain {...defaultProps} />);

      // Find trash icon button
      const buttons = screen.getAllByRole("button");
      const clearButton = buttons.find(
        (btn) => btn.querySelector(".lucide-trash2") !== null,
      );
      expect(clearButton).toBeDefined();
    });

    it("does not show clear button when thread is empty", () => {
      mockUseChatSession.messages = [];

      render(<PlaygroundMain {...defaultProps} />);

      // Should not have trash button
      const buttons = screen.getAllByRole("button");
      const clearButton = buttons.find(
        (btn) => btn.querySelector(".lucide-trash2") !== null,
      );
      expect(clearButton).toBeUndefined();
    });
  });

  describe("device type", () => {
    it("renders with default mobile device type", () => {
      render(<PlaygroundMain {...defaultProps} />);

      // Device controls are rendered by HostContextHeader (mocked)
      expect(screen.getByTestId("host-context-header")).toBeInTheDocument();
    });

    it("renders with device frame using mobile dimensions", () => {
      render(<PlaygroundMain {...defaultProps} />);

      // The device frame container should have mobile dimensions from PRESET_DEVICE_CONFIGS
      const deviceFrame = document.querySelector('[style*="width: 375px"]');
      expect(deviceFrame).toBeInTheDocument();
    });
  });

  describe("locale", () => {
    it("shows display context header for locale controls", () => {
      render(<PlaygroundMain {...defaultProps} locale="en-US" />);

      // Locale controls are rendered by HostContextHeader (mocked)
      expect(screen.getByTestId("host-context-header")).toBeInTheDocument();
    });
  });

  describe("pending execution", () => {
    it("injects messages when pendingExecution is set", async () => {
      const onExecutionInjected = vi.fn();
      const pendingExecution = {
        toolName: "test_tool",
        params: { input: "test" },
        result: { output: "result" },
        toolMeta: undefined,
      };

      render(
        <PlaygroundMain
          {...defaultProps}
          pendingExecution={pendingExecution}
          onExecutionInjected={onExecutionInjected}
        />,
      );

      await waitFor(() => {
        expect(onExecutionInjected).toHaveBeenCalled();
      });
    });
  });
});
