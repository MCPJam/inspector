import { describe, it, expect, vi, beforeEach } from "vitest";
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
});

describe("ConformanceTab", () => {
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
    setupSuccessfulRunMocks();

    render(<ConformanceTab server={createHttpServer()} />);
    await runToCompletion();

    // Empty fixtures leave zero applicable checks everywhere: a percentage
    // would be noise dressed as a number, so the card says so in words.
    expect(
      screen.getByText("Nothing applicable to score on this server."),
    ).toBeInTheDocument();
    expect(screen.queryByText("%")).toBeNull();
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

  it("asks for a server instead of running when none is selected", () => {
    const info = vi.spyOn(toast, "info");
    render(<ConformanceTab server={null} />);

    expect(
      screen.getByText("Run your first conformance check"),
    ).toBeInTheDocument();
    clickRun();

    expect(info).toHaveBeenCalledWith(
      "Connect an MCP server to run conformance checks.",
    );
    expect(mockRunProtocol).not.toHaveBeenCalled();
    info.mockRestore();
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

  it("shows the readiness sections without a flag of their own", () => {
    // This file mocks no feature-flag provider, so the sections appearing here
    // IS the assertion: reaching this page already required
    // `mcpjam-conformance`, and a second flag would have gated an audience
    // against itself. If one is ever reintroduced, this fails.
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
      screen.getByText(/checks in this suite — not run yet/),
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
    expect(screen.queryByText(/checks in this suite — not run yet/)).toBeNull();
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
    expect(screen.queryByText(/checks in this suite — not run yet/)).toBeNull();

    pending.resolve({ success: true, result: createProtocolResult() });
    await waitFor(() => {
      expect(within(suiteHeader("protocol")).getByText("PASSED")).toBeDefined();
    });
  });

  it("stays in the run for OAuth between the callback and the result", async () => {
    const openSpy = vi
      .spyOn(window, "open")
      .mockReturnValue(null as unknown as Window);
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
    expect(screen.queryByText(/checks in this suite — not run yet/)).toBeNull();

    poll.resolve({ phase: "complete", result: createOAuthResult() });
    await waitFor(() => {
      expect(within(suiteHeader("oauth")).getByText("PASSED")).toBeDefined();
    });
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
    // Once in the row's summary line, once in the opened error banner.
    expect(
      screen.getAllByText("Required tool metadata is missing"),
    ).toHaveLength(2);
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
    ).toHaveLength(2);
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
        summary:
          "OAuth conformance not applicable for https://example.com/mcp: the server served an unauthenticated request instead of challenging, and authorization is OPTIONAL in 2025-11-25",
      }),
    });

    render(<ConformanceTab server={createHttpServer()} />);
    await runToCompletion();

    // The reason replaces the suite's description, under a neutral chip
    // rather than a red failure.
    const header = screen
      .getByText(/OAuth conformance not applicable/)
      .closest("button")!;
    expect(within(header).getByText("NOT APPLICABLE")).toBeDefined();
    expect(within(header).queryByText("FAILED")).toBeNull();
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
      screen.getByTitle("unscored by this run's profile").closest("button"),
    ).toBe(pendingRow);

    const scoredRow = screen.getByText("Ping").closest("button");
    expect(scoredRow).not.toHaveTextContent("unscored");
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
