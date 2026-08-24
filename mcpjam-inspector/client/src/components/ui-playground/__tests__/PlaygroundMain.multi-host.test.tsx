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
import { act, render, screen, waitFor } from "@testing-library/react";
import { PlaygroundMain } from "../PlaygroundMain";
import { usePlaygroundChatHistoryBridgeStore } from "@/components/playground/playground-chat-history-bridge";
import { useHostContextStore } from "@/stores/client-context-store";
import type { HostDetail } from "@/hooks/useClients";
import type { HostConfigDtoV2 } from "@/lib/client-config-v2";
import {
  loadSelectedHostIds,
  saveSelectedHostIds,
} from "@/lib/selected-host-storage";
import { savePreviewedHostId } from "@/lib/previewed-client-storage";

vi.mock("framer-motion", async (importOriginal) => {
  const actual = await importOriginal<typeof import("framer-motion")>();
  return { ...actual, useReducedMotion: () => false };
});

const mockMultiModelPlaygroundCard = vi.fn();

vi.mock("lucide-react", async (importOriginal) => ({
  // Spread the real icon set so a newly-rendered icon (e.g. Columns2) never
  // breaks the whole suite; the explicit stubs below stay as overrides.
  ...(await importOriginal<typeof import("lucide-react")>()),
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

// Project Environments (Phase 2) is flag-gated; default OFF so every existing
// multi-host assertion keeps exercising the unchanged host path.
const {
  environmentsFlag,
  environmentPreviewFixture,
  environmentPreviewLoading,
} = vi.hoisted(() => ({
  environmentsFlag: { value: false as boolean | undefined },
  environmentPreviewFixture: { value: null as unknown },
  // Separate from the body on purpose: a live EDIT of the SELECTED
  // environment refetches while KEEPING the previous body on screen, so
  // "loading" and "has a preview" are simultaneously true and the fixture
  // has to be able to express that pair.
  environmentPreviewLoading: { value: false },
}));
vi.mock("posthog-js/react", () => ({
  usePostHog: () => ({ capture: vi.fn() }),
  useFeatureFlagEnabled: (flag: string) =>
    flag === "project-environments-enabled" ? environmentsFlag.value : false,
}));
// The preview is a network read (`/api/web/environments/:id/preview`); the
// fixture stands in for the resolver so the test drives what the environment
// resolves to.
vi.mock("@/hooks/use-environment-preview", () => ({
  useEnvironmentPreview: (
    projectId: string | null,
    environmentId: string | null
  ) => ({
    preview:
      projectId && environmentId ? environmentPreviewFixture.value : null,
    isLoading: environmentPreviewLoading.value,
    error: null,
    refresh: vi.fn(),
  }),
}));
vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));

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
  // useChatSession resolves the Convex client to submit elicitation answers
  // straight to the rendezvous table (the blocked replica isn't addressable).
  useConvex: () => ({ mutation: vi.fn().mockResolvedValue({ ok: true }) }),
  useConvexAuth: () => ({ isAuthenticated: true, isLoading: false }),
  useQuery: (_name: string, args: unknown) =>
    args === "skip" ? undefined : null,
  useMutation: () => () => Promise.resolve(),
  // COMP-14: useComputerAttachmentUpload pulls in useMintTerminalToken (a
  // Convex action). The flag mock keeps the flow inert; this keeps it mountable.
  useAction: () => () => Promise.resolve({ token: "test-token" }),
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

let capturedChatSessionOptions: any = null;
vi.mock("@/hooks/use-chat-session", () => ({
  useChatSession: (options: any) => {
    capturedChatSessionOptions = options;
    return mockUseChatSession;
  },
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

// Capture-mock so submit/stop routing tests can drive the composer's
// `onSubmit` and `stop` props directly. `mockChatInput.mock.calls.at(-1)[0]`
// gives the most-recent props.
const mockChatInput = vi.fn();
vi.mock("@/components/chat-v2/chat-input", () => ({
  ChatInput: (props: any) => {
    mockChatInput(props);
    return <div data-testid="chat-input" />;
  },
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
  })
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
  const actual = await importOriginal<
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
const mockCreateHost = vi.hoisted(() => vi.fn());
const mockHostMutations = vi.hoisted(() => ({
  createHost: undefined as unknown as ReturnType<typeof vi.fn>,
  updateHost: vi.fn(),
  deleteHost: vi.fn(),
  duplicateHost: vi.fn(),
}));
mockHostMutations.createHost = mockCreateHost;

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
    ids: (string | null | undefined)[]
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
  // Every mutation is a STABLE reference, matching Convex's `useMutation`
  // (which memoizes per mutation). Minting fresh `vi.fn()`s here instead
  // would change these identities on every render, and the seed effect
  // depends on `createHost`/`deleteHost` — so the effect would re-run on
  // every render and quietly retry a failed seed on its own, hiding whether
  // the real retry path works at all.
  useHostMutations: () => mockHostMutations,
}));

// PUR-11 seed backstop reads live catalog templates (chatgpt/claude/
// cursor) to seed a guest's first 3 clients. `getCatalogHost` /
// `getCatalogTemplate` are the REAL sdk functions running against this fake
// "live" catalog — only the network-fetching hook is mocked.
const seedCatalogFixture = {
  status: "live" as const,
  version: 1,
  source: "test",
  catalog: {
    hostsById: {
      chatgpt: {
        id: "chatgpt",
        label: "ChatGPT",
        provenance: "assumed",
        rendersMcpApps: false,
        modelId: "openai/gpt-5.6-luna",
        systemPrompt: "",
        temperature: 0.7,
        requireToolApproval: false,
        serverIds: [],
        optionalServerIds: [],
        connectionDefaults: { headers: {}, requestTimeout: 30000 },
        clientCapabilities: {},
        hostContext: {},
      },
      claude: {
        id: "claude",
        label: "Claude",
        provenance: "assumed",
        rendersMcpApps: true,
        modelId: "anthropic/claude-haiku-4.5",
        systemPrompt: "",
        temperature: 1,
        requireToolApproval: false,
        serverIds: [],
        optionalServerIds: [],
        connectionDefaults: { headers: {}, requestTimeout: 30000 },
        clientCapabilities: {},
        hostContext: {},
      },
      cursor: {
        id: "cursor",
        label: "Cursor",
        provenance: "probe",
        rendersMcpApps: true,
        modelId: "anthropic/claude-sonnet-4.5",
        systemPrompt: "",
        temperature: 0.7,
        requireToolApproval: false,
        serverIds: [],
        optionalServerIds: [],
        connectionDefaults: { headers: {}, requestTimeout: 30000 },
        clientCapabilities: {},
        hostContext: {},
      },
    },
  },
};

// The catalog is fetched once per page load and memoized for the session, so
// a degraded status is permanent — the seed has to cope with it rather than
// wait it out. Tests override this to exercise "fallback"/"error"; the
// `beforeEach` resets it to the live fixture above.
let seedCatalogState: {
  status: "live" | "fallback" | "error";
  version: number | null;
  source: string | null;
  catalog: unknown;
} = seedCatalogFixture;

vi.mock("@/lib/host-compat/use-host-catalog", () => ({
  useHostCatalog: () => seedCatalogState,
}));

function readPreviewedHostId(projectId = "default"): string | null {
  const raw = localStorage.getItem("mcp-previewed-host-id");
  if (!raw) return null;
  return (JSON.parse(raw) as Record<string, string | null>)[projectId] ?? null;
}

function makeHost(
  id: string,
  name: string,
  config: Partial<HostConfigDtoV2>
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
    activeProjectId: "default",
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
    mockChatInput.mockClear();
    // `mockReset`, not `mockClear`: the seed test installs a
    // `mockImplementation` that mirrors its argument into `multiHostFixture`,
    // and neither `mockClear` nor `vi.clearAllMocks()` drops implementations —
    // so it would leak into every later test and quietly rewrite the fixture
    // out from under their own assertions.
    mockSetSelectedHostIds.mockReset();
    mockSetMultiHostEnabled.mockReset();
    mockCreateHost.mockResolvedValue({
      hostId: "seeded-host",
      hostConfigId: "seeded-host-config",
    });
    usePersistedHostProjectIds.length = 0;
    localStorage.clear();
    // Reset fixture defaults — individual tests opt in to deviations.
    multiHostFixture.multiHostEnabled = true;
    multiHostFixture.selectedHostIds = [];
    multiHostFixture.hostList = [];
    multiHostFixture.hosts = {};
    // Reset shared-app-state to the default project; the shared-project
    // test mutates this to force `convexProjectId !== activeProjectId`.
    mockSharedAppState.projects = {};
    mockSharedAppState.activeProjectId = "default";
    capturedChatSessionOptions = null;
    seedCatalogState = seedCatalogFixture;
    environmentsFlag.value = false;
    environmentPreviewFixture.value = null;
    environmentPreviewLoading.value = false;
  });

  it("selects MCPJam as the previewed client when no current client is selected", async () => {
    multiHostFixture.multiHostEnabled = false;
    multiHostFixture.hostList = [
      { hostId: "h-zed", name: "Zed" },
      { hostId: "h-mcpjam", name: "MCPJam" },
    ];

    render(<PlaygroundMain {...defaultProps} />);

    await waitFor(() => {
      expect(readPreviewedHostId()).toBe("h-mcpjam");
    });
    expect(mockCreateHost).not.toHaveBeenCalled();
  });

  // PUR-11: guests land with 3 pre-selected clients (Claude, ChatGPT, Cursor)
  // instead of a single blank "MCPJam" host + a toggle to find first.
  it("seeds 3 default clients (Claude, ChatGPT, Cursor) for empty projects", async () => {
    multiHostFixture.multiHostEnabled = false;
    multiHostFixture.hostList = [];
    mockCreateHost
      .mockResolvedValueOnce({
        hostId: "h-claude",
        hostConfigId: "h-claude-config",
      })
      .mockResolvedValueOnce({
        hostId: "h-chatgpt",
        hostConfigId: "h-chatgpt-config",
      })
      .mockResolvedValueOnce({
        hostId: "h-cursor",
        hostConfigId: "h-cursor-config",
      });

    // So the grid-render assertion below is actually wired to what the seed
    // effect calls `setSelectedHostIds` with — not a value hardcoded to
    // match it — mirror the fixture from the real call's argument, the same
    // way `usePersistedHost`'s own state would update.
    mockSetSelectedHostIds.mockImplementation((ids: string[]) => {
      multiHostFixture.selectedHostIds = ids;
    });

    const { rerender } = render(<PlaygroundMain {...defaultProps} />);

    await waitFor(() => {
      expect(mockCreateHost).toHaveBeenCalledTimes(3);
    });
    expect(mockCreateHost).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: "default", name: "Claude" })
    );
    expect(mockCreateHost).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "default",
        name: "ChatGPT",
        // Straight from the catalog template — the seed no longer carries a
        // per-host model override on top of it.
        input: expect.objectContaining({ modelId: "openai/gpt-5.6-luna" }),
      })
    );
    expect(mockCreateHost).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "default",
        name: "Cursor",
        // The seed pins each template's default model — a modelless host
        // breaks synthetic/swarm runs (no picker fallback on that path).
        input: expect.objectContaining({
          modelId: "anthropic/claude-sonnet-4.5",
        }),
      })
    );

    // Lead is the first seed template (Claude); the compare lineup is
    // seeded alongside it — no manual toggle needed for a guest to land in
    // a 3-way compare.
    await waitFor(() => {
      expect(readPreviewedHostId()).toBe("h-claude");
    });
    expect(mockSetSelectedHostIds).toHaveBeenCalledWith([
      "h-claude",
      "h-chatgpt",
      "h-cursor",
    ]);

    // The acceptance criterion end to end: once the host-list query catches
    // up to the 3 just-created hosts (simulated here the same way a live
    // Convex subscription would resolve shortly after — this half is
    // necessarily manual, standing in for an external subscription this
    // mock setup has no live path to), the guest actually lands in the
    // 3-way compare grid. `multiHostFixture.selectedHostIds` is NOT set
    // here — it was already updated above by the real `setSelectedHostIds`
    // call via `mockSetSelectedHostIds`'s implementation, so a regression
    // that seeds the wrong ids would show up as the wrong (or zero) cards
    // below rather than being masked by a hardcoded fixture value.
    multiHostFixture.hostList = [
      { hostId: "h-chatgpt", name: "ChatGPT" },
      { hostId: "h-claude", name: "Claude" },
      { hostId: "h-cursor", name: "Cursor" },
    ];
    multiHostFixture.hosts = {
      "h-chatgpt": makeHost("h-chatgpt", "ChatGPT", { hostStyle: "chatgpt" }),
      "h-claude": makeHost("h-claude", "Claude", { hostStyle: "claude" }),
      "h-cursor": makeHost("h-cursor", "Cursor", {
        hostStyle: "cursor",
      }),
    };
    rerender(<PlaygroundMain {...defaultProps} />);

    await waitFor(() => {
      expect(screen.getByTestId("playground-multi-host-grid")).toBeTruthy();
    });
    expect(screen.getAllByTestId("multi-host-card")).toHaveLength(3);
  });

  // A "fallback" catalog is the server serving its own bundled copy, which
  // carries all 3 seed templates — so the guest still gets the full lineup.
  // Waiting for "live" instead would strand them with zero clients for the
  // whole session: the catalog is fetched once per page load and memoized, so
  // a degraded status never upgrades without a reload, and the playground
  // hides the global host bar that would otherwise seed a default host.
  it("seeds the full 3-client lineup from a bundled ('fallback') catalog", async () => {
    seedCatalogState = { ...seedCatalogFixture, status: "fallback" };
    multiHostFixture.multiHostEnabled = false;
    multiHostFixture.hostList = [];
    mockCreateHost
      .mockResolvedValueOnce({
        hostId: "h-chatgpt",
        hostConfigId: "h-chatgpt-config",
      })
      .mockResolvedValueOnce({
        hostId: "h-claude",
        hostConfigId: "h-claude-config",
      })
      .mockResolvedValueOnce({
        hostId: "h-cursor",
        hostConfigId: "h-cursor-config",
      });

    render(<PlaygroundMain {...defaultProps} />);

    await waitFor(() => {
      expect(mockCreateHost).toHaveBeenCalledTimes(3);
    });
    await waitFor(() => {
      expect(mockSetSelectedHostIds).toHaveBeenCalledWith([
        "h-chatgpt",
        "h-claude",
        "h-cursor",
      ]);
    });
  });

  // "error" means no catalog at all, so there are no templates to clone —
  // but zero clients on a surface with no host bar is a dead end. Fall back
  // to the pre-PUR-11 backstop (one blank "MCPJam" host, no compare lineup)
  // rather than leaving the project empty.
  it("seeds a single blank MCPJam host when the catalog failed to load", async () => {
    seedCatalogState = {
      status: "error",
      version: null,
      source: null,
      catalog: null,
    };
    multiHostFixture.multiHostEnabled = false;
    multiHostFixture.hostList = [];
    mockCreateHost.mockResolvedValue({
      hostId: "h-mcpjam",
      hostConfigId: "h-mcpjam-config",
    });

    render(<PlaygroundMain {...defaultProps} />);

    await waitFor(() => {
      expect(mockCreateHost).toHaveBeenCalledTimes(1);
    });
    expect(mockCreateHost).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "default",
        name: "MCPJam",
        input: expect.objectContaining({
          modelId: "anthropic/claude-haiku-4.5",
        }),
      })
    );
    await waitFor(() => {
      expect(readPreviewedHostId()).toBe("h-mcpjam");
    });
    // A single-host lineup, not an empty one: `usePersistedHost` derives the
    // lineup from the lead anyway, and writing it explicitly is what keeps a
    // stale array from surviving (see the orphaned-lineup test below).
    await waitFor(() => {
      expect(loadSelectedHostIds("default")).toEqual(["h-mcpjam"]);
    });
    expect(mockSetSelectedHostIds).toHaveBeenCalledWith(["h-mcpjam"]);
  });

  // The fallback promises "one host, no compare" — but leaving the stored
  // lineup alone doesn't deliver that for a project whose hosts were deleted:
  // the dead ids are still in storage, and `usePersistedHost` PRESERVES the
  // stored column count at read time (replacing slot 0 with the lead rather
  // than shrinking), so they'd come back as a 3-column compare lineup around
  // one real host and flip `isComparingHosts` (`selectedHostIds.length > 1`)
  // on. The fallback has to overwrite the lineup, not skip it.
  it("collapses an orphaned compare lineup when falling back to a single host", async () => {
    saveSelectedHostIds("default", [
      "h-deleted-1",
      "h-deleted-2",
      "h-deleted-3",
    ]);
    seedCatalogState = {
      status: "error",
      version: null,
      source: null,
      catalog: null,
    };
    multiHostFixture.multiHostEnabled = false;
    multiHostFixture.hostList = [];
    mockCreateHost.mockResolvedValue({
      hostId: "h-mcpjam",
      hostConfigId: "h-mcpjam-config",
    });

    render(<PlaygroundMain {...defaultProps} />);

    await waitFor(() => {
      expect(loadSelectedHostIds("default")).toEqual(["h-mcpjam"]);
    });
    expect(readPreviewedHostId()).toBe("h-mcpjam");
  });

  // Clearing the per-project "seeded" marker only PERMITS a retry — nothing
  // in the effect's dependency list changes when a create rejects, so
  // without an explicit re-trigger the guest is stuck on an empty playground
  // for the rest of the session. This is the surface with no global host bar
  // to fall back on, so the backstop itself has to be recoverable.
  it("retries the single-host fallback after the create fails", async () => {
    seedCatalogState = {
      status: "error",
      version: null,
      source: null,
      catalog: null,
    };
    multiHostFixture.multiHostEnabled = false;
    multiHostFixture.hostList = [];
    mockCreateHost
      .mockRejectedValueOnce(new Error("backend blip"))
      .mockResolvedValueOnce({
        hostId: "h-mcpjam",
        hostConfigId: "h-mcpjam-config",
      });

    render(<PlaygroundMain {...defaultProps} />);

    await waitFor(() => {
      expect(mockCreateHost).toHaveBeenCalledTimes(1);
    });
    // The retry is scheduled on a real (backed-off) timer, so this waits it
    // out rather than asserting synchronously.
    await waitFor(
      () => {
        expect(mockCreateHost).toHaveBeenCalledTimes(2);
      },
      { timeout: 4000 }
    );
    await waitFor(() => {
      expect(readPreviewedHostId()).toBe("h-mcpjam");
    });
  });

  // A project can go back to `hostList.length === 0` after being fully
  // seeded once, if all 3 hosts are later deleted — but the array in
  // storage isn't cleared just because the hosts it points at are gone, so
  // `loadSelectedHostIds` still returns the 3 (now orphaned) ids. A naive
  // "is the stored array non-empty" check would misread that leftover data
  // as a manual selection made mid-reseed and skip applying the new lineup,
  // permanently stranding the project. The reseed must go through as long
  // as nothing has changed the lineup since the seed effect itself started.
  it("reseeds a project whose hosts were all deleted, even though the stale array is non-empty", async () => {
    saveSelectedHostIds("default", [
      "h-deleted-1",
      "h-deleted-2",
      "h-deleted-3",
    ]);
    multiHostFixture.multiHostEnabled = false;
    multiHostFixture.hostList = [];
    mockCreateHost
      .mockResolvedValueOnce({
        hostId: "h-chatgpt",
        hostConfigId: "h-chatgpt-config",
      })
      .mockResolvedValueOnce({
        hostId: "h-claude",
        hostConfigId: "h-claude-config",
      })
      .mockResolvedValueOnce({
        hostId: "h-cursor",
        hostConfigId: "h-cursor-config",
      });

    render(<PlaygroundMain {...defaultProps} />);

    await waitFor(() => {
      expect(mockCreateHost).toHaveBeenCalledTimes(3);
    });
    await waitFor(() => {
      expect(mockSetSelectedHostIds).toHaveBeenCalledWith([
        "h-chatgpt",
        "h-claude",
        "h-cursor",
      ]);
    });
  });

  // The lead moves independently of the compare array: the global host bar
  // switches the previewed client through `savePreviewedHostId` alone and
  // never touches the lineup. So a mid-seed guard that compares only the
  // array sees "nothing changed" and the seed's own `savePreviewedHostId`
  // overwrites the client the user just switched to.
  it("keeps a previewed client switched mid-seed, even though the compare lineup is untouched", async () => {
    multiHostFixture.multiHostEnabled = false;
    multiHostFixture.hostList = [];
    // Hold the three creates open so the switch below lands strictly between
    // the seed effect's snapshot and its completion — the only window in
    // which this bug is reachable.
    const releaseCreate: Array<(host: { hostId: string }) => void> = [];
    mockCreateHost.mockImplementation(
      () =>
        new Promise((resolve) => {
          releaseCreate.push(resolve as (host: { hostId: string }) => void);
        })
    );

    render(<PlaygroundMain {...defaultProps} />);

    await waitFor(() => {
      expect(releaseCreate).toHaveLength(3);
    });

    // The user picks a client in the global host bar while the creates are
    // still in flight. Lead only — the lineup stays exactly as snapshotted.
    savePreviewedHostId("default", "h-user-picked");

    await act(async () => {
      releaseCreate[0]({ hostId: "h-chatgpt" });
      releaseCreate[1]({ hostId: "h-claude" });
      releaseCreate[2]({ hostId: "h-cursor" });
    });

    await waitFor(() => {
      expect(mockCreateHost).toHaveBeenCalledTimes(3);
    });
    expect(readPreviewedHostId()).toBe("h-user-picked");
    expect(loadSelectedHostIds("default")).toEqual([]);
    expect(mockSetSelectedHostIds).not.toHaveBeenCalledWith([
      "h-chatgpt",
      "h-claude",
      "h-cursor",
    ]);
  });

  it("chooses a fallback lead after a user changes only the compare lineup mid-seed", async () => {
    multiHostFixture.multiHostEnabled = false;
    multiHostFixture.hostList = [];
    const releaseCreate: Array<(host: { hostId: string }) => void> = [];
    mockCreateHost.mockImplementation(
      () =>
        new Promise((resolve) => {
          releaseCreate.push(resolve as (host: { hostId: string }) => void);
        })
    );

    const { rerender } = render(<PlaygroundMain {...defaultProps} />);
    await waitFor(() => {
      expect(releaseCreate).toHaveLength(3);
    });

    // The user changes only the compare lineup. With no previewed host yet,
    // the fallback is deferred until the seed finishes so this choice is not
    // overwritten by the seed itself.
    saveSelectedHostIds("default", ["h-chatgpt"]);
    multiHostFixture.selectedHostIds = ["h-chatgpt"];
    multiHostFixture.hostList = [
      { hostId: "h-claude", name: "Claude" },
      { hostId: "h-chatgpt", name: "ChatGPT" },
      { hostId: "h-cursor", name: "Cursor" },
    ];
    rerender(<PlaygroundMain {...defaultProps} />);
    expect(readPreviewedHostId()).toBeNull();

    await act(async () => {
      releaseCreate[0]({ hostId: "h-claude" });
      releaseCreate[1]({ hostId: "h-chatgpt" });
      releaseCreate[2]({ hostId: "h-cursor" });
    });

    await waitFor(() => {
      expect(readPreviewedHostId()).toBe("h-chatgpt");
    });
    expect(loadSelectedHostIds("default")).toEqual(["h-chatgpt"]);
  });

  it("keeps Claude as lead when ChatGPT reaches the host list first", async () => {
    multiHostFixture.multiHostEnabled = false;
    multiHostFixture.hostList = [];
    const releaseCreate: Array<(host: { hostId: string }) => void> = [];
    mockCreateHost.mockImplementation(
      () =>
        new Promise((resolve) => {
          releaseCreate.push(resolve as (host: { hostId: string }) => void);
        })
    );

    const { rerender } = render(<PlaygroundMain {...defaultProps} />);

    await waitFor(() => {
      expect(releaseCreate).toHaveLength(3);
    });

    // ChatGPT resolves before the first seed (Claude), so a generic fallback
    // would otherwise make ChatGPT the automatic default.
    await act(async () => {
      releaseCreate[1]({ hostId: "h-chatgpt" });
    });
    multiHostFixture.hostList = [{ hostId: "h-chatgpt", name: "ChatGPT" }];
    rerender(<PlaygroundMain {...defaultProps} />);
    await waitFor(() => {
      expect(readPreviewedHostId()).toBeNull();
    });

    multiHostFixture.hostList = [
      { hostId: "h-claude", name: "Claude" },
      { hostId: "h-chatgpt", name: "ChatGPT" },
      { hostId: "h-cursor", name: "Cursor" },
    ];
    rerender(<PlaygroundMain {...defaultProps} />);

    await act(async () => {
      releaseCreate[0]({ hostId: "h-claude" });
      releaseCreate[2]({ hostId: "h-cursor" });
    });

    await waitFor(() => {
      expect(loadSelectedHostIds("default")).toEqual([
        "h-claude",
        "h-chatgpt",
        "h-cursor",
      ]);
    });
    expect(readPreviewedHostId()).toBe("h-claude");
  });

  it("seeds 3 default clients for each empty project", async () => {
    multiHostFixture.multiHostEnabled = false;
    multiHostFixture.hostList = [];
    mockCreateHost
      .mockResolvedValueOnce({
        hostId: "h-first-chatgpt",
        hostConfigId: "h-first-chatgpt-config",
      })
      .mockResolvedValueOnce({
        hostId: "h-first-claude",
        hostConfigId: "h-first-claude-config",
      })
      .mockResolvedValueOnce({
        hostId: "h-first-cursor",
        hostConfigId: "h-first-cursor-config",
      })
      .mockResolvedValueOnce({
        hostId: "h-second-chatgpt",
        hostConfigId: "h-second-chatgpt-config",
      })
      .mockResolvedValueOnce({
        hostId: "h-second-claude",
        hostConfigId: "h-second-claude-config",
      })
      .mockResolvedValueOnce({
        hostId: "h-second-cursor",
        hostConfigId: "h-second-cursor-config",
      });

    const { rerender } = render(<PlaygroundMain {...defaultProps} />);

    await waitFor(() => {
      expect(readPreviewedHostId("default")).toBe("h-first-chatgpt");
    });
    expect(mockCreateHost).toHaveBeenCalledTimes(3);
    expect(mockSetSelectedHostIds).toHaveBeenCalledWith([
      "h-first-chatgpt",
      "h-first-claude",
      "h-first-cursor",
    ]);

    rerender(<PlaygroundMain {...defaultProps} activeProjectId="second" />);

    await waitFor(() => {
      expect(readPreviewedHostId("second")).toBe("h-second-chatgpt");
    });
    expect(mockCreateHost).toHaveBeenCalledTimes(6);
    // Assert the SECOND project's seed the same way as the first: a
    // regression that seeds the wrong templates (or leaves compare off) for
    // a later empty project shouldn't slip through just because it isn't the
    // first one seeded.
    expect(mockCreateHost).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: "second", name: "ChatGPT" })
    );
    expect(mockCreateHost).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: "second", name: "Claude" })
    );
    expect(mockCreateHost).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: "second", name: "Cursor" })
    );
    expect(mockSetSelectedHostIds).toHaveBeenCalledWith([
      "h-second-chatgpt",
      "h-second-claude",
      "h-second-cursor",
    ]);
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

    render(<PlaygroundMain {...defaultProps} />);

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

  it("passes each host id into the per-column hosted runtime context", () => {
    const hostA = makeHost("h-A", "Host A", { hostStyle: "chatgpt" });
    const hostB = makeHost("h-B", "Host B", { hostStyle: "claude" });
    multiHostFixture.hostList = [
      { hostId: "h-A", name: "Host A" },
      { hostId: "h-B", name: "Host B" },
    ];
    multiHostFixture.hosts = { "h-A": hostA, "h-B": hostB };
    multiHostFixture.selectedHostIds = ["h-A", "h-B"];

    render(<PlaygroundMain {...defaultProps} />);

    const lastByCompareId = new Map<string, any>();
    for (const [props] of mockMultiModelPlaygroundCard.mock.calls) {
      lastByCompareId.set(props.compareId, props);
    }

    expect(lastByCompareId.get("h-A")?.hostedContext?.hostId).toBe("h-A");
    expect(lastByCompareId.get("h-B")?.hostedContext?.hostId).toBe("h-B");
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

  it("multi-host cards hide Latency/Tokens chrome but show host identity", () => {
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
    // Latency/Tokens block. Identity header brands each column; the tab
    // strip stays via `showTraceTabs` inside `ModelCompareCardHeader`.
    for (const [props] of calls) {
      expect(props.showComparisonChrome).toBe(false);
      expect(props.showIdentityHeader).toBe(true);
      expect(typeof props.logoSrc).toBe("string");
      expect(props.logoSrc.length).toBeGreaterThan(0);
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

  it("chat-input client chip is controlled: receives the SAME selectedHostIds + setters as the grid uses (Blocker 1)", () => {
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

    // The standalone "Compare" picker moved into the chat-input client chip:
    // host state is now wired through `ChatInput`'s `clientSelector` prop. It
    // must get the same array (by ref) and the same setters PlaygroundMain
    // owns — guarding against a regression to a separate `usePersistedHost`
    // instance (separate array refs + setter identities that drift).
    expect(mockChatInput).toHaveBeenCalled();
    const clientSelector =
      mockChatInput.mock.calls[mockChatInput.mock.calls.length - 1][0]
        .clientSelector;
    expect(clientSelector).toBeDefined();
    expect(clientSelector.selectedHostIds).toBe(
      multiHostFixture.selectedHostIds
    );
    // PUR-11 removed the "Multiple clients" toggle, and with it the selector's
    // `multiHostEnabled` input — compare state is derived from the lineup
    // length. The `onMultiHostEnabledChange` callback stays: it's how the
    // selector keeps the parent's multi-model mutual exclusion in sync.
    expect(clientSelector.multiHostEnabled).toBeUndefined();
    expect(typeof clientSelector.onSelectedHostIdsChange).toBe("function");
    expect(typeof clientSelector.onMultiHostEnabledChange).toBe("function");
    expect(typeof clientSelector.onPromoteLead).toBe("function");

    // Setter from the client chip maps to the parent's hook setter (single
    // source of truth — no separate hook instance to drift away).
    clientSelector.onSelectedHostIdsChange(["h-B", "h-A"]);
    expect(mockSetSelectedHostIds).toHaveBeenCalledWith(["h-B", "h-A"]);

    // `usePersistedHost` was called with `multiHostProjectId` — the
    // grid's storage scope. There is no separate picker hook anymore.
    expect(usePersistedHostProjectIds.length).toBeGreaterThan(0);
  });

  it("client chip host state matches multiHostProjectId scope in shared-project flows (Blocker 2)", () => {
    // Mirror the shared-project shape: `appState.projects[active]`
    // has a `sharedProjectId` distinct from the local `activeProjectId`.
    // The grid's `usePersistedHost` is scoped to `convexProjectId`; the
    // chat-input run picker reads that SAME lifted state, so there's no
    // second storage scope to diverge (`...:{activeProjectId}` vs
    // `...:{convexProjectId}`).
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
      <PlaygroundMain {...defaultProps} activeProjectId="local-project" />
    );

    // Grid's `usePersistedHost` is scoped to `convexProjectId`.
    expect(usePersistedHostProjectIds.at(-1)).toBe("convex-shared-id");

    // The client chip received the SAME lifted array — its reads align with
    // the grid's storage scope (one source of truth, not two).
    const clientSelector =
      mockChatInput.mock.calls[mockChatInput.mock.calls.length - 1][0]
        .clientSelector;
    expect(clientSelector?.selectedHostIds).toBe(
      multiHostFixture.selectedHostIds
    );
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
      expectedExecutionConfig
    );
    expect(lastByCompareId.get("h-C").executionConfig).toEqual(
      expectedExecutionConfig
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

  // -----------------------------------------------------------------
  // Reviewer-flagged P1 routing blockers — every spot in PlaygroundMain
  // that previously branched on `isMultiModelMode` and writes to (or
  // reads from) the compare cards needs to fire for host-axis compare
  // too. These tests pin down each routing decision so a future
  // mode-flag refactor can't silently regress host compare.
  // -----------------------------------------------------------------

  it("submit in multi-host mode broadcasts to the compare cards and does NOT also fire the hidden root sendMessage", async () => {
    // P1 #1. Pre-fix the submit handler branched on `isMultiModelMode`,
    // so multi-host mode fell through the `else` branch which called
    // BOTH `queueBroadcastRequest` AND `sendMessage`. The hidden run
    // produced a duplicate stream and broke the transcript-handoff
    // baseline.
    const hostA = makeHost("h-A", "Host A", { hostStyle: "chatgpt" });
    const hostB = makeHost("h-B", "Host B", { hostStyle: "claude" });
    multiHostFixture.hostList = [
      { hostId: "h-A", name: "Host A" },
      { hostId: "h-B", name: "Host B" },
    ];
    multiHostFixture.hosts = { "h-A": hostA, "h-B": hostB };
    multiHostFixture.selectedHostIds = ["h-A", "h-B"];
    multiHostFixture.multiHostEnabled = true;

    render(<PlaygroundMain {...defaultProps} />);

    // The composer's input lives inside `useComposerOnboarding`. Drive
    // it via the captured `onChange` so `composer.input` becomes
    // non-empty; otherwise `onSubmit` short-circuits on the empty-
    // content guard.
    const initialInputProps = mockChatInput.mock.calls.at(-1)![0];
    await act(async () => {
      initialInputProps.onChange("hello hosts");
    });

    const updatedInputProps = mockChatInput.mock.calls.at(-1)![0];
    await act(async () => {
      await updatedInputProps.onSubmit({
        preventDefault: () => {},
      } as any);
    });

    // The hidden parent chat session must NOT have been kicked off —
    // multi-host mode broadcasts only to the visible cards.
    expect(mockUseChatSession.sendMessage).not.toHaveBeenCalled();

    // The compare cards must have received a fresh broadcast request.
    const broadcastsAfter = mockMultiModelPlaygroundCard.mock.calls
      .map(([props]) => props.broadcastRequest)
      .filter(Boolean);
    expect(broadcastsAfter.length).toBeGreaterThan(0);
    const latestBroadcast = broadcastsAfter.at(-1)!;
    expect(latestBroadcast.text).toBe("hello hosts");
  });

  it("deterministic tool execution in multi-host mode fans out to the visible cards (not the hidden root session)", () => {
    // P1 #2. Pre-fix the deterministic-execution effect branched on
    // `isMultiModelMode`, so in host compare a `pendingExecution` was
    // appended to the hidden root `messages` via `setMessages` instead
    // of being broadcast via `deterministicExecutionRequest`.
    const hostA = makeHost("h-A", "Host A", { hostStyle: "chatgpt" });
    const hostB = makeHost("h-B", "Host B", { hostStyle: "claude" });
    multiHostFixture.hostList = [
      { hostId: "h-A", name: "Host A" },
      { hostId: "h-B", name: "Host B" },
    ];
    multiHostFixture.hosts = { "h-A": hostA, "h-B": hostB };
    multiHostFixture.selectedHostIds = ["h-A", "h-B"];
    multiHostFixture.multiHostEnabled = true;

    const pendingExecution = {
      toolName: "echo",
      params: { value: "ping" },
      result: { value: "ping" },
      toolMeta: {},
      state: "output-available" as const,
      errorText: undefined,
      renderOverride: undefined,
      toolCallId: "tc-1",
      replaceExisting: false,
    };

    const { rerender } = render(<PlaygroundMain {...defaultProps} />);
    rerender(
      <PlaygroundMain {...defaultProps} pendingExecution={pendingExecution} />
    );

    // Every visible card should have received the broadcast.
    const latestByCompareId = new Map<string, any>();
    for (const [props] of mockMultiModelPlaygroundCard.mock.calls) {
      latestByCompareId.set(props.compareId, props);
    }
    for (const id of ["h-A", "h-B"]) {
      const props = latestByCompareId.get(id);
      expect(props.deterministicExecutionRequest).not.toBeNull();
      expect(props.deterministicExecutionRequest.toolName).toBe("echo");
      expect(props.deterministicExecutionRequest.toolCallId).toBe("tc-1");
    }
    // The hidden root chat must NOT have grown — the host-mode branch
    // can't fall through to `setMessages` like single-pane does.
    expect(mockUseChatSession.setMessages).not.toHaveBeenCalled();
  });

  it("compare state (compareHasMessages) survives a chat-input model change in multi-host mode (host-id entries not pruned)", () => {
    // P1 #3. Pre-fix the prune effect computed activeIds from
    // `resolvedSelectedModels` only, so any time the user changed the
    // chat-input model the host-keyed entries (compareHasMessages,
    // compareSummaries) were evicted — the grid would visually
    // collapse to its empty state despite the cards still holding
    // live transcripts. Active-id set now includes host compareIds.
    const hostA = makeHost("h-A", "Host A", { hostStyle: "chatgpt" });
    const hostB = makeHost("h-B", "Host B", { hostStyle: "claude" });
    multiHostFixture.hostList = [
      { hostId: "h-A", name: "Host A" },
      { hostId: "h-B", name: "Host B" },
    ];
    multiHostFixture.hosts = { "h-A": hostA, "h-B": hostB };
    multiHostFixture.selectedHostIds = ["h-A", "h-B"];
    multiHostFixture.multiHostEnabled = true;

    const previousSelectedModel = mockUseChatSession.selectedModel;
    try {
      const { rerender } = render(<PlaygroundMain {...defaultProps} />);

      // Mark h-A as having messages via the card's captured callback
      // (mirrors what `useChatSession.messages` length flips would do
      // in the real card).
      const hostACard = mockMultiModelPlaygroundCard.mock.calls
        .map(([props]) => props)
        .filter((props) => props.compareId === "h-A")
        .at(-1);
      expect(hostACard).toBeDefined();
      act(() => {
        hostACard.onHasMessagesChange("h-A", true);
      });

      const compareSection = screen.getByTestId(
        "playground-multi-host-compare-section"
      );
      expect(compareSection).toHaveAttribute("aria-hidden", "false");

      // Now swap the chat-input model. Pre-fix this triggered the
      // model-only prune effect which dropped h-A from
      // `compareHasMessages` even though the card transcript still
      // exists. The section would flip to aria-hidden=true.
      mockUseChatSession.selectedModel = {
        id: "anthropic/claude-sonnet-4.5",
        name: "Claude Sonnet 4.5",
        provider: "anthropic",
        contextWindow: 8192,
        maxOutputTokens: 4096,
        supportsTools: true,
        supportsVision: false,
        supportsStreaming: true,
      } as any;
      rerender(<PlaygroundMain {...defaultProps} />);

      expect(
        screen.getByTestId("playground-multi-host-compare-section")
      ).toHaveAttribute("aria-hidden", "false");
    } finally {
      mockUseChatSession.selectedModel = previousSelectedModel;
    }
  });

  it("stop control in multi-host mode bumps the broadcast stop-request and does NOT hit the hidden root stop()", () => {
    // P1 #4. `useChatStopControls` previously took `isMultiModelMode`
    // and would call the root `stop()` in host compare — leaving the
    // visible per-card streams running. Renamed to `isCompareMode` so
    // host compare routes through `setStopBroadcastRequestId`.
    const hostA = makeHost("h-A", "Host A", { hostStyle: "chatgpt" });
    const hostB = makeHost("h-B", "Host B", { hostStyle: "claude" });
    multiHostFixture.hostList = [
      { hostId: "h-A", name: "Host A" },
      { hostId: "h-B", name: "Host B" },
    ];
    multiHostFixture.hosts = { "h-A": hostA, "h-B": hostB };
    multiHostFixture.selectedHostIds = ["h-A", "h-B"];
    multiHostFixture.multiHostEnabled = true;

    render(<PlaygroundMain {...defaultProps} />);

    const stopRequestIdsBefore = mockMultiModelPlaygroundCard.mock.calls.map(
      ([props]) => props.stopRequestId
    );
    const baselineStopRequestId = stopRequestIdsBefore.at(-1) ?? 0;

    const inputProps = mockChatInput.mock.calls.at(-1)![0];
    act(() => {
      inputProps.stop();
    });

    expect(mockUseChatSession.stop).not.toHaveBeenCalled();

    const latestStopRequestId = mockMultiModelPlaygroundCard.mock.calls
      .map(([props]) => props.stopRequestId)
      .at(-1);
    expect(latestStopRequestId).toBeGreaterThan(baselineStopRequestId);
  });

  it("enabling multi-model while in host compare clears the host lineup too (no 'two checked, Compare off' limbo)", () => {
    // Reviewer-flagged UX blocker. Pre-fix `handleMultiModelEnabledChange`
    // set `multiHostEnabled=false` but kept `selectedHostIds` intact.
    // The picker then read `effectiveSelectedHostIds.length === 2` and
    // showed two clients still ticked in the popover — with the
    // trigger displaying "Compare" (idle) — so the user had to
    // uncheck/recheck a client to re-enter compare. Now we also
    // collapse `selectedHostIds` so the next compare entry starts
    // clean from the live lead.
    const hostA = makeHost("h-A", "Host A", { hostStyle: "chatgpt" });
    const hostB = makeHost("h-B", "Host B", { hostStyle: "claude" });
    multiHostFixture.hostList = [
      { hostId: "h-A", name: "Host A" },
      { hostId: "h-B", name: "Host B" },
    ];
    multiHostFixture.hosts = { "h-A": hostA, "h-B": hostB };
    multiHostFixture.selectedHostIds = ["h-A", "h-B"];
    multiHostFixture.multiHostEnabled = true;

    render(<PlaygroundMain {...defaultProps} />);

    // Grab the picker's `onMultiModelEnabledChange` from the parent-
    // owned chat input props and fire it. (The chat input is the
    // surface that toggles the model-mode flag.)
    const inputProps = mockChatInput.mock.calls.at(-1)![0];
    expect(typeof inputProps.onMultiModelEnabledChange).toBe("function");

    act(() => {
      inputProps.onMultiModelEnabledChange(true);
    });

    // Multi-host was force-cleared AND the host lineup was collapsed
    // — those are the two mutations that prevent the limbo state.
    expect(mockSetMultiHostEnabled).toHaveBeenCalledWith(false);
    expect(mockSetSelectedHostIds).toHaveBeenCalledWith([]);
  });

  it("falls back to single-pane when multi-host is persisted on but only one host resolves (length>1 gate)", () => {
    // Valid-but-lower reviewer finding. The picker auto-disables
    // `multiHostEnabled` on the 2 → 1 transition, but a stale
    // localStorage value (or a secondary that briefly unresolves)
    // would otherwise let the grid render as a one-column variant
    // of single-pane — routing submit / stop / state through the
    // compare path with no compare value. `isMultiHostMode` now
    // requires `resolvedSelectedHosts.length > 1`.
    const hostA = makeHost("h-A", "Host A", { hostStyle: "chatgpt" });
    multiHostFixture.hostList = [
      { hostId: "h-A", name: "Host A" },
      { hostId: "h-B", name: "Host B" }, // exists in project — canEnableMultiHost passes
    ];
    multiHostFixture.hosts = { "h-A": hostA }; // h-B intentionally unresolved
    multiHostFixture.selectedHostIds = ["h-A"];
    multiHostFixture.multiHostEnabled = true;

    render(<PlaygroundMain {...defaultProps} />);

    expect(screen.queryByTestId("playground-multi-host-grid")).toBeNull();
  });
});

// ── Project Environments — Phase 2 (Playground integration) ────────────────
describe("PlaygroundMain — environment mode", () => {
  const defaultProps = {
    activeProjectId: "default",
    serverName: "test-server",
    pendingExecution: null,
    onExecutionInjected: vi.fn(),
  };

  const preview = {
    specVersion: 1,
    environment: { environmentId: "env_1", name: "Staging", revision: 3 },
    host: {
      hostId: "h-A",
      hostName: "Host A",
      hostConfigId: "cfg_1",
      modelId: null,
      hostStyle: null,
      harness: null,
    },
    servers: [
      { serverId: "srv_plugin", name: "Docs", source: "plugin" as const },
    ],
    skills: [],
    plugins: [],
    capabilities: {
      requireToolApproval: null,
      respectToolVisibility: null,
      progressiveToolDiscovery: null,
      builtInToolIds: [],
      hasComputer: false,
      serverCount: 1,
      skillCount: 0,
      skillDelivery: "emulated" as const,
      pluginCount: 0,
      serversOverridden: false,
    },
  };

  function selectEnvironment() {
    environmentsFlag.value = true;
    environmentPreviewFixture.value = preview;
    localStorage.setItem(
      "mcp-previewed-environment-id",
      JSON.stringify({ default: "env_1" })
    );
  }

  it("does not touch the hosted context while the flag is off", () => {
    // Everything shipped before this phase was inert; that must stay true for
    // users without the flag even if they somehow have a persisted selection.
    localStorage.setItem(
      "mcp-previewed-environment-id",
      JSON.stringify({ default: "env_1" })
    );
    environmentPreviewFixture.value = preview;
    multiHostFixture.hostList = [{ hostId: "h-A", name: "Host A" }];

    render(<PlaygroundMain {...defaultProps} />);

    expect(capturedChatSessionOptions?.hostedContext?.executionTarget).toBe(
      undefined
    );
  });

  it("targets the environment and stops sending a legacy hostId", () => {
    selectEnvironment();
    multiHostFixture.hostList = [{ hostId: "h-A", name: "Host A" }];

    render(<PlaygroundMain {...defaultProps} />);

    const hostedContext = capturedChatSessionOptions?.hostedContext;
    expect(hostedContext?.executionTarget).toEqual({
      kind: "environment",
      environmentId: "env_1",
    });
    // `hostId` + `executionTarget` in one body is a 400, not a precedence
    // question — the environment's host is presentation only.
    expect(hostedContext?.hostId).toBeUndefined();
    // No override until the user asks for one.
    expect(hostedContext?.environmentOverrides).toBeUndefined();
    // The environment's servers resolve server-side (some are plugin-owned and
    // invisible to the browser catalog), so the turn must use /api/web/chat-v2
    // and must NOT run the name→id persistence preflight.
    expect(hostedContext?.requiresWebChatApi).toBe(true);
    expect(hostedContext?.ensureServerIds).toBeUndefined();
  });

  it("blocks sends while the selected environment is still resolving", () => {
    // Activating the target is synchronous; the scope re-key and the
    // preview→previewed-host sync are not. A turn submitted in that window
    // carries the NEW environment id with the PREVIOUS host's model, system
    // prompt and approval setting, and the scope reset that follows can drop
    // the in-flight message.
    environmentsFlag.value = true;
    environmentPreviewFixture.value = null;
    localStorage.setItem(
      "mcp-previewed-environment-id",
      JSON.stringify({ default: "env_1" })
    );
    multiHostFixture.hostList = [{ hostId: "h-A", name: "Host A" }];

    render(<PlaygroundMain {...defaultProps} />);

    expect(mockChatInput.mock.calls.at(-1)![0].submitDisabled).toBe(true);
  });

  it("re-opens sends once the environment has resolved", () => {
    // Control for the gate above — it must be a transition gate, not a
    // permanent block on environment mode.
    selectEnvironment();
    multiHostFixture.hostList = [{ hostId: "h-A", name: "Host A" }];

    render(<PlaygroundMain {...defaultProps} />);

    expect(mockChatInput.mock.calls.at(-1)![0].submitDisabled).toBe(false);
  });

  it("blocks sends while a live EDIT of the selected environment is refetching", () => {
    // The gap the other two gates cannot see. Editing the SELECTED environment
    // refetches without blanking the panel (live-config semantics), so the
    // preview on screen is the STALE one: a preview exists, so nothing is
    // "resolving", and the previewed host still matches the OLD host id the
    // stale body reports. If that edit repointed the environment at another
    // host, a turn sent here resolves server-side against the NEW host while
    // carrying the PREVIOUS host's model, system prompt and approval setting.
    selectEnvironment();
    environmentPreviewLoading.value = true;
    multiHostFixture.hostList = [{ hostId: "h-A", name: "Host A" }];

    render(<PlaygroundMain {...defaultProps} />);

    expect(mockChatInput.mock.calls.at(-1)![0].submitDisabled).toBe(true);
  });

  it("exits multi-host comparison when an environment is selected", () => {
    // An environment names exactly one host; comparison exists to run one turn
    // against several. Both being true would misreport what ran.
    selectEnvironment();
    multiHostFixture.multiHostEnabled = true;
    multiHostFixture.hostList = [
      { hostId: "h-A", name: "Host A" },
      { hostId: "h-B", name: "Host B" },
    ];
    multiHostFixture.selectedHostIds = ["h-A", "h-B"];

    render(<PlaygroundMain {...defaultProps} />);

    expect(mockSetMultiHostEnabled).toHaveBeenCalledWith(false);
  });
});
