import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  render,
  screen,
  fireEvent,
  waitFor,
  act,
  within,
} from "@testing-library/react";
import { PlaygroundMain } from "../PlaygroundMain";
import { track } from "@/lib/analytics";
import { DEFAULT_CHAT_COMPOSER_PLACEHOLDER } from "@/components/chat-v2/shared/chat-helpers";
import { useHostContextStore } from "@/stores/client-context-store";
import { usePlaygroundChatHistoryBridgeStore } from "@/components/playground/playground-chat-history-bridge";
import { saveSelectedModelId } from "@/lib/selected-model-storage";
import { invalidateChatHistoryPrefetch } from "@/components/chat-v2/history/chat-history-prefetch";
import { useAgentToolPromptBridge } from "@/stores/agent-tool-prompt-bridge";

vi.mock("framer-motion", async (importOriginal) => {
  const actual = await importOriginal<typeof import("framer-motion")>();
  return {
    ...actual,
    useReducedMotion: () => false,
  };
});

const mockThread = vi.fn();
const mockChatInputProps = vi.fn();
const mockFullscreenChatOverlay = vi.fn();
const mockMultiModelPlaygroundCard = vi.fn();
const mockTraceViewer = vi.fn();
const mockGetChatHistoryDetail = vi.hoisted(() => vi.fn());
const mockChatHistoryAction = vi.hoisted(() => vi.fn());
// Convex auth is what decides whether chat history — and therefore the way back
// from a branch — is reachable at all. Mutable so the edit/branch tests can
// exercise both sides of that gate. Defaults to signed out, which is what every
// other test in this file has always run as.
const mockConvexAuthState = vi.hoisted(() => ({ isAuthenticated: false }));
const mockReactiveHistoryState = vi.hoisted(() => ({
  session: undefined as any,
  widgetSnapshots: undefined as any,
}));

const mockHostQueryState = vi.hoisted(() => ({ result: null as unknown }));
// Non-null `harnessId` means the chat executes inside a harness runtime
// (Claude Code, Codex). Default null = an ordinary model host.
const mockHarnessState = vi.hoisted(() => ({
  harnessId: null as string | null,
}));
vi.mock("@/hooks/useHarnessBuiltinTools", () => ({
  useHarnessBuiltinTools: () => ({
    harnessId: mockHarnessState.harnessId,
    tools: [],
    loading: false,
  }),
  useHarnessBuiltinToolCatalog: () => ({ tools: [], loading: false }),
}));

// Mock lucide-react icons
vi.mock("lucide-react", async (importOriginal) => ({
  // Spread the real icon set so a newly-rendered icon (e.g. Columns2) never
  // breaks the whole suite; the explicit stubs below keep the data-testids the
  // assertions rely on.
  ...(await importOriginal<typeof import("lucide-react")>()),
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
  // Icons used by PlaygroundCenterHeaderBar
  ArrowLeft: () => <span data-testid="icon-arrow-left" />,
  Code2: () => <span data-testid="icon-code2" />,
  MessageSquare: () => <span data-testid="icon-message-square" />,
  // Icons used by MultiHostPicker (rendered via PlaygroundHostPicker in the
  // header `leading` slot)
  Server: () => <span data-testid="icon-server" />,
  X: () => <span data-testid="icon-x" />,
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
  useFeatureFlagEnabled: () => false,
}));
vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));

// Mock PosthogUtils
vi.mock("@/lib/PosthogUtils", () => ({
  detectEnvironment: vi.fn().mockReturnValue("test"),
  detectPlatform: vi.fn().mockReturnValue("web"),
  standardEventProps: vi.fn().mockReturnValue({}),
}));

// Mock authkit
vi.mock("@workos-inc/authkit-react", () => ({
  useAuth: () => ({
    signUp: vi.fn(),
    user: { id: "test-user" },
    isLoading: false,
  }),
}));

vi.mock("@/contexts/db-user-ready-context", () => ({
  useDbUserReady: () => true,
}));

// Mock convex/react
vi.mock("convex/react", () => ({
  // useChatSession resolves the Convex client to submit elicitation answers
  // straight to the rendezvous table (the blocked replica isn't addressable).
  useConvex: () => ({ mutation: vi.fn().mockResolvedValue({ ok: true }) }),
  useConvexAuth: () => ({
    isAuthenticated: mockConvexAuthState.isAuthenticated,
    isLoading: false,
  }),
  // `useHost` (and any other Convex-backed hook PlaygroundMain pulls in)
  // calls useQuery. The test doesn't exercise auth flows, so a static
  // null is enough — the consumer treats it as "no host resolved yet".
  useQuery: (name: string, args: unknown) => {
    if (args === "skip") return undefined;
    if (name === "hosts:getHost") return mockHostQueryState.result;
    // The reactive chat-history subscription. `useResumedThreadPersistence`
    // reconciles a failed/absent persist receipt against this, so it needs a
    // real cell rather than the blanket null the other queries get.
    if (name === "directChatHistory:getCurrentSession") {
      return mockReactiveHistoryState.session;
    }
    if (name === "directChatHistory:getCurrentSessionWidgetSnapshots") {
      return mockReactiveHistoryState.widgetSnapshots;
    }
    return null;
  },
  useMutation: () => () => Promise.resolve(),
  // COMP-14: useComputerAttachmentUpload pulls in useMintTerminalToken (a
  // Convex action). The flag mock keeps the flow inert; this keeps it mountable.
  useAction: () => () => Promise.resolve({ token: "test-token" }),
}));

// Mock useViews (useProjectServers)
vi.mock("@/hooks/useViews", () => ({
  useProjectServers: () => ({
    serversByName: new Map(),
    serversById: new Map(),
  }),
}));

vi.mock("@/lib/apis/web/chat-history-api", () => ({
  getChatHistoryDetail: (...args: unknown[]) =>
    mockGetChatHistoryDetail(...args),
  chatHistoryAction: (...args: unknown[]) => mockChatHistoryAction(...args),
}));

// Mock useChatSession hook
const mockUseChatSession = {
  // Elicitation surface (hosted). These suites never elicit, but the shape
  // must match the hook's contract or the dialog crashes on undefined.
  pendingElicitations: [],
  respondToElicitation: vi.fn(),
  elicitationResponding: false,
  urlElicitationRequired: [],
  dismissUrlElicitationRequired: vi.fn(),
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
  systemPrompt: "",
  setSystemPrompt: vi.fn(),
  temperature: 0.7,
  setTemperature: vi.fn(),
  toolsMetadata: {},
  toolServerMap: {},
  tokenUsage: null,
  resetChat: vi.fn(),
  loadChatSession: vi.fn(async () => undefined),
  rewindToMessage: vi.fn(),
  detachToLocalFork: vi.fn(async () => ({ chatSessionId: "forked-session" })),
  consumePersistReceipt: vi.fn(() => null),
  consumeTurnAborted: vi.fn(() => false),
  syncResumedVersion: vi.fn(),
  resumedVersion: null,
  restoredToolRenderOverrides: {},
  chatSessionId: "chat-session-1",
  liveTraceEnvelope: null,
  requestPayloadHistory: [],
  hasTraceSnapshot: false,
  hasLiveTimelineContent: false,
  traceViewsSupported: false,
  requireToolApproval: false,
  setRequireToolApproval: vi.fn(),
  addToolApprovalResponse: vi.fn(),
  isSessionBootstrapComplete: true,
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
    onEditUserMessage,
    editDisabled,
    sendFollowUpMessage,
    onFullscreenChange,
  }: {
    messages: any[];
    isLoading: boolean;
    loadingIndicatorVariant?: string;
    onEditUserMessage?: (message: any, text: string) => void;
    editDisabled?: boolean;
    // Widget-driven follow-ups bypass the composer, so tests need the handler
    // itself — a rendered button could never stand in for that path.
    sendFollowUpMessage?: (text: string) => void;
    // A widget going fullscreen is what swaps the docked composer for the
    // pinned overlay; only the widget can report it, so tests drive it here.
    onFullscreenChange?: (fullscreen: boolean) => void;
  }) =>
    (() => {
      mockThread({
        messages,
        isLoading,
        loadingIndicatorVariant,
        onEditUserMessage,
        editDisabled,
        sendFollowUpMessage,
        onFullscreenChange,
      });
      return (
        <div data-testid="thread">
          <span data-testid="message-count">{messages.length}</span>
          {isLoading && <span data-testid="thread-loading">Loading...</span>}
          {/* Stands in for the per-message edit affordance — mirrors the
              "Edit first message" button in ChatTabV2's test suite. Only
              rendered when the affordance isn't suppressed, same as the real
              Thread/MessageView action row. */}
          {onEditUserMessage && (
            <button
              type="button"
              data-testid="edit-first-message"
              disabled={editDisabled}
              onClick={() =>
                onEditUserMessage(messages[0], "Edited text should not leak")
              }
            >
              Edit first message
            </button>
          )}
        </div>
      );
    })(),
}));

// Mock ChatInput component
vi.mock("@/components/chat-v2/chat-input", () => ({
  ChatInput: (props: {
    value: string;
    onChange: (v: string) => void;
    onSubmit: (e: any) => void;
    disabled: boolean;
    submitDisabled?: boolean;
    isLoading?: boolean;
    placeholder: string;
    pulseSubmit?: boolean;
    clientSelector?: unknown;
    onChangeSkillResults?: (results: unknown[]) => void;
    skillResults?: unknown[];
    onModelSelectorOpenChange?: (open: boolean) => void;
    notice?: React.ReactNode;
  }) => {
    // Captures the FULL props object (not just the fields this stub renders)
    // so tests can reach into props the rendered markup below never surfaces
    // — e.g. `onModelSelectorOpenChange`, which drives the layout lock that
    // keeps the single-pane Thread mounted across a compare-mode flip.
    // Mirrors ChatTabV2.trace-views.test.tsx's `mockChatInput` pattern.
    mockChatInputProps(props);
    const {
      value,
      onChange,
      onSubmit,
      disabled,
      submitDisabled,
      isLoading,
      placeholder,
      pulseSubmit,
      clientSelector,
      onChangeSkillResults,
      skillResults,
      notice,
    } = props;
    return (
      <form
        data-testid="chat-input"
        data-loading={isLoading ? "true" : "false"}
        data-skill-count={skillResults?.length ?? 0}
        data-client-selector={clientSelector ? "true" : "false"}
        onSubmit={(e) => {
          e.preventDefault();
          onSubmit(e);
        }}
      >
        {notice}
        <input
          data-testid="chat-input-field"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          disabled={disabled}
          placeholder={placeholder}
        />
        {/* Stands in for the composer's skill picker: attaching a skill is
            what populates `skillResults`, and the injection rule only exists
            on that path. */}
        <button
          type="button"
          data-testid="chat-input-attach-skill"
          onClick={() =>
            onChangeSkillResults?.([
              {
                id: "skill-1",
                skillId: "sk_1",
                name: "release-notes",
                content: "skill body",
              },
            ])
          }
        >
          Attach skill
        </button>
        <button
          type="submit"
          disabled={disabled || !!submitDisabled}
          data-testid="chat-submit-button"
          data-pulsing={pulseSubmit ? "true" : "false"}
        >
          Send
        </button>
      </form>
    );
  },
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
  })
);

// Mock FullscreenChatOverlay. It renders the `notice` slot and a
// canSend-driven Send button because the overlay REPLACES the docked
// composer — a stub that dropped either would hide exactly the dead end
// these tests exist to catch.
vi.mock("@/components/chat-v2/fullscreen-chat-overlay", () => ({
  FullscreenChatOverlay: (props: {
    loadingIndicatorVariant?: string;
    notice?: React.ReactNode;
    input?: string;
    onInputChange?: (value: string) => void;
    canSend?: boolean;
    onSend?: () => void;
  }) => {
    mockFullscreenChatOverlay(props);
    return (
      <div data-testid="fullscreen-overlay">
        {props.notice}
        <input
          data-testid="fullscreen-overlay-input"
          value={props.input ?? ""}
          onChange={(e) => props.onInputChange?.(e.target.value)}
        />
        <button
          type="button"
          data-testid="fullscreen-overlay-send"
          disabled={!props.canSend}
          onClick={() => props.onSend?.()}
        >
          Send
        </button>
      </div>
    );
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

// Mock ClientContextHeader which exports PRESET_DEVICE_CONFIGS
vi.mock("@/components/shared/ClientContextHeader", () => ({
  ClientContextHeader: ({ showThemeToggle }: { showThemeToggle?: boolean }) => (
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
  projects: {},
  activeProjectId: "default",
};

vi.mock("@/state/app-state-context", () => ({
  useSharedAppState: () => mockSharedAppState,
}));

// Mock chat-helpers (keep real placeholders; stub formatError + a fixed
// starter so tests don't churn when the real starter copy changes)
vi.mock("@/components/chat-v2/shared/chat-helpers", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("@/components/chat-v2/shared/chat-helpers")
  >();
  return {
    ...actual,
    formatErrorMessage: (error: any) =>
      error ? { message: error.message || "Error", details: null } : null,
    STARTER_PROMPTS: [{ label: "Starter chip", text: "Starter chip prompt" }],
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
    localStorage.clear();
    mockConvexAuthState.isAuthenticated = false;
    mockHostQueryState.result = null;
    mockReactiveHistoryState.session = undefined;
    mockReactiveHistoryState.widgetSnapshots = undefined;
    mockHarnessState.harnessId = null;
    capturedChatSessionOptions = null;
    usePlaygroundChatHistoryBridgeStore.getState().setBridge(null);
    mockGetChatHistoryDetail.mockReset();
    mockChatHistoryAction.mockReset();
    mockChatHistoryAction.mockResolvedValue({ ok: true });
    mockPreferencesState.themeMode = "light";
    mockPreferencesState.themePreset = "soft-pop";
    mockPreferencesState.hostStyle = "claude";
    useHostContextStore.setState({
      activeProjectId: null,
      defaultHostContext: {},
      savedHostContext: undefined,
      draftHostContext: {},
      hostContextText: "{}",
      hostContextError: null,
      isSaving: false,
      isDirty: false,
      pendingProjectId: null,
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
      resumedVersion: null,
      availableModels: [],
      selectedModelIds: [],
      multiModelEnabled: false,
      liveTraceEnvelope: null,
      requestPayloadHistory: [],
      hasTraceSnapshot: false,
      hasLiveTimelineContent: false,
      traceViewsSupported: false,
      // Fresh instance per test: a prior test's `mockResolvedValue` on the
      // shared object would otherwise leak into the next one.
      rewindToMessage: vi.fn(),
    });
    mockThread.mockClear();
    mockChatInputProps.mockClear();
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
        screen.queryByTestId("fullscreen-overlay")
      ).not.toBeInTheDocument();
    });

    it("renders device controls", () => {
      render(<PlaygroundMain {...defaultProps} />);

      // Device controls are rendered by ClientContextHeader (mocked)
      expect(screen.getByTestId("host-context-header")).toBeInTheDocument();
    });

    it("renders theme toggle button", () => {
      render(<PlaygroundMain {...defaultProps} />);

      expect(
        screen.getByTestId("host-context-theme-toggle")
      ).toBeInTheDocument();
    });

    it("starts shared-session rail chats with project visibility", async () => {
      render(<PlaygroundMain {...defaultProps} />);

      await waitFor(() => {
        expect(usePlaygroundChatHistoryBridgeStore.getState().bridge).not.toBe(
          null
        );
      });
      expect(capturedChatSessionOptions.directVisibility).toBe("private");

      await act(async () => {
        const bridge = usePlaygroundChatHistoryBridgeStore.getState().bridge;
        await Promise.resolve(bridge?.onNewChat({ shared: true }));
      });

      await waitFor(() => {
        expect(capturedChatSessionOptions.directVisibility).toBe("project");
      });
      expect(mockUseChatSession.resetChat).toHaveBeenCalled();
    });

    it("drops the chat-input client chip after the active session is shared", async () => {
      const privateSessionLocal = {
        _id: "history-share-gate-1",
        chatSessionId: "chat-session-share-gate-1",
        firstMessagePreview: "Hello",
        status: "active" as const,
        directVisibility: "private" as const,
        messageCount: 2,
        version: 4,
        startedAt: 1,
        lastActivityAt: 1,
        isPinned: false,
        manualUnread: false,
        isUnread: false,
        messagesBlobUrl: "https://storage.test/blob",
        resumeConfig: { selectedServers: ["test-server"] },
      };
      const sharedSessionLocal = {
        ...privateSessionLocal,
        directVisibility: "project" as const,
        version: 5,
      };
      mockGetChatHistoryDetail
        .mockResolvedValueOnce({
          ok: true,
          session: privateSessionLocal,
          widgetSnapshots: [],
        })
        .mockResolvedValueOnce({
          ok: true,
          session: sharedSessionLocal,
          widgetSnapshots: [],
        });

      render(<PlaygroundMain {...defaultProps} />);

      await waitFor(() => {
        expect(usePlaygroundChatHistoryBridgeStore.getState().bridge).not.toBe(
          null
        );
      });

      // Private sessions get the chat-input client chip wired up.
      expect(screen.getByTestId("chat-input")).toHaveAttribute(
        "data-client-selector",
        "true"
      );

      await act(async () => {
        const bridge = usePlaygroundChatHistoryBridgeStore.getState().bridge;
        await Promise.resolve(bridge?.onSelectThread(privateSessionLocal));
      });
      await waitFor(() => {
        expect(capturedChatSessionOptions.directVisibility).toBe("private");
      });

      await act(async () => {
        const bridge = usePlaygroundChatHistoryBridgeStore.getState().bridge;
        await Promise.resolve(
          bridge?.onSessionAction?.({
            action: "share",
            session: privateSessionLocal,
          })
        );
      });

      await waitFor(() => {
        expect(capturedChatSessionOptions.directVisibility).toBe("project");
      });
      // Shared sessions can't switch hosts — `clientSelector` is left undefined.
      expect(screen.getByTestId("chat-input")).toHaveAttribute(
        "data-client-selector",
        "false"
      );
    });

    it("refuses the send but KEEPS the thread when the pre-send sync fails transiently", async () => {
      // `refreshCurrentHistorySession` returns null for 403/404 — the thread is
      // gone — and callers detach on that. A network blip or 5xx must NOT be
      // flattened into the same signal, or a brief history-API outage tears
      // users off perfectly valid conversations.
      const session = {
        _id: "history-1",
        chatSessionId: "chat-session-1",
        firstMessagePreview: "Hello",
        status: "active" as const,
        directVisibility: "private" as const,
        messageCount: 2,
        version: 4,
        startedAt: 1,
        lastActivityAt: 1,
        isPinned: false,
        manualUnread: false,
        isUnread: false,
        messagesBlobUrl: "https://storage.test/blob",
        resumeConfig: { selectedServers: ["test-server"] },
      };
      // The detail cache is module-level and this file clears it per test
      // rather than in beforeEach; without this, the session ids below stay
      // cached and shift the next test's mockResolvedValueOnce queue.
      invalidateChatHistoryPrefetch();
      // A non-empty transcript, so a detach would take the FORK branch and be
      // visible as a `detachToLocalFork` call rather than a silent no-op.
      mockUseChatSession.messages = [
        { id: "u1", role: "user", parts: [{ type: "text", text: "Hello" }] },
        { id: "a1", role: "assistant", parts: [{ type: "text", text: "Hi" }] },
      ];
      mockGetChatHistoryDetail.mockResolvedValueOnce({
        ok: true,
        session,
        widgetSnapshots: [],
      });

      render(<PlaygroundMain {...defaultProps} />);
      await waitFor(() => {
        expect(usePlaygroundChatHistoryBridgeStore.getState().bridge).not.toBe(
          null
        );
      });

      await act(async () => {
        const bridge = usePlaygroundChatHistoryBridgeStore.getState().bridge;
        await Promise.resolve(bridge?.onSelectThread(session));
      });

      // A rail-opened conversation records no host or environment, so the
      // composer discloses that and holds the first reply until the user
      // accepts the target it will actually run on. Accept it here — this test
      // is about the pre-send SYNC, not about the target disclosure.
      fireEvent.click(
        screen.getByTestId("conversation-target-notice-acknowledge")
      );

      // Control: with the sync healthy the send goes through, so the assertions
      // below are about the failure and not about a submit path that never runs.
      mockGetChatHistoryDetail.mockResolvedValue({
        ok: true,
        session,
        widgetSnapshots: [],
      });
      fireEvent.change(screen.getByTestId("chat-input-field"), {
        target: { value: "first message" },
      });
      await act(async () => {
        fireEvent.submit(screen.getByTestId("chat-input"));
      });
      expect(mockUseChatSession.sendMessage).toHaveBeenCalledTimes(1);

      mockGetChatHistoryDetail.mockRejectedValue(new Error("network down"));
      fireEvent.change(screen.getByTestId("chat-input-field"), {
        target: { value: "another message" },
      });
      await act(async () => {
        fireEvent.submit(screen.getByTestId("chat-input"));
      });

      // Blocked, because a blind send could clobber another writer...
      expect(mockUseChatSession.sendMessage).toHaveBeenCalledTimes(1);
      // ...but the conversation is still the user's; nothing was forked away.
      expect(mockUseChatSession.detachToLocalFork).not.toHaveBeenCalled();

      // Leave the module-level detail cache as this test found it — the ids
      // above are reused by later tests, which queue their own
      // `mockResolvedValueOnce` responses and would otherwise be served stale.
      invalidateChatHistoryPrefetch();
    });

    it("keeps active playground thread visibility in sync after sharing", async () => {
      const privateSession = {
        _id: "history-1",
        chatSessionId: "chat-session-1",
        firstMessagePreview: "Hello",
        status: "active" as const,
        directVisibility: "private" as const,
        messageCount: 2,
        version: 4,
        startedAt: 1,
        lastActivityAt: 1,
        isPinned: false,
        manualUnread: false,
        isUnread: false,
        messagesBlobUrl: "https://storage.test/blob",
        resumeConfig: {
          selectedServers: ["test-server"],
        },
      };
      const sharedSession = {
        ...privateSession,
        directVisibility: "project" as const,
        version: 5,
      };
      mockGetChatHistoryDetail
        .mockResolvedValueOnce({
          ok: true,
          session: privateSession,
          widgetSnapshots: [],
        })
        .mockResolvedValueOnce({
          ok: true,
          session: sharedSession,
          widgetSnapshots: [],
        });

      render(<PlaygroundMain {...defaultProps} />);

      await waitFor(() => {
        expect(usePlaygroundChatHistoryBridgeStore.getState().bridge).not.toBe(
          null
        );
      });

      await act(async () => {
        const bridge = usePlaygroundChatHistoryBridgeStore.getState().bridge;
        await Promise.resolve(bridge?.onSelectThread(privateSession));
      });
      await waitFor(() => {
        expect(capturedChatSessionOptions.directVisibility).toBe("private");
      });

      await act(async () => {
        const bridge = usePlaygroundChatHistoryBridgeStore.getState().bridge;
        await Promise.resolve(
          bridge?.onSessionAction?.({
            action: "share",
            session: privateSession,
          })
        );
      });

      await waitFor(() => {
        expect(capturedChatSessionOptions.directVisibility).toBe("project");
      });
    });

    // Removed: "passes the requested loading indicator variant to Thread".
    // PlaygroundMain no longer accepts a `loadingIndicatorVariant` prop —
    // the inner Thread reads the host id from `ScenarioHostStyleProvider`
    // context. Brand-indicator behavior is covered in
    // `LoadingIndicatorContent.test.tsx` and `Thread.test.tsx`.
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
        "dark"
      );

      act(() => {
        useHostContextStore.getState().setHostContextText("{}");
      });

      expect(screen.getByTestId("playground-thread-shell")).toHaveAttribute(
        "data-thread-theme",
        "light"
      );
      expect(screen.getByTestId("playground-thread-shell")).not.toHaveClass(
        "dark"
      );
    });
  });

  describe("empty state", () => {
    it("shows welcome message when thread is empty", () => {
      render(<PlaygroundMain {...defaultProps} />);

      expect(screen.getByRole("img", { name: /MCPJam/i })).toBeInTheDocument();
      expect(
        screen.getByRole("heading", {
          name: /This is your playground for MCP./i,
        })
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
        screen.queryByRole("button", { name: /Skip onboarding/i })
      ).not.toBeInTheDocument();
    });

    it("shows the ticket hint copy in the post-connect guide", () => {
      render(<PlaygroundMain {...defaultProps} showPostConnectGuide={true} />);

      expect(
        screen.getByText("Try asking Excalidraw to draw something.")
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

  describe("message edit and branch", () => {
    beforeEach(() => {
      mockUseChatSession.messages = [
        { id: "1", role: "user", parts: [{ type: "text", text: "Original" }] },
      ];
      // The affordance requires reachable history (see the gating test at the
      // end of this block), so these tests run signed in.
      mockConvexAuthState.isAuthenticated = true;
    });

    afterEach(() => {
      // The URL test below navigates; `window.location` is shared across tests.
      window.history.replaceState({}, "", "/");
      invalidateChatHistoryPrefetch();
    });

    it("rewinds on edit and tracks it", async () => {
      mockUseChatSession.rewindToMessage = vi.fn().mockResolvedValue({
        previousChatSessionId: "prev-session-1",
      });

      render(<PlaygroundMain {...defaultProps} />);

      fireEvent.click(screen.getByTestId("edit-first-message"));

      await waitFor(() => {
        expect(mockUseChatSession.rewindToMessage).toHaveBeenCalledWith(
          expect.objectContaining({
            messageId: "1",
            text: "Edited text should not leak",
          })
        );
      });

      // The `edit_message` analytics only fires once `rewindToMessage` actually
      // branched — it lives AFTER the `if (!outcome) return` guard in the
      // handler, and this pins that. Nothing is shown to the user: the branch is
      // deliberately silent, so analytics is the only observable effect left.
      expect(track).toHaveBeenCalledWith("edit_message", {
        location: "playground",
        model_id: "gpt-4",
        model_name: "GPT-4",
        model_provider: "openai",
      });
    });

    it("refuses silently when rewindToMessage resolves null: no analytics", async () => {
      // `null` means the rewind was refused (a turn started in the gap after
      // `ensureSelectedServerReadyForChat`'s round trip, or the message is
      // gone). Nothing branched, so the `edit_message` event must not fire —
      // this pins the ordering the review flagged: it sits AFTER
      // `if (!outcome) return`, never before it.
      mockUseChatSession.rewindToMessage = vi.fn().mockResolvedValue(null);

      render(<PlaygroundMain {...defaultProps} />);

      fireEvent.click(screen.getByTestId("edit-first-message"));

      await waitFor(() => {
        expect(mockUseChatSession.rewindToMessage).toHaveBeenCalled();
      });

      expect(track).not.toHaveBeenCalledWith("edit_message", expect.anything());
    });

    it("leaves the thread attached when the rewind is refused", async () => {
      // Regression. The teardown used to run BEFORE `rewindToMessage`, so a
      // refusal left the ORIGINAL session id live with its
      // optimistic-concurrency guard already gone: `resumedVersion` null means
      // the next ordinary send carries no `expectedVersion`, and the backend
      // then rewrites that session's row without checking whether another tab
      // or device advanced it — silently dropping their turns. A refused
      // rewind touches nothing, so the guard has to survive it.
      mockUseChatSession.syncResumedVersion.mockClear();
      const ORIGINAL_CONVERSATION_ID = "original-chat-session";
      window.history.replaceState(
        {},
        "",
        `/playground?conversation=${ORIGINAL_CONVERSATION_ID}`
      );
      mockUseChatSession.chatSessionId = ORIGINAL_CONVERSATION_ID;
      // Refuses without ever minting a branch — `onBeforeBranch` is not called.
      mockUseChatSession.rewindToMessage = vi.fn().mockResolvedValue(null);

      render(<PlaygroundMain {...defaultProps} syncConversationToUrl />);

      fireEvent.click(screen.getByTestId("edit-first-message"));

      await waitFor(() => {
        expect(mockUseChatSession.rewindToMessage).toHaveBeenCalled();
      });

      expect(
        mockUseChatSession.syncResumedVersion.mock.calls.some(
          ([version]: [number | null]) => version === null
        )
      ).toBe(false);
      // And the conversation keeps its place in the URL, so a refresh still
      // lands on the thread instead of a blank Playground.
      expect(window.location.search).toContain(ORIGINAL_CONVERSATION_ID);
    });

    it("detaches from the resumed thread before the branch's turn is dispatched", async () => {
      // The post-stream conflict check captures its baseline the instant the
      // stream starts — and that happens INSIDE `rewindToMessage`, just after
      // the branch is minted. Still attached to the ORIGINAL thread at that
      // moment, the baseline names the original, the branch's completed stream
      // is compared against it, and a deliberate branch surfaces as a phantom
      // "this chat changed elsewhere" (which also re-forks, so the user's next
      // message lands in a third session). Detaching therefore has to happen
      // BEFORE the rewind is dispatched, which is what this asserts — the check
      // runs from inside the rewind, since "after it returned" is already late.
      // Deliberately does NOT seed `resumedVersion`: the handler clears it
      // unconditionally, so seeding it would prove nothing here while leaking a
      // mutation of the shared mock into later tests. The realistic
      // resumed-thread path — rail attached, version 4, detaching to "none" —
      // is covered in `ChatTabV2.history-sync.test.tsx`, whose mock reflects
      // `syncResumedVersion` back onto `resumedVersion`. This pins the ordering.
      mockUseChatSession.syncResumedVersion.mockClear();

      let clearedBeforeRewind: boolean | undefined = undefined;
      // The real hook fires `onBeforeBranch` as the branch is minted, just
      // before the turn dispatches; observing after it is what makes this an
      // ordering assertion rather than a no-op.
      mockUseChatSession.rewindToMessage = vi
        .fn()
        .mockImplementation(async (options) => {
          options?.onBeforeBranch?.();
          clearedBeforeRewind =
            mockUseChatSession.syncResumedVersion.mock.calls.some(
              ([version]: [number | null]) => version === null
            );
          return { previousChatSessionId: "prev-session-1" };
        });

      render(<PlaygroundMain {...defaultProps} />);

      // Guard against a vacuous pass: nothing may have cleared it during the
      // render, or "it was already null" would prove nothing about ordering.
      expect(
        mockUseChatSession.syncResumedVersion.mock.calls.some(
          ([version]: [number | null]) => version === null
        )
      ).toBe(false);

      fireEvent.click(screen.getByTestId("edit-first-message"));

      await waitFor(() => {
        expect(mockUseChatSession.rewindToMessage).toHaveBeenCalled();
      });

      expect(clearedBeforeRewind).toBe(true);
    });

    it("drops the original conversation from the URL when a rewind branches", async () => {
      // Regression. Detaching from the resumed thread (the fix above) clears
      // `activeHistorySessionId`, and that is one of the two guards holding the
      // conversation-URL restore effect back:
      //
      //     if (activeHistorySessionId) return;
      //     if (hasMessages) return;
      //
      // The other falls too when the user edits the FIRST message: the prefix
      // before it is empty, so the branch is seeded with an empty transcript.
      // With both guards down and `?conversation=` still naming the ORIGINAL,
      // the restore effect refetched the original and reloaded it over the
      // branch — the edit appeared to do nothing but show a toast.
      //
      // `onReset("fork")` deliberately does not clear the URL (auth-bootstrap
      // re-mints are the SAME conversation and must keep it), so a branch has
      // to say so itself — exactly as New Chat does via `onReset("reset")`.
      //
      // This asserts the fix's mechanism rather than replaying the empty-thread
      // window, which the chat-session mock cannot produce: it never actually
      // truncates the transcript.
      const ORIGINAL_CONVERSATION_ID = "original-chat-session";
      window.history.replaceState(
        {},
        "",
        `/playground?conversation=${ORIGINAL_CONVERSATION_ID}`
      );
      // The live session IS the one the URL names — the hook's stated invariant
      // ("restored ⇔ chatSessionId === param"). Without this the sync effect
      // overwrites the param with the mock's default id on the first render and
      // the setup never reaches the state being tested.
      mockUseChatSession.chatSessionId = ORIGINAL_CONVERSATION_ID;
      // The URL is dropped from `onBeforeBranch`, which the real hook fires as
      // the branch is minted — so a refused rewind keeps its `?conversation=`.
      mockUseChatSession.rewindToMessage = vi
        .fn()
        .mockImplementation(async (options) => {
          options?.onBeforeBranch?.();
          return { previousChatSessionId: ORIGINAL_CONVERSATION_ID };
        });

      render(<PlaygroundMain {...defaultProps} syncConversationToUrl />);

      // Guard against a vacuous pass: the param has to be there to be dropped.
      expect(window.location.search).toContain(ORIGINAL_CONVERSATION_ID);

      fireEvent.click(screen.getByTestId("edit-first-message"));

      await waitFor(() => {
        expect(mockUseChatSession.rewindToMessage).toHaveBeenCalled();
      });

      // Not "no param at all": once the branch's transcript has content the sync
      // effect writes the BRANCH's id here. What must never survive is the
      // original's, which is what the restore effect would act on.
      await waitFor(() => {
        expect(window.location.search).not.toContain(ORIGINAL_CONVERSATION_ID);
      });
    });

    it("withholds the edit affordance when signed out, where there is no history to go back to", () => {
      // The Playground ships in the desktop / `npx` build (it sits in the base
      // navigation), and `PlaygroundLeftRail` renders `ChatHistoryRail` there
      // with no `HOSTED_MODE` gate — but every path that would get the user
      // back to a branched-away thread needs a bearer token: the rail's
      // reactive Convex query, its signed-out REST fallback, and
      // `/chat-history/detail`, which the branch notice calls to reopen the
      // original. Signed out, editing would discard the original thread with
      // no way back while promising "still in your history".
      mockConvexAuthState.isAuthenticated = false;

      render(<PlaygroundMain {...defaultProps} />);

      expect(
        screen.queryByTestId("edit-first-message")
      ).not.toBeInTheDocument();
      expect(
        mockThread.mock.calls.at(-1)?.[0].onEditUserMessage
      ).toBeUndefined();
    });

    it("withholds the edit affordance on harness hosts", () => {
      // Claude Code / Codex keep the conversation on their own side, filed
      // under the chat session id, and receive only the newest user message.
      // `@ai-sdk/harness` offers resume-this-exact-session and nothing else —
      // no fork, no rewind, and the resume payload is opaque, so the discarded
      // tail cannot be trimmed from it. A branch mints a NEW session id, so
      // there is nothing to resume: the harness would answer the edited
      // message with no memory of the conversation while the persisted
      // transcript still shows the whole history.
      mockConvexAuthState.isAuthenticated = true;
      mockHarnessState.harnessId = "claude-code";

      render(<PlaygroundMain {...defaultProps} />);

      expect(
        screen.queryByTestId("edit-first-message")
      ).not.toBeInTheDocument();
      expect(
        mockThread.mock.calls.at(-1)?.[0].onEditUserMessage
      ).toBeUndefined();
    });

    it("withholds edit until a newly selected ordinary host resolves", () => {
      // Convex-shaped id on purpose: this test drives the REAL `useHost`, which
      // skips the query for an id that could never name a host document (a
      // `/hosts/:hostId` URL can carry a catalog slug — see `shouldQueryHostId`).
      // A `host-…` placeholder would be skipped, so the host could never
      // "resolve" and the assertion below would be testing the guard, not the
      // edit affordance.
      const HOST_ID = "hlk3m9x2q7v5b8n1t4r6s0dc";
      localStorage.setItem(
        "mcp-previewed-host-id",
        JSON.stringify({ "project-1": HOST_ID })
      );
      mockHostQueryState.result = undefined;

      const props = { ...defaultProps, activeProjectId: "project-1" };
      const { rerender } = render(<PlaygroundMain {...props} />);

      expect(
        mockThread.mock.calls.at(-1)?.[0].onEditUserMessage
      ).toBeUndefined();

      mockHostQueryState.result = {
        hostId: HOST_ID,
        name: "Ordinary host",
        config: {
          id: "config-1",
          modelId: "",
          systemPrompt: "",
          temperature: 0.7,
          requireToolApproval: false,
          serverIds: [],
          optionalServerIds: [],
        },
      };
      rerender(<PlaygroundMain {...props} />);

      expect(mockThread.mock.calls.at(-1)?.[0].onEditUserMessage).toBeDefined();
    });

    it("keeps the edit affordance on ordinary model hosts", () => {
      // Guards the gate above against over-reach: no harness, pencil stays.
      mockConvexAuthState.isAuthenticated = true;
      mockHarnessState.harnessId = null;

      render(<PlaygroundMain {...defaultProps} />);

      expect(mockThread.mock.calls.at(-1)?.[0].onEditUserMessage).toBeDefined();
    });

    it("suppresses the edit affordance when hideMessageEdit is set", () => {
      render(<PlaygroundMain {...defaultProps} hideMessageEdit />);

      expect(
        screen.queryByTestId("edit-first-message")
      ).not.toBeInTheDocument();
      expect(
        mockThread.mock.calls.at(-1)?.[0].onEditUserMessage
      ).toBeUndefined();
    });

    it("suppresses the edit affordance when compare mode is live, independent of hideMessageEdit", async () => {
      // `enableMultiModelChat` + 2 `availableModels` makes `canEnableMultiModel`
      // true; flipping `multiModelEnabled` then makes `isCompareMode` true.
      mockUseChatSession.availableModels = [
        { id: "openai/gpt-5-mini", name: "GPT-5 Mini", provider: "openai" },
        {
          id: "anthropic/claude-sonnet-4-5",
          name: "Claude Sonnet 4.5",
          provider: "anthropic",
        },
      ];

      const { rerender } = render(
        <PlaygroundMain {...defaultProps} enableMultiModelChat={true} />
      );

      // Sanity check: single-model mode, editing is available.
      expect(
        mockThread.mock.calls.at(-1)?.[0].onEditUserMessage
      ).toBeInstanceOf(Function);

      // `useModelSelectorLayoutLock` keeps whichever surface was mounted when
      // the model selector opens mounted through a subsequent mode flip (see
      // ChatTabV2.trace-views.test.tsx's identical pattern), so opening it
      // here keeps the single-pane Thread mounted even once compare mode
      // goes live below — isolating the ternary's `isCompareMode` arm from
      // the (separately-tested, and separately real) fact that compare mode
      // normally unmounts Thread in favor of the multi-model card grid.
      const chatInputProps = mockChatInputProps.mock.calls.at(-1)?.[0] as {
        onModelSelectorOpenChange?: (open: boolean) => void;
      };
      act(() => {
        chatInputProps.onModelSelectorOpenChange?.(true);
      });

      mockUseChatSession.multiModelEnabled = true;
      rerender(
        <PlaygroundMain {...defaultProps} enableMultiModelChat={true} />
      );

      // Confirms the lock actually held — Thread, not the compare grid, is
      // still what's on screen. If this assertion fails, the test below it
      // is meaningless (it would just be re-proving "compare mode unmounts
      // Thread", not the ternary).
      expect(screen.getByTestId("thread")).toBeInTheDocument();
      expect(
        mockThread.mock.calls.at(-1)?.[0].onEditUserMessage
      ).toBeUndefined();
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
        })
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
        })
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
        })
      );

      await waitFor(() => {
        expect(
          mockMultiModelPlaygroundCard.mock.calls.some(
            ([props]) => props.stopRequestId === 1
          )
        ).toBe(true);
      });
    });

    it("passes the previewed host id into multi-model card runtime context", () => {
      localStorage.setItem(
        "mcp-previewed-host-id",
        JSON.stringify({ "project-1": "host-claude-code" })
      );
      mockUseChatSession.availableModels = [
        {
          id: "openai/gpt-5-mini",
          name: "GPT-5 Mini",
          provider: "openai",
        },
        {
          id: "anthropic/claude-haiku-4.5",
          name: "Claude Haiku 4.5",
          provider: "anthropic",
        },
      ];
      mockUseChatSession.selectedModelIds = [
        "openai/gpt-5-mini",
        "anthropic/claude-haiku-4.5",
      ];
      mockUseChatSession.multiModelEnabled = true;

      render(
        <PlaygroundMain
          {...defaultProps}
          activeProjectId="project-1"
          enableMultiModelChat={true}
        />
      );

      expect(mockMultiModelPlaygroundCard.mock.calls.length).toBeGreaterThan(0);
      for (const [props] of mockMultiModelPlaygroundCard.mock.calls) {
        expect(props.hostedContext?.hostId).toBe("host-claude-code");
      }
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
        })
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
        <PlaygroundMain {...defaultProps} enableTraceViews={true} />
      );

      // Trace / Chat / Raw row in PlaygroundCenterHeaderBar (second strip).
      expect(
        screen.getByTestId("playground-trace-view-tabs")
      ).toBeInTheDocument();

      mockUseChatSession.traceViewsSupported = false;
      rerender(<PlaygroundMain {...defaultProps} enableTraceViews={true} />);

      expect(
        screen.queryByTestId("playground-trace-view-tabs")
      ).not.toBeInTheDocument();
    });

    it("shows trace mode tabs on an empty thread when trace views are supported", () => {
      mockUseChatSession.messages = [];
      mockUseChatSession.traceViewsSupported = true;

      render(<PlaygroundMain {...defaultProps} enableTraceViews={true} />);

      expect(
        screen.getByTestId("playground-trace-view-tabs")
      ).toBeInTheDocument();
    });

    it("renders the shared trace header tabs", () => {
      mockUseChatSession.messages = [];
      mockUseChatSession.traceViewsSupported = true;

      render(<PlaygroundMain {...defaultProps} enableTraceViews={true} />);

      expect(screen.getByTestId("playground-main-header")).toBeInTheDocument();
      expect(
        screen.getByTestId("playground-trace-view-tabs")
      ).toBeInTheDocument();
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
          "playground-live-raw-pending-sample-preview"
        )
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
          "playground-live-trace-pending-sample-preview"
        )
      ).toBeInTheDocument();
      expect(within(pending).getByTestId("trace-viewer")).toBeInTheDocument();
      expect(
        screen.getByTestId("playground-trace-diagnostics")
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
        sampleLiveTraceEnvelope.traceStartedAtMs
      );
      expect(timelineProps.traceEndedAtMs).toBe(
        sampleLiveTraceEnvelope.traceEndedAtMs
      );

      fireEvent.click(screen.getByRole("button", { name: "Raw" }));

      const rawProps = mockTraceViewer.mock.calls.at(-1)?.[0];
      expect(rawProps.forcedViewMode).toBe("raw");
      expect(rawProps.traceStartedAtMs).toBe(
        sampleLiveTraceEnvelope.traceStartedAtMs
      );
      expect(rawProps.traceEndedAtMs).toBe(
        sampleLiveTraceEnvelope.traceEndedAtMs
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
        />
      );

      fireEvent.click(screen.getByRole("button", { name: "Raw" }));

      expect(screen.getByTestId("trace-viewer")).toHaveAttribute(
        "data-mode",
        "raw"
      );
      expect(screen.getByTestId("trace-viewer")).toHaveAttribute(
        "data-trace",
        expect.stringContaining("Execute `create_view`")
      );

      mockUseChatSession.hasTraceSnapshot = true;
      mockUseChatSession.hasLiveTimelineContent = true;
      mockUseChatSession.liveTraceEnvelope = sampleLiveTraceEnvelope;

      rerender(
        <PlaygroundMain
          {...defaultProps}
          enableTraceViews={true}
          pendingExecution={null}
        />
      );

      await waitFor(() => {
        expect(screen.getByTestId("trace-viewer")).toHaveAttribute(
          "data-mode",
          "raw"
        );
        expect(screen.getByTestId("trace-viewer")).toHaveAttribute(
          "data-trace",
          expect.stringContaining("Draw the diagram")
        );
      });
      expect(
        screen.queryByTestId("playground-live-trace-pending")
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
        />
      );

      const compareShell = screen.getByTestId("playground-compare-shell");
      expect(compareShell).toHaveAttribute("data-thread-theme", "light");
      expect(compareShell).not.toHaveClass("dark");
      expect(
        screen.getByText("Try one of these to get started")
      ).toBeInTheDocument();
      expect(screen.getAllByTestId("multi-model-playground-card")).toHaveLength(
        3
      );
      expect(
        screen.getByTestId("playground-multi-model-compare-section")
      ).toHaveClass("hidden");
      const grid = screen.getByTestId("playground-multi-model-grid");
      expect(grid.className.includes("hidden")).toBe(false);
      expect(grid).toHaveClass("xl:grid-cols-3");
      expect(grid).not.toHaveClass("2xl:grid-cols-3");
      expect(
        screen.getByTestId("playground-trace-view-tabs")
      ).toBeInTheDocument();
      expect(screen.getAllByTestId("chat-input")).not.toHaveLength(0);
      expect(
        screen.queryByText(
          "Send a shared message to start this model’s thread."
        )
      ).not.toBeInTheDocument();
      expect(
        screen.getAllByPlaceholderText(DEFAULT_CHAT_COMPOSER_PLACEHOLDER)
      ).not.toHaveLength(0);
    });

    it("tracks the chip click with the compare location when multi-model is active", () => {
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

      fireEvent.click(screen.getByRole("button", { name: "Starter chip" }));

      const starterCalls = vi
        .mocked(track)
        .mock.calls.filter(
          ([event]) => event === "chat_starter_prompt_clicked"
        );
      expect(starterCalls).toEqual([
        [
          "chat_starter_prompt_clicked",
          { prompt: "Starter chip prompt", location: "playground_compare" },
        ],
      ]);
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
        />
      );

      fireEvent.click(screen.getByText("Trace"));

      expect(
        screen.getByTestId("playground-multi-empty-trace-pending")
      ).toBeInTheDocument();
      expect(
        screen.getByTestId("playground-multi-model-compare-section")
      ).toHaveClass("hidden");
      expect(
        screen.queryByText("Try one of these to get started")
      ).not.toBeInTheDocument();
    });
  });

  describe("single-model starter prompts", () => {
    it("shows starter prompt chips in the single-model empty state", () => {
      render(<PlaygroundMain {...defaultProps} />);

      expect(
        screen.getByText("Try one of these to get started")
      ).toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: "Starter chip" })
      ).toBeInTheDocument();
    });

    it("sends the starter prompt through the single-model chat on click", async () => {
      render(<PlaygroundMain {...defaultProps} />);

      fireEvent.click(screen.getByRole("button", { name: "Starter chip" }));

      await waitFor(() => {
        expect(mockUseChatSession.sendMessage).toHaveBeenCalledWith(
          expect.objectContaining({ text: "Starter chip prompt" })
        );
      });
    });

    it("tracks the chip click with the prompt and single-model location", () => {
      render(<PlaygroundMain {...defaultProps} />);

      fireEvent.click(screen.getByRole("button", { name: "Starter chip" }));

      // Filter by event name: the single-model click also fires
      // app_builder_send_message, so a bare call count would be racy.
      const starterCalls = vi
        .mocked(track)
        .mock.calls.filter(
          ([event]) => event === "chat_starter_prompt_clicked"
        );
      expect(starterCalls).toEqual([
        [
          "chat_starter_prompt_clicked",
          { prompt: "Starter chip prompt", location: "playground_single" },
        ],
      ]);
    });

    it("hides starter chips when the welcome hero is suppressed", () => {
      render(<PlaygroundMain {...defaultProps} hideWelcomeHero />);

      expect(
        screen.queryByText("Try one of these to get started")
      ).not.toBeInTheDocument();
    });

    it("hides starter chips when the auth upsell is active", () => {
      mockUseChatSession.disableForAuthentication = true;

      render(<PlaygroundMain {...defaultProps} />);

      expect(
        screen.queryByText("Try one of these to get started")
      ).not.toBeInTheDocument();
    });

    it("clears staged skill results after a starter chip send", async () => {
      render(<PlaygroundMain {...defaultProps} />);

      fireEvent.click(screen.getByTestId("chat-input-attach-skill"));
      expect(screen.getByTestId("chat-input")).toHaveAttribute(
        "data-skill-count",
        "1"
      );

      fireEvent.click(screen.getByRole("button", { name: "Starter chip" }));

      await waitFor(() => {
        expect(mockUseChatSession.sendMessage).toHaveBeenCalled();
      });
      await waitFor(() => {
        expect(screen.getByTestId("chat-input")).toHaveAttribute(
          "data-skill-count",
          "0"
        );
      });
    });

    it("does not replay a single-model send into compare cards mounted later", async () => {
      const { rerender } = render(
        <PlaygroundMain {...defaultProps} enableMultiModelChat={true} />
      );

      fireEvent.click(screen.getByRole("button", { name: "Starter chip" }));
      await waitFor(() => {
        expect(mockUseChatSession.sendMessage).toHaveBeenCalled();
      });

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
      rerender(
        <PlaygroundMain {...defaultProps} enableMultiModelChat={true} />
      );

      await waitFor(() => {
        expect(
          screen.getAllByTestId("multi-model-playground-card")
        ).toHaveLength(2);
      });

      const staleRequests = mockMultiModelPlaygroundCard.mock.calls
        .map(([props]) => props.broadcastRequest)
        .filter(Boolean);
      expect(staleRequests).toEqual([]);
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
        "true"
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
          "Try a prompt that could call your tools..."
        )
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
        />
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
          expect.objectContaining({ text: "Hello from playground" })
        );
      });
    });

    it("injects an explicitly attached skill into the turn (INS-4)", async () => {
      // An attached skill is turn CONTENT. Playground built no skill messages,
      // so the skill silently evaporated on send — and a skill-only send did
      // not count as content at all.
      render(<PlaygroundMain {...defaultProps} />);

      fireEvent.click(screen.getByTestId("chat-input-attach-skill"));
      fireEvent.click(screen.getByTestId("chat-submit-button"));

      await waitFor(() => {
        expect(mockUseChatSession.setMessages).toHaveBeenCalled();
      });
      // The prepend lands in the thread BEFORE the user turn, so the request
      // carries it as history instead of trailing the model's answer.
      const updater = mockUseChatSession.setMessages.mock.calls.at(-1)![0];
      const next = typeof updater === "function" ? updater([]) : updater;
      expect(JSON.stringify(next)).toContain("release-notes");
      expect(mockUseChatSession.sendMessage).toHaveBeenCalled();
    });

    it("shows the guided prompt in the input when post-connect onboarding is active", () => {
      render(
        <PlaygroundMain
          {...defaultProps}
          showPostConnectGuide={true}
          initialInput="Draw me an MCP architecture diagram"
        />
      );

      expect(screen.getByTestId("chat-input-field")).toHaveValue(
        "Draw me an MCP architecture diagram"
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
        />
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
        />
      );

      expect(screen.getByTestId("chat-submit-button")).toHaveAttribute(
        "data-pulsing",
        "true"
      );

      fireEvent.change(screen.getByTestId("chat-input-field"), {
        target: { value: "User edit" },
      });

      expect(screen.getByTestId("chat-submit-button")).toHaveAttribute(
        "data-pulsing",
        "false"
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
        />
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
        />
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
        />
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
        />
      );

      const hint = screen.getByTestId("playground-send-nux-hint");
      const chatInput = screen.getByTestId("chat-input");
      expect(hint).toHaveTextContent(
        "Try this prompt with Excalidraw and compare across clients"
      );
      expect(hint.closest('[data-testid="chat-input"]')).toBeNull();
      expect(
        chatInput.compareDocumentPosition(hint) &
          Node.DOCUMENT_POSITION_FOLLOWING
      ).toBeTruthy();
      expect(hint.querySelector("svg")).toBeTruthy();
    });

    it("keeps Playground send NUX hint visible after server connects", () => {
      mockSharedAppState.servers["test-server"] = {
        connectionStatus: "connected",
      };

      render(
        <PlaygroundMain
          {...defaultProps}
          initialInput="Draw me an MCP architecture diagram"
          initialInputTypewriter={true}
          blockSubmitUntilServerConnected={true}
        />
      );

      expect(screen.getByTestId("playground-send-nux-hint")).toHaveTextContent(
        "Try this prompt with Excalidraw and compare across clients"
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
        />
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
        />
      );

      act(() => {
        capturedChatSessionOptions.onReset();
      });

      expect(screen.getByTestId("chat-input-field")).toHaveValue(
        "Draw me an MCP architecture diagram"
      );
    });

    it("stops the onboarding pulse after the user edits the prefilled prompt", () => {
      render(
        <PlaygroundMain
          {...defaultProps}
          showPostConnectGuide={true}
          initialInput="Draw me an MCP architecture diagram"
          pulseSubmit={true}
        />
      );

      expect(screen.getByTestId("chat-submit-button")).toHaveAttribute(
        "data-pulsing",
        "true"
      );

      fireEvent.change(screen.getByTestId("chat-input-field"), {
        target: { value: "Draw me a sequence diagram instead" },
      });

      expect(screen.getByTestId("chat-submit-button")).toHaveAttribute(
        "data-pulsing",
        "false"
      );
    });

    it("stops preserving the guided prompt once the user edits it", () => {
      render(
        <PlaygroundMain
          {...defaultProps}
          showPostConnectGuide={true}
          initialInput="Draw me an MCP architecture diagram"
        />
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
        screen.getByPlaceholderText("Sign in to use chat")
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
        screen.getAllByPlaceholderText("Sign in to use free chat").length
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
        />
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
        />
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
        "Something went wrong"
      );
    });
  });

  describe("clear chat", () => {
    // Set by the URL test below, which swaps in a `resetChat` that fires the
    // reset chain. Undone in `afterEach` so it cannot leak into another test.
    let restoreResetChat: (() => void) | null = null;

    it("shows clear button when thread has messages", () => {
      mockUseChatSession.messages = [
        { id: "1", role: "user", parts: [{ type: "text", text: "Hello" }] },
      ];

      render(<PlaygroundMain {...defaultProps} />);

      // Find the "Clear chat" restart-session button
      const clearButton = screen.queryByRole("button", { name: "Clear chat" });
      expect(clearButton).not.toBeNull();
    });

    it("does not show clear button when thread is empty", () => {
      mockUseChatSession.messages = [];

      render(<PlaygroundMain {...defaultProps} />);

      // Should not have the "Clear chat" button
      const clearButton = screen.queryByRole("button", { name: "Clear chat" });
      expect(clearButton).toBeNull();
    });

    /**
     * Clearing mints a fresh `chatSessionId`, so the next turn persists to a
     * NEW history row. Staying attached to the thread the user had open leaves
     * the post-stream reconciliation checking a baseline this session can never
     * advance, and it detaches with a false "This chat changed elsewhere"
     * toast (BUGS-22).
     */
    it("detaches the open saved thread when the chat is cleared", async () => {
      const savedSession = {
        _id: "history-clear-1",
        chatSessionId: "chat-session-clear-1",
        firstMessagePreview: "Hello",
        status: "active" as const,
        directVisibility: "private" as const,
        messageCount: 2,
        version: 4,
        startedAt: 1,
        lastActivityAt: 1,
        isPinned: false,
        manualUnread: false,
        isUnread: false,
        messagesBlobUrl: "https://storage.test/blob",
        resumeConfig: { selectedServers: ["test-server"] },
      };
      mockGetChatHistoryDetail.mockResolvedValue({
        ok: true,
        session: savedSession,
        widgetSnapshots: [],
      });
      mockUseChatSession.messages = [
        { id: "1", role: "user", parts: [{ type: "text", text: "Hello" }] },
      ];
      // The resume cursor a send-time conflict baseline would be built from.
      mockUseChatSession.resumedVersion = savedSession.version;

      render(<PlaygroundMain {...defaultProps} />);

      await waitFor(() => {
        expect(usePlaygroundChatHistoryBridgeStore.getState().bridge).not.toBe(
          null
        );
      });

      await act(async () => {
        const bridge = usePlaygroundChatHistoryBridgeStore.getState().bridge;
        await Promise.resolve(bridge?.onSelectThread(savedSession));
      });
      await waitFor(() => {
        expect(
          usePlaygroundChatHistoryBridgeStore.getState().bridge?.activeSessionId
        ).toBe(savedSession._id);
      });

      const clearButton = screen.getByRole("button", { name: "Clear chat" });
      fireEvent.click(clearButton);
      fireEvent.click(
        within(screen.getByTestId("confirm-dialog")).getByRole("button", {
          name: "Confirm",
        })
      );

      await waitFor(() => {
        expect(
          usePlaygroundChatHistoryBridgeStore.getState().bridge?.activeSessionId
        ).toBe(null);
      });
      expect(mockUseChatSession.resetChat).toHaveBeenCalled();
      // The next turn must ship no `expectedVersion`, or the fresh row's first
      // ingest 409s against a version that belongs to the abandoned thread.
      expect(mockUseChatSession.syncResumedVersion).toHaveBeenCalledWith(null);
    });

    /**
     * Guards the interaction between the detach above and the conversation URL.
     *
     * The restore effect in `use-playground-conversation-url.ts` is held back by
     * two conditions:
     *
     *     if (activeHistorySessionId) return;
     *     if (hasMessages) return;
     *
     * Clearing drops BOTH at once — it detaches the thread and empties the
     * transcript. If `?conversation=` still named the cleared thread at that
     * moment, the restore effect would refetch it and put it straight back, so
     * clearing would appear to do nothing.
     *
     * It is safe today only because `resetChat()` fires `onReset("reset")`,
     * which calls `clearConversationUrlRef`, and the param mask is synchronous
     * so no render sees the gap. That is an ordering dependency between two
     * functions with nothing linking them, which is exactly the shape of bug
     * this pins: reorder the calls in `handleResetAllChats`, or change the reset
     * reason, and clearing a chat starts reloading it.
     */
    it("drops the cleared conversation from the URL so the restore effect cannot bring it back", async () => {
      const savedSession = {
        _id: "history-clear-url",
        chatSessionId: "chat-session-clear-url",
        firstMessagePreview: "Hello",
        status: "active" as const,
        directVisibility: "private" as const,
        messageCount: 2,
        version: 4,
        startedAt: 1,
        lastActivityAt: 1,
        isPinned: false,
        manualUnread: false,
        isUnread: false,
        messagesBlobUrl: "https://storage.test/blob",
        resumeConfig: { selectedServers: ["test-server"] },
      };
      mockGetChatHistoryDetail.mockResolvedValue({
        ok: true,
        session: savedSession,
        widgetSnapshots: [],
      });
      mockUseChatSession.messages = [
        { id: "1", role: "user", parts: [{ type: "text", text: "Hello" }] },
      ];
      // The live session IS the one the URL names — the hook's own invariant,
      // "restored <=> chatSessionId === param". Without it the sync effect
      // overwrites the param on the first render and the setup never reaches
      // the state under test.
      mockUseChatSession.chatSessionId = savedSession.chatSessionId;
      window.history.replaceState(
        {},
        "",
        `/playground?conversation=${savedSession.chatSessionId}`
      );

      // This file mocks the chat hook with a bare `vi.fn()` for `resetChat`, so
      // none of what the real one does happens. Three of those matter here, and
      // leaving any out makes the URL behave for reasons unrelated to the code
      // under test: it empties the transcript, mints a fresh `chatSessionId`,
      // and fires `onReset("reset")` (`use-chat-session.ts:3379`) — the only
      // thing that reaches `clearConversationUrlRef`.
      //
      // Only the hook's own behaviour is faked. `onReset` is the component's
      // real implementation, so "a reset drops the conversation param" and "the
      // sync effect does not put the old id back" are both genuinely tested.
      const bareResetChat = mockUseChatSession.resetChat;
      restoreResetChat = () => {
        mockUseChatSession.resetChat = bareResetChat;
      };
      mockUseChatSession.resetChat = vi.fn(() => {
        mockUseChatSession.messages = [];
        mockUseChatSession.chatSessionId = "chat-session-minted-after-clear";
        capturedChatSessionOptions?.onReset?.("reset");
      });

      render(<PlaygroundMain {...defaultProps} syncConversationToUrl />);

      await waitFor(() => {
        expect(usePlaygroundChatHistoryBridgeStore.getState().bridge).not.toBe(
          null
        );
      });

      await act(async () => {
        const bridge = usePlaygroundChatHistoryBridgeStore.getState().bridge;
        await Promise.resolve(bridge?.onSelectThread(savedSession));
      });
      await waitFor(() => {
        expect(
          usePlaygroundChatHistoryBridgeStore.getState().bridge?.activeSessionId
        ).toBe(savedSession._id);
      });

      // Guard against a vacuous pass: the param has to be there to be dropped.
      expect(window.location.search).toContain(savedSession.chatSessionId);

      const clearButton = screen.getByRole("button", { name: "Clear chat" });
      fireEvent.click(clearButton);
      fireEvent.click(
        within(screen.getByTestId("confirm-dialog")).getByRole("button", {
          name: "Confirm",
        })
      );

      await waitFor(() => {
        expect(window.location.search).not.toContain(
          savedSession.chatSessionId
        );
      });
    });

    afterEach(() => {
      // `window.location` is shared across tests, and the URL test above
      // navigates.
      window.history.replaceState({}, "", "/");
      invalidateChatHistoryPrefetch();
      restoreResetChat?.();
      restoreResetChat = null;
    });
  });

  describe("device type", () => {
    it("renders with default mobile device type", () => {
      render(<PlaygroundMain {...defaultProps} />);

      // Device controls are rendered by ClientContextHeader (mocked)
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

      // Locale controls are rendered by ClientContextHeader (mocked)
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
        />
      );

      await waitFor(() => {
        expect(onExecutionInjected).toHaveBeenCalled();
      });
    });
  });

  // BACK2-628. The selected-model sanitize effect ends in
  // `setSelectedModelIds`, which persists the lead model id
  // (`use-persisted-model.ts:150-159`) under a key shared by every chat
  // surface. Playground is the surface that actually turns compare mode on,
  // and it renders both the real Playground and the eval live-chat panel, so a
  // clobber here destroys the selection the hosted scenario reads back.
  describe("selected-model persistence", () => {
    const LEAD_KEY = "mcp-inspector-selected-model";
    const OWN_PROVIDER_MODEL_ID = "claude-haiku-4-5";
    const originalSetSelectedModelIds = mockUseChatSession.setSelectedModelIds;

    beforeEach(() => {
      // Assert on the key that actually gets clobbered rather than on a spy
      // standing in for it.
      mockUseChatSession.setSelectedModelIds = vi.fn((modelIds: string[]) => {
        saveSelectedModelId(modelIds[0] ?? null);
      });
    });

    afterEach(() => {
      mockUseChatSession.setSelectedModelIds = originalSetSelectedModelIds;
    });

    it("does not persist the derived fallback while the selection is unresolved", () => {
      localStorage.setItem(LEAD_KEY, OWN_PROVIDER_MODEL_ID);
      // The org-managed provider config is still in flight: the persisted id
      // is absent from `availableModels`, so `selectedModel` is only
      // `getDefaultModel`'s fallback.
      Object.assign(mockUseChatSession, {
        isSelectedModelResolved: false,
        selectedModel: {
          id: "claude-fable-5",
          name: "Claude Fable 5",
          provider: "anthropic",
        },
        availableModels: [
          {
            id: "claude-fable-5",
            name: "Claude Fable 5",
            provider: "anthropic",
          },
          { id: "gpt-5-mini", name: "GPT-5 Mini", provider: "openai" },
        ],
        selectedModelIds: [OWN_PROVIDER_MODEL_ID],
        multiModelEnabled: true,
      });

      render(<PlaygroundMain {...defaultProps} enableMultiModelChat={true} />);

      expect(localStorage.getItem(LEAD_KEY)).toBe(OWN_PROVIDER_MODEL_ID);
      expect(mockUseChatSession.setSelectedModelIds).not.toHaveBeenCalled();
    });

    // Same window, but with the multi-model gate closed — this is the branch
    // that fires on a surface which never offers compare, because
    // `multiModelEnabled` is stored under one global key.
    it("does not persist the derived fallback when resetting a stale multi-model toggle", () => {
      localStorage.setItem(LEAD_KEY, OWN_PROVIDER_MODEL_ID);
      Object.assign(mockUseChatSession, {
        isSelectedModelResolved: false,
        selectedModel: {
          id: "claude-fable-5",
          name: "Claude Fable 5",
          provider: "anthropic",
        },
        selectedModelIds: [OWN_PROVIDER_MODEL_ID],
        multiModelEnabled: true,
      });

      // No `enableMultiModelChat` ⇒ `canEnableMultiModel` is false.
      render(<PlaygroundMain {...defaultProps} />);

      expect(localStorage.getItem(LEAD_KEY)).toBe(OWN_PROVIDER_MODEL_ID);
      expect(mockUseChatSession.setMultiModelEnabled).not.toHaveBeenCalled();
    });

    it("sanitizes once the selection has resolved", () => {
      Object.assign(mockUseChatSession, {
        isSelectedModelResolved: true,
        selectedModel: {
          id: OWN_PROVIDER_MODEL_ID,
          name: "Claude Haiku 4.5",
          provider: "anthropic",
        },
        selectedModelIds: ["stale-model"],
        multiModelEnabled: false,
      });

      render(<PlaygroundMain {...defaultProps} />);

      expect(mockUseChatSession.setSelectedModelIds).toHaveBeenCalledWith([
        OWN_PROVIDER_MODEL_ID,
      ]);
      expect(localStorage.getItem(LEAD_KEY)).toBe(OWN_PROVIDER_MODEL_ID);
    });
  });

  /**
   * A conversation restored from `?conversation=` carries a model id, but the
   * model catalog loads independently and can arrive afterwards. The deferred
   * apply therefore has to remember WHICH conversation asked for that model.
   */
  describe("restored model applied late", () => {
    const RESTORED_SESSION_ID = "restored-chat-session";
    const LATE_MODEL = {
      id: "late-model",
      name: "Late Model",
      provider: "openai",
      contextWindow: 8192,
      maxOutputTokens: 4096,
      supportsTools: true,
      supportsVision: false,
      supportsStreaming: true,
    };

    const arriveAtRestoredConversation = () => {
      window.history.replaceState(
        {},
        "",
        `/playground?conversation=${RESTORED_SESSION_ID}`
      );
      mockGetChatHistoryDetail.mockResolvedValue({
        ok: true,
        session: {
          _id: "history-restored",
          chatSessionId: RESTORED_SESSION_ID,
          firstMessagePreview: "Hello",
          status: "active" as const,
          directVisibility: "private" as const,
          version: 3,
          createdAt: 1,
          updatedAt: 1,
          lastActivityAt: 1,
          isPinned: false,
          manualUnread: false,
          isUnread: false,
          messagesBlobUrl: "https://storage.test/blob",
          // The catalog is empty at restore time, so `loadChatSession` cannot
          // apply this and it becomes the deferred model.
          modelId: LATE_MODEL.id,
          resumeConfig: {},
        },
        widgetSnapshots: [],
      });
    };

    beforeEach(() => {
      // The detail cache is module-level and outlives a test, so without this
      // the second restore of the same id is served from the first test's
      // entry and never reaches the mock.
      invalidateChatHistoryPrefetch();
    });

    afterEach(() => {
      window.history.replaceState({}, "", "/");
      invalidateChatHistoryPrefetch();
    });

    it("applies the restored model when the catalog arrives", async () => {
      arriveAtRestoredConversation();

      const { rerender } = render(
        <PlaygroundMain {...defaultProps} syncConversationToUrl />
      );

      await waitFor(() => {
        expect(mockGetChatHistoryDetail).toHaveBeenCalledWith(
          expect.objectContaining({ chatSessionId: RESTORED_SESSION_ID })
        );
      });
      expect(mockUseChatSession.setSelectedModel).not.toHaveBeenCalled();

      // Hydration lands, then the catalog does.
      mockUseChatSession.chatSessionId = RESTORED_SESSION_ID;
      mockUseChatSession.availableModels = [LATE_MODEL];
      await act(async () => {
        rerender(<PlaygroundMain {...defaultProps} syncConversationToUrl />);
      });

      expect(mockUseChatSession.setSelectedModel).toHaveBeenCalledWith(
        LATE_MODEL
      );
    });

    it("does not retag a different thread opened before the catalog arrives", async () => {
      arriveAtRestoredConversation();

      const { rerender } = render(
        <PlaygroundMain {...defaultProps} syncConversationToUrl />
      );

      await waitFor(() => {
        expect(mockGetChatHistoryDetail).toHaveBeenCalledWith(
          expect.objectContaining({ chatSessionId: RESTORED_SESSION_ID })
        );
      });

      // The user moves to another thread while the catalog is still loading.
      mockUseChatSession.chatSessionId = "some-other-session";
      mockUseChatSession.availableModels = [LATE_MODEL];
      await act(async () => {
        rerender(<PlaygroundMain {...defaultProps} syncConversationToUrl />);
      });

      // Applying it now would silently switch THEIR thread to the restored
      // conversation's model.
      expect(mockUseChatSession.setSelectedModel).not.toHaveBeenCalled();

      // And the stale pending model must not linger to fire later either.
      mockUseChatSession.chatSessionId = "yet-another-session";
      await act(async () => {
        rerender(<PlaygroundMain {...defaultProps} syncConversationToUrl />);
      });
      expect(mockUseChatSession.setSelectedModel).not.toHaveBeenCalled();
    });
  });
  /**
   * A reopened conversation renders under the viewer's AMBIENT host and
   * environment — those live in per-project browser storage, not on the
   * session — so the composer describes the viewer, not the chat. Left
   * unlabelled that reads as history, and the reply goes to whatever is
   * selected: a Cursor-harness transcript answering as Claude.
   */
  describe("as-run execution target", () => {
    const RESTORED_SESSION_ID = "restored-target-session";

    const arriveAtRestoredConversation = (
      resumeConfig: Record<string, unknown>
    ) => {
      window.history.replaceState(
        {},
        "",
        `/playground?conversation=${RESTORED_SESSION_ID}`
      );
      mockGetChatHistoryDetail.mockResolvedValue({
        ok: true,
        session: {
          _id: "history-restored-target",
          chatSessionId: RESTORED_SESSION_ID,
          firstMessagePreview: "what harness are you",
          status: "active" as const,
          directVisibility: "private" as const,
          version: 3,
          createdAt: 1,
          updatedAt: 1,
          lastActivityAt: 1,
          isPinned: false,
          manualUnread: false,
          isUnread: false,
          messagesBlobUrl: "https://storage.test/blob",
          resumeConfig,
        },
        widgetSnapshots: [],
      });
    };

    /**
     * Open the conversation and let the chat hook adopt its session id, which
     * is what binds the disclosure to the thread on screen.
     */
    const openRestoredConversation = async (
      resumeConfig: Record<string, unknown>,
      extraProps: Record<string, unknown> = {}
    ) => {
      arriveAtRestoredConversation(resumeConfig);
      const props = { ...defaultProps, ...extraProps };
      const { rerender: rerenderRaw } = render(
        <PlaygroundMain {...props} syncConversationToUrl />
      );
      await waitFor(() => {
        expect(mockGetChatHistoryDetail).toHaveBeenCalledWith(
          expect.objectContaining({ chatSessionId: RESTORED_SESSION_ID })
        );
      });
      mockUseChatSession.chatSessionId = RESTORED_SESSION_ID;
      // Keeps the caller's props on every re-render, so a test that entered
      // via `displayMode: "fullscreen"` does not silently fall back to the
      // docked composer on the next flush.
      const rerender = () =>
        rerenderRaw(<PlaygroundMain {...props} syncConversationToUrl />);
      await act(async () => {
        rerender();
      });
      return { rerender };
    };

    beforeEach(() => {
      invalidateChatHistoryPrefetch();
      // The bridge is a module-level store; a request left pending by one test
      // would fire on the next one's first render.
      useAgentToolPromptBridge.setState({ pending: null });
    });

    afterEach(() => {
      window.history.replaceState({}, "", "/");
      invalidateChatHistoryPrefetch();
      useAgentToolPromptBridge.setState({ pending: null });
      // Module-level store, not reset by the global `beforeEach`; the overlay
      // tests below change it and every other test assumes the default.
      mockUIPlaygroundStore.deviceType = "mobile";
    });

    it("says nothing about a live chat the user started here", () => {
      render(<PlaygroundMain {...defaultProps} syncConversationToUrl />);

      expect(
        screen.queryByTestId("conversation-target-notice")
      ).not.toBeInTheDocument();
      expect(screen.getByTestId("chat-submit-button")).not.toBeDisabled();
    });

    it("discloses that a reopened conversation recorded no target, instead of passing the current selection off as history", async () => {
      // The shape every `origin: "playground"` row has: prompt/servers, no
      // host and no environment anywhere on the session.
      await openRestoredConversation({ selectedServers: ["deepwiki"] });

      const notice = await screen.findByTestId("conversation-target-notice");
      expect(notice).toHaveAttribute("data-disclosure", "unrecorded");
      expect(notice.textContent).toContain("As-run configuration unavailable");
    });

    it("blocks the reply until the user accepts the target it will actually run on", async () => {
      await openRestoredConversation({ selectedServers: ["deepwiki"] });

      await screen.findByTestId("conversation-target-notice");
      expect(screen.getByTestId("chat-submit-button")).toBeDisabled();

      fireEvent.click(
        screen.getByTestId("conversation-target-notice-acknowledge")
      );

      await waitFor(() => {
        expect(
          screen.queryByTestId("conversation-target-notice")
        ).not.toBeInTheDocument();
      });
      expect(screen.getByTestId("chat-submit-button")).not.toBeDisabled();
    });

    it("refuses the send outright, not just the button, while the target is unaccepted", async () => {
      await openRestoredConversation({ selectedServers: ["deepwiki"] });
      await screen.findByTestId("conversation-target-notice");

      fireEvent.change(screen.getByTestId("chat-input-field"), {
        target: { value: "what harness are you" },
      });
      fireEvent.submit(screen.getByTestId("chat-input"));

      await act(async () => {});
      expect(mockUseChatSession.sendMessage).not.toHaveBeenCalled();
    });

    it("holds a widget-driven follow-up to the same gate", async () => {
      // A widget follow-up bypasses the composer entirely, so a disabled Send
      // button is no protection: it would be the first thing to run on a
      // target the transcript never used.
      const { rerender } = await openRestoredConversation({
        selectedServers: ["deepwiki"],
      });
      mockUseChatSession.messages = [
        { id: "m1", role: "user", parts: [{ type: "text", text: "hi" }] },
      ] as any;
      await act(async () => {
        rerender();
      });

      const sendFollowUpMessage =
        mockThread.mock.calls.at(-1)?.[0].sendFollowUpMessage;
      expect(sendFollowUpMessage).toBeDefined();
      await act(async () => {
        sendFollowUpMessage("follow up from a widget");
      });

      expect(mockUseChatSession.sendMessage).not.toHaveBeenCalled();
    });

    // Every remaining way to start a turn. A gate that only covers the
    // composer is theatre: each of these reaches `sendMessage`,
    // `queueBroadcastRequest` or `rewindToMessage` without the composer's
    // Send button ever being pressed.
    it("holds a starter chip to the same gate, and keeps its prompt as a draft", async () => {
      // A chip is a one-click SEND from the empty state — the shortest path of
      // all to running a reopened conversation on the wrong target.
      await openRestoredConversation({ selectedServers: ["deepwiki"] });
      await screen.findByTestId("conversation-target-notice");

      fireEvent.click(screen.getByRole("button", { name: "Starter chip" }));
      await act(async () => {});

      expect(mockUseChatSession.sendMessage).not.toHaveBeenCalled();
      // Refused, not discarded: the text is waiting in the composer.
      expect(screen.getByTestId("chat-input-field")).toHaveValue(
        "Starter chip prompt",
      );
    });

    it("lets the starter chip through once the target is accepted", async () => {
      // The other half of the gate: it has to open, or the disclosure is a
      // dead end rather than a decision.
      await openRestoredConversation({ selectedServers: ["deepwiki"] });
      await screen.findByTestId("conversation-target-notice");

      fireEvent.click(
        screen.getByTestId("conversation-target-notice-acknowledge"),
      );
      await waitFor(() => {
        expect(
          screen.queryByTestId("conversation-target-notice"),
        ).not.toBeInTheDocument();
      });

      fireEvent.click(screen.getByRole("button", { name: "Starter chip" }));

      await waitFor(() => {
        expect(mockUseChatSession.sendMessage).toHaveBeenCalledWith(
          expect.objectContaining({ text: "Starter chip prompt" }),
        );
      });
    });

    it("holds an 'Ask agent to run' prompt to the same gate, and keeps it as a draft", async () => {
      // The Tools rail requests this send from a sibling subtree through the
      // bridge store, so a disabled Send button is no protection at all.
      await openRestoredConversation({ selectedServers: ["deepwiki"] });
      await screen.findByTestId("conversation-target-notice");

      await act(async () => {
        useAgentToolPromptBridge
          .getState()
          .requestRun("Run read_file on /etc/hosts");
      });
      await act(async () => {});

      expect(mockUseChatSession.sendMessage).not.toHaveBeenCalled();
      expect(screen.getByTestId("chat-input-field")).toHaveValue(
        "Run read_file on /etc/hosts",
      );
    });

    it("will not rewind a reopened conversation, and shows the edit action as unavailable", async () => {
      // A rewind is a send AND a fork: it would run the edited turn on the
      // ambient target and mint a branch recording that it did.
      mockConvexAuthState.isAuthenticated = true;
      const { rerender } = await openRestoredConversation({
        selectedServers: ["deepwiki"],
      });
      mockUseChatSession.messages = [
        { id: "1", role: "user", parts: [{ type: "text", text: "hi" }] },
      ] as any;
      await act(async () => {
        rerender();
      });
      await screen.findByTestId("conversation-target-notice");

      // Disabled, not merely inert: the affordance says so before it is used.
      expect(screen.getByTestId("edit-first-message")).toBeDisabled();

      // And the handler refuses even when invoked directly, which is what the
      // real `UserMessageRow` does fire-and-forget from its editor.
      const onEditUserMessage =
        mockThread.mock.calls.at(-1)?.[0].onEditUserMessage;
      expect(onEditUserMessage).toBeDefined();
      await act(async () => {
        await onEditUserMessage(mockUseChatSession.messages[0], "edited");
      });

      expect(mockUseChatSession.rewindToMessage).not.toHaveBeenCalled();
    });

    /**
     * The gate must never be reachable from a surface that cannot lift it.
     * Disabling Send while the only "Continue here" button lives in a composer
     * the layout has hidden is a worse failure than the one the gate prevents:
     * it has no exit.
     */
    describe("surfaces that replace the docked composer", () => {
      /**
       * `displayMode` reaches the component through the host-context draft,
       * not the prop: `extractEffectiveHostDisplayMode` always resolves to a
       * concrete mode (defaulting to "inline"), so the prop's `??` fallback
       * never fires. Every layout below is entered through the store.
       */
      const setHostDisplayMode = (mode: string) => {
        useHostContextStore.setState({
          draftHostContext: { displayMode: mode },
        });
      };

      /** Widget fullscreen on a desktop-ish frame swaps in the pinned overlay. */
      const enterFullscreenOverlay = async (
        rerender: () => void,
      ): Promise<void> => {
        mockUseChatSession.messages = [
          { id: "m1", role: "user", parts: [{ type: "text", text: "hi" }] },
        ] as any;
        await act(async () => {
          rerender();
        });
        const onFullscreenChange =
          mockThread.mock.calls.at(-1)?.[0].onFullscreenChange;
        expect(onFullscreenChange).toBeDefined();
        await act(async () => {
          onFullscreenChange(true);
        });
      };

      it("moves the acknowledgement into the fullscreen overlay instead of stranding it in the hidden composer", async () => {
        mockUIPlaygroundStore.deviceType = "fill";
        setHostDisplayMode("fullscreen");
        const { rerender } = await openRestoredConversation({
          selectedServers: ["deepwiki"],
        });
        await screen.findByTestId("conversation-target-notice");

        await enterFullscreenOverlay(rerender);

        // The docked composer really is gone — this is what made it a dead end.
        expect(screen.getByTestId("fullscreen-overlay")).toBeInTheDocument();
        expect(screen.queryByTestId("chat-input")).not.toBeInTheDocument();

        // ...and the notice moved with it, rather than disappearing.
        const notice = screen.getByTestId("conversation-target-notice");
        expect(screen.getByTestId("fullscreen-overlay")).toContainElement(
          notice,
        );
        expect(screen.getByTestId("fullscreen-overlay-send")).toBeDisabled();
      });

      it("sends from the overlay once its own acknowledgement is used", async () => {
        // The "gate opens" direction: the overlay is a decision point, not a
        // trap. Without a reachable control this test cannot even be written.
        mockUIPlaygroundStore.deviceType = "fill";
        setHostDisplayMode("fullscreen");
        const { rerender } = await openRestoredConversation({
          selectedServers: ["deepwiki"],
        });
        await screen.findByTestId("conversation-target-notice");
        await enterFullscreenOverlay(rerender);

        fireEvent.click(
          screen.getByTestId("conversation-target-notice-acknowledge"),
        );
        await waitFor(() => {
          expect(
            screen.queryByTestId("conversation-target-notice"),
          ).not.toBeInTheDocument();
        });

        fireEvent.change(screen.getByTestId("fullscreen-overlay-input"), {
          target: { value: "continue here" },
        });
        await waitFor(() => {
          expect(
            screen.getByTestId("fullscreen-overlay-send"),
          ).not.toBeDisabled();
        });
        fireEvent.click(screen.getByTestId("fullscreen-overlay-send"));

        await waitFor(() => {
          expect(mockUseChatSession.sendMessage).toHaveBeenCalledWith(
            expect.objectContaining({ text: "continue here" }),
          );
        });
      });

      it("pins the acknowledgement over a widget full takeover, which renders no composer at all", async () => {
        // Mobile/tablet fullscreen hides the footer composer AND forbids the
        // overlay, yet a widget can still request a follow-up — which the gate
        // refuses. Nothing on screen would lift it without this.
        mockUIPlaygroundStore.deviceType = "mobile";
        setHostDisplayMode("fullscreen");
        const { rerender } = await openRestoredConversation({
          selectedServers: ["deepwiki"],
        });
        mockUseChatSession.messages = [
          { id: "m1", role: "user", parts: [{ type: "text", text: "hi" }] },
        ] as any;
        await act(async () => {
          rerender();
        });

        expect(screen.queryByTestId("chat-input")).not.toBeInTheDocument();
        expect(
          screen.queryByTestId("fullscreen-overlay"),
        ).not.toBeInTheDocument();

        const pinned = await screen.findByTestId(
          "pinned-conversation-target-notice",
        );
        expect(pinned).toContainElement(
          screen.getByTestId("conversation-target-notice"),
        );

        // A widget follow-up is refused until it is used, and goes through after.
        const sendFollowUpMessage =
          mockThread.mock.calls.at(-1)?.[0].sendFollowUpMessage;
        await act(async () => {
          sendFollowUpMessage("follow up from a widget");
        });
        expect(mockUseChatSession.sendMessage).not.toHaveBeenCalled();

        fireEvent.click(
          screen.getByTestId("conversation-target-notice-acknowledge"),
        );
        await waitFor(() => {
          expect(
            screen.queryByTestId("pinned-conversation-target-notice"),
          ).not.toBeInTheDocument();
        });
        await act(async () => {
          sendFollowUpMessage("follow up from a widget");
        });
        await waitFor(() => {
          expect(mockUseChatSession.sendMessage).toHaveBeenCalledWith(
            expect.objectContaining({ text: "follow up from a widget" }),
          );
        });
      });
    });

    it("names the environment a conversation pinned when the composer points elsewhere", async () => {
      // `resumeConfig.environmentId` is the one execution target that IS
      // persisted (Agent Playground turns pin it), and the browser ignored it.
      await openRestoredConversation({ environmentId: "env_recorded" });

      const notice = await screen.findByTestId("conversation-target-notice");
      expect(notice).toHaveAttribute("data-disclosure", "mismatch");
      expect(notice.textContent).toContain("env_recorded");
    });
  });
});
