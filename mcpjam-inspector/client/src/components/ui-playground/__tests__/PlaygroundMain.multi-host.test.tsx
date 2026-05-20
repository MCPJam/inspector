/**
 * PlaygroundMain — Phase 4 multi-host render path.
 *
 * Asserts the render-branch contract:
 *   - When `multiHostEnabled=true`, the project has >1 host, and the
 *     hook stack resolves >=2 hosts, the grid renders one card per host.
 *   - All columns share the project's `selectedServers` (project-scoped
 *     server config invariant).
 *   - Every column shares the lead's model and the global chip-edited
 *     `executionConfig` — multi-host varies the host axis only.
 *   - Two hosts with the SAME default model still render as two cards
 *     with distinct `compareId`s — the polymorphic-card regression the
 *     Phase 3 refactor enabled.
 *
 * Mocking strategy follows `PlaygroundMain.test.tsx`: heavy children are
 * stubbed; `useChatSession` is shared via a captured object; the new
 * multi-host stack (`usePersistedHost`, `useHostList`,
 * `usePlaygroundHostSlots`) is mocked at the module boundary so we can
 * drive the test fixtures.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { PlaygroundMain } from "../PlaygroundMain";
import { usePlaygroundChatHistoryBridgeStore } from "@/components/playground/playground-chat-history-bridge";
import { useHostContextStore } from "@/stores/client-context-store";
import type { HostDetail } from "@/hooks/useClients";
import type { HostConfigDtoV2 } from "@/lib/client-config-v2";

vi.mock("framer-motion", async (importOriginal) => {
  const actual = await importOriginal<typeof import("framer-motion")>();
  return { ...actual, useReducedMotion: () => false };
});

const mockMultiModelPlaygroundCard = vi.fn();

vi.mock("lucide-react", () => ({
  ArrowDown: () => <span />,
  ArrowUp: () => <span />,
  Braces: () => <span />,
  Loader2: () => <span />,
  Smartphone: () => <span />,
  Tablet: () => <span />,
  Monitor: () => <span />,
  Trash2: () => <span />,
  Sun: () => <span />,
  Moon: () => <span />,
  Globe: () => <span />,
  Clock: () => <span />,
  Shield: () => <span />,
  MousePointer2: () => <span />,
  Hand: () => <span />,
  Settings2: () => <span />,
  Eye: () => <span />,
  Pencil: () => <span />,
  AlignLeft: () => <span />,
  Copy: () => <span />,
  Check: () => <span />,
  Undo2: () => <span />,
  Redo2: () => <span />,
  Maximize2: () => <span />,
  Minimize2: () => <span />,
  ChevronRight: () => <span />,
  ArrowLeft: () => <span />,
  Code2: () => <span />,
  MessageSquare: () => <span />,
  Server: () => <span />,
  X: () => <span />,
}));

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
    <div>{children}</div>
  ),
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  ),
}));

vi.mock("@mcpjam/design-system/popover", () => ({
  Popover: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  PopoverContent: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  PopoverTrigger: ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  ),
}));

vi.mock("@mcpjam/design-system/input", () => ({
  Input: (props: any) => <input {...props} />,
}));

vi.mock("@mcpjam/design-system/label", () => ({
  Label: ({ children, ...props }: any) => <label {...props}>{children}</label>,
}));

vi.mock("@/lib/mcp-ui/mcp-apps-utils", () => ({
  UIType: {
    OPENAI_SDK: "openai-apps",
    MCP_APPS: "mcp-apps",
    OPENAI_SDK_AND_MCP_APPS: "both",
  },
}));

vi.mock("posthog-js/react", () => ({
  usePostHog: () => ({ capture: vi.fn() }),
  useFeatureFlagEnabled: () => false,
}));

vi.mock("@/lib/PosthogUtils", () => ({
  detectEnvironment: () => "test",
  detectPlatform: () => "web",
  standardEventProps: () => ({}),
}));

vi.mock("@workos-inc/authkit-react", () => ({
  useAuth: () => ({
    signUp: vi.fn(),
    user: { id: "u1" },
    isLoading: false,
  }),
}));

vi.mock("convex/react", () => ({
  useConvexAuth: () => ({ isAuthenticated: true, isLoading: false }),
  useQuery: (_name: string, args: unknown) =>
    args === "skip" ? undefined : null,
  useMutation: () => () => Promise.resolve(),
}));

vi.mock("@/hooks/useViews", () => ({
  useProjectServers: () => ({
    serversByName: new Map(),
    serversById: new Map(),
  }),
}));

vi.mock("@/lib/apis/web/chat-history-api", () => ({
  getChatHistoryDetail: vi.fn(),
  chatHistoryAction: vi.fn().mockResolvedValue({ ok: true }),
}));

// `useChatSession` is shared with single-host tests; we don't need it
// to do anything beyond return the standard mock object.
const mockUseChatSession = {
  messages: [],
  setMessages: vi.fn(),
  sendMessage: vi.fn(),
  stop: vi.fn(),
  status: "ready",
  error: null,
  selectedModel: {
    id: "openai/gpt-5-mini",
    name: "GPT-4o",
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
  availableModels: [
    {
      id: "openai/gpt-5-mini",
      name: "GPT-4o",
      provider: "openai",
    },
    {
      id: "anthropic/claude-sonnet-4.5",
      name: "Claude Sonnet 4.5",
      provider: "anthropic",
    },
  ],
  isAuthLoading: false,
  systemPrompt: "GLOBAL_SYSTEM_PROMPT",
  setSystemPrompt: vi.fn(),
  temperature: 0.42,
  setTemperature: vi.fn(),
  toolsMetadata: {},
  toolServerMap: {},
  tokenUsage: null,
  resetChat: vi.fn(),
  loadChatSession: vi.fn(async () => undefined),
  syncResumedVersion: vi.fn(),
  resumedVersion: null,
  restoredToolRenderOverrides: {},
  chatSessionId: "chat-session-1",
  startChatWithMessages: vi.fn(),
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

vi.mock("@/hooks/use-chat-session", () => ({
  useChatSession: () => mockUseChatSession,
}));

vi.mock("use-stick-to-bottom", () => {
  const StickToBottomComponent = ({ children }: any) => <div>{children}</div>;
  StickToBottomComponent.Content = ({ children }: any) => <div>{children}</div>;
  return {
    StickToBottom: StickToBottomComponent,
    useStickToBottomContext: () => ({
      isAtBottom: true,
      scrollToBottom: vi.fn(),
    }),
  };
});

vi.mock("@/components/chat-v2/thread", () => ({
  Thread: () => <div />,
}));

vi.mock("@/components/chat-v2/chat-input", () => ({
  ChatInput: () => <div data-testid="chat-input" />,
}));

vi.mock("@/components/chat-v2/error", () => ({
  ErrorBox: () => <div />,
}));

vi.mock("@/components/evals/trace-viewer", () => ({
  TraceViewer: () => <div />,
}));

vi.mock("@/components/evals/trace-view-mode-tabs", () => ({
  TraceViewModeTabs: () => <div />,
  ChatTraceViewModeHeaderBar: () => <div />,
}));

// The mock captures props per render so we can assert the card received
// the right `compareId`, `hostSnapshot`, `executionConfig`, etc.
vi.mock("@/components/ui-playground/multi-model-playground-card", () => ({
  MultiModelPlaygroundCard: (props: any) => {
    mockMultiModelPlaygroundCard(props);
    return (
      <div
        data-testid="multi-host-card"
        data-compare-id={props.compareId}
        data-compare-kind={props.compareKind}
        data-host-style={props.hostStyle}
      >
        {props.compareLabel}
      </div>
    );
  },
}));

vi.mock(
  "@/components/chat-v2/chat-input/dialogs/confirm-chat-reset-dialog",
  () => ({
    ConfirmChatResetDialog: () => null,
  }),
);

vi.mock("@/components/chat-v2/fullscreen-chat-overlay", () => ({
  FullscreenChatOverlay: () => <div />,
}));

vi.mock("@/components/chat-v2/mcpjam-free-models-prompt", () => ({
  MCPJamFreeModelsPrompt: () => <div />,
}));

vi.mock("../SafeAreaEditor", () => ({
  SafeAreaEditor: () => <div />,
}));

vi.mock("../playground-helpers", () => ({
  createDeterministicToolMessages: vi.fn().mockReturnValue({ messages: [] }),
}));

const mockPreferencesState = {
  themeMode: "light",
  themePreset: "soft-pop",
  hostStyle: "claude",
  hostCapabilitiesOverride: undefined,
  chatUiOverride: undefined,
  setThemeMode: vi.fn(),
  setHostStyle: vi.fn(),
};

vi.mock("@/stores/preferences/preferences-provider", () => ({
  usePreferencesStore: (selector: any) =>
    selector ? selector(mockPreferencesState) : mockPreferencesState,
}));

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

vi.mock("@/components/shared/ClientContextHeader", () => ({
  ClientContextHeader: () => <div />,
  PRESET_DEVICE_CONFIGS: {
    mobile: { width: 375, height: 667, label: "Phone", icon: () => null },
    tablet: { width: 768, height: 1024, label: "Tablet", icon: () => null },
    desktop: { width: 1280, height: 800, label: "Desktop", icon: () => null },
  },
}));

// Capture the props the parent threads into the picker so we can assert
// that:
//   - After Blocker 1 (lift state ownership), the picker receives the
//     SAME `selectedHostIds` array as the grid uses, plus setters.
//   - After Blocker 2 (project-id alignment), the `projectId` prop
//     matches the project id used for `usePersistedHost` (the grid's
//     storage scope).
const mockPlaygroundHostPicker = vi.fn();
vi.mock("@/components/playground/PlaygroundHostPicker", () => ({
  PlaygroundHostPicker: (props: any) => {
    mockPlaygroundHostPicker(props);
    return <div data-testid="playground-host-picker-stub" />;
  },
}));

vi.mock("@/stores/traffic-log-store", () => ({
  useTrafficLogStore: (selector: any) => {
    const state = { clear: vi.fn() };
    return selector ? selector(state) : state;
  },
}));

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

vi.mock("@/lib/utils", () => ({
  cn: (...args: any[]) => args.filter(Boolean).join(" "),
}));

// --- Multi-host stack: drive the test fixture from a mutable object. ---

const multiHostFixture = {
  multiHostEnabled: true,
  selectedHostIds: [] as string[],
  hostList: [] as { hostId: string; name: string }[],
  hosts: {} as Record<string, HostDetail>,
};

// Track the project id `PlaygroundMain` passes to `usePersistedHost`
// (a.k.a. `multiHostProjectId`). After Blocker 2 (project-id alignment)
// the picker must receive the SAME id; we assert both reads.
const usePersistedHostProjectIds: (string | null)[] = [];
const mockSetSelectedHostIds = vi.fn();
const mockSetMultiHostEnabled = vi.fn();

vi.mock("@/hooks/use-persisted-host", () => ({
  usePersistedHost: (projectId: string | null) => {
    usePersistedHostProjectIds.push(projectId);
    return {
      selectedHostIds: multiHostFixture.selectedHostIds,
      setSelectedHostIds: mockSetSelectedHostIds,
      multiHostEnabled: multiHostFixture.multiHostEnabled,
      setMultiHostEnabled: mockSetMultiHostEnabled,
    };
  },
}));

vi.mock("@/hooks/use-playground-host-slots", () => ({
  usePlaygroundHostSlots: (
    _isAuthenticated: boolean,
    ids: (string | null | undefined)[],
  ) => {
    const resolve = (id: string | null | undefined) =>
      id ? multiHostFixture.hosts[id] ?? null : null;
    return [
      { host: resolve(ids[0]), isLoading: false },
      { host: resolve(ids[1]), isLoading: false },
      { host: resolve(ids[2]), isLoading: false },
    ];
  },
}));

vi.mock("@/hooks/useClients", () => ({
  useHost: () => ({ host: null, isLoading: false }),
  useHostList: () => ({
    hosts: multiHostFixture.hostList,
    isLoading: false,
  }),
  useHostMutations: () => ({
    createHost: vi.fn(),
    updateHost: vi.fn(),
    deleteHost: vi.fn(),
    duplicateHost: vi.fn(),
  }),
}));

function makeHost(
  id: string,
  name: string,
  config: Partial<HostConfigDtoV2>,
): HostDetail {
  return {
    hostId: id,
    name,
    config: {
      id: `${id}-config`,
      schemaVersion: 1,
      hostStyle: "chatgpt",
      modelId: "openai/gpt-5-mini",
      systemPrompt: "",
      temperature: 0.7,
      requireToolApproval: false,
      serverIds: [],
      optionalServerIds: [],
      connectionDefaults: { headers: {}, requestTimeout: 30000 },
      clientCapabilities: {},
      hostContext: {},
      ...config,
    } as HostConfigDtoV2,
  };
}

describe("PlaygroundMain — multi-host render path", () => {
  const defaultProps = {
    serverName: "test-server",
    pendingExecution: null,
    onExecutionInjected: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    usePlaygroundChatHistoryBridgeStore.getState().setBridge(null);
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
      multiModelEnabled: false,
      selectedModelIds: [],
    });
    mockMultiModelPlaygroundCard.mockClear();
    mockPlaygroundHostPicker.mockClear();
    mockSetSelectedHostIds.mockClear();
    mockSetMultiHostEnabled.mockClear();
    usePersistedHostProjectIds.length = 0;
    // Reset fixture defaults — individual tests opt in to deviations.
    multiHostFixture.multiHostEnabled = true;
    multiHostFixture.selectedHostIds = [];
    multiHostFixture.hostList = [];
    multiHostFixture.hosts = {};
    // Reset shared-app-state to the default project; the shared-project
    // test mutates this to force `convexProjectId !== activeProjectId`.
    mockSharedAppState.projects = {};
    mockSharedAppState.activeProjectId = "default";
  });

  it("renders one card per resolved host in a multi-host grid", () => {
    const hostA = makeHost("h-A", "Host A", {
      hostStyle: "chatgpt",
      modelId: "openai/gpt-5-mini",
      systemPrompt: "host-A-prompt",
      temperature: 0.1,
    });
    const hostB = makeHost("h-B", "Host B", {
      hostStyle: "claude",
      modelId: "anthropic/claude-sonnet-4.5",
      systemPrompt: "host-B-prompt",
      temperature: 0.9,
    });
    multiHostFixture.hostList = [
      { hostId: "h-A", name: "Host A" },
      { hostId: "h-B", name: "Host B" },
    ];
    multiHostFixture.hosts = { "h-A": hostA, "h-B": hostB };
    multiHostFixture.selectedHostIds = ["h-A", "h-B"];
    multiHostFixture.multiHostEnabled = true;

    render(
      <PlaygroundMain {...defaultProps} />,
    );

    const grid = screen.getByTestId("playground-multi-host-grid");
    expect(grid).toBeTruthy();
    const cards = screen.getAllByTestId("multi-host-card");
    expect(cards).toHaveLength(2);
    expect(cards[0].getAttribute("data-compare-id")).toBe("h-A");
    expect(cards[1].getAttribute("data-compare-id")).toBe("h-B");
    expect(cards[0].getAttribute("data-host-style")).toBe("chatgpt");
    expect(cards[1].getAttribute("data-host-style")).toBe("claude");
    expect(cards[0].getAttribute("data-compare-kind")).toBe("host");
  });

  it("shares selectedServers across all columns (project-scoped invariant)", () => {
    const hostA = makeHost("h-A", "Host A", { hostStyle: "chatgpt" });
    const hostB = makeHost("h-B", "Host B", { hostStyle: "claude" });
    multiHostFixture.hostList = [
      { hostId: "h-A", name: "Host A" },
      { hostId: "h-B", name: "Host B" },
    ];
    multiHostFixture.hosts = { "h-A": hostA, "h-B": hostB };
    multiHostFixture.selectedHostIds = ["h-A", "h-B"];

    render(<PlaygroundMain {...defaultProps} />);

    const calls = mockMultiModelPlaygroundCard.mock.calls;
    expect(calls.length).toBeGreaterThanOrEqual(2);
    const serversPerCard = calls.map((call) => call[0].selectedServers);
    // Every card got the same array (by value).
    for (const servers of serversPerCard.slice(1)) {
      expect(servers).toEqual(serversPerCard[0]);
    }
  });

  it("every column shares the global chip state and the lead's model (multi-host varies host only)", () => {
    const hostA = makeHost("h-A", "Host A", {
      hostStyle: "chatgpt",
      modelId: "openai/gpt-5-mini",
      systemPrompt: "host-A-prompt",
      temperature: 0.1,
      requireToolApproval: true,
    });
    const hostB = makeHost("h-B", "Host B", {
      hostStyle: "claude",
      modelId: "anthropic/claude-sonnet-4.5",
      systemPrompt: "host-B-prompt",
      temperature: 0.9,
      requireToolApproval: false,
    });
    multiHostFixture.hostList = [
      { hostId: "h-A", name: "Host A" },
      { hostId: "h-B", name: "Host B" },
    ];
    multiHostFixture.hosts = { "h-A": hostA, "h-B": hostB };
    multiHostFixture.selectedHostIds = ["h-A", "h-B"];

    render(<PlaygroundMain {...defaultProps} />);

    const calls = mockMultiModelPlaygroundCard.mock.calls;
    const lastByCompareId = new Map<string, any>();
    for (const [props] of calls) {
      lastByCompareId.set(props.compareId, props);
    }
    const leadProps = lastByCompareId.get("h-A");
    const secondaryProps = lastByCompareId.get("h-B");

    // Both columns receive the global chip state — host's own persisted
    // systemPrompt/temperature/requireToolApproval are NOT used at the
    // execution-config layer (the host axis varies via hostSnapshot,
    // hostConfig, and the per-card capability resolver, not via chip
    // state).
    const expectedExecutionConfig = {
      systemPrompt: "GLOBAL_SYSTEM_PROMPT",
      temperature: 0.42,
      requireToolApproval: false,
    };
    expect(leadProps.executionConfig).toEqual(expectedExecutionConfig);
    expect(secondaryProps.executionConfig).toEqual(expectedExecutionConfig);

    // Both columns also share the lead host's resolved model — the
    // secondary's persisted modelId is ignored.
    expect(secondaryProps.model).toBe(leadProps.model);
    expect(String(leadProps.model.id)).toBe("openai/gpt-5-mini");
    expect(leadProps.compareSubLabel).toBe(secondaryProps.compareSubLabel);
  });

  it("multi-host card chrome is hidden — Trace/Chat/Raw tab strip is the only header content", () => {
    const hostA = makeHost("h-A", "Host A", { hostStyle: "chatgpt" });
    const hostB = makeHost("h-B", "Host B", { hostStyle: "claude" });
    multiHostFixture.hostList = [
      { hostId: "h-A", name: "Host A" },
      { hostId: "h-B", name: "Host B" },
    ];
    multiHostFixture.hosts = { "h-A": hostA, "h-B": hostB };
    multiHostFixture.selectedHostIds = ["h-A", "h-B"];

    render(<PlaygroundMain {...defaultProps} />);

    const calls = mockMultiModelPlaygroundCard.mock.calls;
    expect(calls.length).toBeGreaterThanOrEqual(2);
    // `showComparisonChrome=false` removes the per-card model title +
    // Latency/Tokens block. The tab strip stays because it's gated on
    // `showTraceTabs` inside `ModelCompareCardHeader`.
    for (const [props] of calls) {
      expect(props.showComparisonChrome).toBe(false);
    }
  });

  it("two hosts with the SAME default model still render as two cards with distinct compareIds (polymorphic-card regression)", () => {
    const hostA = makeHost("h-A", "Host A", {
      hostStyle: "chatgpt",
      modelId: "openai/gpt-5-mini",
    });
    const hostB = makeHost("h-B", "Host B", {
      // Same model id as hostA — pre-Phase-3 this collided on the
      // model-keyed transcript state.
      hostStyle: "claude",
      modelId: "openai/gpt-5-mini",
    });
    multiHostFixture.hostList = [
      { hostId: "h-A", name: "Host A" },
      { hostId: "h-B", name: "Host B" },
    ];
    multiHostFixture.hosts = { "h-A": hostA, "h-B": hostB };
    multiHostFixture.selectedHostIds = ["h-A", "h-B"];

    render(<PlaygroundMain {...defaultProps} />);

    const cards = screen.getAllByTestId("multi-host-card");
    expect(cards).toHaveLength(2);
    const compareIds = cards.map((c) => c.getAttribute("data-compare-id"));
    expect(new Set(compareIds).size).toBe(2);
    expect(compareIds.sort()).toEqual(["h-A", "h-B"]);
  });

  it("falls back to single-pane when multiHostEnabled but no hosts resolved", () => {
    multiHostFixture.hostList = [
      { hostId: "h-A", name: "Host A" },
      { hostId: "h-B", name: "Host B" },
    ];
    multiHostFixture.hosts = {}; // ids point at nothing
    multiHostFixture.selectedHostIds = ["h-A", "h-B"];

    render(<PlaygroundMain {...defaultProps} />);

    expect(screen.queryByTestId("playground-multi-host-grid")).toBeNull();
  });

  it("does NOT render the multi-host grid when the project has only one host (host-count gate)", () => {
    const hostA = makeHost("h-A", "Host A", { hostStyle: "chatgpt" });
    // Only one host in the project — `canEnableMultiHost` is gated on
    // `hostList.length > 1`, so the grid stays disabled even if the
    // persisted `multiHostEnabled` flag flips true.
    multiHostFixture.hostList = [{ hostId: "h-A", name: "Host A" }];
    multiHostFixture.hosts = { "h-A": hostA };
    multiHostFixture.selectedHostIds = ["h-A"];
    multiHostFixture.multiHostEnabled = true;

    render(<PlaygroundMain {...defaultProps} />);

    expect(screen.queryByTestId("playground-multi-host-grid")).toBeNull();
  });

  // --- Reviewer-flagged blockers ---

  it("picker is a controlled component: receives the SAME selectedHostIds + setters as the grid uses (Blocker 1)", () => {
    const hostA = makeHost("h-A", "Host A", {
      hostStyle: "chatgpt",
      modelId: "openai/gpt-5-mini",
    });
    const hostB = makeHost("h-B", "Host B", {
      hostStyle: "claude",
      modelId: "anthropic/claude-sonnet-4.5",
    });
    multiHostFixture.hostList = [
      { hostId: "h-A", name: "Host A" },
      { hostId: "h-B", name: "Host B" },
    ];
    multiHostFixture.hosts = { "h-A": hostA, "h-B": hostB };
    multiHostFixture.selectedHostIds = ["h-A", "h-B"];
    multiHostFixture.multiHostEnabled = true;

    render(<PlaygroundMain {...defaultProps} />);

    // Picker rendered at least once and got the same array (by ref)
    // and the same setters that PlaygroundMain owns. This guards against
    // a regression to the "picker calls its own usePersistedHost" anti-
    // pattern — separate hook instances would yield separate array
    // refs and separate setter identities.
    expect(mockPlaygroundHostPicker).toHaveBeenCalled();
    const lastProps =
      mockPlaygroundHostPicker.mock.calls[
        mockPlaygroundHostPicker.mock.calls.length - 1
      ][0];
    expect(lastProps.selectedHostIds).toBe(multiHostFixture.selectedHostIds);
    expect(lastProps.multiHostEnabled).toBe(true);
    expect(typeof lastProps.onSelectedHostIdsChange).toBe("function");
    expect(typeof lastProps.onMultiHostEnabledChange).toBe("function");
    expect(typeof lastProps.onPromoteLead).toBe("function");

    // Setter from the picker maps to the parent's hook setter (single
    // source of truth — no separate hook instance to drift away).
    lastProps.onSelectedHostIdsChange(["h-B", "h-A"]);
    expect(mockSetSelectedHostIds).toHaveBeenCalledWith(["h-B", "h-A"]);

    // `usePersistedHost` was called with `multiHostProjectId` — the
    // grid's storage scope. The picker doesn't call it at all anymore.
    expect(usePersistedHostProjectIds.length).toBeGreaterThan(0);
  });

  it("picker projectId matches multiHostProjectId in shared-project flows (Blocker 2)", () => {
    // Mirror the shared-project shape: `appState.projects[active]`
    // has a `sharedProjectId` distinct from the local `activeProjectId`.
    // Pre-fix, the picker received `activeProjectId` directly so its
    // storage scope (`mcp-inspector-selected-hosts:{activeProjectId}`)
    // diverged from the grid's (`...:{convexProjectId}`).
    mockSharedAppState.projects = {
      "local-project": { sharedProjectId: "convex-shared-id" } as any,
    };
    mockSharedAppState.activeProjectId = "local-project";

    const hostA = makeHost("h-A", "Host A", { hostStyle: "chatgpt" });
    const hostB = makeHost("h-B", "Host B", { hostStyle: "claude" });
    multiHostFixture.hostList = [
      { hostId: "h-A", name: "Host A" },
      { hostId: "h-B", name: "Host B" },
    ];
    multiHostFixture.hosts = { "h-A": hostA, "h-B": hostB };
    multiHostFixture.selectedHostIds = ["h-A", "h-B"];

    render(
      <PlaygroundMain
        {...defaultProps}
        activeProjectId="local-project"
      />,
    );

    // Grid's `usePersistedHost` is scoped to `convexProjectId`.
    expect(usePersistedHostProjectIds.at(-1)).toBe("convex-shared-id");

    // Picker received the SAME id — its `useHostList` /
    // `usePreviewedHostId` reads must align with the grid's storage.
    const lastProps =
      mockPlaygroundHostPicker.mock.calls[
        mockPlaygroundHostPicker.mock.calls.length - 1
      ][0];
    expect(lastProps.projectId).toBe("convex-shared-id");
  });

  it("slot 0 unresolved (lead host missing) → single-pane fallback (Blocker 3)", () => {
    const hostC = makeHost("h-C", "Host C", { hostStyle: "claude" });
    multiHostFixture.hostList = [
      { hostId: "h-A", name: "Host A" },
      { hostId: "h-C", name: "Host C" },
    ];
    // Lead id "h-A" intentionally NOT in `hosts` map — still loading
    // or deleted. The compacted `resolvedSelectedHosts` would have
    // collapsed slot 0 to host C; the pre-fix code would treat host C
    // as lead (wrong). The fix gates `isMultiHostMode` on lead being
    // fully resolved, so the grid does not render.
    multiHostFixture.hosts = { "h-C": hostC };
    multiHostFixture.selectedHostIds = ["h-A", "h-C"];
    multiHostFixture.multiHostEnabled = true;

    render(<PlaygroundMain {...defaultProps} />);

    expect(screen.queryByTestId("playground-multi-host-grid")).toBeNull();
  });

  it("slot 1 unresolved with slot 0 + slot 2 resolved → 2 columns, lead preserved (Blocker 3)", () => {
    const hostA = makeHost("h-A", "Host A", {
      hostStyle: "chatgpt",
      modelId: "openai/gpt-5-mini",
      systemPrompt: "host-A-prompt",
      temperature: 0.1,
    });
    const hostC = makeHost("h-C", "Host C", {
      hostStyle: "claude",
      modelId: "anthropic/claude-sonnet-4.5",
      systemPrompt: "host-C-prompt",
      temperature: 0.9,
    });
    multiHostFixture.hostList = [
      { hostId: "h-A", name: "Host A" },
      { hostId: "h-B", name: "Host B" },
      { hostId: "h-C", name: "Host C" },
    ];
    // Slot 1 ("h-B") deliberately missing. The fix iterates
    // `selectedHostIds` (not the compacted list), so the lead stays
    // pinned to `selectedHostIds[0]`.
    multiHostFixture.hosts = { "h-A": hostA, "h-C": hostC };
    multiHostFixture.selectedHostIds = ["h-A", "h-B", "h-C"];
    multiHostFixture.multiHostEnabled = true;

    render(<PlaygroundMain {...defaultProps} />);

    const cards = screen.getAllByTestId("multi-host-card");
    expect(cards).toHaveLength(2);
    // Order is preserved: lead first, slot 2 second. Slot 1's hole
    // does NOT promote slot 2 into the lead position.
    expect(cards[0].getAttribute("data-compare-id")).toBe("h-A");
    expect(cards[1].getAttribute("data-compare-id")).toBe("h-C");

    // Lead identity assertion: with the host-only-axis contract, every
    // column shares the GLOBAL chip state. Before, `h-C` (secondary)
    // would have used its own host config; now host config is consumed
    // via `hostSnapshot`/`hostConfig` only — chip state is shared.
    const lastByCompareId = new Map<string, any>();
    for (const [props] of mockMultiModelPlaygroundCard.mock.calls) {
      lastByCompareId.set(props.compareId, props);
    }
    const expectedExecutionConfig = {
      systemPrompt: "GLOBAL_SYSTEM_PROMPT",
      temperature: 0.42,
      requireToolApproval: false,
    };
    expect(lastByCompareId.get("h-A").executionConfig).toEqual(
      expectedExecutionConfig,
    );
    expect(lastByCompareId.get("h-C").executionConfig).toEqual(
      expectedExecutionConfig,
    );
  });

  it("chat-input model unset → single-pane fallback", () => {
    // Multi-host columns inherit the chat-input `selectedModel` for
    // every column. If the picker has no model selected, the grid
    // can't render a coherent execution, so we fall through to
    // single-pane. Host modelIds are intentionally NOT consulted.
    const hostA = makeHost("h-A", "Host A", {
      hostStyle: "chatgpt",
      modelId: "openai/gpt-5-mini",
    });
    const hostB = makeHost("h-B", "Host B", {
      hostStyle: "claude",
      modelId: "anthropic/claude-sonnet-4.5",
    });
    multiHostFixture.hostList = [
      { hostId: "h-A", name: "Host A" },
      { hostId: "h-B", name: "Host B" },
    ];
    multiHostFixture.hosts = { "h-A": hostA, "h-B": hostB };
    multiHostFixture.selectedHostIds = ["h-A", "h-B"];
    multiHostFixture.multiHostEnabled = true;

    const previousSelectedModel = mockUseChatSession.selectedModel;
    mockUseChatSession.selectedModel = null;
    try {
      render(<PlaygroundMain {...defaultProps} />);
      expect(screen.queryByTestId("playground-multi-host-grid")).toBeNull();
    } finally {
      mockUseChatSession.selectedModel = previousSelectedModel;
    }
  });

  it("host modelIds are ignored — every column inherits the chat-input model regardless of host config", () => {
    // Hosts ship their own persisted `modelId`, but in multi-host mode
    // those are not the source of truth for the column model. The
    // chat-input picker's `selectedModel` drives every column.
    const hostA = makeHost("h-A", "Host A", {
      hostStyle: "chatgpt",
      // Intentionally a modelId NOT present in `availableModels` — the
      // previous contract would have refused to render. Under the new
      // contract this is irrelevant; grid still renders.
      modelId: "openai/gpt-4o",
    });
    const hostB = makeHost("h-B", "Host B", {
      hostStyle: "claude",
      modelId: "anthropic/claude-sonnet-4.5",
    });
    multiHostFixture.hostList = [
      { hostId: "h-A", name: "Host A" },
      { hostId: "h-B", name: "Host B" },
    ];
    multiHostFixture.hosts = { "h-A": hostA, "h-B": hostB };
    multiHostFixture.selectedHostIds = ["h-A", "h-B"];
    multiHostFixture.multiHostEnabled = true;

    render(<PlaygroundMain {...defaultProps} />);

    const cards = screen.getAllByTestId("multi-host-card");
    expect(cards).toHaveLength(2);
    const lastByCompareId = new Map<string, any>();
    for (const [props] of mockMultiModelPlaygroundCard.mock.calls) {
      lastByCompareId.set(props.compareId, props);
    }
    const leadProps = lastByCompareId.get("h-A");
    const secondaryProps = lastByCompareId.get("h-B");
    // Both columns receive the chat-input `selectedModel` from the
    // mocked `useChatSession` fixture (openai/gpt-5-mini), NOT any
    // host's persisted modelId.
    expect(leadProps.model).toBe(mockUseChatSession.selectedModel);
    expect(secondaryProps.model).toBe(mockUseChatSession.selectedModel);
  });

  it("adding a host while compare is active seeds the new column from the lead's CURRENT transcript (not the original enter snapshot)", async () => {
    // Regression for the reviewer-flagged P2 bug. Pre-fix:
    //   - The model-mode added-column effect was the only place that
    //     wrote to `compareAddColumnSeeds`. It returned early when
    //     `isMultiModelMode` was false (i.e. during host mode).
    //   - So a host added mid-conversation in host-compare mode would
    //     fall back to the global `compareEnterMessages` snapshot
    //     (frozen at the moment compare was first entered) instead of
    //     the lead's CURRENT transcript.
    //
    // The new host-mode sibling effect closes that gap.
    const hostA = makeHost("h-A", "Host A", { hostStyle: "chatgpt" });
    const hostB = makeHost("h-B", "Host B", { hostStyle: "claude" });
    const hostC = makeHost("h-C", "Host C", { hostStyle: "chatgpt" });
    multiHostFixture.hostList = [
      { hostId: "h-A", name: "Host A" },
      { hostId: "h-B", name: "Host B" },
      { hostId: "h-C", name: "Host C" },
    ];
    multiHostFixture.hosts = { "h-A": hostA, "h-B": hostB, "h-C": hostC };
    multiHostFixture.selectedHostIds = ["h-A", "h-B"];
    multiHostFixture.multiHostEnabled = true;

    const { rerender } = render(<PlaygroundMain {...defaultProps} />);

    // Grab the most recent props the lead card was rendered with so we
    // can drive `onTranscriptSync` ourselves. The transcript that flows
    // through here is the lead's LIVE state; the effect should pick it
    // up from `compareTranscriptsRef` on the next render.
    const leadCallBefore = mockMultiModelPlaygroundCard.mock.calls
      .map(([props]) => props)
      .filter((props) => props.compareId === "h-A")
      .at(-1);
    expect(leadCallBefore).toBeDefined();
    const liveTranscript = [
      { id: "u-1", role: "user", parts: [{ type: "text", text: "live-msg" }] },
      {
        id: "a-1",
        role: "assistant",
        parts: [{ type: "text", text: "live-reply" }],
      },
    ] as any[];
    leadCallBefore.onTranscriptSync("h-A", liveTranscript);

    // Now the user adds a 3rd host while compare is still running.
    multiHostFixture.selectedHostIds = ["h-A", "h-B", "h-C"];
    rerender(<PlaygroundMain {...defaultProps} />);

    // After the re-render, the host-mode added-column effect should
    // have written an `addColumnSeed` for h-C with the LIVE transcript
    // we synced above — not the empty `compareEnterMessages` array.
    const hostCCall = mockMultiModelPlaygroundCard.mock.calls
      .map(([props]) => props)
      .filter((props) => props.compareId === "h-C")
      .at(-1);
    expect(hostCCall).toBeDefined();
    expect(hostCCall.addColumnSeed).not.toBeNull();
    expect(hostCCall.addColumnSeed.messages).toHaveLength(2);
    expect(hostCCall.addColumnSeed.messages[0].id).toBe("u-1");
    expect(hostCCall.addColumnSeed.messages[1].id).toBe("a-1");
    // The pre-existing columns (h-A, h-B) should NOT receive a fresh
    // seed — only the newly-added column does.
    const hostBCall = mockMultiModelPlaygroundCard.mock.calls
      .map(([props]) => props)
      .filter((props) => props.compareId === "h-B")
      .at(-1);
    expect(hostBCall.addColumnSeed).toBeNull();
  });
});
