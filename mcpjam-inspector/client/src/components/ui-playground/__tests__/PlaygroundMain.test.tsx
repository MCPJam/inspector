import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { PlaygroundMain } from "../PlaygroundMain";

// Mock lucide-react icons
vi.mock("lucide-react", () => ({
  ArrowDown: () => <span data-testid="icon-arrow-down" />,
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
vi.mock("@/components/ui/button", () => ({
  Button: ({ children, onClick, className, ...props }: any) => (
    <button onClick={onClick} className={className} {...props}>
      {children}
    </button>
  ),
}));

vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => (
    <div className="tooltip-content">{children}</div>
  ),
  TooltipTrigger: ({
    children,
    asChild,
  }: {
    children: React.ReactNode;
    asChild?: boolean;
  }) => <>{children}</>,
}));

vi.mock("@/components/ui/popover", () => ({
  Popover: ({
    children,
    open,
  }: {
    children: React.ReactNode;
    open?: boolean;
  }) => <>{children}</>,
  PopoverContent: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  PopoverTrigger: ({
    children,
    asChild,
  }: {
    children: React.ReactNode;
    asChild?: boolean;
  }) => <>{children}</>,
}));

vi.mock("@/components/ui/input", () => ({
  Input: (props: any) => <input {...props} />,
}));

vi.mock("@/components/ui/label", () => ({
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
  isStreaming: false,
  disableForAuthentication: false,
  submitBlocked: false,
};

vi.mock("@/hooks/use-chat-session", () => ({
  useChatSession: () => mockUseChatSession,
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
  }: {
    messages: any[];
    isLoading: boolean;
  }) => (
    <div data-testid="thread">
      <span data-testid="message-count">{messages.length}</span>
      {isLoading && <span data-testid="thread-loading">Loading...</span>}
    </div>
  ),
}));

// Mock ChatInput component
vi.mock("@/components/chat-v2/chat-input", () => ({
  ChatInput: ({
    value,
    onChange,
    onSubmit,
    disabled,
    placeholder,
  }: {
    value: string;
    onChange: (v: string) => void;
    onSubmit: (e: any) => void;
    disabled: boolean;
    placeholder: string;
  }) => (
    <form
      data-testid="chat-input"
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
      <button type="submit" disabled={disabled}>
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
  FullscreenChatOverlay: () => (
    <div data-testid="fullscreen-overlay">Fullscreen Overlay</div>
  ),
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
vi.mock("@/stores/preferences/preferences-provider", () => ({
  usePreferencesStore: (selector: any) => {
    const state = {
      themeMode: "light",
      setThemeMode: vi.fn(),
    };
    return selector ? selector(state) : state;
  },
}));

// Mock theme-utils
vi.mock("@/lib/theme-utils", () => ({
  updateThemeMode: vi.fn(),
}));

// Mock UI Playground store
const mockUIPlaygroundStore = {
  deviceType: "mobile",
  customViewport: { width: 375, height: 667 },
  setCustomViewport: vi.fn(),
  setPlaygroundActive: vi.fn(),
  cspMode: "permissive",
  setCspMode: vi.fn(),
  mcpAppsCspMode: "permissive",
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

// Mock DisplayContextHeader which exports PRESET_DEVICE_CONFIGS
vi.mock("@/components/shared/DisplayContextHeader", () => ({
  DisplayContextHeader: () => <div data-testid="display-context-header" />,
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

// Mock shared app state
vi.mock("@/state/app-state-context", () => ({
  useSharedAppState: () => ({
    servers: {
      "test-server": { connectionStatus: "connected" },
    },
  }),
}));

// Mock chat-helpers
vi.mock("@/components/chat-v2/shared/chat-helpers", () => ({
  formatErrorMessage: (error: any) =>
    error ? { message: error.message || "Error", details: null } : null,
}));

// Mock utils
vi.mock("@/lib/utils", () => ({
  cn: (...args: any[]) => args.filter(Boolean).join(" "),
}));

describe("PlaygroundMain", () => {
  const defaultProps = {
    serverName: "test-server",
    pendingExecution: null,
    onExecutionInjected: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    Object.assign(mockUseChatSession, {
      messages: [],
      status: "ready",
      error: null,
      isAuthLoading: false,
      disableForAuthentication: false,
      submitBlocked: false,
      isStreaming: false,
    });
  });

  describe("rendering", () => {
    it("renders the component", () => {
      render(<PlaygroundMain {...defaultProps} />);

      expect(screen.getByTestId("chat-input")).toBeInTheDocument();
    });

    it("renders device controls", () => {
      render(<PlaygroundMain {...defaultProps} />);

      // Device controls are rendered by DisplayContextHeader (mocked)
      expect(screen.getByTestId("display-context-header")).toBeInTheDocument();
    });

    it("renders theme toggle button", () => {
      render(<PlaygroundMain {...defaultProps} />);

      // Theme toggle should exist (sun/moon icon)
      const buttons = screen.getAllByRole("button");
      expect(buttons.length).toBeGreaterThan(0);
    });
  });

  describe("empty state", () => {
    it("shows welcome message when thread is empty", () => {
      render(<PlaygroundMain {...defaultProps} />);

      expect(
        screen.getByText("Test ChatGPT Apps and MCP Apps"),
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

      render(<PlaygroundMain {...defaultProps} />);

      expect(screen.getByTestId("thread-loading")).toBeInTheDocument();
    });
  });

  describe("chat input", () => {
    it("renders chat input", () => {
      render(<PlaygroundMain {...defaultProps} />);

      expect(screen.getByTestId("chat-input-field")).toBeInTheDocument();
    });

    it("disables input when not ready", () => {
      mockUseChatSession.status = "submitted";

      render(<PlaygroundMain {...defaultProps} />);

      expect(screen.getByTestId("chat-input-field")).toBeDisabled();
    });

    it("disables input when submit is blocked", () => {
      mockUseChatSession.submitBlocked = true;

      render(<PlaygroundMain {...defaultProps} />);

      expect(screen.getByTestId("chat-input-field")).toBeDisabled();
    });

    it("shows correct placeholder", () => {
      render(<PlaygroundMain {...defaultProps} />);

      expect(
        screen.getByPlaceholderText("Ask something to render UI..."),
      ).toBeInTheDocument();
    });

    it("shows sign in placeholder when auth required", () => {
      mockUseChatSession.disableForAuthentication = true;

      render(<PlaygroundMain {...defaultProps} />);

      expect(
        screen.getByPlaceholderText("Sign in to use chat"),
      ).toBeInTheDocument();
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

      // Device controls are rendered by DisplayContextHeader (mocked)
      expect(screen.getByTestId("display-context-header")).toBeInTheDocument();
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

      // Locale controls are rendered by DisplayContextHeader (mocked)
      expect(screen.getByTestId("display-context-header")).toBeInTheDocument();
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
