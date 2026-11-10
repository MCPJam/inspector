import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  act,
  render,
  renderHook,
  screen,
  fireEvent,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode } from "react";
import type {
  MCPConformanceResult,
  MCPAppsConformanceResult,
  MCPTasksConformanceResult,
  ConformanceResult as OAuthConformanceResult,
} from "@mcpjam/sdk";
import type { ServerWithName } from "@/hooks/use-app-state";

const { enabledFlags } = vi.hoisted(() => ({
  enabledFlags: new Set<string>(),
}));

vi.mock("posthog-js/react", () => ({
  useFeatureFlagEnabled: (key: string) => enabledFlags.has(key),
}));

// Home cards subscribe to each run for suite scores. These tests render
// the home without a Convex client, so the suite rows stay empty.
vi.mock("convex/react", () => ({
  useQuery: () => undefined,
}));

vi.mock("../PersistConformanceRun", () => ({ PersistConformanceRun: () => null }));

const mockRunProtocol = vi.fn();
const mockRunApps = vi.fn();
const mockRunTasks = vi.fn();
const mockStartOAuth = vi.fn();
const mockSubmitCode = vi.fn();
const mockCompleteOAuth = vi.fn();

vi.mock("@/lib/apis/conformance-connection-api", () => ({
  checkConformanceConnection: vi.fn(
    async (_server: string, version: string) => ({
      status: "ready",
      protocolVersion: version === "auto" ? "2025-11-25" : version,
    }),
  ),
}));

vi.mock("@/lib/apis/mcp-conformance-api", () => ({
  cancelOAuthConformance: vi.fn(async () => ({ success: true })),
  runProtocolConformance: (...args: unknown[]) => mockRunProtocol(...args),
  runAppsConformance: (...args: unknown[]) => mockRunApps(...args),
  runTasksConformance: (...args: unknown[]) => mockRunTasks(...args),
  startOAuthConformance: (...args: unknown[]) => mockStartOAuth(...args),
  submitOAuthConformanceCode: (...args: unknown[]) => mockSubmitCode(...args),
  completeOAuthConformance: (...args: unknown[]) => mockCompleteOAuth(...args),
}));

// Group scheduling and aggregation are covered by run-task-conformance-groups.test.ts.
// These panel tests supply the completed suite report.
vi.mock("@/hooks/run-task-conformance-groups", () => ({
  runTaskConformanceGroups: async (
    server: string,
    options: Record<string, unknown>,
    _isActive: () => boolean,
    remainingBudget: () => Record<string, unknown>,
  ) => (await mockRunTasks(server, { ...options, ...remainingBudget() })).result,
}));

// Step 2 lists a server's tools for the checks that must call one.
const mockListTools = vi.fn(async () => ({ tools: [] as unknown[] }));
vi.mock("@/lib/apis/mcp-tools-api", () => ({
  listTools: (...args: unknown[]) => mockListTools(...args),
}));

vi.mock("@/components/oauth/utils", () => ({
  deriveOAuthProfileFromServer: () => ({
    serverUrl: "https://test.com",
    clientId: "",
    clientSecret: "",
    scopes: "",
    customHeaders: [],
    protocolVersion: "2025-11-25",
    registrationStrategy: "cimd",
  }),
}));

import { cancelOAuthConformance } from "@/lib/apis/mcp-conformance-api";
import { useConformanceRun } from "@/hooks/use-conformance-run";
import { checkConformanceConnection } from "@/lib/apis/conformance-connection-api";
import { toast } from "@/lib/toast";
import { MCP_TASKS_CHECK_IDS, TASKS_CHECK_CATALOG } from "@mcpjam/sdk/browser";
import { OAUTH_CATALOG } from "../conformance-catalogs";
import { ConformanceTab } from "../ConformanceTab";
import {
  ConformanceServerPicker,
  ProtocolVersionSelect,
  RUN_LABEL,
} from "../ConformancePageChrome";
import { SUITE_COPY } from "../conformance-ui";

/** A tool option: its name, then its safety badge. */
const toolOption = (name: string, tag: string) =>
  new RegExp(`^${name}\\s*·\\s*${tag}$`);

function createProtocolResult(
  overrides: Partial<MCPConformanceResult> = {},
): MCPConformanceResult {
  return {
    passed: true,
    serverUrl: "https://example.com/mcp",
    summary: "Protocol summary",
    durationMs: 5,
    checks: [],
    categorySummary: {
      core: { total: 0, passed: 0, failed: 0, skipped: 0 },
      protocol: { total: 0, passed: 0, failed: 0, skipped: 0 },
      tools: { total: 0, passed: 0, failed: 0, skipped: 0 },
      prompts: { total: 0, passed: 0, failed: 0, skipped: 0 },
      resources: { total: 0, passed: 0, failed: 0, skipped: 0 },
      security: { total: 0, passed: 0, failed: 0, skipped: 0 },
      transport: { total: 0, passed: 0, failed: 0, skipped: 0 },
    },
    ...overrides,
  };
}

function createAppsResult(
  overrides: Partial<MCPAppsConformanceResult> = {},
): MCPAppsConformanceResult {
  return {
    passed: true,
    target: "https://example.com/mcp",
    summary: "Apps summary",
    durationMs: 5,
    checks: [],
    categorySummary: {
      tools: { total: 0, passed: 0, failed: 0, skipped: 0 },
      resources: { total: 0, passed: 0, failed: 0, skipped: 0 },
    },
    discovery: {
      toolCount: 0,
      uiToolCount: 0,
      listedResourceCount: 0,
      listedUiResourceCount: 0,
      checkedUiResourceCount: 0,
    },
    ...overrides,
  };
}

function createTasksResult(
  overrides: Partial<MCPTasksConformanceResult> = {},
): MCPTasksConformanceResult {
  return {
    passed: true,
    target: "https://example.com/mcp",
    summary: "Tasks summary",
    durationMs: 5,
    checks: [],
    categorySummary: {
      dispatch: { total: 0, passed: 0, failed: 0, skipped: 0 },
      creation: { total: 0, passed: 0, failed: 0, skipped: 0 },
      lifecycle: { total: 0, passed: 0, failed: 0, skipped: 0 },
    },
    discovery: {
      protocolVersion: "2026-07-28",
      wire: "extension",
      toolCount: 1,
      taskCapableToolCount: 0,
    },
    ...overrides,
  };
}

function createOAuthResult(
  overrides: Partial<OAuthConformanceResult> = {},
): OAuthConformanceResult {
  return {
    passed: true,
    outcome: "passed",
    protocolVersion: "2025-11-25",
    registrationStrategy: "cimd",
    serverUrl: "https://example.com/mcp",
    summary: "OAuth summary",
    durationMs: 5,
    steps: [],
    ...overrides,
  };
}

function setupSuccessfulRunMocks({
  protocol = createProtocolResult(),
  apps = createAppsResult(),
  oauth = createOAuthResult(),
}: {
  protocol?: MCPConformanceResult;
  apps?: MCPAppsConformanceResult;
  oauth?: OAuthConformanceResult;
} = {}) {
  mockRunProtocol.mockResolvedValue({ success: true, result: protocol });
  mockRunApps.mockResolvedValue({ success: true, result: apps });
  mockRunTasks.mockResolvedValue({
    success: true,
    result: createTasksResult(),
  });
  mockStartOAuth.mockResolvedValue({ phase: "complete", result: oauth });
}

function clickRow(title: string) {
  const button = screen.getByText(title).closest("button");
  expect(button).not.toBeNull();
  fireEvent.click(button!);
}

/**
 * Before a run the header and the pre-run prompt both offer Run; either starts
 * it. With a server list, Run opens the setup steps first: continue through
 * both, unless step 1 cannot continue.
 */
async function clickRun() {
  // After a run the run header offers "Run again" instead.
  fireEvent.click(screen.getAllByRole("button", { name: RUN_OR_AGAIN })[0]);
  const next = screen.queryByRole("button", { name: "Continue" });
  if (!next) return;
  if (screen.queryByText(/Finding a protocol version|Connecting with/))
    await waitFor(() => expect(next).toBeEnabled());
  if ((next as HTMLButtonElement).disabled) return;
  fireEvent.click(next);
  fireEvent.click(screen.getByRole("button", { name: RUN_LABEL }));
}

async function continueSetup() {
  const next = screen.getByRole("button", { name: "Continue" });
  await waitFor(() => expect(next).toBeEnabled());
  fireEvent.click(next);
}

/** Starts a run and waits until no suite is still running. */
async function runToCompletion() {
  await clickRun();
  // A run from the setup steps starts a tick later, on the run's own page.
  await screen.findByRole("button", {
    name: /^(Run again|Running\.\.\.|Connecting\.\.\.)$/,
  });
  await waitFor(() => {
    expect(screen.queryByText("RUNNING")).toBeNull();
    expect(
      screen.getAllByRole("button", { name: RUN_OR_AGAIN })[0],
    ).toBeEnabled();
  });
}

const RUN_OR_AGAIN = new RegExp(`^(${RUN_LABEL}|Run again)$`);

/** Step 1's server picker, named by its label and then its value. */
const SERVER_FIELD =
  /^Choose the server you want to test for protocol conformance/;

/** A server's row in the open picker: its name, not its Connect. */
function serverRow(name: string) {
  return within(screen.getByRole("dialog"))
    .getAllByRole("button", { name: new RegExp(`${name}$`) })
    .find((button) => !button.getAttribute("aria-label")?.startsWith("Connect"))!;
}

/** A suite's input badge: "optional" is set in its own element. */
function inputBadge(text: string) {
  return (_: string, element: Element | null) =>
    element?.tagName === "SPAN" && element.textContent === text;
}

/** A suite's header row, found by its description (unique, unlike titles). */
function suiteHeader(suite: keyof typeof SUITE_COPY) {
  const button = screen
    .getByText(SUITE_COPY[suite].description)
    .closest("button");
  expect(button).not.toBeNull();
  return button!;
}

/**
 * Collapsed content stays mounted so it can slide shut, marked `inert`
 * instead; "hidden" means inside an inert subtree, not absent.
 */
function isCollapsed(element: HTMLElement) {
  return element.closest("[inert]") !== null;
}

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function createHttpServer(
  overrides: Partial<ServerWithName> = {},
): ServerWithName {
  return {
    name: "http-server",
    lastConnectionTime: new Date(),
    connectionStatus: "connected",
    enabled: true,
    retryCount: 0,
    config: {
      url: "https://example.com/mcp",
      timeout: 30000,
    },
    ...overrides,
  };
}

const createRunListItem = (id: string) => ({
  _id: id,
  projectId: "proj_1",
  targetKind: "server",
  targetKey: `server:${id}`,
  serverId: id,
  source: "ui",
  verification: "mcpjam_verified" as const,
  status: "completed",
  outcome: "passed" as const,
  incompleteReason: null,
  score: 100,
  applicable: 3,
  passed: 3,
  failed: 0,
  couldNotRun: 0,
  requestedSuites: ["protocol"],
  protocolVersion: "2025-11-25",
  actorLabel: null,
  ciMetadata: null,
  createdAt: Date.UTC(2026, 9, 28, 12),
  completedAt: null,
  durationMs: null,
  sharingEnabled: false,
});

function createStdioServer(
  overrides: Partial<ServerWithName> = {},
): ServerWithName {
  return {
    name: "stdio-server",
    lastConnectionTime: new Date(),
    connectionStatus: "connected",
    enabled: true,
    retryCount: 0,
    config: {
      command: "node",
      args: ["server.js"],
    },
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  enabledFlags.clear();
  // These tests cover the update check and its answers; one below turns it off.
  enabledFlags.add("conformance-tasks-update-check");
  window.localStorage.clear();
  window.sessionStorage.clear();
});

describe("ConformanceTab", () => {
  it("explains an unsupported version above the live score without changing results", async () => {
    setupSuccessfulRunMocks({ protocol: createProtocolResult({
      passed: false,
      protocolVersion: "2026-07-28",
      checks: [{ id: "completion-complete", category: "protocol", title: "Completion", description: "Completion", status: "failed", durationMs: 1,
        error: { message: 'MCP server "http-server" doesn\'t support MCP protocol version 2026-07-28, which this client is pinned to. It offers 2025-06-18.' } }],
    }) });
    render(<ConformanceTab server={createHttpServer()} />);
    await runToCompletion();
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("http-server doesn’t support 2026-07-28. Checks requiring that version could not run.");
    expect(alert).toHaveTextContent("Server offers: 2025-06-18.");
    expect(screen.getAllByText("Completion").length).toBeGreaterThan(0);
  });

  // The page writes the active tab to `?view=`; start each test without it.
  afterEach(() => {
    window.history.replaceState(null, "", "/");
  });

  it("shows a pooled score headline with denominator, and readiness advice worth 0 points", async () => {
    setupSuccessfulRunMocks({
      protocol: createProtocolResult({
        checks: [
          {
            id: "ping",
            category: "core",
            title: "Ping",
            description: "Ping.",
            status: "passed",
            durationMs: 1,
          },
          {
            id: "tools-list",
            category: "tools",
            title: "Tools List",
            description: "List tools.",
            status: "skipped",
            skipReason: "not-applicable",
            durationMs: 0,
          },
        ],
        protocolVersion: "2025-11-25",
        readiness: [
          {
            id: "readiness-deprecated-feature-use",
            title: "Deprecated Feature Use",
            severity: "warning",
            specStrength: "Deprecation Notice",
            message: "Cacheable results advertise ttlMs: 0",
          },
        ],
      } as Partial<MCPConformanceResult>),
      apps: createAppsResult({
        checks: [
          {
            id: "ui-tools-present",
            category: "tools",
            title: "UI Tools Present",
            description: "ui",
            status: "passed",
            durationMs: 1,
          },
        ],
      }),
      oauth: createOAuthResult({
        steps: [
          {
            step: "request_without_token",
            title: "Initial MCP Request",
            summary: "first",
            status: "passed",
            durationMs: 1,
            logs: [],
            httpAttempts: [],
          },
        ],
      }),
    });
    mockRunTasks.mockResolvedValue({
      success: true,
      result: createTasksResult({
        checks: [
          {
            id: "tasks-wire-resolvable",
            category: "dispatch",
            title: "Tasks Wire Resolvable",
            description: "wire",
            status: "passed",
            durationMs: 1,
          },
        ],
      }),
    });

    render(<ConformanceTab server={createHttpServer()} />);
    await runToCompletion();

    // Pooled: 4/4 applicable across the suites = 100. The deprecation advisory
    // from protocol readiness is listed but worth 0 points.
    expect(screen.getAllByText("100").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("Conformant, with guidance.")).toBeInTheDocument();
    // The denominator travels with the number.
    expect(screen.getByText("4/4")).toBeInTheDocument();

    // The advisory sits in the one container above the
    // suites, closed with a count until opened.
    const advice = screen.getByRole("button", {
      name: /^Additional enhancements/,
    });
    expect(advice).toHaveAttribute("aria-expanded", "false");
    expect(within(advice).getByText("1")).toBeInTheDocument();
    fireEvent.click(advice);
    const row = screen.getByText("Deprecated Feature Use").closest("li")!;
    expect(row).toHaveTextContent(
      "Suggested Protocol Deprecated Feature Use",
    );
  });

  it("shows no number when nothing was applicable", async () => {
    const notApplicable = (id: string) => ({
      id,
      category: "tools" as const,
      title: id,
      description: id,
      status: "skipped" as const,
      skipReason: "not-applicable" as const,
      durationMs: 0,
    });
    setupSuccessfulRunMocks({
      protocol: createProtocolResult({
        checks: [notApplicable("tools-list")],
      }),
      apps: createAppsResult({
        checks: [notApplicable("ui-tools-present")],
      }),
      oauth: createOAuthResult({ passed: false, outcome: "not-applicable" }),
    });
    mockRunTasks.mockResolvedValue({
      success: true,
      result: createTasksResult({
        checks: [
          { ...notApplicable("tasks-wire-resolvable"), category: "dispatch" },
        ],
      }),
    });

    render(<ConformanceTab server={createHttpServer()} />);
    await runToCompletion();

    // Every check ran and none applied: a percentage would be noise dressed
    // as a number, so the card says so in words.
    expect(
      screen.getByText("Nothing applicable to score on this server."),
    ).toBeInTheDocument();
    expect(screen.queryByText("%")).toBeNull();
    const protocolHeader = screen.getByText(SUITE_COPY.protocol.title).closest("button")!;
    expect(within(protocolHeader).getByText("NOT APPLICABLE")).toBeInTheDocument();
    const appsHeader = screen.getByText(SUITE_COPY.apps.title).closest("button")!;
    expect(within(appsHeader).getByText("NOT APPLICABLE")).toBeInTheDocument();
    expect(within(appsHeader).getByText(SUITE_COPY.apps.description)).toBeInTheDocument();
    expect(appsHeader).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(appsHeader);
    expect(appsHeader).toHaveAttribute("aria-expanded", "true");
  });

  it("reads suites that ran no checks as incomplete, not as nothing applicable", async () => {
    // Zero checks establishes nothing, so the SDK scores it incomplete.
    setupSuccessfulRunMocks();

    render(<ConformanceTab server={createHttpServer()} />);
    await runToCompletion();

    expect(
      screen.getByText("Incomplete. No check finished, so there is no score."),
    ).toBeInTheDocument();
  });

  it("opens on the first-run prompt for an HTTP server", () => {
    render(<ConformanceTab server={createHttpServer()} />);

    expect(
      screen.getByRole("heading", { name: "Conformance" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Run your first conformance check"),
    ).toBeInTheDocument();
    // The header's Run and the prompt's Run.
    expect(screen.getAllByRole("button", { name: RUN_LABEL })).toHaveLength(2);
    // Suites appear only once a run starts.
    expect(screen.queryByText(SUITE_COPY.protocol.description)).toBeNull();
  });

  it("moves between Overview and History with the arrow keys", async () => {
    const user = userEvent.setup();
    render(
      <ConformanceTab
        server={createHttpServer()}
        history={<p>History table</p>}
      />,
    );

    const overview = screen.getByRole("tab", { name: "Overview" });
    const history = screen.getByRole("tab", { name: "History" });
    // Roving focus: only the active tab is in the tab order.
    expect(overview).toHaveAttribute("tabindex", "0");
    expect(history).toHaveAttribute("tabindex", "-1");
    expect(screen.getByRole("tabpanel")).toHaveAttribute(
      "aria-labelledby",
      overview.id,
    );

    overview.focus();
    await user.keyboard("{ArrowRight}");

    expect(history).toHaveFocus();
    expect(history).toHaveAttribute("aria-selected", "true");
    expect(history).toHaveAttribute(
      "aria-controls",
      "conformance-panel-history",
    );
    expect(overview).not.toHaveAttribute("aria-controls");
    expect(screen.getByRole("tabpanel")).toHaveTextContent("History table");

    // Wraps around at either end.
    await user.keyboard("{ArrowRight}");
    expect(overview).toHaveFocus();
  });

  it("opens the run when a run starts from History", async () => {
    setupSuccessfulRunMocks();
    render(
      <ConformanceTab
        server={createHttpServer()}
        history={<p>History table</p>}
      />,
    );

    fireEvent.click(screen.getByRole("tab", { name: "History" }));
    expect(screen.getByRole("tabpanel")).toHaveTextContent("History table");

    // On History only the header offers Run.
    await clickRun();

    // The run's own header, whose Back leads to History.
    expect(screen.getByTestId("conformance-run-back")).toHaveTextContent(
      "Conformance History",
    );
    expect(screen.queryByRole("button", { name: "History" })).toBeNull();
    expect(screen.queryByText("History table")).toBeNull();
    await waitFor(() => expect(mockRunProtocol).toHaveBeenCalled());
  });

  it("keeps the URL on the tab, so a refresh after Run lands on the run", async () => {
    setupSuccessfulRunMocks();
    // Arrived from a run's page, which links back with `?view=history`.
    window.history.replaceState(null, "", "/conformance?view=history");
    render(
      <ConformanceTab
        server={createHttpServer()}
        history={<p>History table</p>}
      />,
    );
    expect(screen.getByRole("tab", { name: "History" })).toHaveAttribute(
      "aria-selected",
      "true",
    );

    await runToCompletion();
    expect(window.location.search).toBe("");

    // The run started from History, so Back goes there.
    fireEvent.click(screen.getByTestId("conformance-run-back"));
    expect(window.location.search).toBe("?view=history");
    expect(screen.getByRole("tab", { name: "History" })).toHaveAttribute(
      "aria-selected",
      "true",
    );

    // The sidebar's plain `/conformance` link: the page follows the address.
    act(() => {
      window.history.pushState({}, "", "/conformance");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    expect(screen.getByRole("tab", { name: "Overview" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });

  it("stays on History when Run has no server to run", async () => {
    const info = vi.spyOn(toast, "info");
    // A selection the page does not offer: Run asks for a server instead.
    render(
      <ConformanceTab
        server={createHttpServer({ name: "removed" })}
        servers={[]}
        onSelectServer={vi.fn()}
        history={<p>History table</p>}
      />,
    );
    fireEvent.click(screen.getByRole("tab", { name: "History" }));

    await clickRun();
    expect(
      screen.getByText("Add a server to run conformance checks."),
    ).toBeInTheDocument();
    expect(info).not.toHaveBeenCalled();
    expect(mockRunProtocol).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByRole("tab", { name: "History" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    info.mockRestore();
  });

  it("asks for a server instead of running when none is selected", async () => {
    const info = vi.spyOn(toast, "info");
    render(<ConformanceTab server={null} />);

    expect(
      screen.getByText("Run your first conformance check"),
    ).toBeInTheDocument();
    await clickRun();

    expect(info).toHaveBeenCalledWith(
      "Add a server to run conformance checks.",
    );
    expect(mockRunProtocol).not.toHaveBeenCalled();
    info.mockRestore();
  });

  it("picks the first connected server when nothing usable is selected", () => {
    const onSelectServer = vi.fn();
    const servers = [
      createHttpServer({ name: "alpha" }),
      createHttpServer({ name: "beta" }),
    ];
    render(
      <ConformanceTab
        server={null}
        servers={servers}
        onSelectServer={onSelectServer}
      />,
    );
    expect(onSelectServer).toHaveBeenCalledWith("alpha");
  });

  it("returns to the server last selected here when it is still connected", () => {
    window.localStorage.setItem("mcpjam.conformance.lastServer.v1", "beta");
    const onSelectServer = vi.fn();
    // A selection that is not connected is not one this page can run.
    render(
      <ConformanceTab
        server={createHttpServer({ name: "gamma" })}
        servers={[
          createHttpServer({ name: "alpha" }),
          createHttpServer({ name: "beta" }),
        ]}
        onSelectServer={onSelectServer}
      />,
    );
    expect(onSelectServer).toHaveBeenCalledWith("beta");
  });

  it("treats a selection the page no longer offers as no server", async () => {
    const info = vi.spyOn(toast, "info");
    // The selected server was removed and the project has no other.
    render(
      <ConformanceTab
        server={createHttpServer({ name: "gamma" })}
        servers={[]}
        onSelectServer={vi.fn()}
      />,
    );

    await clickRun();

    // Run opens the setup steps, which say what is missing.
    expect(
      screen.getByText("Add a server to run conformance checks."),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Continue" })).toBeDisabled();
    expect(info).not.toHaveBeenCalled();
    expect(mockRunProtocol).not.toHaveBeenCalled();
    info.mockRestore();
  });

  it("keeps a run in flight when its server is removed, but blocks a new one", async () => {
    const pending = createDeferred<{
      success: true;
      result: MCPConformanceResult;
    }>();
    setupSuccessfulRunMocks();
    mockRunProtocol.mockReturnValue(pending.promise);
    const onSelectServer = vi.fn();
    const server = createHttpServer({ name: "alpha" });
    const { rerender } = render(
      <ConformanceTab
        server={server}
        servers={[server]}
        onSelectServer={onSelectServer}
      />,
    );
    await clickRun();
    await screen.findByText(/Running \d+ checks/);

    // The server is removed mid-run and the project has no other.
    rerender(
      <ConformanceTab
        server={server}
        servers={[]}
        onSelectServer={onSelectServer}
      />,
    );
    pending.resolve({ success: true, result: createProtocolResult() });
    await waitFor(() => {
      expect(within(suiteHeader("protocol")).getByText("PASSED")).toBeDefined();
    });

    const info = vi.spyOn(toast, "info");
    mockRunProtocol.mockClear();
    // Run again runs this server directly, which the page no longer offers.
    await clickRun();
    expect(info).toHaveBeenCalledWith(
      "Add a server to run conformance checks.",
    );
    expect(mockRunProtocol).not.toHaveBeenCalled();
    info.mockRestore();
  });

  it("stays on a reconnecting selection while another server is connected", () => {
    window.localStorage.setItem("mcpjam.conformance.lastServer.v1", "alpha");
    const onSelectServer = vi.fn();
    render(
      <ConformanceTab
        server={createHttpServer({
          name: "alpha",
          connectionStatus: "connecting",
        })}
        servers={[createHttpServer({ name: "beta" })]}
        onSelectServer={onSelectServer}
      />,
    );

    expect(onSelectServer).not.toHaveBeenCalled();
    expect(
      window.localStorage.getItem("mcpjam.conformance.lastServer.v1"),
    ).toBe("alpha");
  });

  it("keeps a connected selection and remembers it", () => {
    const onSelectServer = vi.fn();
    render(
      <ConformanceTab
        server={createHttpServer({ name: "beta" })}
        servers={[
          createHttpServer({ name: "alpha" }),
          createHttpServer({ name: "beta" }),
        ]}
        onSelectServer={onSelectServer}
      />,
    );
    expect(onSelectServer).not.toHaveBeenCalled();
    expect(
      window.localStorage.getItem("mcpjam.conformance.lastServer.v1"),
    ).toBe("beta");
  });

  it("prefers a connected server over the first when nothing is remembered", () => {
    const onSelectServer = vi.fn();
    render(
      <ConformanceTab
        server={null}
        servers={[
          createHttpServer({ name: "alpha", connectionStatus: "disconnected" }),
          createHttpServer({ name: "beta" }),
        ]}
        onSelectServer={onSelectServer}
      />,
    );
    expect(onSelectServer).toHaveBeenCalledWith("beta");
  });

  it("opens the setup steps from Run, and Cancel goes back without running", () => {
    const server = createHttpServer({ name: "alpha" });
    render(
      <ConformanceTab
        server={server}
        servers={[server]}
        onSelectServer={vi.fn()}
      />,
    );

    fireEvent.click(screen.getAllByRole("button", { name: RUN_LABEL })[0]);

    expect(
      screen.getByRole("heading", { name: "Check for conformance" }),
    ).toBeInTheDocument();
    const steps = screen.getByRole("list", { name: "Conformance setup" });
    expect(
      within(steps).getByText("Choose server and protocol"),
    ).toBeInTheDocument();
    expect(within(steps).getByText("Select what to test")).toBeInTheDocument();
    // The page's server comes preselected, on the negotiated version.
    expect(screen.getByRole("button", { name: SERVER_FIELD })).toHaveTextContent(
      "alpha",
    );
    expect(
      screen.getByRole("combobox", { name: "Select protocol version" }),
    ).toHaveTextContent("Protocol · Auto");

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(
      screen.getByText("Run your first conformance check"),
    ).toBeInTheDocument();
    expect(mockRunProtocol).not.toHaveBeenCalled();
  });

  it("lists each suite's checks in step 2, and Back keeps step 1's picks", async () => {
    const user = userEvent.setup();
    const server = createHttpServer({ name: "alpha" });
    render(
      <ConformanceTab
        server={server}
        servers={[server]}
        onSelectServer={vi.fn()}
      />,
    );
    fireEvent.click(screen.getAllByRole("button", { name: RUN_LABEL })[0]);
    await user.click(
      screen.getByRole("combobox", { name: "Select protocol version" }),
    );
    await user.click(screen.getByRole("option", { name: "2026-07-28" }));
    await continueSetup();

    expect(
      screen.getByRole("heading", { name: "Set what you'd like to test" }),
    ).toBeInTheDocument();
    const oauth = screen.getByRole("button", {
      name: /^OAuth.*checks selected$/,
    });
    expect(oauth).toHaveTextContent(/\d+\/\d+ checks selected/);
    expect(oauth).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(oauth);
    expect(oauth).toHaveAttribute("aria-expanded", "true");
    // The open suite lists its checks under the same count. OAuth runs as
    // one flow, so a check's box says whether it COUNTS: unchecked, it still
    // runs, unscored.
    const count = oauth.textContent?.match(/(\d+)\/\d+ checks selected/)?.[1];
    const oauthRow = oauth.parentElement!.parentElement!;
    expect(
      within(oauthRow).getByText(
        `${count} checks in this suite. They run together as one sign-in flow, so an unchecked check still runs but does not count toward the score.`,
      ),
    ).toBeInTheDocument();
    const oauthBox = within(oauthRow).getByRole("checkbox", {
      name: "Run OAuth",
    });
    // The OAuth advice has its own box, covered by the suite's.
    const issAdvice = within(oauthRow).getByRole("checkbox", {
      name: "Run Authorization Response iss",
    });
    const oauthChecks = within(oauthRow)
      .getAllByRole("checkbox")
      .filter((box) => box !== oauthBox && box !== issAdvice);
    expect(oauthChecks).toHaveLength(Number(count));
    for (const box of oauthChecks) {
      expect(box).toBeEnabled();
      expect(box).toHaveAttribute("data-state", "checked");
    }
    fireEvent.click(oauthChecks[0]!);
    expect(oauthChecks[0]).toHaveAttribute("data-state", "unchecked");
    // No in-between state: the suite's box is checked only with every check.
    expect(oauthBox).toHaveAttribute("data-state", "unchecked");
    expect(oauth).toHaveTextContent(
      `${Number(count) - 1}/${count} checks selected`,
    );
    // The suite's box puts every check back, then leaves the flow out.
    fireEvent.click(oauthBox);
    expect(oauthChecks[0]).toHaveAttribute("data-state", "checked");
    fireEvent.click(oauthBox);
    for (const box of oauthChecks) {
      expect(box).toHaveAttribute("data-state", "unchecked");
    }
    expect(issAdvice).toHaveAttribute("data-state", "unchecked");
    expect(issAdvice).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(
      screen.getByRole("combobox", { name: "Select protocol version" }),
    ).toHaveTextContent("Protocol · 2026-07-28");
    expect(mockRunProtocol).not.toHaveBeenCalled();
  });

  it("runs only the suites and checks picked in step 2", async () => {
    setupSuccessfulRunMocks();
    const server = createHttpServer({ name: "alpha" });
    render(
      <ConformanceTab
        server={server}
        servers={[server]}
        onSelectServer={vi.fn()}
      />,
    );
    fireEvent.click(screen.getAllByRole("button", { name: RUN_LABEL })[0]);
    await continueSetup();

    // Every suite starts fully picked.
    const appsBox = screen.getByRole("checkbox", { name: "Run Apps" });
    expect(appsBox).toHaveAttribute("data-state", "checked");

    // Leave one Apps check out: the suite's box goes unchecked, and the
    // count says how many of the suite's checks are left.
    const appsRow = appsBox.closest("label")!.parentElement!.parentElement!;
    const appsChecks = within(appsRow)
      .getAllByRole("checkbox")
      .filter((box) => box !== appsBox);
    const dropped = appsChecks[0]!;
    fireEvent.click(dropped);
    expect(appsBox).toHaveAttribute("data-state", "unchecked");
    expect(appsRow).toHaveTextContent(
      `${appsChecks.length - 1}/${appsChecks.length} checks selected`,
    );

    // Leave Tasks and OAuth out entirely.
    fireEvent.click(screen.getByRole("checkbox", { name: "Run Tasks" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Run OAuth" }));
    expect(screen.getByRole("checkbox", { name: "Run OAuth" })).toHaveAttribute(
      "data-state",
      "unchecked",
    );

    fireEvent.click(screen.getByRole("button", { name: RUN_LABEL }));

    await waitFor(() => expect(mockRunApps).toHaveBeenCalled());
    const appsCall = mockRunApps.mock.calls[0]!;
    expect(appsCall[0]).toBe("alpha");
    const appsIds = (appsCall[1] as { checkIds: string[] }).checkIds;
    expect(appsIds).toHaveLength(appsChecks.length - 1);
    // The whole protocol suite was picked, so it runs without a list.
    await waitFor(() =>
      expect(mockRunProtocol).toHaveBeenCalledWith("alpha", {
        runTimeoutSeconds: 300,
        remainingRunTimeoutMs: expect.any(Number),
        signal: expect.any(AbortSignal),
        protocolVersion: "2025-11-25",
      }),
    );
    expect(mockRunTasks).not.toHaveBeenCalled();
    expect(mockStartOAuth).not.toHaveBeenCalled();
    // Tasks and OAuth read as left out, not as not applicable.
    await waitFor(() =>
      expect(screen.getAllByText("NOT SELECTED")).toHaveLength(2),
    );
    expect(
      screen.getAllByText("Not selected for this run, so it is not scored."),
    ).toHaveLength(2);
  });

  it("keeps Run off in step 2 until something is picked", async () => {
    const server = createHttpServer({ name: "alpha" });
    render(
      <ConformanceTab
        server={server}
        servers={[server]}
        onSelectServer={vi.fn()}
      />,
    );
    fireEvent.click(screen.getAllByRole("button", { name: RUN_LABEL })[0]);
    await continueSetup();

    for (const suite of ["Protocol", "Apps", "Tasks", "OAuth"]) {
      fireEvent.click(screen.getByRole("checkbox", { name: `Run ${suite}` }));
    }
    expect(screen.getByRole("button", { name: RUN_LABEL })).toBeDisabled();

    fireEvent.click(screen.getByRole("checkbox", { name: "Run Apps" }));
    expect(screen.getByRole("button", { name: RUN_LABEL })).toBeEnabled();
  });

  it("runs the server and version chosen in the setup steps", async () => {
    const user = userEvent.setup();
    setupSuccessfulRunMocks();
    const alpha = createHttpServer({ name: "alpha" });
    const beta = createHttpServer({ name: "beta" });
    const onSelectServer = vi.fn();
    const { rerender } = render(
      <ConformanceTab
        server={alpha}
        servers={[alpha, beta]}
        onSelectServer={onSelectServer}
      />,
    );

    fireEvent.click(screen.getAllByRole("button", { name: RUN_LABEL })[0]);
    await user.click(screen.getByRole("button", { name: SERVER_FIELD }));
    await user.click(serverRow("beta"));
    await user.click(
      screen.getByRole("combobox", { name: "Select protocol version" }),
    );
    await user.click(screen.getByRole("option", { name: "2026-07-28" }));
    await continueSetup();
    fireEvent.click(screen.getByRole("button", { name: RUN_LABEL }));

    expect(onSelectServer).toHaveBeenCalledWith("beta");
    // Nothing runs against alpha while the selection catches up.
    expect(mockRunProtocol).not.toHaveBeenCalled();
    rerender(
      <ConformanceTab
        server={beta}
        servers={[alpha, beta]}
        onSelectServer={onSelectServer}
      />,
    );
    await waitFor(() =>
      expect(mockRunProtocol).toHaveBeenCalledWith("beta", {
        runTimeoutSeconds: 300,
        remainingRunTimeoutMs: expect.any(Number),
        signal: expect.any(AbortSignal),
        protocolVersion: "2026-07-28",
      }),
    );
    expect(mockRunProtocol).toHaveBeenCalledTimes(1);
  });

  it("runs once from the setup steps under StrictMode's double mount", async () => {
    setupSuccessfulRunMocks();
    const alpha = createHttpServer({ name: "alpha" });
    render(
      <StrictMode>
        <ConformanceTab
          server={alpha}
          servers={[alpha]}
          onSelectServer={vi.fn()}
        />
      </StrictMode>,
    );

    // The undone first mount must not cancel the run and leave every suite
    // idle: the run goes through, once.
    await runToCompletion();
    expect(mockRunProtocol).toHaveBeenCalledTimes(1);
    expect(screen.getAllByText("PASSED").length).toBeGreaterThan(0);
  });

  it("starts the server a saved run's Run again names, with its defaults, once", async () => {
    setupSuccessfulRunMocks();
    const alpha = createHttpServer({ name: "alpha" });
    window.history.replaceState(null, "", "/conformance?run=alpha");
    render(
      <ConformanceTab
        server={alpha}
        servers={[alpha]}
        onSelectServer={vi.fn()}
        serverDefaults={{ alpha: { tasks: [], oauth: false } }}
      />,
    );

    await waitFor(() => expect(mockRunProtocol).toHaveBeenCalledTimes(1));
    expect(mockRunTasks).not.toHaveBeenCalled();
    expect(mockStartOAuth).not.toHaveBeenCalled();
    // Dropped, so a refresh does not run it again.
    expect(window.location.search).toBe("");
  });

  it("starts a requested run once, on the Overview, even from the History tab", async () => {
    setupSuccessfulRunMocks();
    const alpha = createHttpServer({ name: "alpha" });
    const onSelectServer = vi.fn();
    window.history.replaceState(
      null,
      "",
      "/conformance?view=history&run=alpha",
    );
    render(
      <ConformanceTab
        server={alpha}
        servers={[alpha]}
        onSelectServer={onSelectServer}
        history={<p>History table</p>}
      />,
    );

    await waitFor(() => expect(mockRunProtocol).toHaveBeenCalledTimes(1));
    // Started once: a second start would replace the first, which a slower
    // render lets begin, and leave behind as a cancelled run.
    expect(onSelectServer).toHaveBeenCalledTimes(1);
    expect(window.location.search).toBe("");
    expect(screen.queryByText("History table")).toBeNull();
  });

  it("waits for shared defaults before a saved rerun and sends its inputs once", async () => {
    setupSuccessfulRunMocks();
    const alpha = createHttpServer({ name: "alpha" });
    const defaults =
      createDeferred<
        import("@/hooks/use-conformance-server-data").ConformanceDefaults
      >();
    const load = vi.fn(() => defaults.promise);
    window.history.replaceState(
      null,
      "",
      "/conformance?view=history&run=alpha",
    );
    render(
      <StrictMode>
        <ConformanceTab
          server={alpha}
          servers={[alpha]}
          onSelectServer={vi.fn()}
          onLoadServerDefaults={load}
          history={<p>History</p>}
        />
      </StrictMode>,
    );
    expect(mockRunProtocol).not.toHaveBeenCalled();
    await act(async () =>
      defaults.resolve({
        selection: {
          protocol: ["ping"],
          apps: [],
          tasks: ["tasks-update-ack-shape"],
          oauth: false,
        },
        inputs: {
          tasksProbe: {
            toolName: "job",
            arguments: { count: 2 },
            inputResponses: { confirm: true },
          },
        },
      }),
    );
    await waitFor(() =>
      expect(mockRunTasks).toHaveBeenCalledWith("alpha", {
        runTimeoutSeconds: 300,
        remainingRunTimeoutMs: expect.any(Number),
        signal: expect.any(AbortSignal),
        checkIds: ["tasks-update-ack-shape"],
        protocolVersion: "2025-11-25",
        toolName: "job",
        toolArguments: { count: 2 },
        inputResponses: { confirm: true },
      }),
    );
    expect(mockRunProtocol).toHaveBeenCalledTimes(1);
    expect(mockRunTasks).toHaveBeenCalledTimes(1);
    expect(window.location.search).toBe("");
  });

  it.each(["success", "failure"])(
    "ignores a stale defaults %s after switching setup servers",
    async (outcome) => {
      const user = userEvent.setup();
      setupSuccessfulRunMocks();
      const alpha = createHttpServer({ name: "alpha" });
      const beta = createHttpServer({ name: "beta" });
      const defaults =
        createDeferred<
          import("@/hooks/use-conformance-server-data").ConformanceDefaults
        >();
      const load = vi.fn((name: string) =>
        name === "alpha"
          ? defaults.promise
          : Promise.resolve({
              selection: {
                protocol: [],
                apps: [],
                tasks: ["tasks-update-ack-shape"],
                oauth: false,
              },
              inputs: {
                tasksProbe: {
                  toolName: "beta-job",
                  arguments: { count: 2 },
                  inputResponses: { confirm: true },
                },
              },
            }),
      );
      const onSelectServer = vi.fn();
      const props = {
        servers: [alpha, beta],
        onSelectServer,
        onLoadServerDefaults: load,
      };
      const { rerender } = render(<ConformanceTab server={alpha} {...props} />);
      fireEvent.click(screen.getAllByRole("button", { name: RUN_LABEL })[0]);
      await continueSetup();
      expect(load).toHaveBeenCalledWith("alpha");
      await user.click(screen.getByRole("button", { name: SERVER_FIELD }));
      await user.click(serverRow("beta"));
      await act(async () => {
        if (outcome === "failure") defaults.reject(new Error("offline"));
        else
          defaults.resolve({
            selection: { tasks: [], oauth: false },
            inputs: { tasksProbe: { toolName: "alpha-job" } },
          });
      });
      await waitFor(() => expect(screen.getByRole("button", { name: "Continue" })).toBeEnabled());
      expect(screen.queryByRole("alert")).toBeNull();
      expect(mockRunProtocol).not.toHaveBeenCalled();
      expect(mockRunTasks).not.toHaveBeenCalled();
      await continueSetup();
      await waitFor(() => expect(load).toHaveBeenLastCalledWith("beta"));
      fireEvent.click(await screen.findByRole("button", { name: RUN_LABEL }));
      expect(onSelectServer).toHaveBeenCalledWith("beta");
      rerender(<ConformanceTab server={beta} {...props} />);
      await waitFor(() =>
        expect(mockRunTasks).toHaveBeenCalledWith("beta", {
        runTimeoutSeconds: 300,
        remainingRunTimeoutMs: expect.any(Number),
        signal: expect.any(AbortSignal),
          checkIds: ["tasks-update-ack-shape"],
          protocolVersion: "2025-11-25",
          toolName: "beta-job",
          toolArguments: { count: 2 },
          inputResponses: { confirm: true },
        }),
      );
      expect(mockRunProtocol).not.toHaveBeenCalled();
      expect(mockRunTasks).toHaveBeenCalledTimes(1);
    },
  );

  it("keeps the selected suites when an unsaved server runs again", async () => {
    setupSuccessfulRunMocks();
    const alpha = createHttpServer({ name: "alpha" });
    const load = vi.fn();
    render(
      <ConformanceTab
        server={alpha}
        servers={[alpha]}
        onSelectServer={vi.fn()}
        isSavedServer={() => false}
        onLoadServerDefaults={load}
      />,
    );
    fireEvent.click(screen.getAllByRole("button", { name: RUN_LABEL })[0]);
    await continueSetup();
    for (const suite of ["Apps", "Tasks", "OAuth"]) {
      fireEvent.click(
        await screen.findByRole("checkbox", { name: `Run ${suite}` }),
      );
    }
    fireEvent.click(screen.getByRole("button", { name: RUN_LABEL }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Run again" })).toBeEnabled(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Run again" }));
    await waitFor(() => expect(mockRunProtocol).toHaveBeenCalledTimes(2));
    expect(mockRunApps).not.toHaveBeenCalled();
    expect(mockRunTasks).not.toHaveBeenCalled();
    expect(mockStartOAuth).not.toHaveBeenCalled();
    expect(load).not.toHaveBeenCalled();
  });

  it("keeps setup edits as a draft until Run and discards them on Cancel", async () => {
    const alpha = createHttpServer({ name: "alpha" });
    const save = vi.fn();
    render(
      <ConformanceTab
        server={alpha}
        servers={[alpha]}
        onSelectServer={vi.fn()}
        onLoadServerDefaults={vi.fn(async () => ({
          selection: {},
          inputs: {},
        }))}
        onSaveServerDefaults={save}
      />,
    );
    fireEvent.click(screen.getAllByRole("button", { name: RUN_LABEL })[0]);
    await continueSetup();
    fireEvent.click(await screen.findByRole("checkbox", { name: "Run Tasks" }));
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(save).not.toHaveBeenCalled();
    expect(mockRunProtocol).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Run again" })).toBeNull();
  });

  it("does not run with guessed defaults after a failed read and offers Retry", async () => {
    setupSuccessfulRunMocks();
    const alpha = createHttpServer({ name: "alpha" });
    const load = vi
      .fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue({
        selection: { tasks: [], oauth: false },
        inputs: {},
      });
    window.history.replaceState(null, "", "/conformance?run=alpha");
    render(
      <ConformanceTab
        server={alpha}
        servers={[alpha]}
        onSelectServer={vi.fn()}
        onLoadServerDefaults={load}
      />,
    );
    const retry = await screen.findByRole("button", { name: "Retry" });
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Could not load your saved inputs. Try again.",
    );
    for (const button of screen.getAllByRole("button", { name: RUN_OR_AGAIN }))
      expect(button).toBeDisabled();
    expect(mockRunProtocol).not.toHaveBeenCalled();
    fireEvent.click(retry);
    await waitFor(() => expect(mockRunProtocol).toHaveBeenCalledTimes(1));
    expect(mockRunTasks).not.toHaveBeenCalled();
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("blocks Run again after an input load error and recovers through Retry", async () => {
    setupSuccessfulRunMocks();
    const alpha = createHttpServer({ name: "alpha" });
    const defaults = { selection: { tasks: [], oauth: false }, inputs: {} };
    const load = vi
      .fn()
      .mockResolvedValueOnce(defaults)
      .mockRejectedValueOnce(new Error("bad saved inputs"))
      .mockResolvedValue(defaults);
    window.history.replaceState(null, "", "/conformance?run=alpha");
    render(
      <ConformanceTab
        server={alpha}
        servers={[alpha]}
        onSelectServer={vi.fn()}
        onLoadServerDefaults={load}
      />,
    );
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Run again" })).toBeEnabled(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Run again" }));
    const retry = await screen.findByRole("button", { name: "Retry" });
    expect(screen.getByRole("button", { name: "Run again" })).toBeDisabled();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Could not load your saved inputs. Try again.",
    );
    expect(mockRunProtocol).toHaveBeenCalledTimes(1);
    fireEvent.click(retry);
    await waitFor(() => expect(mockRunProtocol).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("keeps other servers runnable after a defaults read fails", async () => {
    setupSuccessfulRunMocks();
    const alpha = createHttpServer({ name: "alpha" });
    const beta = createHttpServer({ name: "beta" });
    const betaDefaults =
      createDeferred<
        import("@/hooks/use-conformance-server-data").ConformanceDefaults
      >();
    const load = vi.fn(async (name: string) => {
      if (name === "alpha") throw new Error("offline");
      return betaDefaults.promise;
    });
    const props = {
      servers: [alpha, beta],
      onSelectServer: vi.fn(),
      onLoadServerDefaults: load,
      lastRuns: {
        alpha: createRunListItem("srv_a"),
        beta: createRunListItem("srv_b"),
      },
      onViewRun: vi.fn(),
    };
    const { rerender } = render(<ConformanceTab server={alpha} {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "Run alpha" }));
    const retry = await screen.findByRole("button", { name: "Retry" });
    expect(screen.getByRole("button", { name: "Run alpha" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Run beta" })).toBeEnabled();
    for (const button of screen.getAllByRole("button", { name: RUN_LABEL }))
      expect(button).toBeDisabled();
    fireEvent.click(retry);
    await waitFor(() => expect(load).toHaveBeenCalledTimes(2));
    await screen.findByRole("button", { name: "Retry" });
    expect(load.mock.calls.map(([name]) => name)).toEqual(["alpha", "alpha"]);
    expect(mockRunProtocol).not.toHaveBeenCalled();

    rerender(<ConformanceTab server={beta} {...props} />);
    for (const button of screen.getAllByRole("button", { name: RUN_LABEL }))
      expect(button).toBeEnabled();
    expect(screen.getByRole("button", { name: "Run alpha" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Run beta" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Run beta" }));
    expect(load).toHaveBeenLastCalledWith("beta");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByRole("button", { name: "Run alpha" })).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Starting beta" }),
    ).toBeDisabled();
    await act(async () =>
      betaDefaults.resolve({
        selection: { protocol: ["ping"], apps: [], tasks: [], oauth: false },
        inputs: {},
      }),
    );
    await waitFor(() =>
      expect(mockRunProtocol).toHaveBeenCalledWith(
        "beta",
        expect.objectContaining({ checkIds: ["ping"] }),
      ),
    );
    expect(mockRunProtocol).toHaveBeenCalledTimes(1);
    expect(mockRunApps).not.toHaveBeenCalled();
    expect(mockRunTasks).not.toHaveBeenCalled();
    expect(props.onSelectServer).toHaveBeenLastCalledWith("beta");
  });

  it("keeps Run again available when another server's defaults fail", async () => {
    setupSuccessfulRunMocks();
    const alpha = createHttpServer({ name: "alpha" });
    const beta = createHttpServer({ name: "beta" });
    const load = vi.fn(async (name: string) => {
      if (name === "alpha") throw new Error("offline");
      return { selection: { apps: [], tasks: [], oauth: false }, inputs: {} };
    });
    const props = {
      servers: [alpha, beta],
      onSelectServer: vi.fn(),
      onLoadServerDefaults: load,
    };
    window.history.replaceState(null, "", "/conformance?run=beta");
    render(<ConformanceTab server={beta} {...props} />);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Run again" })).toBeEnabled(),
    );
    expect(mockRunProtocol).toHaveBeenCalledTimes(1);
    act(() => {
      window.history.replaceState(null, "", "/conformance?run=alpha");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    const retry = await screen.findByRole("button", { name: "Retry" });
    expect(screen.getByRole("button", { name: "Run again" })).toBeEnabled();
    fireEvent.click(retry);
    await waitFor(() => expect(load).toHaveBeenCalledTimes(3));
    await screen.findByRole("button", { name: "Retry" });
    expect(load.mock.calls.map(([name]) => name)).toEqual([
      "beta",
      "alpha",
      "alpha",
    ]);
    fireEvent.click(screen.getByRole("button", { name: "Run again" }));
    await waitFor(() => expect(mockRunProtocol).toHaveBeenCalledTimes(2));
    expect(load).toHaveBeenLastCalledWith("beta");
    expect(mockRunProtocol.mock.calls.map(([name]) => name)).toEqual([
      "beta",
      "beta",
    ]);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("keeps setup on the same screen with Retry after an input read fails", async () => {
    const alpha = createHttpServer({ name: "alpha" });
    const load = vi
      .fn()
      .mockRejectedValueOnce(new Error("bad saved inputs"))
      .mockResolvedValue({ selection: {}, inputs: {} });
    render(
      <ConformanceTab
        server={alpha}
        servers={[alpha]}
        onSelectServer={vi.fn()}
        onLoadServerDefaults={load}
      />,
    );
    fireEvent.click(screen.getAllByRole("button", { name: RUN_LABEL })[0]);
    await continueSetup();
    const retry = await screen.findByRole("button", { name: "Retry" });
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Could not load your saved inputs. Try again.",
    );
    expect(screen.queryByRole("button", { name: RUN_LABEL })).toBeNull();
    expect(mockRunProtocol).not.toHaveBeenCalled();
    fireEvent.click(retry);
    expect(
      await screen.findByRole("button", { name: RUN_LABEL }),
    ).toBeEnabled();
    expect(mockRunProtocol).not.toHaveBeenCalled();
  });

  it("says so, and runs nothing, when Run again names a server it does not offer", async () => {
    setupSuccessfulRunMocks();
    const info = vi.spyOn(toast, "info");
    const alpha = createHttpServer({ name: "alpha" });
    window.history.replaceState(null, "", "/conformance?run=gone");
    render(
      <ConformanceTab
        server={alpha}
        servers={[alpha]}
        onSelectServer={vi.fn()}
      />,
    );

    await waitFor(() =>
      expect(info).toHaveBeenCalledWith(
        "gone is not one of this project's servers.",
      ),
    );
    expect(window.location.search).toBe("");
    expect(mockRunProtocol).not.toHaveBeenCalled();
  });

  it("lists servers with runs, and Run goes straight to a run with their defaults", async () => {
    setupSuccessfulRunMocks();
    const alpha = createHttpServer({ name: "alpha" });
    const onSelectServer = vi.fn();
    const onViewRun = vi.fn();
    const lastRun = {
      _id: "run_9",
      projectId: "proj_1",
      targetKind: "server",
      targetKey: "server:srv_1",
      serverId: "srv_1",
      source: "ui",
      verification: "mcpjam_verified" as const,
      status: "completed",
      outcome: "passed" as const,
      incompleteReason: null,
      score: 100,
      applicable: 22,
      passed: 22,
      failed: 0,
      couldNotRun: 0,
      requestedSuites: ["protocol"],
      protocolVersion: null,
      actorLabel: null,
      ciMetadata: null,
      createdAt: Date.UTC(2026, 9, 28, 12),
      completedAt: null,
      durationMs: null,
      sharingEnabled: false,
    };
    render(
      <ConformanceTab
        server={alpha}
        servers={[alpha]}
        onSelectServer={onSelectServer}
        lastRuns={{ alpha: lastRun }}
        onViewRun={onViewRun}
        serverDefaults={{ alpha: { tasks: [], oauth: false } }}
      />,
    );

    const card = screen.getByRole("list", { name: "Servers" });
    expect(card).toHaveTextContent("alpha");
    expect(card).toHaveTextContent("· Protocol Auto");
    expect(card).toHaveTextContent(/Last run/);
    expect(
      within(card).getByRole("img", { name: "100%. 22 passed of 22" }),
    ).toBeInTheDocument();
    expect(card).toHaveTextContent("100%");
    expect(card).not.toHaveTextContent("22/22");

    fireEvent.click(
      within(card).getByRole("button", { name: "View last run" }),
    );
    expect(onViewRun).toHaveBeenCalledWith("run_9");

    // No setup steps: it runs with the server's default checks.
    fireEvent.click(within(card).getByRole("button", { name: "Run alpha" }));
    await waitFor(() => expect(mockRunProtocol).toHaveBeenCalled());
    expect(mockRunTasks).not.toHaveBeenCalled();
    expect(mockStartOAuth).not.toHaveBeenCalled();
  });

  it("shows a server's logo on its card, and initials without one", () => {
    const alpha = createHttpServer({ name: "alpha" });
    const beta = createHttpServer({ name: "beta" });
    render(
      <ConformanceTab
        server={alpha}
        servers={[alpha, beta]}
        onSelectServer={vi.fn()}
        lastRuns={{
          alpha: createRunListItem("srv_a"),
          beta: createRunListItem("srv_b"),
        }}
        onViewRun={vi.fn()}
        serverIcons={{ alpha: "https://example.test/alpha.png" }}
      />,
    );

    const [alphaCard, betaCard] = within(
      screen.getByRole("list", { name: "Servers" }),
    ).getAllByRole("listitem");
    expect(alphaCard!.querySelector("img")).toHaveAttribute(
      "src",
      "https://example.test/alpha.png",
    );
    expect(alphaCard).toHaveTextContent("Protocol 2025-11-25");
    expect(betaCard!.querySelector("img")).toBeNull();
    expect(betaCard).toHaveTextContent("Be");
  });

  it("says which card is starting while every Run waits on its defaults", async () => {
    setupSuccessfulRunMocks();
    const alpha = createHttpServer({ name: "alpha" });
    const beta = createHttpServer({ name: "beta" });
    const defaults =
      createDeferred<
        import("@/hooks/use-conformance-server-data").ConformanceDefaults
      >();
    render(
      <ConformanceTab
        server={alpha}
        servers={[alpha, beta]}
        onSelectServer={vi.fn()}
        lastRuns={{
          alpha: createRunListItem("srv_a"),
          beta: createRunListItem("srv_b"),
        }}
        onViewRun={vi.fn()}
        onLoadServerDefaults={vi.fn(() => defaults.promise)}
        serverDefaults={{ alpha: {}, beta: {} }}
      />,
    );

    const list = screen.getByRole("list", { name: "Servers" });
    fireEvent.click(within(list).getByRole("button", { name: "Run alpha" }));

    const starting = within(list).getByRole("button", {
      name: "Starting alpha",
    });
    expect(starting).toBeDisabled();
    expect(starting).toHaveAttribute("aria-busy", "true");
    expect(starting).toHaveTextContent("Starting...");
    // The other card stays off, since a second Run would replace this one,
    // but it does not claim to be starting.
    const other = within(list).getByRole("button", { name: "Run beta" });
    expect(other).toBeDisabled();
    expect(other).not.toHaveAttribute("aria-busy");
    expect(other).toHaveTextContent(/^Run$/);

    await act(async () => defaults.resolve({ selection: {}, inputs: {} }));
    await waitFor(() => expect(mockRunProtocol).toHaveBeenCalled());
  });

  it("shows progress, not a score, until the run finishes", async () => {
    setupSuccessfulRunMocks();
    // Protocol never answers: the run stays going.
    mockRunProtocol.mockReturnValue(new Promise(() => {}));
    const alpha = createHttpServer({ name: "alpha" });
    render(
      <ConformanceTab
        server={alpha}
        servers={[alpha]}
        onSelectServer={vi.fn()}
      />,
    );
    await clickRun();

    expect(
      await screen.findByText(
        /^Running conformance checks\. \d of 4 suites done\.$/,
      ),
    ).toBeInTheDocument();
    // Apps and Tasks finished, yet no headline number claims a result.
    await waitFor(() => expect(mockRunTasks).toHaveBeenCalled());
    expect(screen.queryByText(/^\d+\/\d+ · partial$/)).toBeNull();
    expect(screen.queryByText("Conformant.")).toBeNull();
  });

  it("counts only the suites the run covers in its progress", async () => {
    setupSuccessfulRunMocks();
    mockRunProtocol.mockReturnValue(new Promise(() => {}));
    const alpha = createHttpServer({ name: "alpha" });
    render(
      <ConformanceTab
        server={alpha}
        servers={[alpha]}
        onSelectServer={vi.fn()}
        serverDefaults={{ alpha: { tasks: [], oauth: false } }}
      />,
    );
    fireEvent.click(screen.getAllByRole("button", { name: RUN_LABEL })[0]);
    await continueSetup();
    fireEvent.click(screen.getByRole("button", { name: RUN_LABEL }));

    // Tasks and OAuth are left out: two suites, Apps done, Protocol going.
    expect(
      await screen.findByText(
        "Running conformance checks. 1 of 2 suites done.",
      ),
    ).toBeInTheDocument();
  });

  it("goes back to the server list from the run's Back", async () => {
    setupSuccessfulRunMocks();
    const alpha = createHttpServer({ name: "alpha" });
    const lastRun = {
      _id: "run_9",
      projectId: "proj_1",
      targetKind: "server",
      targetKey: "server:srv_1",
      serverId: "srv_1",
      source: "ui",
      verification: "mcpjam_verified" as const,
      status: "completed",
      outcome: "passed" as const,
      incompleteReason: null,
      score: 100,
      applicable: 22,
      passed: 22,
      failed: 0,
      couldNotRun: 0,
      requestedSuites: ["protocol"],
      protocolVersion: null,
      actorLabel: null,
      ciMetadata: null,
      createdAt: Date.UTC(2026, 9, 28, 12),
      completedAt: null,
      durationMs: null,
      sharingEnabled: false,
    };
    render(
      <ConformanceTab
        server={alpha}
        servers={[alpha]}
        onSelectServer={vi.fn()}
        history={<p>History table</p>}
        lastRuns={{ alpha: lastRun }}
        onViewRun={vi.fn()}
      />,
    );
    fireEvent.click(
      within(screen.getByRole("list", { name: "Servers" })).getByRole(
        "button",
        { name: "Run alpha" },
      ),
    );
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Run again" })).toBeEnabled(),
    );

    fireEvent.click(screen.getByTestId("conformance-run-back"));

    // The page's home, not the run it just left.
    expect(screen.getByRole("list", { name: "Servers" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Run again" })).toBeNull();
  });

  it("runs an unchecked OAuth check but leaves it out of the score", async () => {
    const left = OAUTH_CATALOG[0]!;
    setupSuccessfulRunMocks({
      oauth: createOAuthResult({
        passed: false,
        outcome: "failed",
        steps: [
          {
            step: left.id as OAuthConformanceResult["steps"][number]["step"],
            title: left.title,
            summary: "…",
            status: "failed",
            durationMs: 1,
            logs: [],
            httpAttempts: [],
            error: { message: "profile shape is wrong" },
          },
          {
            step: "oauth_token_format",
            title: "Token Format",
            summary: "…",
            status: "passed",
            durationMs: 1,
            logs: [],
            httpAttempts: [],
          },
        ],
      }),
    });
    const alpha = createHttpServer({ name: "alpha" });
    const onSaveServerDefaults = vi.fn(async () => {});
    render(
      <ConformanceTab
        server={alpha}
        servers={[alpha]}
        onSelectServer={vi.fn()}
        onSaveServerDefaults={onSaveServerDefaults}
      />,
    );
    fireEvent.click(screen.getAllByRole("button", { name: RUN_LABEL })[0]);
    await continueSetup();
    fireEvent.click(
      screen.getByRole("button", { name: /^OAuth.*checks selected$/ }),
    );
    fireEvent.click(
      screen.getByRole("checkbox", { name: `Run ${left.title}` }),
    );
    fireEvent.click(screen.getByRole("button", { name: RUN_LABEL }));

    // Saved with the server's defaults, and the flow still ran.
    expect(onSaveServerDefaults).toHaveBeenCalledWith(
      "alpha",
      expect.objectContaining({ oauthUnscored: [left.id] }),
      {},
    );
    await waitFor(() => expect(mockStartOAuth).toHaveBeenCalled());
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Run again" })).toBeEnabled(),
    );

    // The failed step reads as unscored, and does not fail the run.
    fireEvent.click(suiteHeader("oauth"));
    const row = screen.getByText(left.title).closest("button")!;
    expect(within(row).getByText("unscored")).toBeInTheDocument();
    // Its failure is reported, not counted: grey, not red. It shows once open.
    expect(within(row).queryByText("profile shape is wrong")).toBeNull();
    fireEvent.click(row);
    const message = screen.getByText("profile shape is wrong");
    expect(message).toHaveClass("text-muted-foreground");
    expect(message).not.toHaveClass("text-red-600");
    expect(screen.queryByText(/^Not conformant\./)).toBeNull();
    // The suite's badge follows the score, not the unscored failure.
    expect(
      within(suiteHeader("oauth")).getByText("PASSED"),
    ).toBeInTheDocument();
    expect(within(suiteHeader("oauth")).queryByText("FAILED")).toBeNull();
  });

  it("starts step 2 from the server's default checks", async () => {
    const alpha = createHttpServer({ name: "alpha" });
    render(
      <ConformanceTab
        server={alpha}
        servers={[alpha]}
        onSelectServer={vi.fn()}
        serverDefaults={{ alpha: { tasks: [], oauth: false } }}
      />,
    );
    fireEvent.click(screen.getAllByRole("button", { name: RUN_LABEL })[0]);
    await continueSetup();

    expect(screen.getByRole("checkbox", { name: "Run Tasks" })).toHaveAttribute(
      "data-state",
      "unchecked",
    );
    expect(screen.getByRole("checkbox", { name: "Run OAuth" })).toHaveAttribute(
      "data-state",
      "unchecked",
    );
    expect(
      screen.getByRole("checkbox", { name: "Run Protocol" }),
    ).toHaveAttribute("data-state", "checked");
  });

  it("saves the checks picked for a run as defaults, and Settings opens on them", async () => {
    setupSuccessfulRunMocks();
    const alpha = createHttpServer({ name: "alpha" });
    const onSaveServerDefaults = vi.fn(async () => {});
    render(
      <ConformanceTab
        server={alpha}
        servers={[alpha]}
        onSelectServer={vi.fn()}
        onSaveServerDefaults={onSaveServerDefaults}
      />,
    );
    fireEvent.click(screen.getAllByRole("button", { name: RUN_LABEL })[0]);
    await continueSetup();
    fireEvent.click(screen.getByRole("checkbox", { name: "Run Tasks" }));
    fireEvent.click(screen.getByRole("button", { name: RUN_LABEL }));

    expect(onSaveServerDefaults).toHaveBeenCalledWith(
      "alpha",
      expect.objectContaining({ tasks: [] }),
      {},
    );
    await screen.findByRole("button", { name: /^(Run again|Running\.\.\.)$/ });
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Run again" })).toBeEnabled(),
    );

    // The checks that still need a tool stay picked in the defaults, so they
    // run once a tool is set.
    expect(onSaveServerDefaults.mock.calls[0]![1].protocol).toBeUndefined();

    // The saved row has not come back yet: Settings shows the run's picks.
    // Its protocol checks that need a tool show unchecked, so the suite's box
    // does too.
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    expect(screen.getByRole("checkbox", { name: "Run Tasks" })).toHaveAttribute(
      "data-state",
      "unchecked",
    );
    expect(
      screen.getByRole("checkbox", { name: "Run Protocol" }),
    ).toHaveAttribute("data-state", "unchecked");
    expect(
      screen.getByRole("button", { name: /^Protocol.*checks selected$/ }),
    ).not.toHaveTextContent(/(^|\D)0\/\d+ checks selected/);
  });

  it("runs again with the checks changed in Settings", async () => {
    setupSuccessfulRunMocks();
    const alpha = createHttpServer({ name: "alpha" });
    const { rerender } = render(
      <ConformanceTab
        server={alpha}
        servers={[alpha]}
        onSelectServer={vi.fn()}
        onSaveServerDefaults={vi.fn(async () => {})}
      />,
    );
    await runToCompletion();
    expect(mockRunTasks).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Run Tasks" }));
    rerender(
      <ConformanceTab
        server={alpha}
        servers={[alpha]}
        onSelectServer={vi.fn()}
        onSaveServerDefaults={vi.fn(async () => {})}
        serverDefaults={{ alpha: { tasks: [], tasksAdvice: [] } }}
        history={<p>History table</p>}
      />,
    );
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Back" })).toBeEnabled(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Back" }));

    // Run again picks up the change before the save comes back.
    await runToCompletion();
    expect(mockRunProtocol).toHaveBeenCalledTimes(2);
    expect(mockRunTasks).toHaveBeenCalledTimes(1);
    expect(screen.getByText("NOT SELECTED")).toBeInTheDocument();
  });

  it("rolls a Settings change back when its save fails", async () => {
    setupSuccessfulRunMocks();
    const alpha = createHttpServer({ name: "alpha" });
    const onSaveServerDefaults = vi.fn(async () => {});
    const error = vi.spyOn(toast, "error");
    render(
      <ConformanceTab
        server={alpha}
        servers={[alpha]}
        onSelectServer={vi.fn()}
        onSaveServerDefaults={onSaveServerDefaults}
      />,
    );
    await runToCompletion();
    expect(mockRunTasks).toHaveBeenCalledTimes(1);

    onSaveServerDefaults.mockRejectedValueOnce(
      new Error("[Request ID: abc] Server Error"),
    );
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Run Tasks" }));

    // A fixed message, not the raw backend error; the box goes back.
    await waitFor(() =>
      expect(error).toHaveBeenCalledWith(
        "Could not save the default checks and inputs. Try again.",
      ),
    );
    // Once the save settles, the boxes show what is saved again. The Tasks
    // checks that need a tool stay unchecked, so the count shows the others.
    const tasksHeader = () =>
      screen.getByRole("button", { name: /^Tasks.*checks selected$/ });
    await waitFor(() =>
      expect(tasksHeader()).not.toHaveTextContent(
        /(^|\D)0\/\d+ checks selected/,
      ),
    );

    // Run again does not use the change that was never saved.
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    await runToCompletion();
    expect(mockRunTasks).toHaveBeenCalledTimes(2);
    error.mockRestore();
  });

  it("goes back to History when the setup steps are cancelled", async () => {
    setupSuccessfulRunMocks();
    const alpha = createHttpServer({ name: "alpha" });
    render(
      <ConformanceTab
        server={alpha}
        servers={[alpha]}
        onSelectServer={vi.fn()}
        history={<p>History table</p>}
      />,
    );
    await runToCompletion();

    fireEvent.click(screen.getByTestId("conformance-run-back"));
    fireEvent.click(screen.getByRole("tab", { name: "History" }));
    fireEvent.click(screen.getAllByRole("button", { name: RUN_LABEL })[0]);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByText("History table")).toBeInTheDocument();

    // Overview, after a finished run, is the page's home again.
    fireEvent.click(screen.getByRole("tab", { name: "Overview" }));
    expect(screen.queryByRole("button", { name: "Run again" })).toBeNull();
  });

  it("waits for the saved defaults before step 2", () => {
    const alpha = createHttpServer({ name: "alpha" });
    render(
      <ConformanceTab
        server={alpha}
        servers={[alpha]}
        onSelectServer={vi.fn()}
        serverDefaultsLoaded={false}
        onSaveServerDefaults={vi.fn(async () => {})}
      />,
    );
    fireEvent.click(screen.getAllByRole("button", { name: RUN_LABEL })[0]);
    expect(screen.getByRole("button", { name: "Continue" })).toBeDisabled();
  });

  it("keeps Settings closed until the saved defaults have loaded", async () => {
    setupSuccessfulRunMocks();
    const alpha = createHttpServer({ name: "alpha" });
    const onSaveServerDefaults = vi.fn(async () => {});
    const props = {
      server: alpha,
      servers: [alpha],
      onSelectServer: vi.fn(),
      onSaveServerDefaults,
      serverDefaults: { alpha: { tasks: [] } },
    };
    const { rerender } = render(<ConformanceTab {...props} />);
    await runToCompletion();
    // The setup's run saved its picks; only what follows counts here.
    onSaveServerDefaults.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    expect(
      screen.getByRole("heading", { name: "alpha Conformance Settings" }),
    ).toBeInTheDocument();

    // The defaults reload: Settings would start from "everything" and a
    // change would save over them, so it closes and cannot be opened.
    rerender(<ConformanceTab {...props} serverDefaultsLoaded={false} />);
    expect(
      screen.queryByRole("heading", { name: "alpha Conformance Settings" }),
    ).toBeNull();
    expect(screen.getByRole("button", { name: "Settings" })).toBeDisabled();
    expect(onSaveServerDefaults).not.toHaveBeenCalled();

    // Loaded again: it comes back on the saved defaults.
    rerender(<ConformanceTab {...props} serverDefaultsLoaded />);
    expect(screen.getByRole("checkbox", { name: "Run Tasks" })).toHaveAttribute(
      "data-state",
      "unchecked",
    );
  });

  describe("tools the checks may call", () => {
    beforeEach(() => {
      mockListTools.mockResolvedValue({
        tools: [
          { name: "delete_row", annotations: { destructiveHint: true } },
          {
            name: "echo",
            annotations: { readOnlyHint: true },
            inputSchema: {
              type: "object",
              properties: { message: { type: "string" } },
            },
          },
          {
            name: "weather",
            annotations: { readOnlyHint: true },
            outputSchema: {
              type: "object",
              properties: { temperature: { type: "number" } },
            },
          },
        ],
      });
    });

    /** Setup on 2026-07-28, where the checks that call a tool run. */
    async function toStep2(pin = "2026-07-28") {
      const user = userEvent.setup();
      const alpha = createHttpServer({ name: "alpha" });
      render(
        <ConformanceTab
          server={alpha}
          servers={[alpha]}
          onSelectServer={vi.fn()}
        />,
      );
      fireEvent.click(screen.getAllByRole("button", { name: RUN_LABEL })[0]);
      if (pin !== "auto") {
        await user.click(
          screen.getByRole("combobox", { name: "Select protocol version" }),
        );
        await user.click(screen.getByRole("option", { name: pin }));
      }
      await continueSetup();
    }

    /** The field a tool dropdown sits in, with its arguments and level. */
    const fieldOf = (combobox: HTMLElement) =>
      within(combobox.parentElement as HTMLElement);

    /** Setup to step 2 with the Protocol suite open. */
    async function openProtocolChecks() {
      await toStep2();
      fireEvent.click(
        screen.getByRole("button", { name: /^Protocol.*checks selected$/ }),
      );
      await waitFor(() =>
        expect(
          screen.getByRole("combobox", { name: "Tool that emits logs" }),
        ).toBeEnabled(),
      );
    }

    it.each([
      {
        suite: "Protocol",
        field: "Tool that emits logs",
        row: "Logs Require A Log Level",
        missing: "2 optional checks need input",
        ready: "1 optional check needs input",
      },
      {
        suite: "Tasks",
        field: "Tool that creates a task",
        row: "Result Type Discipline",
        missing: "11 optional checks need input",
        ready: undefined,
      },
    ])(
      "keeps required-argument badges in $suite until arguments are valid",
      async ({ suite, field, row, missing, ready }) => {
        mockListTools.mockResolvedValue({
          tools: [
            {
              name: "echo",
              annotations: { readOnlyHint: true },
              inputSchema: {
                type: "object",
                properties: { projectId: { type: "string" } },
                required: ["projectId"],
              },
            },
          ],
        });
        const user = userEvent.setup();
        await toStep2();
        const header = screen.getByRole("button", {
          name: new RegExp(`^${suite}.*checks selected$`),
        });
        fireEvent.click(header);
        const tool = screen.getByRole("combobox", { name: field });
        await waitFor(() => expect(tool).toBeEnabled());
        await user.click(tool);
        await user.click(
          screen.getByRole("option", { name: toolOption("echo", "read-only") }),
        );
        const checkRow = screen.getByRole("button", {
          name: new RegExp(`^${row}`),
        });
        expect(checkRow).toHaveTextContent("Needs input");
        expect(
          within(header).getByText(inputBadge(missing)),
        ).toBeInTheDocument();

        // Filled in through the form built from the tool's input schema.
        const args = fieldOf(tool).getByPlaceholderText("Enter projectId");
        fireEvent.change(args, { target: { value: "project-1" } });
        expect(checkRow).toHaveTextContent("Input set");
        if (ready)
          expect(
            within(header).getByText(inputBadge(ready)),
          ).toBeInTheDocument();
        else expect(within(header).queryByText(/needs? input/)).toBeNull();

        // An emptied required box is not sent, so the check needs input again.
        fireEvent.change(args, { target: { value: "" } });
        expect(checkRow).toHaveTextContent("Needs input");
        fireEvent.click(header);
        expect(header).toHaveAttribute("aria-expanded", "false");
        expect(
          within(header).getByText(inputBadge(missing)),
        ).toBeInTheDocument();
      },
    );

    it.each([
      {
        suite: "Protocol",
        field: "Tool that emits logs",
        row: "Logs Require A Log Level",
      },
      {
        suite: "Tasks",
        field: "Tool that creates a task",
        row: "Result Type Discipline",
      },
    ])(
      "clears $suite badges after manual selection when the schema cannot be checked",
      async ({ suite, field, row }) => {
        mockListTools.mockResolvedValue({
          tools: [
            {
              name: "echo",
              annotations: { readOnlyHint: true },
              inputSchema: {
                type: "object",
                properties: {
                  d: { type: "string", pattern: "^\\d{4}\\-\\d{2}$" },
                },
              },
            },
          ],
        });
        const user = userEvent.setup();
        await toStep2();
        const header = screen.getByRole("button", {
          name: new RegExp(`^${suite}.*checks selected$`),
        });
        fireEvent.click(header);
        const tool = screen.getByRole("combobox", { name: field });
        await waitFor(() => expect(tool).toBeEnabled());
        const checkRow = screen.getByRole("button", {
          name: new RegExp(`^${row}`),
        });
        expect(checkRow).toHaveTextContent("Needs input");
        await user.click(tool);
        await user.click(
          screen.getByRole("option", { name: toolOption("echo", "read-only") }),
        );
        expect(checkRow).toHaveTextContent("Input set");
        // An optional argument: untick skip, then fill it in.
        fireEvent.click(fieldOf(tool).getByRole("checkbox", { name: "skip" }));
        fireEvent.change(fieldOf(tool).getByPlaceholderText("Enter d"), {
          target: { value: "2026-11" },
        });
        expect(checkRow).toHaveTextContent("Input set");
        fireEvent.click(header);
        if (suite === "Tasks")
          expect(within(header).queryByText(/needs? input/)).toBeNull();
        else
          expect(
            within(header).getByText(
              inputBadge("1 optional check needs input"),
            ),
          ).toBeInTheDocument();
      },
    );

    it("sends the output check's tool on its own", async () => {
      const user = userEvent.setup();
      setupSuccessfulRunMocks();
      await openProtocolChecks();

      await user.click(
        screen.getByRole("combobox", { name: "Tool to check output" }),
      );
      // Only tools that declare an output schema can be graded.
      expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual(
        ["Not set", "weather·read-only"],
      );
      await user.click(
        screen.getByRole("option", { name: toolOption("weather", "read-only") }),
      );

      fireEvent.click(screen.getByRole("button", { name: RUN_LABEL }));
      await waitFor(() =>
        expect(mockRunProtocol).toHaveBeenCalledWith(
          "alpha",
          expect.objectContaining({
            probes: { toolCallProbe: { toolName: "weather" } },
          }),
        ),
      );
    });

    it("asks under the check which tool to call, and runs with it", async () => {
      const user = userEvent.setup();
      setupSuccessfulRunMocks();
      await openProtocolChecks();

      // One field per tool, under the check that calls it.
      expect(
        screen.getByRole("combobox", { name: "Tool that asks for input" }),
      ).toBeInTheDocument();
      // The log level shows only once a tool is picked.
      expect(
        screen.queryByRole("combobox", { name: "Log level to request" }),
      ).toBeNull();

      const logs = screen.getByRole("combobox", {
        name: "Tool that emits logs",
      });
      await user.click(logs);
      // Read-only tools first, and a warning on one that may modify data.
      const options = screen.getAllByRole("option").map((o) => o.textContent);
      expect(options).toEqual([
        "Not set",
        "echo·read-only",
        "weather·read-only",
        "delete_row·may modify data",
      ]);
      await user.click(
        screen.getByRole("option", { name: toolOption("echo", "read-only") }),
      );

      // A form from the tool's input schema; message is optional, so it
      // starts skipped.
      fireEvent.click(fieldOf(logs).getByRole("checkbox", { name: "skip" }));
      fireEvent.change(fieldOf(logs).getByPlaceholderText("Enter message"), {
        target: { value: "hi" },
      });
      expect(screen.getByRole("button", { name: RUN_LABEL })).toBeEnabled();

      // The level the log level advice asks for: the SDK's default until
      // picked.
      const level = screen.getByRole("combobox", {
        name: "Log level to request",
      });
      expect(level).toHaveTextContent("warning");
      await user.click(level);
      await user.click(screen.getByRole("option", { name: "info" }));

      fireEvent.click(screen.getByRole("button", { name: RUN_LABEL }));
      const sent = {
        probes: {
          logProbe: {
            toolName: "echo",
            arguments: { message: "hi" },
            level: "info",
          },
        },
      };
      await waitFor(() =>
        expect(mockRunProtocol).toHaveBeenCalledWith(
          "alpha",
          expect.objectContaining(sent),
        ),
      );

      // Kept for the server: Run again calls the same tool.
      await waitFor(() =>
        expect(screen.getByRole("button", { name: "Run again" })).toBeEnabled(),
      );
      mockRunProtocol.mockClear();
      fireEvent.click(screen.getByRole("button", { name: "Run again" }));
      await waitFor(() =>
        expect(mockRunProtocol).toHaveBeenCalledWith(
          "alpha",
          expect.objectContaining(sent),
        ),
      );
    });

    it("lists the tool's own arguments as fields", async () => {
      const user = userEvent.setup();
      await openProtocolChecks();
      const logs = screen.getByRole("combobox", {
        name: "Tool that emits logs",
      });
      await user.click(logs);
      await user.click(
        screen.getByRole("option", { name: toolOption("echo", "read-only") }),
      );

      expect(fieldOf(logs).getByText("message")).toBeInTheDocument();
      expect(
        fieldOf(logs).getByPlaceholderText("Enter message"),
      ).toBeInTheDocument();
      expect(fieldOf(logs).queryByRole("switch")).toBeNull();
    });

    it("flags the checks that need an input before the suite is opened", async () => {
      const user = userEvent.setup();
      await toStep2();

      // Closed: the header says how many picked checks still need one.
      const header = screen.getByRole("button", {
        name: /^Protocol.*checks selected$/,
      });
      expect(header).toHaveAttribute("aria-expanded", "false");
      expect(
        within(header).getByText(inputBadge("3 optional checks need input")),
      ).toBeInTheDocument();
      // The protocol suite runs without these tools, so the badge says so.
      expect(within(header).getByText("optional").tagName).toBe("EM");

      fireEvent.click(header);
      // Three protocol checks, the log advice, and eleven Tasks checks.
      expect(screen.getAllByText("Needs input")).toHaveLength(15);
      await waitFor(() =>
        expect(
          screen.getByRole("combobox", { name: "Tool that emits logs" }),
        ).toBeEnabled(),
      );
      await user.click(
        screen.getByRole("combobox", { name: "Tool that emits logs" }),
      );
      await user.click(
        screen.getByRole("option", { name: toolOption("echo", "read-only") }),
      );

      expect(screen.getAllByText("Input set")).toHaveLength(2);
      expect(screen.getAllByText("Needs input")).toHaveLength(13);
      expect(
        within(header).getByText(inputBadge("2 optional checks need input")),
      ).toBeInTheDocument();
    });

    it("shows checks that need input unchecked until they have it", async () => {
      const user = userEvent.setup();
      setupSuccessfulRunMocks();
      await toStep2();

      // Three protocol checks still need a tool: the count leaves them out,
      // so the suite's box is unchecked.
      const header = screen.getByRole("button", {
        name: /^Protocol.*checks selected$/,
      });
      const [, picked, total] = header
        .textContent!.match(/(\d+)\/(\d+) checks selected/)!
        .map(Number);
      expect(picked).toBe(total! - 3);
      const suiteBox = screen.getByRole("checkbox", { name: "Run Protocol" });
      expect(suiteBox).toHaveAttribute("data-state", "unchecked");

      fireEvent.click(header);
      const logsCheck = screen.getByRole("checkbox", {
        name: "Run Logs Require A Log Level",
      });
      expect(logsCheck).toHaveAttribute("data-state", "unchecked");
      expect(logsCheck).toBeDisabled();

      // Every check that can run is picked, so the suite's box leaves the
      // suite out, then picks it again.
      fireEvent.click(suiteBox);
      expect(header).toHaveTextContent(`0/${total} checks selected`);
      fireEvent.click(suiteBox);
      expect(header).toHaveTextContent(
        `${total! - 3}/${total} checks selected`,
      );

      // The tool field stays under the locked check, so it can still be set.
      const logs = screen.getByRole("combobox", {
        name: "Tool that emits logs",
      });
      await waitFor(() => expect(logs).toBeEnabled());
      await user.click(logs);
      await user.click(
        screen.getByRole("option", { name: toolOption("echo", "read-only") }),
      );
      expect(logsCheck).toHaveAttribute("data-state", "checked");
      expect(logsCheck).toBeEnabled();
      expect(header).toHaveTextContent(
        `${total! - 2}/${total} checks selected`,
      );
      expect(suiteBox).toHaveAttribute("data-state", "unchecked");

      // The run still sends the checks without a tool, so the result reports
      // them as not run for want of input, like Run again does.
      fireEvent.click(screen.getByRole("button", { name: RUN_LABEL }));
      await waitFor(() => expect(mockRunProtocol).toHaveBeenCalled());
      const { checkIds } = mockRunProtocol.mock.calls[0]![1] as {
        checkIds?: string[];
      };
      expect(checkIds).toBeUndefined();
    });

    it("shades the output check when no tool declares an output schema", async () => {
      const user = userEvent.setup();
      mockListTools.mockResolvedValue({
        tools: [{ name: "echo", annotations: { readOnlyHint: true } }],
      });
      await toStep2();
      const header = screen.getByRole("button", {
        name: /^Protocol.*checks selected$/,
      });
      fireEvent.click(header);
      await waitFor(() =>
        expect(
          screen.getByRole("combobox", { name: "Tool that emits logs" }),
        ).toBeEnabled(),
      );

      // Nothing to grade, so the check does not apply: no field, no tag, no
      // count. It stays picked, so it runs once a tool declares a schema.
      expect(
        screen.queryByRole("combobox", { name: "Tool to check output" }),
      ).toBeNull();
      const box = screen.getByRole("checkbox", {
        name: "Run Tool Output Schema Honored",
      });
      expect(box).toBeChecked();
      const row = box.closest("label")!.parentElement!;
      expect(row).toHaveClass("opacity-50");
      await user.hover(within(row).getByText("Tool Output Schema Honored"));
      expect(await screen.findByRole("tooltip")).toHaveTextContent(
        "No tool on this server declares an output schema, so this check does not apply.",
      );
      expect(
        within(header).getByText(inputBadge("2 optional checks need input")),
      ).toBeInTheDocument();
    });

    it("asks for no protocol tool on Auto, where these checks do not run", async () => {
      await toStep2("auto");
      const header = screen.getByRole("button", {
        name: /^Protocol.*checks selected$/,
      });
      expect(within(header).queryByText(/need(s)? input/)).toBeNull();
      fireEvent.click(header);
      // Tasks still needs its tool on Auto; protocol tools do not apply.
      expect(screen.getAllByText("Needs input")).toHaveLength(11);
      expect(
        screen.queryByRole("combobox", { name: "Tool that emits logs" }),
      ).toBeNull();
    });

    it.each([
      ["auto", undefined],
      ["2025-11-25", undefined],
      ["2026-07-28", undefined],
      ["2026-07-28", "required"],
      ["2026-07-28", "optional"],
    ])(
      "flags missing Tasks inputs on %s with task support %s even when the suite is closed",
      async (pin, taskSupport) => {
        if (taskSupport) {
          mockListTools.mockResolvedValue({
            tools: [
              {
                name: "echo",
                annotations: { readOnlyHint: true },
                execution: { taskSupport },
              },
            ],
          });
        }
        const user = userEvent.setup();
        await toStep2(pin);
        const header = screen.getByRole("button", {
          name: /^Tasks.*checks selected$/,
        });
        expect(header).toHaveAttribute("aria-expanded", "false");
        expect(
          within(header).getByText(inputBadge("11 optional checks need input")),
        ).toBeInTheDocument();
        expect(within(header).getByText("optional").tagName).toBe("EM");

        const suite = screen.getByRole("checkbox", { name: "Run Tasks" });
        fireEvent.click(suite);
        expect(within(header).queryByText(/needs? input/)).toBeNull();
        fireEvent.click(suite);
        expect(
          within(header).getByText(inputBadge("11 optional checks need input")),
        ).toBeInTheDocument();

        fireEvent.click(header);
        const tool = await screen.findByRole("combobox", {
          name: "Tool that creates a task",
        });
        await waitFor(() => expect(tool).toBeEnabled());
        const taskRow = screen.getByRole("button", {
          name: /^Undeclared Task Creation Refused/,
        });
        expect(taskRow).toHaveTextContent("Needs input");
        // A picked check without its tool sits the run out: shown unchecked,
        // and locked until the tool is set.
        const typeCheck = screen.getByRole("checkbox", {
          name: "Run Result Type Discipline",
        });
        expect(typeCheck).toHaveAttribute("data-state", "unchecked");
        expect(typeCheck).toBeDisabled();
        await user.click(
          screen.getByRole("combobox", { name: "Tool that creates a task" }),
        );
        await user.click(
          screen.getByRole("option", { name: toolOption("echo", "read-only") }),
        );
        expect(within(header).queryByText(/needs? input/)).toBeNull();
        expect(taskRow).toHaveTextContent("Input set");
        expect(typeCheck).toHaveAttribute("data-state", "checked");
        expect(typeCheck).toBeEnabled();

        await user.click(
          screen.getByRole("combobox", { name: "Tool that creates a task" }),
        );
        await user.click(screen.getByRole("option", { name: "Not set" }));
        expect(taskRow).toHaveTextContent("Needs input");
        fireEvent.click(header);
        expect(header).toHaveAttribute("aria-expanded", "false");
        expect(
          within(header).getByText(inputBadge("11 optional checks need input")),
        ).toBeInTheDocument();
      },
    );

    it.each([
      ["auto", "required"],
      ["auto", "optional"],
      ["2025-11-25", "required"],
      ["2025-11-25", "optional"],
    ])(
      "does not require a Tasks input on %s when a tool advertises %s task support",
      async (pin, taskSupport) => {
        mockListTools.mockResolvedValue({
          tools: [
            {
              name: "create_task",
              execution: { taskSupport },
              inputSchema: { type: "object", properties: {} },
              annotations: { readOnlyHint: true },
            },
          ],
        });
        const user = userEvent.setup();
        await toStep2(pin);
        const header = screen.getByRole("button", {
          name: /^Tasks.*checks selected$/,
        });
        await waitFor(() =>
          expect(within(header).queryByText(/needs? input/)).toBeNull(),
        );
        fireEvent.click(header);
        const taskRow = screen.getByRole("button", {
          name: /^Result Type Discipline/,
        });
        expect(within(taskRow).queryByText("Needs input")).toBeNull();
        const tool = screen.getByRole("combobox", {
          name: "Tool that creates a task",
        });
        await waitFor(() => expect(tool).toBeEnabled());
        expect(tool).toHaveTextContent("Not set");

        await user.click(tool);
        await user.click(
          screen.getByRole("option", { name: toolOption("create_task", "read-only") }),
        );
        expect(taskRow).toHaveTextContent("Input set");
        await user.click(tool);
        await user.click(screen.getByRole("option", { name: "Not set" }));
        expect(within(taskRow).queryByText("Needs input")).toBeNull();
        expect(within(header).queryByText(/needs? input/)).toBeNull();
      },
    );

    it.each(["auto", "2025-11-25"])(
      "keeps Tasks warnings on %s when the runner's automatic tool needs arguments",
      async (pin) => {
        mockListTools.mockResolvedValue({
          tools: [
            {
              name: "z_create",
              execution: { taskSupport: "required" },
              inputSchema: {
                type: "object",
                properties: { message: { type: "string" } },
                required: ["message"],
              },
            },
            {
              name: "a_create",
              execution: { taskSupport: "required" },
              inputSchema: { type: "object", properties: {} },
            },
            {
              name: "optional_create",
              execution: { taskSupport: "optional" },
              inputSchema: { type: "object", properties: {} },
            },
          ],
        });
        await toStep2(pin);
        const header = screen.getByRole("button", {
          name: /^Tasks.*checks selected$/,
        });
        fireEvent.click(header);
        await waitFor(() =>
          expect(
            screen.getByRole("combobox", {
              name: "Tool that creates a task",
            }),
          ).toBeEnabled(),
        );
        expect(
          within(header).getByText(inputBadge("11 optional checks need input")),
        ).toBeInTheDocument();
        expect(
          screen.getByRole("button", {
            name: /^Result Type Discipline/,
          }),
        ).toHaveTextContent("Needs input");
      },
    );

    it("still requires a Tasks input when a tool forbids task execution", async () => {
      mockListTools.mockResolvedValue({
        tools: [{ name: "echo", execution: { taskSupport: "forbidden" } }],
      });
      await toStep2("2025-11-25");
      const header = screen.getByRole("button", {
        name: /^Tasks.*checks selected$/,
      });
      fireEvent.click(header);
      await waitFor(() =>
        expect(
          screen.getByRole("combobox", {
            name: "Tool that creates a task",
          }),
        ).toBeEnabled(),
      );
      expect(
        within(header).getByText(inputBadge("11 optional checks need input")),
      ).toBeInTheDocument();
    });

    it("asks once for the Tasks tool on any pin, and for answers under the update check", async () => {
      const user = userEvent.setup();
      setupSuccessfulRunMocks();
      await toStep2("auto");
      fireEvent.click(
        screen.getByRole("button", { name: /^Tasks.*checks selected$/ }),
      );
      const tool = await screen.findByRole("combobox", {
        name: "Tool that creates a task",
      });
      await waitFor(() => expect(tool).toBeEnabled());
      // One field: the other checks that call it point to it.
      expect(
        screen.getAllByRole("combobox", { name: "Tool that creates a task" }),
      ).toHaveLength(1);
      expect(
        screen.getAllByRole("checkbox", { name: "Use suite default" }).length,
      ).toBeGreaterThan(0);
      // The answers need a tool first.
      expect(
        screen.queryByRole("textbox", {
          name: "Answers to the task's questions (optional)",
        }),
      ).toBeNull();

      await user.click(tool);
      await user.click(screen.getByRole("option", { name: toolOption("echo", "read-only") }));

      const answers = screen.getByRole("textbox", {
        name: "Answers to the task's questions (optional)",
      });
      fireEvent.change(answers, { target: { value: "[1]" } });
      expect(screen.getByRole("button", { name: RUN_LABEL })).toBeDisabled();
      // The message is tied to the box, so a screen reader reads it too.
      expect(answers).toHaveAccessibleDescription(/Enter a JSON object/);
      // Past the routes' cap the run would only get a 400.
      fireEvent.change(answers, {
        target: { value: JSON.stringify({ confirm: "x".repeat(10_001) }) },
      });
      expect(answers).toHaveAccessibleDescription(/under 10,000 characters/);
      expect(screen.getByRole("button", { name: RUN_LABEL })).toBeDisabled();
      fireEvent.change(answers, {
        target: { value: '{"confirm": {"action": "accept"}}' },
      });
      expect(screen.getByRole("button", { name: RUN_LABEL })).toBeEnabled();

      fireEvent.click(screen.getByRole("button", { name: RUN_LABEL }));
      await waitFor(() =>
        expect(mockRunTasks).toHaveBeenCalledWith("alpha", {
        runTimeoutSeconds: 300,
        remainingRunTimeoutMs: expect.any(Number),
        signal: expect.any(AbortSignal),
          toolName: "echo",
          protocolVersion: "2025-11-25",
          inputResponses: { confirm: { action: "accept" } },
        }),
      );
    });

    it("hides the flagged update check and its answers box", async () => {
      enabledFlags.delete("conformance-tasks-update-check");
      const user = userEvent.setup();
      setupSuccessfulRunMocks();
      await toStep2("auto");
      fireEvent.click(
        screen.getByRole("button", { name: /^Tasks.*checks selected$/ }),
      );
      const tool = await screen.findByRole("combobox", {
        name: "Tool that creates a task",
      });
      await waitFor(() => expect(tool).toBeEnabled());
      await user.click(tool);
      await user.click(screen.getByRole("option", { name: toolOption("echo", "read-only") }));

      expect(
        screen.queryByText(TASKS_CHECK_CATALOG["tasks-update-ack-shape"].title),
      ).toBeNull();
      expect(
        screen.queryByRole("textbox", {
          name: "Answers to the task's questions (optional)",
        }),
      ).toBeNull();
    });

    it("lists the tools once for every field, across pages", async () => {
      mockListTools.mockReset();
      mockListTools
        .mockResolvedValueOnce({
          tools: [{ name: "echo", annotations: { readOnlyHint: true } }],
          nextCursor: "page-2",
        })
        .mockResolvedValueOnce({
          tools: [{ name: "ask_user", annotations: { readOnlyHint: true } }],
        });
      const user = userEvent.setup();
      await openProtocolChecks();

      await user.click(
        screen.getByRole("combobox", { name: "Tool that asks for input" }),
      );
      expect(
        screen.getByRole("option", { name: toolOption("ask_user", "read-only") }),
      ).toBeInTheDocument();
      // Two fields, two pages: one call per page, not one per field.
      expect(mockListTools).toHaveBeenCalledTimes(2);
      expect(mockListTools).toHaveBeenLastCalledWith(
        expect.objectContaining({ cursor: "page-2" }),
      );
    });

    it("says when the server pages past what can be listed", async () => {
      // Never stops paging: the list stops at its cap and says so.
      mockListTools.mockReset();
      mockListTools.mockResolvedValue({
        tools: [{ name: "echo", annotations: { readOnlyHint: true } }],
        nextCursor: "more",
      });
      await openProtocolChecks();

      expect(mockListTools).toHaveBeenCalledTimes(50);
      expect(
        screen.getAllByText(/lists more tools than can be shown here/)[0],
      ).toBeInTheDocument();
    });

    it("never sends a tool for a check left out of the run", async () => {
      const user = userEvent.setup();
      setupSuccessfulRunMocks();
      await openProtocolChecks();
      await user.click(
        screen.getByRole("combobox", { name: "Tool that emits logs" }),
      );
      await user.click(
        screen.getByRole("option", { name: toolOption("echo", "read-only") }),
      );

      // The check and the advice that would call it are left out.
      fireEvent.click(
        screen.getByRole("checkbox", { name: "Run Logs Require A Log Level" }),
      );
      fireEvent.click(
        screen.getByRole("checkbox", { name: "Run Log Level Filtering" }),
      );
      expect(
        screen.queryByRole("combobox", { name: "Tool that emits logs" }),
      ).toBeNull();

      fireEvent.click(screen.getByRole("button", { name: RUN_LABEL }));
      await waitFor(() => expect(mockRunProtocol).toHaveBeenCalled());
      expect(mockRunProtocol.mock.calls[0]![1]).not.toHaveProperty("probes");
      expect(mockRunProtocol.mock.calls[0]![1].readinessIds).not.toContain(
        "readiness-log-level-filtering",
      );
    });

    it("lists the advice under the checks, and moves the log tool to it when only it calls the tool", async () => {
      const user = userEvent.setup();
      setupSuccessfulRunMocks();
      await openProtocolChecks();
      // Protocol, Tasks and OAuth each list theirs; Apps has none.
      expect(
        screen.getAllByText(/^Advice: \d+ tips?, run with the checks above\.$/),
      ).toHaveLength(3);
      await user.click(
        screen.getByRole("combobox", { name: "Tool that emits logs" }),
      );
      await user.click(
        screen.getByRole("option", { name: toolOption("echo", "read-only") }),
      );
      // Under the advice row: its own dropdown, filled with the check's tool,
      // and the level.
      expect(
        screen.getByRole("checkbox", {
          name: "Use the tool from Logs Require A Log Level",
        }),
      ).toBeChecked();
      expect(
        screen.getByRole("combobox", {
          name: "Tool that emits logs for Log Level Filtering",
        }),
      ).toHaveTextContent("echo");
      expect(
        screen.getByRole("combobox", { name: "Log level to request" }),
      ).toBeInTheDocument();

      // Only the advice calls it now, so the tool field moves to its row.
      fireEvent.click(
        screen.getByRole("checkbox", { name: "Run Logs Require A Log Level" }),
      );
      expect(
        screen.getByRole("combobox", { name: "Tool that emits logs" }),
      ).toHaveTextContent("echo");
      // Another advice left out is not asked for.
      fireEvent.click(
        screen.getByRole("checkbox", {
          name: "Run Explicit Session Termination",
        }),
      );

      fireEvent.click(screen.getByRole("button", { name: RUN_LABEL }));
      await waitFor(() => expect(mockRunProtocol).toHaveBeenCalled());
      const sent = mockRunProtocol.mock.calls[0]![1];
      expect(sent.probes).toEqual({ logProbe: { toolName: "echo" } });
      expect(sent.checkIds).not.toContain("modern-logs-require-log-level");
      expect(sent.readinessIds).toContain("readiness-log-level-filtering");
      expect(sent.readinessIds).not.toContain("readiness-session-termination");
    });

    it("lets the advice pick its own log tool, and sends it with the run", async () => {
      const user = userEvent.setup();
      setupSuccessfulRunMocks();
      await openProtocolChecks();
      await user.click(
        screen.getByRole("combobox", { name: "Tool that emits logs" }),
      );
      await user.click(
        screen.getByRole("option", { name: toolOption("echo", "read-only") }),
      );

      const inherit = screen.getByRole("checkbox", {
        name: "Use the tool from Logs Require A Log Level",
      });
      const adviceTool = screen.getByRole("combobox", {
        name: "Tool that emits logs for Log Level Filtering",
      });
      await user.click(adviceTool);
      await user.click(
        screen.getByRole("option", { name: toolOption("weather", "read-only") }),
      );
      expect(inherit).not.toBeChecked();
      expect(adviceTool).toHaveTextContent("weather");
      // The check keeps its own tool.
      expect(
        screen.getByRole("combobox", { name: "Tool that emits logs" }),
      ).toHaveTextContent("echo");

      fireEvent.click(screen.getByRole("button", { name: RUN_LABEL }));
      await waitFor(() => expect(mockRunProtocol).toHaveBeenCalled());
      expect(mockRunProtocol.mock.calls[0]![1].probes).toEqual({
        logProbe: { toolName: "echo" },
        logLevelOverride: { toolName: "weather" },
      });
    });

    it("turns the advice off with the suite's box, and offers none with no check picked", async () => {
      const user = userEvent.setup();
      await openProtocolChecks();
      // The advice calls the logs tool, so it can run once that is set.
      await user.click(
        screen.getByRole("combobox", { name: "Tool that emits logs" }),
      );
      await user.click(
        screen.getByRole("option", { name: toolOption("echo", "read-only") }),
      );
      const suite = screen.getByRole("checkbox", { name: "Run Protocol" });
      fireEvent.click(suite);
      expect(suite).toHaveAttribute("data-state", "unchecked");
      const advice = screen.getByRole("checkbox", {
        name: "Run Log Level Filtering",
      });
      expect(advice).toHaveAttribute("data-state", "unchecked");
      expect(advice).toBeDisabled();

      fireEvent.click(suite);
      // Two protocol checks still need a tool, so the suite's box stays
      // unchecked while the advice comes back.
      expect(suite).toHaveAttribute("data-state", "unchecked");
      expect(advice).toHaveAttribute("data-state", "checked");
      expect(advice).toBeEnabled();
    });
  });

  it("keeps at least one check in Settings", async () => {
    setupSuccessfulRunMocks();
    const alpha = createHttpServer({ name: "alpha" });
    const onSaveServerDefaults = vi.fn(async () => {});
    const error = vi.spyOn(toast, "error");
    render(
      <ConformanceTab
        server={alpha}
        servers={[alpha]}
        onSelectServer={vi.fn()}
        onSaveServerDefaults={onSaveServerDefaults}
      />,
    );
    await runToCompletion();
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    onSaveServerDefaults.mockClear();

    for (const suite of ["Protocol", "Apps", "Tasks", "OAuth"]) {
      fireEvent.click(screen.getByRole("checkbox", { name: `Run ${suite}` }));
    }

    // The last box would leave nothing to run: refused, not saved.
    expect(error).toHaveBeenCalledWith("Keep at least one check selected.");
    expect(onSaveServerDefaults).toHaveBeenCalledTimes(3);
    expect(screen.getByRole("checkbox", { name: "Run OAuth" })).toHaveAttribute(
      "data-state",
      "checked",
    );
    error.mockRestore();
  });

  it("opens step 2 on the Settings defaults, not the last run's picks", async () => {
    setupSuccessfulRunMocks();
    const alpha = createHttpServer({ name: "alpha" });
    const props = { server: alpha, servers: [alpha], onSelectServer: vi.fn(), onSaveServerDefaults: vi.fn(async () => {}), history: <p>History table</p> };
    const { rerender } = render(
      <ConformanceTab
        {...props}
      />,
    );
    await runToCompletion();
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Run Tasks" }));
    rerender(
      <ConformanceTab
        server={alpha}
        servers={[alpha]}
        onSelectServer={vi.fn()}
        onSaveServerDefaults={vi.fn(async () => {})}
        serverDefaults={{ alpha: { tasks: [], tasksAdvice: [] } }}
        history={<p>History table</p>}
      />,
    );
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Back" })).toBeEnabled(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Back" }));

    // From History, Run opens the setup steps again.
    fireEvent.click(screen.getByTestId("conformance-run-back"));
    fireEvent.click(screen.getByRole("tab", { name: "History" }));
    fireEvent.click(screen.getAllByRole("button", { name: RUN_LABEL })[0]);
    await continueSetup();

    expect(screen.getByRole("checkbox", { name: "Run Tasks" })).toHaveAttribute(
      "data-state",
      "unchecked",
    );
  });

  it("opens a server's Settings from the run, saves each change, and keeps the run", async () => {
    setupSuccessfulRunMocks();
    const alpha = createHttpServer({ name: "alpha" });
    const onSaveServerDefaults = vi.fn(async () => {});
    render(
      <ConformanceTab
        server={alpha}
        servers={[alpha]}
        onSelectServer={vi.fn()}
        onSaveServerDefaults={onSaveServerDefaults}
      />,
    );
    await runToCompletion();

    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    expect(
      screen.getByRole("heading", { name: "alpha Conformance Settings" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Default Checks")).toBeInTheDocument();
    // Counts read "picked of total" here.
    expect(
      screen.getByRole("button", { name: /^OAuth.*checks selected$/ }),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("checkbox", { name: "Run OAuth" }));
    expect(onSaveServerDefaults).toHaveBeenCalledWith(
      "alpha",
      expect.objectContaining({
        oauth: false,
      }),
      {},
    );

    // Back to the run, which is still there.
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Back" })).toBeEnabled(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.getByRole("button", { name: "Run again" })).toBeEnabled();
  });

  it("offers only Run before the first run", () => {
    const server = createHttpServer({ name: "alpha" });
    render(
      <ConformanceTab
        server={server}
        servers={[server]}
        onSelectServer={vi.fn()}
      />,
    );
    // One Run in the header and one under the prompt, and nothing else: the
    // server and protocol pickers join once a run has started.
    expect(screen.getAllByRole("button", { name: RUN_LABEL })).toHaveLength(2);
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
  });

  it("shows the run header once a run has started", async () => {
    setupSuccessfulRunMocks();
    const server = createHttpServer({ name: "alpha" });
    render(
      <ConformanceTab
        server={server}
        servers={[server]}
        onSelectServer={vi.fn()}
        history={<p>History table</p>}
      />,
    );
    await runToCompletion();

    // Back and the server's name, then Run again and when it ran; no
    // Overview/History tabs and no pickers in the run's header.
    expect(screen.getByTestId("conformance-run-back")).toHaveTextContent(
      "Conformance",
    );
    expect(screen.getByRole("heading", { name: "alpha" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Overview" })).toBeNull();
    expect(screen.queryByRole("button", { name: "History" })).toBeNull();
    expect(screen.getByRole("button", { name: "Run again" })).toBeEnabled();
    expect(screen.getByText(/ · UI$/)).toBeInTheDocument();
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    // No save target, so no Settings.
    expect(
      screen.queryByRole("button", { name: "Settings" }),
    ).not.toBeInTheDocument();
  });

  it("connects the page's server when step 1 opens, and waits for it", async () => {
    setupSuccessfulRunMocks();
    const disconnected = createHttpServer({
      name: "alpha",
      connectionStatus: "disconnected",
    });
    const onConnectServer = vi.fn(async () => "ready" as const);
    const { rerender } = render(
      <ConformanceTab
        server={disconnected}
        servers={[disconnected]}
        onSelectServer={vi.fn()}
        onConnectServer={onConnectServer}
      />,
    );

    // No Connect to click: it starts connecting in the background.
    fireEvent.click(screen.getAllByRole("button", { name: RUN_LABEL })[0]);
    await waitFor(() =>
      expect(onConnectServer).toHaveBeenCalledWith("alpha", { signIn: false }),
    );
    expect(onConnectServer).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Continue" })).toBeDisabled();
    expect(mockRunProtocol).not.toHaveBeenCalled();

    // The connect lands: the page re-renders with the connected server.
    const connected = createHttpServer({ name: "alpha" });
    rerender(
      <ConformanceTab
        server={connected}
        servers={[connected]}
        onSelectServer={vi.fn()}
        onConnectServer={onConnectServer}
      />,
    );
    await continueSetup();
    fireEvent.click(screen.getByRole("button", { name: RUN_LABEL }));
    await waitFor(() => expect(mockRunProtocol).toHaveBeenCalled());
  });

  it("connects a server as soon as it is picked in step 1", async () => {
    const user = userEvent.setup();
    const alpha = createHttpServer({ name: "alpha" });
    const beta = createHttpServer({
      name: "beta",
      connectionStatus: "disconnected",
    });
    const onConnectServer = vi.fn(async () => "ready" as const);
    const error = vi.spyOn(toast, "error");
    const loading = vi.spyOn(toast, "loading");
    const success = vi.spyOn(toast, "success");
    const { rerender } = render(
      <ConformanceTab
        server={alpha}
        servers={[alpha, beta]}
        onSelectServer={vi.fn()}
        onConnectServer={onConnectServer}
      />,
    );

    fireEvent.click(screen.getAllByRole("button", { name: RUN_LABEL })[0]);
    // alpha is connected already: nothing to do on open.
    expect(onConnectServer).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: SERVER_FIELD }));
    await user.click(serverRow("beta"));
    expect(onConnectServer).toHaveBeenCalledWith("beta", { signIn: false });
    // One toast says it is connecting, then settles into the result.
    expect(loading).toHaveBeenCalledWith("Connecting beta...");
    // Not while beta is still loading into the session.
    expect(success).not.toHaveBeenCalled();
    const connectedBeta = createHttpServer({ name: "beta" });
    rerender(
      <ConformanceTab
        server={alpha}
        servers={[alpha, connectedBeta]}
        onSelectServer={vi.fn()}
        onConnectServer={onConnectServer}
      />,
    );
    await waitFor(() =>
      expect(success).toHaveBeenCalledWith("beta connected", {
        id: loading.mock.results[0]!.value,
      }),
    );
    expect(error).not.toHaveBeenCalled();
    error.mockRestore();
    loading.mockRestore();
    success.mockRestore();
  });

  it("lists the project's servers not loaded yet, and connects one from step 1", async () => {
    const user = userEvent.setup();
    setupSuccessfulRunMocks();
    const alpha = createHttpServer({ name: "alpha" });
    const onConnectServer = vi.fn(async () => "ready" as const);
    const props = {
      onSelectServer: vi.fn(),
      onConnectServer,
      projectServerNames: ["alpha", "notion"],
    };
    const { rerender } = render(
      <ConformanceTab server={alpha} servers={[alpha]} {...props} />,
    );

    fireEvent.click(screen.getAllByRole("button", { name: RUN_LABEL })[0]);
    await user.click(screen.getByRole("button", { name: SERVER_FIELD }));
    // Listed as not connected; picking it connects it.
    await user.click(serverRow("notion"));
    expect(onConnectServer).toHaveBeenCalledWith("notion", { signIn: false });
    expect(screen.getByRole("button", { name: SERVER_FIELD })).toHaveTextContent(
      "notion",
    );
    expect(screen.getByRole("button", { name: "Continue" })).toBeDisabled();

    // Connected: the session loads it, and the steps go on.
    const notion = createHttpServer({ name: "notion" });
    rerender(
      <ConformanceTab server={alpha} servers={[alpha, notion]} {...props} />,
    );
    await waitFor(() => expect(screen.getByRole("button", { name: "Continue" })).toBeEnabled());
  });

  it("connects the page's server when it arrives after step 1 opened", async () => {
    const onConnectServer = vi.fn(async () => "ready" as const);
    const props = { onSelectServer: vi.fn(), onConnectServer };
    // The server list is still loading when Run opens the steps.
    const { rerender } = render(
      <ConformanceTab server={null} servers={[]} {...props} />,
    );
    fireEvent.click(screen.getAllByRole("button", { name: RUN_LABEL })[0]);
    expect(onConnectServer).not.toHaveBeenCalled();

    const alpha = createHttpServer({
      name: "alpha",
      connectionStatus: "disconnected",
    });
    rerender(<ConformanceTab server={alpha} servers={[alpha]} {...props} />);
    await waitFor(() =>
      expect(onConnectServer).toHaveBeenCalledWith("alpha", { signIn: false }),
    );
    expect(onConnectServer).toHaveBeenCalledTimes(1);
  });

  it("reads no failure for a server named like an object built-in", async () => {
    // `in` would find the inherited `constructor` and loop on clearing it.
    const server = createHttpServer({ name: "constructor" });
    render(
      <ConformanceTab
        server={server}
        serverTimeouts={{}}
        servers={[server]}
        onSelectServer={vi.fn()}
        onConnectServer={vi.fn(async () => "ready" as const)}
      />,
    );
    fireEvent.click(screen.getAllByRole("button", { name: RUN_LABEL })[0]);

    expect(screen.queryByRole("alert")).toBeNull();
    await waitFor(() => expect(screen.getByRole("button", { name: "Continue" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(
      screen.getByRole("heading", { name: "Set what you'd like to test" }),
    ).toBeInTheDocument();
  });

  it("keeps each server's connect failure when they settle out of order", async () => {
    const user = userEvent.setup();
    const alpha = createHttpServer({ name: "alpha" });
    const beta = createHttpServer({
      name: "beta",
      connectionStatus: "disconnected",
    });
    const gamma = createHttpServer({
      name: "gamma",
      connectionStatus: "disconnected",
    });
    const settle: Record<string, (outcome: "failed") => void> = {};
    const onConnectServer = vi.fn(
      (name: string) =>
        new Promise<"failed">((resolve) => (settle[name] = resolve)),
    );
    render(
      <ConformanceTab
        server={alpha}
        servers={[alpha, beta, gamma]}
        onSelectServer={vi.fn()}
        onConnectServer={onConnectServer}
      />,
    );
    fireEvent.click(screen.getAllByRole("button", { name: RUN_LABEL })[0]);

    // beta, then gamma: gamma's connect fails first, beta's after it.
    await user.click(screen.getByRole("button", { name: SERVER_FIELD }));
    await user.click(serverRow("beta"));
    await user.click(screen.getByRole("button", { name: SERVER_FIELD }));
    await user.click(serverRow("gamma"));
    await act(async () => settle.gamma!("failed"));
    await act(async () => settle.beta!("failed"));

    // gamma is the one picked, and its failure is still the one shown.
    expect(await screen.findByRole("alert")).toHaveTextContent(
      `Couldn't connect to "gamma"`,
    );
  });

  it("connects a server that dropped before Run again, then runs", async () => {
    setupSuccessfulRunMocks();
    const connected = createHttpServer({ name: "alpha" });
    const onConnectServer = vi.fn(async () => "ready" as const);
    const { rerender } = render(
      <ConformanceTab
        server={connected}
        servers={[connected]}
        onSelectServer={vi.fn()}
        onConnectServer={onConnectServer}
      />,
    );
    await runToCompletion();
    mockRunProtocol.mockClear();

    // Dropped after the first run: Run again connects it before running.
    const dropped = { ...connected, connectionStatus: "disconnected" as const };
    rerender(
      <ConformanceTab
        server={dropped}
        servers={[dropped]}
        onSelectServer={vi.fn()}
        onConnectServer={onConnectServer}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Run again" }));
    await waitFor(() =>
      expect(onConnectServer).toHaveBeenCalledWith("alpha", { signIn: false }),
    );
    expect(mockRunProtocol).not.toHaveBeenCalled();

    rerender(
      <ConformanceTab
        server={connected}
        servers={[connected]}
        onSelectServer={vi.fn()}
        onConnectServer={onConnectServer}
      />,
    );
    await waitFor(() => expect(mockRunProtocol).toHaveBeenCalled());
  });

  it("names the server and offers Retry or Edit when the connect fails", async () => {
    const server = createHttpServer({
      name: "alpha",
      connectionStatus: "failed",
      lastError: "connect ECONNREFUSED 127.0.0.1:3000",
    });
    const onConnectServer = vi.fn(async () => "failed" as const);
    const onEditServer = vi.fn();
    const error = vi.spyOn(toast, "error");
    render(
      <ConformanceTab
        server={server}
        servers={[server]}
        onSelectServer={vi.fn()}
        onConnectServer={onConnectServer}
        onEditServer={onEditServer}
      />,
    );

    // Opening step 1 connects the page's server in the background.
    fireEvent.click(screen.getAllByRole("button", { name: RUN_LABEL })[0]);
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(`Couldn't connect to "alpha"`);
    expect(alert).toHaveTextContent("connect ECONNREFUSED 127.0.0.1:3000");
    expect(error).toHaveBeenCalledWith(
      "Couldn't connect to alpha. Retry below, or edit its connection.",
      expect.objectContaining({ id: expect.anything() }),
    );
    expect(screen.getByRole("button", { name: "Continue" })).toBeDisabled();

    fireEvent.click(
      within(alert).getByRole("button", { name: "Edit connection" }),
    );
    expect(onEditServer).toHaveBeenCalledWith("alpha");
    fireEvent.click(within(alert).getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(onConnectServer).toHaveBeenCalledTimes(2));
    expect(onConnectServer).toHaveBeenLastCalledWith("alpha", {
      signIn: false,
    });
  });

  it("clears the connect alert once the server connects some other way", async () => {
    const server = createHttpServer({
      name: "alpha",
      connectionStatus: "failed",
    });
    const props = {
      onSelectServer: vi.fn(),
      onConnectServer: vi.fn(async () => "failed" as const),
      onEditServer: vi.fn(),
    };
    const { rerender } = render(
      <ConformanceTab server={server} servers={[server]} {...props} />,
    );

    // Opening step 1 connects the page's server in the background.
    fireEvent.click(screen.getAllByRole("button", { name: RUN_LABEL })[0]);
    expect(await screen.findByRole("alert")).toBeInTheDocument();

    // Fixed from Edit connection, which reconnects without the picker.
    const connected = { ...server, connectionStatus: "connected" as const };
    rerender(
      <ConformanceTab server={connected} servers={[connected]} {...props} />,
    );
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("button", { name: "Continue" })).toBeEnabled());

    // A later drop is a new state, not the old failure coming back.
    const dropped = { ...server, connectionStatus: "disconnected" as const };
    rerender(
      <ConformanceTab server={dropped} servers={[dropped]} {...props} />,
    );
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("asks to sign in again when the connect needs reauthorization", async () => {
    const server = createHttpServer({
      name: "alpha",
      connectionStatus: "disconnected",
    });
    const onConnectServer = vi.fn(async () => "reauth" as const);
    render(
      <ConformanceTab
        server={server}
        servers={[server]}
        onSelectServer={vi.fn()}
        onConnectServer={onConnectServer}
      />,
    );

    // Opening step 1 connects the page's server in the background.
    fireEvent.click(screen.getAllByRole("button", { name: RUN_LABEL })[0]);
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("It needs you to sign in again.");

    // Retrying would hit the same missing sign-in, so the button opens it.
    expect(
      within(alert).queryByRole("button", { name: "Retry" }),
    ).not.toBeInTheDocument();
    fireEvent.click(within(alert).getByRole("button", { name: "Sign in" }));
    await waitFor(() =>
      expect(onConnectServer).toHaveBeenLastCalledWith("alpha", {
        signIn: true,
      }),
    );
  });

  it("keeps Run enabled with no servers, and the setup says to add one", () => {
    render(
      <ConformanceTab server={null} servers={[]} onSelectServer={vi.fn()} />,
    );

    // Run in the header and under the prompt, both enabled.
    const runButtons = screen.getAllByRole("button", { name: RUN_LABEL });
    expect(runButtons).toHaveLength(2);
    for (const button of runButtons) expect(button).toBeEnabled();
    expect(
      screen.queryByRole("button", { name: "Add server" }),
    ).not.toBeInTheDocument();

    fireEvent.click(runButtons[0]);
    expect(
      screen.getByText("Add a server to run conformance checks."),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Continue" })).toBeDisabled();
  });

  it("lists servers with their status, and no Connect", async () => {
    const user = userEvent.setup();
    const alpha = createHttpServer({
      name: "alpha",
      connectionStatus: "disconnected",
    });
    const beta = createHttpServer({ name: "beta" });
    const onSelect = vi.fn();
    render(
      <ConformanceServerPicker
        servers={[alpha, beta]}
        selectedName="alpha"
        onSelect={onSelect}
      />,
    );

    const trigger = screen.getByRole("button", { name: "Server" });
    expect(trigger).toHaveTextContent("alpha");
    await user.click(trigger);

    // Servers only: no groups tab, and Add server stays under the list.
    expect(screen.queryByRole("tab")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add server" })).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Disconnected" })).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Connected" })).toBeInTheDocument();
    // Picking a server connects it, so no row offers Connect.
    expect(screen.queryByRole("button", { name: /^Connect / })).toBeNull();

    await user.click(serverRow("beta"));
    expect(onSelect).toHaveBeenCalledWith("beta");
  });

  it("lists protocol versions newest first, after Auto", async () => {
    const user = userEvent.setup();
    render(<ProtocolVersionSelect value="auto" onChange={vi.fn()} />);
    await user.click(
      screen.getByRole("combobox", { name: "Protocol version" }),
    );
    const versions = screen
      .getAllByRole("option")
      .map((option) => option.textContent);
    expect(versions[0]).toBe("Auto (negotiated)");
    const dated = versions.slice(1);
    expect(dated).toEqual([...dated].sort().reverse());
    expect(dated[0]).toBe("2026-07-28");
  });

  it("shows a not-applicable reason only when its row is open, in neutral", async () => {
    setupSuccessfulRunMocks({
      protocol: createProtocolResult({
        checks: [
          {
            id: "modern-no-session-id",
            category: "transport",
            title: "No Session Id Minted",
            description: "A modern server never mints an Mcp-Session-Id.",
            status: "skipped",
            skipReason: "not-applicable",
            durationMs: 0,
            error: {
              message:
                "Not applicable to the legacy era (run pinned to 2025-11-25)",
            },
          },
        ],
      }),
    });
    render(<ConformanceTab server={createHttpServer()} />);
    await runToCompletion();
    fireEvent.click(suiteHeader("protocol"));

    // Shut, an era skip stays in the inert content without a row preview.
    const reason = screen.getByText(/Not applicable to the legacy era/);
    expect(isCollapsed(reason)).toBe(true);

    clickRow("No Session Id Minted");
    expect(isCollapsed(reason)).toBe(false);
    expect(reason).toHaveClass("text-muted-foreground");
    expect(reason).not.toHaveClass("text-red-600");
  });

  it("shows every suite once a run starts", async () => {
    setupSuccessfulRunMocks();
    render(<ConformanceTab server={createHttpServer()} />);
    await runToCompletion();

    for (const suite of ["protocol", "apps", "tasks", "oauth"] as const) {
      expect(
        within(suiteHeader(suite)).getByText(SUITE_COPY[suite].title),
      ).toBeInTheDocument();
    }
  });

  it("hides the readiness sections unless mcpjam-directory-readiness is on", () => {
    // Directory submissions are a later phase than protocol conformance, so
    // the sections stay out of the page until the flag says otherwise.
    render(<ConformanceTab server={createHttpServer()} />);
    expect(
      screen.getByText("Run your first conformance check"),
    ).toBeInTheDocument();
    expect(screen.queryByText("Claude Directory Readiness")).toBeNull();
    expect(screen.queryByText("OpenAI Directory Readiness")).toBeNull();
    expect(screen.queryByText("Muse Directory Readiness")).toBeNull();
  });

  it("shows the readiness sections when mcpjam-directory-readiness is on", () => {
    enabledFlags.add("mcpjam-directory-readiness");
    render(<ConformanceTab server={createHttpServer()} />);

    // Before any run, too: readiness has its own run control and recovers an
    // in-flight run on mount, so hiding it until the suites run would strand
    // both behind the full run, OAuth browser flow included.
    expect(
      screen.getByText("Run your first conformance check"),
    ).toBeInTheDocument();
    expect(screen.getByText("Claude Directory Readiness")).toBeDefined();
    expect(screen.getByText("OpenAI Directory Readiness")).toBeDefined();
  });

  it("keeps the readiness sections mounted when the first run starts", async () => {
    enabledFlags.add("mcpjam-directory-readiness");
    setupSuccessfulRunMocks();
    render(<ConformanceTab server={createHttpServer()} />);
    const before = screen.getByText("OpenAI Directory Readiness");

    await runToCompletion();

    // A remount would reset choices made before the run, such as the OpenAI
    // submission mode; the same node means the same component instance.
    expect(screen.getByText("OpenAI Directory Readiness")).toBe(before);
  });

  it("falls back to Overview when ?view=history has no History tab", () => {
    window.history.replaceState(null, "", "/?view=history");
    try {
      render(<ConformanceTab server={createHttpServer()} />);

      // No history was passed, so there is no tab to return from.
      expect(screen.queryByRole("tab", { name: "History" })).toBeNull();
      expect(
        screen.getByText("Run your first conformance check"),
      ).toBeInTheDocument();
    } finally {
      window.history.replaceState(null, "", "/");
    }
  });

  it("runs the tasks suite and badges its verdict", async () => {
    setupSuccessfulRunMocks();
    render(<ConformanceTab server={createHttpServer()} />);
    await runToCompletion();

    // The whole suite, and no tool, since none was set.
    expect(mockRunTasks).toHaveBeenCalledWith("http-server", {
        runTimeoutSeconds: 300,
        remainingRunTimeoutMs: expect.any(Number),
        signal: expect.any(AbortSignal),
      protocolVersion: "2025-11-25",
    });
    expect(within(suiteHeader("tasks")).getByText("PASSED")).toBeDefined();
  });

  it("leaves the flagged update check out of a whole-suite Tasks run", async () => {
    enabledFlags.delete("conformance-tasks-update-check");
    setupSuccessfulRunMocks();
    render(<ConformanceTab server={createHttpServer()} />);
    await runToCompletion();

    expect(mockRunTasks).toHaveBeenCalledWith(
      "http-server",
      expect.objectContaining({
        checkIds: MCP_TASKS_CHECK_IDS.filter(
          (id) => id !== "tasks-update-ack-shape",
        ),
      }),
    );
  });

  it("marks Protocol and OAuth as not applicable for stdio servers", async () => {
    setupSuccessfulRunMocks();
    render(<ConformanceTab server={createStdioServer()} />);
    await runToCompletion();

    // Both suites share the same reason from the SDK's canRunConformance.
    expect(
      screen.getAllByText(/requires an HTTP transport/i).length,
    ).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText("NOT APPLICABLE").length).toBeGreaterThanOrEqual(
      2,
    );
    expect(mockRunProtocol).not.toHaveBeenCalled();
  });

  it("resolves Auto once and forwards that version to Protocol and OAuth", async () => {
    setupSuccessfulRunMocks();
    render(<ConformanceTab server={createHttpServer()} />);

    await clickRun();

    await waitFor(() => {
      expect(mockRunProtocol).toHaveBeenCalledWith("http-server", {
        runTimeoutSeconds: 300,
        remainingRunTimeoutMs: expect.any(Number),
        signal: expect.any(AbortSignal),
        protocolVersion: "2025-11-25",
      });
    });
    await waitFor(() => {
      expect(mockStartOAuth).toHaveBeenCalledWith(
        expect.objectContaining({
          oauthProfile: expect.objectContaining({
            protocolVersion: "2025-11-25",
          }),
        }),
      );
    });
  });

  it("threads a pinned protocol version into the protocol and OAuth runs", async () => {
    const user = userEvent.setup();
    setupSuccessfulRunMocks();
    const server = createHttpServer();
    render(
      <ConformanceTab
        server={server}
        servers={[server]}
        onSelectServer={vi.fn()}
      />,
    );

    // The version is picked in the setup steps.
    fireEvent.click(screen.getAllByRole("button", { name: RUN_LABEL })[0]);
    await user.click(
      screen.getByRole("combobox", { name: "Select protocol version" }),
    );
    await user.click(screen.getByRole("option", { name: "2026-07-28" }));
    await continueSetup();
    fireEvent.click(screen.getByRole("button", { name: RUN_LABEL }));

    await waitFor(() => {
      expect(mockRunProtocol).toHaveBeenLastCalledWith("http-server", {
        runTimeoutSeconds: 300,
        remainingRunTimeoutMs: expect.any(Number),
        signal: expect.any(AbortSignal),
        protocolVersion: "2026-07-28",
      });
    });
    await waitFor(() => {
      expect(mockStartOAuth).toHaveBeenLastCalledWith(
        expect.objectContaining({
          oauthProfile: expect.objectContaining({
            protocolVersion: "2026-07-28",
          }),
        }),
      );
    });
  });

  it("opens an errored suite on its error and what it would have run", async () => {
    setupSuccessfulRunMocks();
    mockRunProtocol.mockRejectedValue(new Error("protocol endpoint down"));
    render(<ConformanceTab server={createHttpServer()} />);
    await runToCompletion();

    expect(within(suiteHeader("protocol")).getByText("ERROR")).toBeDefined();
    expect(screen.getByText("protocol endpoint down")).toBeInTheDocument();
    expect(
      screen.getByText(/checks in this suite\. Not run yet/),
    ).toBeInTheDocument();

    // The row shows the canonical title; the explanation stays shut until
    // the row itself is opened.
    const explanation = screen.getByText("Server responds to ping requests.");
    expect(isCollapsed(explanation)).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: /^Ping/ }));

    expect(isCollapsed(explanation)).toBe(false);
  });

  it("narrows the protocol catalog to the pinned version's era", async () => {
    const user = userEvent.setup();
    const server = createHttpServer();
    render(
      <ConformanceTab
        server={server}
        servers={[server]}
        onSelectServer={vi.fn()}
      />,
    );
    fireEvent.click(screen.getAllByRole("button", { name: RUN_LABEL })[0]);
    await continueSetup();

    // Auto resolves before step 2, so only its negotiated era is listed.
    expect(screen.getByText("Ping")).toBeDefined();
    expect(screen.queryByText("Modern Client Handshake")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    await user.click(
      screen.getByRole("combobox", { name: "Select protocol version" }),
    );
    await user.click(screen.getByRole("option", { name: "2025-06-18" }));
    await continueSetup();

    // A legacy pin drops the modern-only checks entirely.
    expect(screen.queryByText("Modern Client Handshake")).toBeNull();
    expect(screen.getByText("Ping")).toBeDefined();
  });

  it("replaces the catalog with real results once a suite runs", async () => {
    setupSuccessfulRunMocks({
      protocol: createProtocolResult({
        checks: [
          {
            id: "ping",
            category: "core",
            title: "Ping",
            description: "Round trip",
            status: "passed",
            durationMs: 1,
          },
        ],
      }),
    });
    render(<ConformanceTab server={createHttpServer()} />);
    await runToCompletion();

    expect(screen.getByText("Round trip")).toBeInTheDocument();
    expect(screen.queryByText(/checks in this suite\. Not run yet/)).toBeNull();
  });

  it("shows a running suite as running, not as the not-yet-run catalog", async () => {
    const pending = createDeferred<{
      success: true;
      result: MCPConformanceResult;
    }>();
    setupSuccessfulRunMocks();
    mockRunProtocol.mockReturnValue(pending.promise);

    render(<ConformanceTab server={createHttpServer()} />);
    await clickRun();

    // The catalog line would read "not run yet", which is exactly wrong
    // while the run is live.
    await screen.findByText(/Running \d+ checks/);
    expect(within(suiteHeader("protocol")).getByText("RUNNING")).toBeDefined();
    expect(screen.queryByText(/checks in this suite\. Not run yet/)).toBeNull();

    pending.resolve({ success: true, result: createProtocolResult() });
    await waitFor(() => {
      expect(within(suiteHeader("protocol")).getByText("PASSED")).toBeDefined();
    });
  });

  it("stays in the run for OAuth between the callback and the result", async () => {
    // A popup that opened: this test is about the callback, not a blocker.
    const openSpy = vi
      .spyOn(window, "open")
      .mockReturnValue({} as unknown as Window);
    const poll = createDeferred<{ phase: string; result?: unknown }>();
    setupSuccessfulRunMocks();
    mockStartOAuth.mockResolvedValue({
      phase: "authorization_needed",
      sessionId: "session-1",
      authorizationUrl: "https://auth.example.com/authorize",
    });
    mockSubmitCode.mockResolvedValue({ success: true });
    mockCompleteOAuth.mockReturnValue(poll.promise);

    render(<ConformanceTab server={createHttpServer()} />);
    await clickRun();

    await screen.findByText("Waiting for browser authorization...");
    expect(suiteHeader("oauth").getAttribute("aria-expanded")).toBe("true");

    // The callback lands and the run moves from "waiting" to polling. The
    // suite must still read as a live run, never as the pre-run catalog.
    window.dispatchEvent(
      new MessageEvent("message", {
        origin: window.location.origin,
        data: { type: "OAUTH_CALLBACK", code: "auth-code" },
      }),
    );

    await waitFor(() => {
      expect(mockCompleteOAuth).toHaveBeenCalledWith("session-1", { signal: expect.any(AbortSignal) });
    });
    expect(within(suiteHeader("oauth")).getByText("RUNNING")).toBeDefined();
    expect(screen.queryByText(/checks in this suite\. Not run yet/)).toBeNull();

    poll.resolve({ phase: "complete", result: createOAuthResult() });
    await waitFor(() => {
      expect(within(suiteHeader("oauth")).getByText("PASSED")).toBeDefined();
    });
    openSpy.mockRestore();
  });

  it("asks for sign-in at the top of the run, not in the OAuth suite at its end", async () => {
    const openSpy = vi
      .spyOn(window, "open")
      .mockReturnValue({} as unknown as Window);
    // Held back, so the run is on screen before sign-in is needed.
    const oauthStart = createDeferred<{
      phase: "authorization_needed";
      sessionId: string;
      authorizationUrl: string;
    }>();
    setupSuccessfulRunMocks();
    mockStartOAuth.mockReturnValue(oauthStart.promise);

    render(<ConformanceTab server={createHttpServer()} />);
    await clickRun();
    // The live region is there, empty, before sign-in is needed, so filling it
    // is announced; inserted with its text, it may not be.
    const announcement = await screen.findByTestId(
      "conformance-oauth-announcement",
    );
    expect(announcement.getAttribute("role")).toBe("status");
    expect(announcement.textContent).toBe("");
    oauthStart.resolve({
      phase: "authorization_needed",
      sessionId: "session-1",
      authorizationUrl: "https://auth.example.com/authorize",
    });

    // Below the fold, a run waiting on sign-in looked like one that never
    // stops loading (CQT-97).
    await screen.findByText("Waiting for browser authorization...");
    const prompt = screen.getByTestId("conformance-oauth-prompt");
    expect(screen.getByTestId("conformance-oauth-announcement")).toBe(
      announcement,
    );
    expect(announcement.textContent).toBe(
      "This run is waiting for you to sign in.",
    );
    expect(
      prompt.compareDocumentPosition(suiteHeader("protocol")) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      within(prompt).getByRole("button", { name: "Open sign-in page" }),
    ).toBeDefined();
    expect(
      within(prompt).getByRole("button", { name: "Skip OAuth" }),
    ).toBeDefined();
    // One prompt: the OAuth suite points at it rather than repeating it.
    expect(
      screen.getAllByRole("button", { name: "Skip OAuth" }),
    ).toHaveLength(1);
    expect(
      screen.getByText(
        "Waiting for sign-in. Use the prompt at the top of the run.",
      ),
    ).toBeDefined();
    openSpy.mockRestore();
  });

  it("offers the authorization page and a skip when the browser blocks the popup", async () => {
    const openSpy = vi
      .spyOn(window, "open")
      .mockReturnValue(null as unknown as Window);
    setupSuccessfulRunMocks();
    mockStartOAuth.mockResolvedValue({
      phase: "authorization_needed",
      sessionId: "session-1",
      authorizationUrl: "https://auth.example.com/authorize",
    });

    render(<ConformanceTab server={createHttpServer()} />);
    await clickRun();

    await screen.findByText(
      "Your browser blocked the sign-in window. Allow pop-ups for this site, or open the sign-in page.",
    );
    expect(
      screen.queryByText("Waiting for browser authorization..."),
    ).toBeNull();
    // The OAuth suite warns too: a spinner there reads as a run that never
    // finishes (CQT-97).
    expect(
      screen.getByTestId("conformance-oauth-suite-blocked"),
    ).toBeDefined();

    // Opening it again from a click is what a popup blocker lets through. The
    // blocked-window dialog sits over the page, so its button is the one in
    // reach.
    openSpy.mockReturnValue({} as unknown as Window);
    fireEvent.click(
      within(screen.getByRole("alertdialog")).getByRole("button", {
        name: "Open sign-in page",
      }),
    );
    expect(openSpy).toHaveBeenLastCalledWith(
      "https://auth.example.com/authorize",
      "oauth_conformance_auth",
      expect.any(String),
    );
    await screen.findByText("Waiting for browser authorization...");
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    openSpy.mockRestore();
  });

  it("skips OAuth while it waits, leaving it not scored rather than failed", async () => {
    const openSpy = vi
      .spyOn(window, "open")
      .mockReturnValue({} as unknown as Window);
    setupSuccessfulRunMocks();
    mockStartOAuth.mockResolvedValue({
      phase: "authorization_needed",
      sessionId: "session-1",
      authorizationUrl: "https://auth.example.com/authorize",
    });

    render(<ConformanceTab server={createHttpServer()} />);
    await clickRun();
    await screen.findByText("Waiting for browser authorization...");

    fireEvent.click(screen.getByRole("button", { name: "Skip OAuth" }));

    const header = await waitFor(() =>
      screen
        .getByText("OAuth was skipped, so it is not scored for this run.")
        .closest("button"),
    );
    expect(within(header!).getByText("NOT APPLICABLE")).toBeDefined();
    expect(within(header!).queryByText("FAILED")).toBeNull();

    // The checks were skipped, not ruled out, so the list says so.
    fireEvent.click(header!);
    expect(screen.getByText(/checks in this suite\. Not run\./)).toBeDefined();
    expect(screen.queryByText(/None apply to this server/)).toBeNull();

    // A consent that completes late cannot bring the suite back.
    window.dispatchEvent(
      new MessageEvent("message", {
        origin: window.location.origin,
        data: { type: "OAUTH_CALLBACK", code: "late-code" },
      }),
    );
    expect(mockSubmitCode).not.toHaveBeenCalled();
    openSpy.mockRestore();
  });

  it("keeps OAuth skipped when a callback already submitting finishes after the skip", async () => {
    const openSpy = vi
      .spyOn(window, "open")
      .mockReturnValue({} as unknown as Window);
    const submit = createDeferred<{ success: boolean }>();
    setupSuccessfulRunMocks();
    mockStartOAuth.mockResolvedValue({
      phase: "authorization_needed",
      sessionId: "session-1",
      authorizationUrl: "https://auth.example.com/authorize",
    });
    mockSubmitCode.mockReturnValue(submit.promise);
    mockCompleteOAuth.mockResolvedValue({
      phase: "complete",
      result: createOAuthResult(),
    });

    render(<ConformanceTab server={createHttpServer()} />);
    await clickRun();
    await screen.findByText("Waiting for browser authorization...");

    window.dispatchEvent(
      new MessageEvent("message", {
        origin: window.location.origin,
        data: { type: "OAUTH_CALLBACK", code: "auth-code" },
      }),
    );
    await waitFor(() => expect(mockSubmitCode).toHaveBeenCalled());

    fireEvent.click(screen.getByRole("button", { name: "Skip OAuth" }));
    submit.resolve({ success: true });
    await submit.promise;

    const header = await waitFor(() =>
      screen
        .getByText("OAuth was skipped, so it is not scored for this run.")
        .closest("button"),
    );
    expect(within(header!).getByText("NOT APPLICABLE")).toBeDefined();
    expect(mockCompleteOAuth).not.toHaveBeenCalled();
    openSpy.mockRestore();
  });

  it("never opens an authorization URL that is not http or https", async () => {
    const openSpy = vi
      .spyOn(window, "open")
      .mockReturnValue({} as unknown as Window);
    setupSuccessfulRunMocks();
    mockStartOAuth.mockResolvedValue({
      phase: "authorization_needed",
      sessionId: "session-1",
      authorizationUrl: "javascript:alert(document.domain)",
    });

    render(<ConformanceTab server={createHttpServer()} />);
    await clickRun();

    await screen.findByText(/authorization URL is not an http or https/);
    expect(openSpy).not.toHaveBeenCalled();
    expect(
      screen.queryByRole("button", { name: "Open sign-in page" }),
    ).toBeNull();
    openSpy.mockRestore();
  });

  it("runs the OAuth suite without a negative-checks opt-in", async () => {
    setupSuccessfulRunMocks();
    render(<ConformanceTab server={createHttpServer()} />);

    // The negative checks are part of the OAuth suite now — no toggle gates
    // them, and the client sends no opt-in flag.
    expect(screen.queryByText("Run negative OAuth checks")).toBeNull();

    await clickRun();

    await waitFor(() => {
      expect(mockStartOAuth).toHaveBeenCalledTimes(1);
    });
    expect(mockStartOAuth.mock.calls[0][0]).not.toHaveProperty(
      "runNegativeChecks",
    );
  });

  it("keeps a passing suite shut until it is opened", async () => {
    setupSuccessfulRunMocks({
      protocol: createProtocolResult({
        checks: [
          {
            id: "ping",
            category: "core",
            title: "Ping",
            description: "Round trip",
            status: "passed",
            durationMs: 1,
          },
        ],
      }),
    });
    render(<ConformanceTab server={createHttpServer()} />);
    await runToCompletion();

    const header = suiteHeader("protocol");
    expect(header.getAttribute("aria-expanded")).toBe("false");
    expect(isCollapsed(screen.getByText("Ping"))).toBe(true);

    fireEvent.click(header);

    expect(header.getAttribute("aria-expanded")).toBe("true");
    expect(isCollapsed(screen.getByText("Ping"))).toBe(false);
  });

  it("expands passed protocol rows and shows descriptions and details", async () => {
    setupSuccessfulRunMocks({
      protocol: createProtocolResult({
        checks: [
          {
            id: "ping",
            category: "core",
            title: "Ping",
            description: "Protocol detail body",
            status: "passed",
            durationMs: 1,
            details: {
              roundTripMs: 1,
              capabilities: ["tools", "resources"],
            },
          },
        ],
      }),
    });

    render(<ConformanceTab server={createHttpServer()} />);
    await runToCompletion();
    fireEvent.click(suiteHeader("protocol"));

    const body = screen.getByText("Protocol detail body");
    expect(isCollapsed(body)).toBe(true);
    clickRow("Ping");

    expect(isCollapsed(body)).toBe(false);
    expect(isCollapsed(screen.getByText(/Round Trip Ms:/))).toBe(true);
    fireEvent.click(
      within(body.parentElement!).getByRole("button", { name: "More details" }),
    );
    expect(isCollapsed(screen.getByText(/Round Trip Ms:/))).toBe(false);
    expect(screen.getByText(/Round Trip Ms:/)).toBeInTheDocument();
    expect(screen.getByText(/"tools"/)).toBeInTheDocument();
    expect(screen.getByText(/"resources"/)).toBeInTheDocument();
  });

  it("expands failed apps rows and shows description, warnings, and errors", async () => {
    setupSuccessfulRunMocks({
      apps: createAppsResult({
        passed: false,
        checks: [
          {
            id: "ui-tool-metadata-valid",
            category: "tools",
            title: "UI Tool Metadata Valid",
            description: "Apps detail body",
            status: "failed",
            durationMs: 2,
            details: { toolName: "render_card" },
            warnings: ["Missing optional output template"],
            error: { message: "Required tool metadata is missing" },
          },
        ],
      }),
    });

    render(<ConformanceTab server={createHttpServer()} />);
    await runToCompletion();

    // A failing suite opens itself.
    expect(suiteHeader("apps").getAttribute("aria-expanded")).toBe("true");
    clickRow("UI Tool Metadata Valid");

    expect(isCollapsed(screen.getByText("Apps detail body"))).toBe(false);
    expect(screen.getByText("Warnings")).toBeInTheDocument();
    expect(
      screen.getByText("Missing optional output template"),
    ).toBeInTheDocument();
    // Once: the row's message box is the only place it appears, open or shut.
    expect(
      screen.getAllByText("Required tool metadata is missing"),
    ).toHaveLength(1);
  });

  it("allows skipped protocol rows to expand", async () => {
    setupSuccessfulRunMocks({
      protocol: createProtocolResult({
        checks: [
          {
            id: "logging-set-level",
            category: "core",
            title: "Logging Set Level",
            description: "Skipped detail body",
            status: "skipped",
            durationMs: 0,
          },
        ],
      }),
    });

    render(<ConformanceTab server={createHttpServer()} />);
    await runToCompletion();
    fireEvent.click(suiteHeader("protocol"));

    clickRow("Logging Set Level");

    expect(isCollapsed(screen.getByText("Skipped detail body"))).toBe(false);
  });

  it("expands OAuth rows for passed and failed steps", async () => {
    setupSuccessfulRunMocks({
      oauth: createOAuthResult({
        steps: [
          {
            step: "oauth_invalid_client",
            title: "OAuth Check: Invalid Client",
            summary: "Reject an invalid client during token exchange.",
            status: "passed",
            durationMs: 12,
            logs: [],
            httpAttempts: [],
            teachableMoments: [
              "Authorization servers should reject unknown clients.",
            ],
          },
          {
            step: "oauth_invalid_redirect",
            title: "OAuth Check: Invalid Redirect URI",
            summary: "Reject mismatched redirect URIs at the token endpoint.",
            status: "failed",
            durationMs: 14,
            logs: [],
            httpAttempts: [],
            error: { message: "Server accepted the mismatched redirect URI." },
          },
        ],
      }),
    });

    render(<ConformanceTab server={createHttpServer()} />);
    await runToCompletion();
    fireEvent.click(suiteHeader("oauth"));

    clickRow("OAuth Check: Invalid Client");
    expect(
      isCollapsed(
        screen.getByText("Reject an invalid client during token exchange."),
      ),
    ).toBe(false);
    expect(
      isCollapsed(
        screen.getByText(
          "Authorization servers should reject unknown clients.",
        ),
      ),
    ).toBe(false);

    clickRow("OAuth Check: Invalid Redirect URI");
    expect(
      isCollapsed(
        screen.getByText(
          "Reject mismatched redirect URIs at the token endpoint.",
        ),
      ),
    ).toBe(false);
    expect(
      screen.getAllByText("Server accepted the mismatched redirect URI."),
    ).toHaveLength(1);
  });

  it("renders warnings on a passed OAuth step without an error banner", async () => {
    setupSuccessfulRunMocks({
      oauth: createOAuthResult({
        steps: [
          {
            step: "oauth_stale_session_rejection",
            title: "OAuth Check: Stale Session Rejection",
            summary: "Reject unknown session ids with a 4xx.",
            status: "passed",
            durationMs: 9,
            logs: [],
            httpAttempts: [],
            warnings: [
              "Rejected with HTTP 400 (the transport spec prefers 404)",
            ],
          },
        ],
      }),
    });

    render(<ConformanceTab server={createHttpServer()} />);
    await runToCompletion();
    fireEvent.click(suiteHeader("oauth"));

    clickRow("OAuth Check: Stale Session Rejection");
    const warning = screen.getByText(
      "Rejected with HTTP 400 (the transport spec prefers 404)",
    );
    expect(isCollapsed(warning)).toBe(false);
    expect(screen.getByText("Warnings")).toBeInTheDocument();
    // Warnings render in the muted style, never the red error treatment.
    expect(warning.closest("div")?.className).not.toContain("red");
  });

  it("collapses expanded rows when conformance is rerun", async () => {
    setupSuccessfulRunMocks({
      protocol: createProtocolResult({
        checks: [
          {
            id: "ping",
            category: "core",
            title: "Ping",
            description: "Rerun detail body",
            status: "passed",
            durationMs: 1,
          },
        ],
      }),
    });

    render(<ConformanceTab server={createHttpServer()} />);
    await runToCompletion();
    fireEvent.click(suiteHeader("protocol"));

    clickRow("Ping");
    expect(isCollapsed(screen.getByText("Rerun detail body"))).toBe(false);

    await runToCompletion();

    expect(isCollapsed(screen.getByText("Rerun detail body"))).toBe(true);
    expect(
      screen
        .getByRole("button", { name: /^Ping/ })
        .getAttribute("aria-expanded"),
    ).toBe("false");
  });

  it("resets state on server switch and ignores stale async completions", async () => {
    const staleProtocolRun = createDeferred<{
      success: boolean;
      result: MCPConformanceResult;
    }>();

    setupSuccessfulRunMocks();
    mockRunProtocol.mockImplementationOnce(() => staleProtocolRun.promise);

    const serverA = createHttpServer({
      name: "http-server-a",
      config: {
        url: "https://example.com/a",
        timeout: 30000,
      },
    });
    const serverB = createHttpServer({
      name: "http-server-b",
      config: {
        url: "https://example.com/b",
        timeout: 30000,
      },
    });

    const { rerender } = render(<ConformanceTab server={serverA} />);

    await clickRun();
    await waitFor(() => {
      expect(within(suiteHeader("apps")).getByText("PASSED")).toBeDefined();
    });

    rerender(<ConformanceTab server={serverB} />);

    // A new server starts over at the first-run prompt.
    expect(screen.queryByText(SUITE_COPY.apps.description)).toBeNull();
    expect(
      screen.getByText("Run your first conformance check"),
    ).toBeInTheDocument();

    const check = (title: string) => ({
      id: "ping" as const,
      category: "core" as const,
      title,
      description: `${title} body`,
      status: "passed" as const,
      durationMs: 1,
    });
    mockRunProtocol.mockResolvedValueOnce({
      success: true,
      result: createProtocolResult({ checks: [check("Fresh check")] }),
    });

    await clickRun();
    await screen.findByText("Fresh check");

    staleProtocolRun.resolve({
      success: true,
      result: createProtocolResult({ checks: [check("Stale check")] }),
    });

    await waitFor(() => {
      expect(screen.getByText("Fresh check")).toBeInTheDocument();
      expect(screen.queryByText("Stale check")).toBeNull();
    });
  });

  it("renders a no-auth server's OAuth suite as not applicable, not failed", async () => {
    setupSuccessfulRunMocks({
      oauth: createOAuthResult({
        passed: false,
        outcome: "not-applicable",
        summary: "No login required: the server answered without a token.",
      }),
    });

    render(<ConformanceTab server={createHttpServer()} />);
    await runToCompletion();

    // The reason replaces the suite's description, under a neutral chip
    // rather than a red failure.
    const header = screen.getByText(/No login required/).closest("button")!;
    expect(within(header).getByText("NOT APPLICABLE")).toBeDefined();
    expect(within(header).queryByText("FAILED")).toBeNull();

    // Shut by default, but it opens to the suite's checks so the reader can
    // see what it covers.
    expect(header.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(header);
    expect(header.getAttribute("aria-expanded")).toBe("true");
    expect(
      screen.getByText(/checks in this suite\. None apply to this server\./),
    ).toBeDefined();
  });

  it("turns checks a server refused for credentials into one reconnect notice", async () => {
    setupSuccessfulRunMocks({
      protocol: createProtocolResult({
        passed: false,
        outcome: "incomplete",
        checks: [
          {
            id: "server-initialize",
            category: "core",
            title: "Server Initialize",
            description: "Server responds to initialize.",
            status: "skipped",
            skipReason: "could-not-run",
            durationMs: 0,
            error: {
              message:
                "The server requires authorization (HTTP 401) and this run had no accepted credentials, so this check could not run.",
            },
            details: { authorizationRequired: true, statusCode: 401 },
          },
        ],
      }),
    });

    render(<ConformanceTab server={createHttpServer()} />);
    await runToCompletion();

    // A 401 is the server doing its job: INCOMPLETE and the next step, never
    // a red FAILED.
    const header = suiteHeader("protocol");
    expect(within(header).getByText("INCOMPLETE")).toBeDefined();
    expect(within(header).queryByText("FAILED")).toBeNull();
    expect(
      screen.getByText(
        /This server requires sign-in.*the checks that need it could not\s+run/s,
      ),
    ).toBeDefined();
    // The headline names the sign-in rather than judging the server.
    expect(
      screen.getByText(
        "Incomplete. 1 check could not run because sign-in failed. Reconnect the server and run again.",
      ),
    ).toBeDefined();
    expect(
      screen.getByText(
        /Reconnect the server with OAuth.*or update its access\s+token/s,
      ),
    ).toBeDefined();
  });

  it("blames sign-in only for the scored checks it blocked", async () => {
    const refused = {
      category: "core",
      description: "Needs a session.",
      status: "skipped",
      skipReason: "could-not-run",
      durationMs: 0,
      details: { authorizationRequired: true, statusCode: 401 },
    } as const;
    setupSuccessfulRunMocks({
      protocol: createProtocolResult({
        passed: false,
        outcome: "incomplete",
        checks: [
          { ...refused, id: "server-initialize", title: "Server Initialize" },
          // Refused too, but unscored, so it is not in `couldNotRun`.
          { ...refused, id: "wire-schema-valid", title: "Wire schema" },
          {
            id: "ping",
            category: "core",
            title: "Ping",
            description: "Ping.",
            status: "skipped",
            skipReason: "could-not-run",
            durationMs: 0,
          },
        ],
        profile: {
          profileId: "mcp-protocol",
          profileVersion: "1",
          manifestDigest: "digest",
          checkerVersion: "1",
          pendingCheckIds: ["wire-schema-valid"],
        },
      }),
    });

    render(<ConformanceTab server={createHttpServer()} />);
    await runToCompletion();

    expect(
      screen.getByText(
        "Incomplete. 1 check could not run because sign-in failed. 1 more could not run. Reconnect the server and run again.",
      ),
    ).toBeDefined();
  });

  it("shows no reconnect notice when nothing waited on authorization", async () => {
    setupSuccessfulRunMocks();
    render(<ConformanceTab server={createHttpServer()} />);
    await runToCompletion();

    expect(screen.queryByText(/This server requires sign-in/)).toBeNull();
  });

  it("badges a finished-but-failing suite as failed, not passed", async () => {
    setupSuccessfulRunMocks({
      protocol: createProtocolResult({ passed: false }),
    });

    render(<ConformanceTab server={createHttpServer()} />);
    await runToCompletion();

    // Finishing only says the run ended; a failing suite must not read green.
    const header = suiteHeader("protocol");
    expect(within(header).getByText("FAILED")).toBeDefined();
    expect(within(header).queryByText("PASSED")).toBeNull();
  });

  it("marks a pending failed protocol check unscored and leaves a scored failure unmarked", async () => {
    setupSuccessfulRunMocks({
      protocol: createProtocolResult({
        passed: true,
        checks: [
          {
            id: "ping",
            category: "core",
            title: "Ping",
            description: "Ping.",
            status: "failed",
            durationMs: 1,
            error: { message: "pong missing" },
          },
          {
            id: "wire-schema-valid",
            category: "protocol",
            title: "Wire schema is valid",
            description: "Schema check.",
            status: "failed",
            durationMs: 1,
            error: { message: "schema mismatch" },
          },
        ],
        profile: {
          profileId: "mcp-protocol",
          profileVersion: "1",
          manifestDigest: "digest",
          checkerVersion: "1",
          pendingCheckIds: ["wire-schema-valid"],
        },
      }),
    });

    render(<ConformanceTab server={createHttpServer()} />);
    await runToCompletion();

    const pendingRow = screen
      .getByText("Wire schema is valid")
      .closest("button");
    expect(pendingRow).toHaveTextContent("unscored");
    expect(
      screen
        .getByTitle(/Unscored checks don't count toward the score/)
        .closest("button"),
    ).toBe(pendingRow);
    // An unscored finding reads as information, not as a failure that counts.
    fireEvent.click(pendingRow!);
    expect(screen.getByText("schema mismatch")).toHaveClass(
      "text-muted-foreground",
    );

    const scoredRow = screen.getByText("Ping").closest("button");
    expect(scoredRow).not.toHaveTextContent("unscored");
    fireEvent.click(scoredRow!);
    expect(screen.getByText("pong missing")).toHaveClass("text-red-600");
  });

  it("badges an incomplete tasks run distinctly from a passing one", async () => {
    setupSuccessfulRunMocks();
    mockRunTasks.mockResolvedValue({
      success: true,
      result: createTasksResult({ passed: false, outcome: "incomplete" }),
    });

    render(<ConformanceTab server={createHttpServer()} />);
    await runToCompletion();

    expect(within(suiteHeader("tasks")).getByText("INCOMPLETE")).toBeDefined();
  });

  it("shows Tasks advice the run could not judge as a grey line", async () => {
    setupSuccessfulRunMocks();
    const reason =
      "Not checked: the task didn't fail, so there was no failure reason to look at.";
    mockRunTasks.mockResolvedValue({
      success: true,
      result: createTasksResult({
        uncheckedAdvice: [
          {
            id: "tasks-readiness-failed-status-message",
            title: "Failed Task Status Message",
            reason,
          },
        ],
      }),
    });

    render(<ConformanceTab server={createHttpServer()} />);
    await runToCompletion();

    expect(screen.getByText("Failed Task Status Message")).toBeDefined();
    expect(screen.getByText(reason)).toHaveClass("text-muted-foreground");
  });

  it("shows which URLs were probed on a failed OAuth step", async () => {
    setupSuccessfulRunMocks({
      oauth: createOAuthResult({
        passed: false,
        outcome: "failed",
        summary:
          "OAuth conformance failed at Request Resource Metadata: Resource server does not implement OAuth 2.0 Protected Resource Metadata.",
        steps: [
          {
            step: "request_resource_metadata",
            title: "Request Resource Metadata",
            summary: "The client requests RFC9728 resource metadata.",
            status: "failed",
            durationMs: 34,
            logs: [],
            httpAttempts: [
              {
                step: "request_resource_metadata",
                timestamp: 1712700000000,
                request: {
                  method: "GET",
                  url: "https://example.com/.well-known/oauth-protected-resource/mcp",
                  headers: {},
                },
                response: { status: 404, statusText: "Not Found", headers: {} },
                duration: 12,
              },
              {
                step: "request_resource_metadata",
                timestamp: 1712700000001,
                request: {
                  method: "GET",
                  url: "https://example.com/.well-known/oauth-protected-resource",
                  headers: {},
                },
                response: { status: 404, statusText: "Not Found", headers: {} },
                duration: 22,
              },
            ],
            error: {
              message:
                "Resource server does not implement OAuth 2.0 Protected Resource Metadata.",
            },
          },
        ],
      }),
    });

    render(<ConformanceTab server={createHttpServer()} />);
    await runToCompletion();

    clickRow("Request Resource Metadata");

    // Both fallback probes are named, so the reader knows what to implement.
    expect(isCollapsed(screen.getByText("Requests tried"))).toBe(false);
    expect(
      screen.getByText(
        "https://example.com/.well-known/oauth-protected-resource/mcp",
      ),
    ).toBeDefined();
    expect(
      screen.getByText(
        "https://example.com/.well-known/oauth-protected-resource",
      ),
    ).toBeDefined();
    expect(screen.getAllByText("404").length).toBe(2);
  });

  it("shows why an OAuth step could not run", async () => {
    setupSuccessfulRunMocks({
      oauth: createOAuthResult({
        passed: false,
        outcome: "incomplete",
        steps: [
          {
            step: "request_resource_metadata",
            title: "Request Resource Metadata",
            summary: "The client requests RFC9728 resource metadata.",
            status: "skipped",
            skipReason: "could-not-run",
            durationMs: 0,
            logs: [],
            httpAttempts: [],
            error: { message: "The authorization server timed out." },
          },
        ],
      }),
    });

    render(<ConformanceTab server={createHttpServer()} />);
    await runToCompletion();

    // The row shows its status; the reason waits for the row to open.
    const row = screen.getByText("Request Resource Metadata").closest("button");
    expect(row).not.toBeNull();
    expect(within(row!).getByText("!")).toBeInTheDocument();
    const reason = "The authorization server timed out.";
    expect(within(row!).queryByText(reason)).toBeNull();
    fireEvent.click(row!);
    expect(screen.getByText(reason).closest("[inert]")).toBeNull();
  });
});

describe("ConformanceTab blocked sign-in window", () => {
  const AUTH_URL = "https://auth.example.com/authorize?client_id=c";
  const DIALOG_TITLE = "Your browser blocked the sign-in window";

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function setupAuthorizationNeeded() {
    setupSuccessfulRunMocks();
    mockStartOAuth.mockResolvedValue({
      phase: "authorization_needed",
      sessionId: "session-1",
      authorizationUrl: AUTH_URL,
    });
  }

  it("asks in a dialog when the browser blocks the sign-in window", async () => {
    setupAuthorizationNeeded();
    vi.spyOn(window, "open").mockReturnValue(null);
    render(<ConformanceTab server={createHttpServer()} />);
    await clickRun();

    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText(DIALOG_TITLE)).toBeInTheDocument();
    expect(
      within(dialog).getByText(
        "OAuth checks need you to sign in to http-server. The other checks keep running.",
      ),
    ).toBeInTheDocument();
    // It opens on its own, so a stray key must not land on Skip OAuth.
    await waitFor(() =>
      expect(
        within(dialog).getByRole("button", { name: "Open sign-in page" }),
      ).toHaveFocus(),
    );
  });

  it("keeps the dialog open when the browser blocks the window again", async () => {
    setupAuthorizationNeeded();
    vi.spyOn(window, "open").mockReturnValue(null);
    render(<ConformanceTab server={createHttpServer()} />);
    await clickRun();
    const dialog = await screen.findByRole("alertdialog");

    fireEvent.click(
      within(dialog).getByRole("button", { name: "Open sign-in page" }),
    );

    expect(screen.getByRole("alertdialog")).toBeInTheDocument();
  });

  it("skips OAuth from the dialog", async () => {
    setupAuthorizationNeeded();
    vi.spyOn(window, "open").mockReturnValue(null);
    render(<ConformanceTab server={createHttpServer()} />);
    await clickRun();
    const dialog = await screen.findByRole("alertdialog");

    fireEvent.click(within(dialog).getByRole("button", { name: "Skip OAuth" }));

    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(
      screen.getByText("OAuth was skipped, so it is not scored for this run."),
    ).toBeInTheDocument();
  });

  it("shows no dialog when the sign-in window opens", async () => {
    setupAuthorizationNeeded();
    vi.spyOn(window, "open").mockReturnValue({} as Window);
    render(<ConformanceTab server={createHttpServer()} />);
    await clickRun();

    expect(
      await screen.findByText("Waiting for browser authorization..."),
    ).toBeInTheDocument();
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });
  it("keeps local Tasks overrides when saved server inputs load and Settings saves", async () => {
    setupSuccessfulRunMocks();
    const alpha = createHttpServer({ name: "alpha" });
    const local = {
      tasksProbe: { toolName: "default-job" },
      tasksOverrides: {
        "tasks-inline-result": {
          toolName: "custom-job",
          arguments: { fast: true },
        },
      },
    };
    window.localStorage.setItem(
      "mcpjam.conformance.probes.v1:alpha",
      JSON.stringify(local),
    );
    const selection = {
      protocol: [],
      apps: [],
      tasks: ["tasks-inline-result"],
      oauth: false,
    } satisfies import("@/hooks/use-conformance-run").ConformanceSelection;
    const save = vi.fn(
      async (_name: string, _selection: unknown, _inputs?: unknown) => {},
    );
    window.history.replaceState(null, "", "/conformance?run=alpha");
    render(
      <ConformanceTab
        server={alpha}
        servers={[alpha]}
        serverInputs={{ alpha: { tasksProbe: { toolName: "shared-job" } } }}
        serverDefaults={{ alpha: selection }}
        onLoadServerDefaults={vi.fn(async () => ({
          selection,
          inputs: { tasksProbe: { toolName: "shared-job" } },
        }))}
        onSaveServerDefaults={save}
      />,
    );
    await waitFor(() =>
      expect(mockRunTasks).toHaveBeenCalledWith(
        "alpha",
        expect.objectContaining({
          toolName: "default-job",
          checkOverrides: {
            "tasks-inline-result": {
              toolName: "custom-job",
              toolArguments: { fast: true },
            },
          },
        }),
      ),
    );
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Run again" })).toBeEnabled(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    fireEvent.click(await screen.findByRole("checkbox", { name: "Run OAuth" }));
    await waitFor(() => expect(save).toHaveBeenCalled());
    expect(save.mock.calls.at(-1)?.[2]).not.toHaveProperty("tasksOverrides");
    expect(
      JSON.parse(
        window.localStorage.getItem("mcpjam.conformance.probes.v1:alpha")!,
      ),
    ).toEqual(local);
  });

});


it("keeps completed suites and ignores late results after a shared timeout, including parked OAuth", async () => {
  vi.useFakeTimers();
  try {
    setupSuccessfulRunMocks();
    let finishApps: (value: unknown) => void = () => {};
    mockRunApps.mockImplementation(() => new Promise((resolve) => { finishApps = resolve; }));
    mockStartOAuth.mockResolvedValue({
      phase: "authorization_needed",
      sessionId: "session-timeout",
      authorizationUrl: "https://auth.example/authorize",
    });
    const server = createHttpServer();
    const { result } = renderHook(() => useConformanceRun({
      server, runTimeoutSeconds: 1, deferOAuthAuthorization: true,
    }));
    await act(async () => { void result.current.runAll(); });
    expect(result.current.protocol.status).toBe("done");
    expect(result.current.apps.status).toBe("running");
    expect(result.current.oauth.status).toBe("needs-authorization");
    await act(async () => { vi.advanceTimersByTime(1_000); });
    expect(result.current.protocol.status).toBe("done");
    expect(result.current.apps.status).toBe("error");
    expect(result.current.oauth.status).toBe("unavailable");
    expect(result.current.oauth.skipped).toBe(true);
    await act(async () => { finishApps({ success: true, result: createAppsResult() }); });
    expect(result.current.apps.status).toBe("error");
    expect(result.current.apps.error).toBe("Run timed out after 1 seconds");
  } finally {
    vi.useRealTimers();
  }
});


it("does not dispatch later suites when the deadline expires after preflight", async () => {
  vi.useFakeTimers();
  try {
    vi.setSystemTime(0);
    setupSuccessfulRunMocks();
    vi.mocked(checkConformanceConnection).mockImplementationOnce(async () => {
      // Move the wall clock without firing the timer: dispatch must notice expiry.
      vi.setSystemTime(1_000);
      return { status: "ready", protocolVersion: "2025-11-25" };
    });
    const server = createHttpServer();
    const { result } = renderHook(() => useConformanceRun({ server, runTimeoutSeconds: 1 }));
    await act(async () => { await result.current.runAll(); });
    expect(mockRunProtocol).not.toHaveBeenCalled();
    expect(mockRunApps).not.toHaveBeenCalled();
    expect(mockRunTasks).not.toHaveBeenCalled();
    expect(mockStartOAuth).not.toHaveBeenCalled();
    for (const suite of [result.current.protocol, result.current.apps, result.current.tasks, result.current.oauth]) {
      expect(suite.status).toBe("error");
      expect(suite.error).toBe("Run timed out after 1 seconds");
    }
  } finally {
    vi.useRealTimers();
  }
});


it("sets a saved server's run timeout in Settings and runs with it", async () => {
  setupSuccessfulRunMocks();
  const alpha = createHttpServer({ name: "alpha" });
  const saveTimeout = vi.fn(async (_name: string, _seconds: number | null) => {});
  render(<ConformanceTab
    server={alpha}
    servers={[alpha]}
    persist={{ projectId: "project-1" }}
    isSavedServer={() => true}
    onSelectServer={vi.fn()}
    onSaveServerDefaults={vi.fn(async () => {})}
    serverDefaults={{ alpha: {} }}
    serverTimeouts={{}}
    onSaveServerTimeout={saveTimeout}
  />);
  await runToCompletion();
  expect(mockRunProtocol).toHaveBeenLastCalledWith(
    "alpha",
    expect.objectContaining({ runTimeoutSeconds: 300 }),
  );

  fireEvent.click(screen.getByRole("button", { name: "Settings" }));
  const field = screen.getByLabelText("Total run timeout (seconds)");
  expect(field).toHaveValue(300);
  fireEvent.change(field, { target: { value: "90" } });
  fireEvent.blur(field);
  await waitFor(() => expect(saveTimeout).toHaveBeenCalledWith("alpha", 90));
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Back" })).toBeEnabled(),
  );
  fireEvent.click(screen.getByRole("button", { name: "Back" }));

  await runToCompletion();
  expect(mockRunProtocol).toHaveBeenLastCalledWith(
    "alpha",
    expect.objectContaining({ runTimeoutSeconds: 90 }),
  );
});


it.each(["lands", "fails"])(
  "runs with a timeout whose save is still in flight, and drops it if the save %s badly",
  async (outcome) => {
    // Back works while the timeout saves, so Run again can start before the
    // save lands: the run must already use the new value.
    setupSuccessfulRunMocks();
    const alpha = createHttpServer({ name: "alpha" });
    const save = createDeferred<void>();
    const saveTimeout = vi.fn(
      (_name: string, _seconds: number | null) => save.promise,
    );
    const error = vi.spyOn(toast, "error").mockImplementation(() => "");
    try {
      render(<ConformanceTab
        server={alpha}
        servers={[alpha]}
        persist={{ projectId: "project-1" }}
        isSavedServer={() => true}
        onSelectServer={vi.fn()}
        onSaveServerDefaults={vi.fn(async () => {})}
        serverDefaults={{ alpha: {} }}
        serverTimeouts={{}}
        onSaveServerTimeout={saveTimeout}
      />);
      await runToCompletion();

      fireEvent.click(screen.getByRole("button", { name: "Settings" }));
      const field = screen.getByLabelText("Total run timeout (seconds)");
      fireEvent.change(field, { target: { value: "90" } });
      fireEvent.blur(field);
      await waitFor(() => expect(saveTimeout).toHaveBeenCalledWith("alpha", 90));
      fireEvent.click(screen.getByRole("button", { name: "Back" }));

      // The save has not landed yet.
      await runToCompletion();
      expect(mockRunProtocol).toHaveBeenLastCalledWith(
        "alpha",
        expect.objectContaining({ runTimeoutSeconds: 90 }),
      );

      if (outcome === "fails") {
        await act(async () => save.reject(new Error("offline")));
        expect(error).toHaveBeenCalledWith(
          "Could not save the run timeout. Try again.",
        );
        // Not saved, so the next run is back on the default.
        await runToCompletion();
        expect(mockRunProtocol).toHaveBeenLastCalledWith(
          "alpha",
          expect.objectContaining({ runTimeoutSeconds: 300 }),
        );
      } else {
        await act(async () => save.resolve());
        await runToCompletion();
        expect(mockRunProtocol).toHaveBeenLastCalledWith(
          "alpha",
          expect.objectContaining({ runTimeoutSeconds: 90 }),
        );
      }
    } finally {
      error.mockRestore();
    }
  },
);


it("runs an unsaved project server, or one with no project, on the default timeout", async () => {
  setupSuccessfulRunMocks();
  // A value the old setup clock left behind is no longer read.
  window.localStorage.setItem("mcpjam:conformance:timeout:local", "90");
  try {
    const unsaved = createHttpServer({ name: "unsaved" });
    const view = render(<ConformanceTab
      server={unsaved}
      servers={[unsaved]}
      persist={{ projectId: "project-1" }}
      isSavedServer={() => false}
      onSelectServer={vi.fn()}
    />);
    await runToCompletion();
    expect(mockRunProtocol).toHaveBeenLastCalledWith(
      "unsaved",
      expect.objectContaining({ runTimeoutSeconds: 300 }),
    );
    view.unmount();

    const local = createHttpServer({ name: "local" });
    render(<ConformanceTab
      server={local}
      servers={[local]}
      onSelectServer={vi.fn()}
    />);
    await runToCompletion();
    expect(mockRunProtocol).toHaveBeenLastCalledWith(
      "local",
      expect.objectContaining({ runTimeoutSeconds: 300 }),
    );
  } finally {
    window.localStorage.removeItem("mcpjam:conformance:timeout:local");
  }
});


it("rejects a late suite response before a delayed deadline timer fires", async () => {
  vi.useFakeTimers();
  try {
    vi.setSystemTime(0);
    setupSuccessfulRunMocks();
    let finishApps: (value: unknown) => void = () => {};
    mockRunApps.mockImplementation(() => new Promise((resolve) => { finishApps = resolve; }));
    const server = createHttpServer();
    const { result } = renderHook(() => useConformanceRun({ server, runTimeoutSeconds: 1 }));
    await act(async () => { void result.current.runAll(); });
    expect(result.current.protocol.status).toBe("done");
    await act(async () => {
      vi.setSystemTime(1_001);
      finishApps({ success: true, result: createAppsResult() });
    });
    expect(result.current.apps.status).toBe("error");
    expect(result.current.apps.verdict).toBe("incomplete");
    expect(result.current.pooledScore?.outcome).toBe("incomplete");
    expect(result.current.protocol.status).toBe("done");
  } finally {
    vi.useRealTimers();
  }
});


it("leaves unstarted public-score OAuth unscored at the default deadline", async () => {
  vi.useFakeTimers();
  try {
    setupSuccessfulRunMocks();
    mockStartOAuth.mockResolvedValue({
      phase: "authorization_needed",
      sessionId: "deferred-score",
      authorizationUrl: "https://auth.example/authorize",
    });
    const server = createHttpServer();
    const { result } = renderHook(() =>
      useConformanceRun({ server, deferOAuthAuthorization: true }),
    );
    await act(async () => {
      await result.current.runAll();
    });
    const completedScore = result.current.pooledScore;
    expect(result.current.oauth.status).toBe("needs-authorization");
    await act(async () => {
      vi.advanceTimersByTime(300_000);
    });
    expect(result.current.pooledScore).toEqual(completedScore);
    expect(cancelOAuthConformance).toHaveBeenCalledWith("deferred-score");
    expect(result.current.oauth).toMatchObject({
      status: "unavailable",
      skipped: true,
    });
    expect(result.current.oauth.authorizationUrl).toBeUndefined();
    expect(result.current.oauth.unavailableReason).toContain(
      "Run again to authorize",
    );
    await act(async () => {
      result.current.authorizeOAuth();
    });
    expect(mockStartOAuth).toHaveBeenCalledTimes(1);
  } finally {
    vi.useRealTimers();
  }
});

it("still marks actively waiting OAuth incomplete when the run expires", async () => {
  vi.useFakeTimers();
  try {
    setupSuccessfulRunMocks();
    vi.spyOn(window, "open").mockReturnValue({} as Window);
    mockStartOAuth.mockResolvedValue({
      phase: "authorization_needed",
      sessionId: "active-auth",
      authorizationUrl: "https://auth.example/authorize",
    });
    const server = createHttpServer();
    const { result } = renderHook(() =>
      useConformanceRun({ server, runTimeoutSeconds: 1 }),
    );
    await act(async () => {
      await result.current.runAll();
    });
    expect(result.current.oauth.status).toBe("running");
    await act(async () => {
      vi.advanceTimersByTime(1_000);
    });
    expect(result.current.oauth.verdict).toBe("incomplete");
    expect(result.current.oauth.error).toBe("Run timed out after 1 seconds");
  } finally {
    vi.useRealTimers();
  }
});
