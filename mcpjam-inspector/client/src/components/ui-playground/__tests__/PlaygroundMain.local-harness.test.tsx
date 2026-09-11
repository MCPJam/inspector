import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import { PlaygroundMain } from "../PlaygroundMain";
import { useHostContextStore } from "@/stores/client-context-store";
import { usePlaygroundChatHistoryBridgeStore } from "@/components/playground/playground-chat-history-bridge";

/**
 * The composer's side of local Claude Code.
 *
 * The controller has its own suite; what is under test HERE is the wiring, and
 * every case is one the plan calls out because getting it wrong is expensive:
 * a chip that appears on a host that cannot run locally, a first Send that
 * downloads 200 MB without asking, a Cancel that leaves the draft consumed or
 * an install running, a cold completion that fires a prompt the user typed
 * minutes ago, and a Send disabled for missing consent — which would make
 * first-send setup unreachable, since both Enter and the button are refused
 * before `onSubmit` ever runs.
 */

const mockLocalHarness = vi.hoisted(() => ({
  state: {
    requestedTarget: "local-native" as string | null,
    effectiveTarget: "hosted",
    phase: "needs-consent" as string,
    reason: null as string | null,
    availability: {
      available: true,
      status: "ok",
      message: null,
      platform: "darwin",
      machineId: "mach_1",
      keyFingerprint: "fp",
      permissionProfile: "workspace-edits",
      policyVersion: "policy-1",
      runtime: null,
      runtimeStatus: { state: "absent", packVersion: "3.4.0" },
      runtimeRootConfigured: true,
      hostedAvailable: false,
      expectedPack: { packVersion: "3.4.0", treeDigest: "sha256:" + "a".repeat(64) },
      suggestedWorkspace: { displayRoot: "~/code/project" },
    } as unknown,
    loading: false,
    availabilityError: null,
    runtimeStatus: { state: "absent", packVersion: "3.4.0" } as unknown,
    statusFetchFailed: false,
    consent: null as unknown,
    workspace: { workspaceGrantId: "ws_1", displayRoot: "~/code/project" } as unknown,
    pendingApproval: null as unknown,
    hostedAvailable: false as boolean | null,
    select: vi.fn(),
    refresh: vi.fn(),
    chooseWorkspace: vi.fn(async () => ({ ok: true })),
    adoptWorkspace: vi.fn(),
    captureApproval: vi.fn(() => ({ attemptId: "approval_1" })),
    cancelApproval: vi.fn(),
    startInstall: vi.fn(async () => ({ ok: true, kind: "accepted" })),
    authorize: vi.fn(async () => ({ ok: true, consent: {} })),
    revoke: vi.fn(async () => {}),
    resolveSendTarget: vi.fn(() => null),
  },
}));
vi.mock("@/hooks/useLocalHarnessTarget", () => ({
  useLocalHarnessController: () => mockLocalHarness.state,
  useLocalHarnessRunsHere: () => false,
}));
vi.mock("@/hooks/useComputersEnabled", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("@/hooks/useComputersEnabled")
  >();
  return { ...actual, useLocalHarnessEnabled: () => true };
});
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


describe("PlaygroundMain — local Claude Code", () => {
  const defaultProps = {
    serverName: "test-server",
    pendingExecution: null,
    onExecutionInjected: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    mockConvexAuthState.isAuthenticated = true;
    mockHostQueryState.result = null;
    mockReactiveHistoryState.session = undefined;
    mockReactiveHistoryState.widgetSnapshots = undefined;
    // A Claude Code host: the only harness local execution is in scope for.
    mockHarnessState.harnessId = "claude-code";
    capturedChatSessionOptions = null;
    usePlaygroundChatHistoryBridgeStore.getState().setBridge(null);
    mockGetChatHistoryDetail.mockReset();
    mockChatHistoryAction.mockReset();
    mockChatHistoryAction.mockResolvedValue({ ok: true });
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
    mockSharedAppState.servers["test-server"] = { connectionStatus: "connected" };
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
      rewindToMessage: vi.fn(),
    });
    Object.assign(mockLocalHarness.state, {
      requestedTarget: "local-native",
      phase: "needs-consent",
      reason: null,
      loading: false,
      statusFetchFailed: false,
      consent: null,
      runtimeStatus: { state: "absent", packVersion: "3.4.0" },
      workspace: { workspaceGrantId: "ws_1", displayRoot: "~/code/project" },
      hostedAvailable: false,
    });
    mockChatInputProps.mockClear();
  });

  const chipData = () =>
    (mockChatInputProps.mock.calls.at(-1)?.[0] as { executionTarget?: unknown })
      ?.executionTarget as
      | { phase: string; hostedAvailable: boolean | null }
      | undefined;

  const type = (text: string) => {
    const input = screen.getByTestId("chat-input-field");
    fireEvent.change(input, { target: { value: text } });
  };

  const submit = async () => {
    await act(async () => {
      fireEvent.submit(screen.getByTestId("chat-input"));
    });
  };

  describe("the chip", () => {
    it("is offered on a Claude Code host", () => {
      render(<PlaygroundMain {...defaultProps} />);
      expect(chipData()).toMatchObject({ phase: "needs-consent" });
    });

    it("is not offered on another harness", () => {
      // Codex, and ordinary emulated chat, must not inherit a local
      // authorization requirement they can never satisfy.
      mockHarnessState.harnessId = "codex";
      render(<PlaygroundMain {...defaultProps} />);
      expect(chipData()).toBeUndefined();
    });

    it("is not offered on an ordinary model host", () => {
      mockHarnessState.harnessId = null;
      render(<PlaygroundMain {...defaultProps} />);
      expect(chipData()).toBeUndefined();
    });

    it("is not offered when the controller says this machine cannot", () => {
      mockLocalHarness.state.phase = "unavailable";
      mockLocalHarness.state.requestedTarget = null;
      render(<PlaygroundMain {...defaultProps} />);
      expect(chipData()).toBeUndefined();
    });

    it("explains a disabled Approve rather than leaving it dead", async () => {
      // A machine with no runtime pack built for it. The button cannot be
      // enabled, so the dialog has to say why — a disabled control with
      // nothing on screen is the failure this flow is arranged to avoid.
      (mockLocalHarness.state.availability as { expectedPack: unknown }).expectedPack =
        null;
      try {
        render(<PlaygroundMain {...defaultProps} />);
        type("pwd");
        await submit();
        expect(
          screen.getByTestId("local-harness-trust-blocked"),
        ).toHaveTextContent(/hasn't published a Claude Code runtime/);
        expect(screen.getByTestId("local-harness-trust-approve")).toBeDisabled();
      } finally {
        (
          mockLocalHarness.state.availability as { expectedPack: unknown }
        ).expectedPack = {
          packVersion: "3.4.0",
          treeDigest: "sha256:" + "a".repeat(64),
        };
      }
    });

    it("passes unknown cloud availability through rather than inventing one", () => {
      mockLocalHarness.state.hostedAvailable = null;
      mockLocalHarness.state.phase = "loading";
      render(<PlaygroundMain {...defaultProps} />);
      expect(chipData()).toMatchObject({ hostedAvailable: null });
    });
  });

  describe("the first send", () => {
    it("opens ONE dialog and downloads nothing", async () => {
      render(<PlaygroundMain {...defaultProps} />);
      type("pwd");
      await submit();

      expect(
        screen.getByTestId("local-harness-trust-dialog"),
      ).toBeInTheDocument();
      expect(mockLocalHarness.state.startInstall).not.toHaveBeenCalled();
      expect(mockLocalHarness.state.captureApproval).not.toHaveBeenCalled();
      // And no turn ran.
      expect(mockUseChatSession.sendMessage).not.toHaveBeenCalled();
    });

    it("deduplicates repeated Send gestures into one dialog", async () => {
      render(<PlaygroundMain {...defaultProps} />);
      type("pwd");
      await submit();
      await submit();
      await submit();
      expect(
        screen.getAllByTestId("local-harness-trust-dialog"),
      ).toHaveLength(1);
    });

    it("Cancel preserves the draft and starts nothing", async () => {
      render(<PlaygroundMain {...defaultProps} />);
      type("pwd");
      await submit();
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
      });

      expect(
        screen.queryByTestId("local-harness-trust-dialog"),
      ).not.toBeInTheDocument();
      expect(mockLocalHarness.state.startInstall).not.toHaveBeenCalled();
      expect(mockUseChatSession.sendMessage).not.toHaveBeenCalled();
      // The draft is still there: cancelling setup must not cost the prompt.
      expect(
        (screen.getByTestId("chat-input-field") as HTMLInputElement).value,
      ).toBe("pwd");
    });

    it("Send reopens the dialog after a cancel", async () => {
      render(<PlaygroundMain {...defaultProps} />);
      type("pwd");
      await submit();
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
      });
      await submit();
      expect(
        screen.getByTestId("local-harness-trust-dialog"),
      ).toBeInTheDocument();
    });
  });

  describe("Install & allow", () => {
    it("starts setup and does not send", async () => {
      render(<PlaygroundMain {...defaultProps} />);
      type("pwd");
      await submit();
      await act(async () => {
        fireEvent.click(screen.getByTestId("local-harness-trust-approve"));
      });

      expect(mockLocalHarness.state.captureApproval).toHaveBeenCalled();
      expect(mockLocalHarness.state.startInstall).toHaveBeenCalled();
      // COLD: no queued send. A prompt that fires itself after a download is
      // not what anybody pressed.
      expect(mockUseChatSession.sendMessage).not.toHaveBeenCalled();
      expect(
        (screen.getByTestId("chat-input-field") as HTMLInputElement).value,
      ).toBe("pwd");
    });

    it("reads 'Allow' and continues the send once when the runtime is warm", async () => {
      mockLocalHarness.state.runtimeStatus = {
        state: "ready",
        packVersion: "3.4.0",
      };
      render(<PlaygroundMain {...defaultProps} />);
      type("pwd");
      await submit();
      expect(screen.getByTestId("local-harness-trust-approve")).toHaveTextContent(
        "Allow",
      );

      await act(async () => {
        fireEvent.click(screen.getByTestId("local-harness-trust-approve"));
      });
      await waitFor(() =>
        expect(mockUseChatSession.sendMessage).toHaveBeenCalledTimes(1),
      );
      expect(mockLocalHarness.state.authorize).toHaveBeenCalledTimes(1);
      expect(mockLocalHarness.state.startInstall).not.toHaveBeenCalled();
    });

    it("does not send when a warm authorization fails", async () => {
      mockLocalHarness.state.runtimeStatus = {
        state: "ready",
        packVersion: "3.4.0",
      };
      mockLocalHarness.state.authorize = vi.fn(async () => ({
        ok: false,
        kind: "conflict",
        status: 409,
        message: "what you approved is not what this machine would run now",
      }));
      render(<PlaygroundMain {...defaultProps} />);
      type("pwd");
      await submit();
      await act(async () => {
        fireEvent.click(screen.getByTestId("local-harness-trust-approve"));
      });
      expect(mockUseChatSession.sendMessage).not.toHaveBeenCalled();
      expect(screen.getByTestId("local-harness-trust-error")).toHaveTextContent(
        /would run now/,
      );
    });
  });

  describe("the composer notice", () => {
    it("reports progress during setup", () => {
      mockLocalHarness.state.phase = "installing";
      mockLocalHarness.state.runtimeStatus = {
        state: "downloading",
        packVersion: "3.4.0",
        percent: 42,
      };
      render(<PlaygroundMain {...defaultProps} />);
      expect(
        screen.getByTestId("local-harness-composer-notice"),
      ).toHaveTextContent("Setting up Claude Code · 42%");
    });

    it("says Verifying when there is no fraction to report", () => {
      mockLocalHarness.state.phase = "installing";
      mockLocalHarness.state.runtimeStatus = {
        state: "verifying",
        packVersion: "3.4.0",
      };
      render(<PlaygroundMain {...defaultProps} />);
      expect(
        screen.getByTestId("local-harness-composer-notice"),
      ).toHaveTextContent("Verifying…");
    });

    it("offers an explicit Retry after a failure, and nothing automatic", () => {
      mockLocalHarness.state.phase = "failed";
      mockLocalHarness.state.reason = "Couldn't download the runtime.";
      render(<PlaygroundMain {...defaultProps} />);
      expect(
        screen.getByTestId("local-harness-composer-notice"),
      ).toHaveTextContent("Couldn't download the runtime.");
      expect(mockLocalHarness.state.startInstall).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole("button", { name: "Retry" }));
      expect(
        screen.getByTestId("local-harness-trust-dialog"),
      ).toBeInTheDocument();
    });

    it("names an interrupted attempt as recoverable", () => {
      mockLocalHarness.state.phase = "interrupted";
      render(<PlaygroundMain {...defaultProps} />);
      expect(
        screen.getByTestId("local-harness-composer-notice"),
      ).toHaveTextContent("Setup was interrupted. Retry to continue.");
    });

    it("says to press Send again after a cold install completes", async () => {
      mockLocalHarness.state.phase = "installing";
      const { rerender } = render(<PlaygroundMain {...defaultProps} />);
      mockLocalHarness.state.phase = "needs-consent";
      await act(async () => {
        rerender(<PlaygroundMain {...defaultProps} />);
      });
      expect(
        screen.getByTestId("local-harness-ready-notice"),
      ).toHaveTextContent("Ready — press Send to continue.");
    });
  });

  describe("Send", () => {
    it("is NOT disabled for missing consent — that is how setup starts", () => {
      // Both Enter and the button are refused by `submitDisabled` before
      // `onSubmit` runs, so disabling here would make first-send setup
      // unreachable.
      render(<PlaygroundMain {...defaultProps} />);
      type("pwd");
      const props = mockChatInputProps.mock.calls.at(-1)?.[0] as {
        submitDisabled?: boolean;
      };
      expect(props.submitDisabled).toBeFalsy();
    });

    it("IS disabled while setup is running", () => {
      mockLocalHarness.state.phase = "installing";
      render(<PlaygroundMain {...defaultProps} />);
      const props = mockChatInputProps.mock.calls.at(-1)?.[0] as {
        submitDisabled?: boolean;
      };
      expect(props.submitDisabled).toBe(true);
    });

    it("IS disabled, with an explanation, when this machine cannot run it", () => {
      mockLocalHarness.state.phase = "unavailable";
      mockLocalHarness.state.reason = "win32 has no local harness runtime";
      render(<PlaygroundMain {...defaultProps} />);
      const props = mockChatInputProps.mock.calls.at(-1)?.[0] as {
        submitDisabled?: boolean;
      };
      expect(props.submitDisabled).toBe(true);
      // A disabled Send with no reason on screen is the failure this pairs
      // against.
      expect(
        screen.getByTestId("local-harness-composer-notice"),
      ).toHaveTextContent("win32 has no local harness runtime");
    });

    it("sends straight through when everything is ready", async () => {
      mockLocalHarness.state.phase = "ready";
      render(<PlaygroundMain {...defaultProps} />);
      type("pwd");
      await submit();
      expect(
        screen.queryByTestId("local-harness-trust-dialog"),
      ).not.toBeInTheDocument();
      expect(mockUseChatSession.sendMessage).toHaveBeenCalledTimes(1);
    });
  });
});
