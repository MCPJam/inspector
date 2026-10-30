import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  render,
  screen,
  fireEvent,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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

const mockRunProtocol = vi.fn();
const mockRunApps = vi.fn();
const mockRunTasks = vi.fn();
const mockStartOAuth = vi.fn();
const mockSubmitCode = vi.fn();
const mockCompleteOAuth = vi.fn();

vi.mock("@/lib/apis/mcp-conformance-api", () => ({
  runProtocolConformance: (...args: unknown[]) => mockRunProtocol(...args),
  runAppsConformance: (...args: unknown[]) => mockRunApps(...args),
  runTasksConformance: (...args: unknown[]) => mockRunTasks(...args),
  startOAuthConformance: (...args: unknown[]) => mockStartOAuth(...args),
  submitOAuthConformanceCode: (...args: unknown[]) => mockSubmitCode(...args),
  completeOAuthConformance: (...args: unknown[]) => mockCompleteOAuth(...args),
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

import { toast } from "@/lib/toast";
import { ConformanceTab } from "../ConformancePanel";
import { RUN_LABEL } from "../ConformancePageChrome";
import { SUITE_COPY } from "../conformance-ui";

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

/** Before a run the header and the pre-run prompt both offer Run; either starts it. */
function clickRun() {
  fireEvent.click(screen.getAllByRole("button", { name: RUN_LABEL })[0]);
}

/** Starts a run and waits until no suite is still running. */
async function runToCompletion() {
  clickRun();
  await waitFor(() => {
    expect(screen.queryByText("RUNNING")).toBeNull();
    expect(screen.getByRole("button", { name: RUN_LABEL })).toBeEnabled();
  });
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
  window.localStorage.clear();
});

describe("ConformanceTab", () => {
  // The page writes the active tab to `?view=`; start each test without it.
  afterEach(() => {
    window.history.replaceState(null, "", "/");
  });

  it("shows a pooled score headline with denominator, and readiness advice that costs points", async () => {
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
            id: "readiness-metadata-quality",
            title: "Metadata Quality",
            severity: "warning",
            specStrength: "SHOULD",
            message: "2 tool(s) have no description",
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

    // Pooled: 4/4 applicable across the suites, one SHOULD advisory (-2)
    // from protocol readiness = 98. The number shows on the headline and on
    // the Protocol row, which carries the same advisory.
    expect(screen.getAllByText("98").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("Conformant, with advice.")).toBeInTheDocument();
    // The denominator travels with the number.
    expect(screen.getByText("4/4")).toBeInTheDocument();

    // The advisory that deducted is visible, tier and all.
    expect(screen.getByText("Metadata Quality")).toBeInTheDocument();
    expect(screen.getByText("(SHOULD)")).toBeInTheDocument();
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

  it("opens Overview when a run starts from History", async () => {
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
    clickRun();

    expect(screen.getByRole("tab", { name: "Overview" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(screen.getByRole("tabpanel")).not.toHaveTextContent("History table");
    await waitFor(() => expect(mockRunProtocol).toHaveBeenCalled());
  });

  it("keeps the URL on the tab, so a refresh after Run lands on Overview", () => {
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

    clickRun();
    expect(window.location.search).toBe("");

    fireEvent.click(screen.getByRole("tab", { name: "History" }));
    expect(window.location.search).toBe("?view=history");
  });

  it("stays on History when Run has no server to run", () => {
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

    clickRun();

    expect(info).toHaveBeenCalledWith(
      "Connect an MCP server to run conformance checks.",
    );
    expect(screen.getByRole("tab", { name: "History" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(mockRunProtocol).not.toHaveBeenCalled();
    info.mockRestore();
  });

  it("asks for a server instead of running when none is selected", () => {
    const info = vi.spyOn(toast, "info");
    render(<ConformanceTab server={null} />);

    expect(
      screen.getByText("Run your first conformance check"),
    ).toBeInTheDocument();
    clickRun();

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

  it("treats a selection the page no longer offers as no server", () => {
    const info = vi.spyOn(toast, "info");
    // The selected server was removed and the project has no other.
    render(
      <ConformanceTab
        server={createHttpServer({ name: "gamma" })}
        servers={[]}
        onSelectServer={vi.fn()}
      />,
    );

    clickRun();

    expect(info).toHaveBeenCalledWith(
      "Add a server to run conformance checks.",
    );
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
    clickRun();
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
    clickRun();
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

  it("offers the server picker beside the run button before the first run", () => {
    const server = createHttpServer({ name: "alpha" });
    render(
      <ConformanceTab
        server={server}
        servers={[server]}
        onSelectServer={vi.fn()}
      />,
    );
    // One in the header, one beside the pre-run prompt's run button.
    expect(screen.getAllByRole("combobox", { name: "Server" })).toHaveLength(2);
  });

  it("connects a server that is not connected, then runs", async () => {
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

    clickRun();
    expect(onConnectServer).toHaveBeenCalledWith("alpha", { signIn: false });
    expect(
      (await screen.findAllByRole("button", { name: /Connecting/ }))[0],
    ).toBeDisabled();
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
    await waitFor(() => expect(mockRunProtocol).toHaveBeenCalled());
  });

  it("names the server and offers Retry or Edit when the connect fails", async () => {
    const info = vi.spyOn(toast, "info");
    const server = createHttpServer({
      name: "alpha",
      connectionStatus: "failed",
      lastError: "connect ECONNREFUSED 127.0.0.1:3000",
    });
    const onConnectServer = vi.fn(async () => "failed" as const);
    const onEditServer = vi.fn();
    render(
      <ConformanceTab
        server={server}
        servers={[server]}
        onSelectServer={vi.fn()}
        onConnectServer={onConnectServer}
        onEditServer={onEditServer}
      />,
    );

    clickRun();
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(`Couldn't connect to "alpha"`);
    expect(alert).toHaveTextContent("connect ECONNREFUSED 127.0.0.1:3000");
    expect(info).not.toHaveBeenCalled();
    expect(mockRunProtocol).not.toHaveBeenCalled();

    fireEvent.click(
      within(alert).getByRole("button", { name: "Edit connection" }),
    );
    expect(onEditServer).toHaveBeenCalledWith("alpha");
    fireEvent.click(within(alert).getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(onConnectServer).toHaveBeenCalledTimes(2));
    expect(onConnectServer).toHaveBeenLastCalledWith("alpha", {
      signIn: false,
    });
    info.mockRestore();
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

    clickRun();
    expect(await screen.findByRole("alert")).toBeInTheDocument();

    // Fixed from Edit connection, which reconnects without going through Run.
    const connected = { ...server, connectionStatus: "connected" as const };
    rerender(
      <ConformanceTab server={connected} servers={[connected]} {...props} />,
    );
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();

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

    clickRun();
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

  it("asks to add a server when the project has none", () => {
    const onAddServer = vi.fn();
    render(
      <ConformanceTab
        server={null}
        servers={[]}
        onSelectServer={vi.fn()}
        onAddServer={onAddServer}
      />,
    );

    expect(
      screen.getByText("Add a server to run conformance checks."),
    ).toBeInTheDocument();
    // Run stays beside Add server, disabled, as well as in the header.
    const runButtons = screen.getAllByRole("button", { name: RUN_LABEL });
    expect(runButtons).toHaveLength(2);
    for (const button of runButtons) expect(button).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Add server" }));
    expect(onAddServer).toHaveBeenCalledTimes(1);
  });

  it("shows a server's connection note in the menu, not the closed select", async () => {
    const user = userEvent.setup();
    const server = createHttpServer({
      name: "alpha",
      connectionStatus: "disconnected",
    });
    render(
      <ConformanceTab
        server={server}
        servers={[server]}
        onSelectServer={vi.fn()}
      />,
    );

    const trigger = screen.getAllByRole("combobox", { name: "Server" })[0];
    expect(trigger).toHaveTextContent("Server · alpha");
    expect(trigger).not.toHaveTextContent("Not connected");

    await user.click(trigger);
    expect(screen.getByRole("option", { name: /alpha/ })).toHaveTextContent(
      "Not connected",
    );
  });

  it("labels the server select like the protocol select", () => {
    const server = createHttpServer({ name: "alpha" });
    const { rerender } = render(
      <ConformanceTab
        server={server}
        servers={[server]}
        onSelectServer={vi.fn()}
      />,
    );
    expect(
      screen.getAllByRole("combobox", { name: "Server" })[0],
    ).toHaveTextContent("Server · alpha");

    // Servers to pick from, none selected yet.
    rerender(
      <ConformanceTab
        server={null}
        servers={[server]}
        onSelectServer={vi.fn()}
      />,
    );
    expect(
      screen.getAllByRole("combobox", { name: "Server" })[0],
    ).toHaveTextContent("Server · Select");

    rerender(
      <ConformanceTab server={null} servers={[]} onSelectServer={vi.fn()} />,
    );
    expect(
      screen.getAllByRole("combobox", { name: "Server" })[0],
    ).toHaveTextContent("Server · None");
  });

  it("lists protocol versions newest first, after Auto", async () => {
    const user = userEvent.setup();
    render(<ConformanceTab server={createHttpServer()} />);
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

    // Shut, an era skip says nothing to act on, so it carries no box.
    expect(screen.queryByText(/Not applicable to the legacy era/)).toBeNull();

    clickRow("No Session Id Minted");
    const reason = screen.getByText(/Not applicable to the legacy era/);
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

    expect(mockRunTasks).toHaveBeenCalledWith("http-server");
    expect(within(suiteHeader("tasks")).getByText("PASSED")).toBeDefined();
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

  it("runs unpinned by default and forwards the OAuth profile's own version", async () => {
    setupSuccessfulRunMocks();
    render(<ConformanceTab server={createHttpServer()} />);

    clickRun();

    await waitFor(() => {
      expect(mockRunProtocol).toHaveBeenCalledWith("http-server", {
        protocolVersion: undefined,
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
    render(<ConformanceTab server={createHttpServer()} />);

    await user.click(
      screen.getByRole("combobox", { name: "Protocol version" }),
    );
    await user.click(screen.getByRole("option", { name: "2026-07-28" }));

    clickRun();

    await waitFor(() => {
      expect(mockRunProtocol).toHaveBeenCalledWith("http-server", {
        protocolVersion: "2026-07-28",
      });
    });
    await waitFor(() => {
      expect(mockStartOAuth).toHaveBeenCalledWith(
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
    setupSuccessfulRunMocks();
    mockRunProtocol.mockRejectedValue(new Error("protocol endpoint down"));
    render(<ConformanceTab server={createHttpServer()} />);
    await runToCompletion();

    // On "auto" the era is unknown, so both eras are listed.
    expect(screen.getByText("Ping")).toBeDefined();
    expect(screen.getByText("Modern Client Handshake")).toBeDefined();

    await user.click(
      screen.getByRole("combobox", { name: "Protocol version" }),
    );
    await user.click(screen.getByRole("option", { name: "2025-06-18" }));

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
    clickRun();

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
    clickRun();

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
      expect(mockCompleteOAuth).toHaveBeenCalledWith("session-1");
    });
    expect(within(suiteHeader("oauth")).getByText("RUNNING")).toBeDefined();
    expect(screen.queryByText(/checks in this suite\. Not run yet/)).toBeNull();

    poll.resolve({ phase: "complete", result: createOAuthResult() });
    await waitFor(() => {
      expect(within(suiteHeader("oauth")).getByText("PASSED")).toBeDefined();
    });
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
    clickRun();

    await screen.findByText(
      "Your browser blocked the authorization window. Allow pop-ups for this site, or open the authorization page.",
    );
    expect(
      screen.queryByText("Waiting for browser authorization..."),
    ).toBeNull();

    // Opening it again from a click is what a popup blocker lets through.
    openSpy.mockReturnValue({} as unknown as Window);
    fireEvent.click(
      screen.getByRole("button", { name: "Open authorization page" }),
    );
    expect(openSpy).toHaveBeenLastCalledWith(
      "https://auth.example.com/authorize",
      "oauth_conformance_auth",
      expect.any(String),
    );
    await screen.findByText("Waiting for browser authorization...");
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
    clickRun();
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
    clickRun();
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
    clickRun();

    await screen.findByText(/authorization URL is not an http or https/);
    expect(openSpy).not.toHaveBeenCalled();
    expect(
      screen.queryByRole("button", { name: "Open authorization page" }),
    ).toBeNull();
    openSpy.mockRestore();
  });

  it("runs the OAuth suite without a negative-checks opt-in", async () => {
    setupSuccessfulRunMocks();
    render(<ConformanceTab server={createHttpServer()} />);

    // The negative checks are part of the OAuth suite now — no toggle gates
    // them, and the client sends no opt-in flag.
    expect(screen.queryByText("Run negative OAuth checks")).toBeNull();

    clickRun();

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

    clickRun();
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

    clickRun();
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
    expect(screen.getByText("schema mismatch")).toHaveClass(
      "text-muted-foreground",
    );

    const scoredRow = screen.getByText("Ping").closest("button");
    expect(scoredRow).not.toHaveTextContent("unscored");
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

    // On the row itself, not only inside its collapsed details.
    const row = screen.getByText("Request Resource Metadata").closest("button");
    expect(row).not.toBeNull();
    expect(within(row!).getByText("!")).toBeInTheDocument();
    expect(
      within(row!).getByText("The authorization server timed out."),
    ).toBeInTheDocument();
  });
});
