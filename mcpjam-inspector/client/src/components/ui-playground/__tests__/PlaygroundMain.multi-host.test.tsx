/**
 * PlaygroundMain — Phase 4 multi-host render path.
 *
 * Asserts the render-branch contract:
 *   - When `enableMultiHostChat=true`, `multiHostEnabled=true`, and the
 *     hook stack resolves >=2 hosts, the grid renders one card per host.
 *   - All columns share the project's `selectedServers` (project-scoped
 *     server config invariant).
 *   - Lead column's `executionConfig` is the global chip-edited state;
 *     secondaries' configs come from each host's persisted config.
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

vi.mock("@/components/playground/PlaygroundHostPicker", () => ({
  PlaygroundHostPicker: () => <div />,
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

vi.mock("@/hooks/use-persisted-host", () => ({
  usePersistedHost: () => ({
    selectedHostIds: multiHostFixture.selectedHostIds,
    setSelectedHostIds: vi.fn(),
    multiHostEnabled: multiHostFixture.multiHostEnabled,
    setMultiHostEnabled: vi.fn(),
  }),
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
      <PlaygroundMain {...defaultProps} enableMultiHostChat={true} />,
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

    render(<PlaygroundMain {...defaultProps} enableMultiHostChat={true} />);

    const calls = mockMultiModelPlaygroundCard.mock.calls;
    expect(calls.length).toBeGreaterThanOrEqual(2);
    const serversPerCard = calls.map((call) => call[0].selectedServers);
    // Every card got the same array (by value).
    for (const servers of serversPerCard.slice(1)) {
      expect(servers).toEqual(serversPerCard[0]);
    }
  });

  it("lead column's executionConfig is the global chip state; secondaries use the host's persisted config", () => {
    const hostA = makeHost("h-A", "Host A", {
      hostStyle: "chatgpt",
      systemPrompt: "host-A-prompt",
      temperature: 0.1,
      requireToolApproval: true,
    });
    const hostB = makeHost("h-B", "Host B", {
      hostStyle: "claude",
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

    render(<PlaygroundMain {...defaultProps} enableMultiHostChat={true} />);

    // Find the most-recent props each card received (last call per
    // compareId).
    const calls = mockMultiModelPlaygroundCard.mock.calls;
    const lastByCompareId = new Map<string, any>();
    for (const [props] of calls) {
      lastByCompareId.set(props.compareId, props);
    }
    const leadProps = lastByCompareId.get("h-A");
    const secondaryProps = lastByCompareId.get("h-B");

    // Lead uses the global mock chip values from useChatSession.
    expect(leadProps.executionConfig).toEqual({
      systemPrompt: "GLOBAL_SYSTEM_PROMPT",
      temperature: 0.42,
      requireToolApproval: false,
    });
    // Secondary uses host-B's config.
    expect(secondaryProps.executionConfig).toEqual({
      systemPrompt: "host-B-prompt",
      temperature: 0.9,
      requireToolApproval: false,
    });
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

    render(<PlaygroundMain {...defaultProps} enableMultiHostChat={true} />);

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

    render(<PlaygroundMain {...defaultProps} enableMultiHostChat={true} />);

    expect(screen.queryByTestId("playground-multi-host-grid")).toBeNull();
  });

  it("does NOT render the multi-host grid when enableMultiHostChat is false (Phase 5 flag default)", () => {
    const hostA = makeHost("h-A", "Host A", { hostStyle: "chatgpt" });
    const hostB = makeHost("h-B", "Host B", { hostStyle: "claude" });
    multiHostFixture.hostList = [
      { hostId: "h-A", name: "Host A" },
      { hostId: "h-B", name: "Host B" },
    ];
    multiHostFixture.hosts = { "h-A": hostA, "h-B": hostB };
    multiHostFixture.selectedHostIds = ["h-A", "h-B"];
    multiHostFixture.multiHostEnabled = true;

    render(<PlaygroundMain {...defaultProps} enableMultiHostChat={false} />);

    expect(screen.queryByTestId("playground-multi-host-grid")).toBeNull();
  });
});
