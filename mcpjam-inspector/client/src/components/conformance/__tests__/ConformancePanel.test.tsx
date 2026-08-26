import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
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

import { ConformanceTab } from "../ConformancePanel";

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
    fireEvent.click(
      screen.getByRole("button", { name: /run available checks/i }),
    );

    // Pooled: 4/4 applicable across the suites, one SHOULD advisory (-2)
    // from protocol readiness = 98. The number appears twice: the pooled
    // headline and the Protocol suite chip (the clean suites' chips read
    // 100/100).
    // The headline's own text node is the bare number (the /100 is a child
    // span); the Protocol suite chip renders the combined "98/100".
    await waitFor(() => expect(screen.getByText("98")).toBeInTheDocument());
    expect(screen.getByText("98/100")).toBeInTheDocument();
    expect(screen.getByText("Conformant, with advice")).toBeInTheDocument();
    // The denominator travels with the number.
    expect(
      screen.getByText(/4\/4 applicable checks passed/),
    ).toBeInTheDocument();

    // The advisory that deducted is visible, tier and all.
    expect(screen.getByText("Metadata Quality")).toBeInTheDocument();
    expect(screen.getByText("(SHOULD)")).toBeInTheDocument();
  });

  it("renders no score card when nothing was applicable", async () => {
    setupSuccessfulRunMocks();

    render(<ConformanceTab server={createHttpServer()} />);
    fireEvent.click(
      screen.getByRole("button", { name: /run available checks/i }),
    );

    await waitFor(() =>
      expect(screen.getByText("Protocol summary")).toBeInTheDocument(),
    );
    // Empty fixtures leave zero applicable checks everywhere: a "—/100" card
    // would be noise dressed as a number, so no card renders at all.
    expect(screen.queryByText("/100")).not.toBeInTheDocument();
  });

  it("renders the tab title for an HTTP server", () => {
    render(<ConformanceTab server={createHttpServer()} />);

    expect(screen.getByText("Conformance")).toBeDefined();
    expect(screen.getByText("Run available checks")).toBeDefined();
    expect(
      screen.getByText(/Run Protocol, Apps, Tasks, and OAuth checks against/),
    ).toBeDefined();
  });

  it("shows an empty state when no server is selected", () => {
    render(<ConformanceTab server={null} />);

    expect(screen.getByText("No server selected")).toBeInTheDocument();
    expect(
      screen.getByText(
        "Select a connected server above to run conformance checks.",
      ),
    ).toBeInTheDocument();
  });

  it("shows all suite sections", () => {
    render(<ConformanceTab server={createHttpServer()} />);

    expect(screen.getByText("Protocol")).toBeDefined();
    expect(screen.getByText("Apps")).toBeDefined();
    expect(screen.getByText("Tasks")).toBeDefined();
    expect(screen.getByText("OAuth")).toBeDefined();
  });

  it("shows the readiness sections without a flag of their own", () => {
    // This file mocks no feature-flag provider, so the sections appearing here
    // IS the assertion: reaching this page already required
    // `mcpjam-conformance`, and a second flag would have gated an audience
    // against itself. If one is ever reintroduced, this fails.
    render(<ConformanceTab server={createHttpServer()} />);

    expect(screen.getByText("Claude Directory Readiness")).toBeDefined();
    expect(screen.getByText("OpenAI Directory Readiness")).toBeDefined();
  });

  it("runs the tasks suite and renders its summary with the resolved wire", async () => {
    setupSuccessfulRunMocks();
    render(<ConformanceTab server={createHttpServer()} />);

    fireEvent.click(screen.getByText("Run available checks"));

    await waitFor(() => {
      expect(mockRunTasks).toHaveBeenCalledWith("http-server");
    });
    await waitFor(() => {
      expect(
        screen.getByText(/Tasks summary \(wire: extension\)/),
      ).toBeDefined();
    });
  });

  it("marks Protocol and OAuth as unavailable for stdio servers", () => {
    render(<ConformanceTab server={createStdioServer()} />);

    // Both suites share the same reason from the SDK's canRunConformance.
    const unavailableMessages = screen.getAllByText(
      /requires an HTTP transport/i,
    );
    expect(unavailableMessages.length).toBeGreaterThanOrEqual(2);
  });

  it("runs unpinned by default and forwards the OAuth profile's own version", async () => {
    setupSuccessfulRunMocks();
    render(<ConformanceTab server={createHttpServer()} />);

    fireEvent.click(screen.getByText("Run available checks"));

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

    fireEvent.click(screen.getByText("Run available checks"));

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

  it("reveals what a suite will run when its header is clicked", async () => {
    const user = userEvent.setup();
    render(<ConformanceTab server={createHttpServer()} />);

    // Nothing has run, so the sections start closed.
    expect(screen.queryByText("Ping")).toBeNull();

    await user.click(screen.getByRole("button", { name: /Protocol/ }));

    expect(screen.getByText("Ping")).toBeDefined();
    expect(
      screen.getByText(/checks in this suite — not run yet/),
    ).toBeDefined();
  });

  it("explains a check when its catalog row is clicked", async () => {
    const user = userEvent.setup();
    render(<ConformanceTab server={createHttpServer()} />);

    await user.click(screen.getByRole("button", { name: /Protocol/ }));

    // The row shows the canonical title; the explanation stays hidden until
    // the row itself is opened.
    expect(screen.queryByText("Server responds to ping requests.")).toBeNull();

    await user.click(screen.getByRole("button", { name: /^Ping/ }));

    expect(screen.getByText("Server responds to ping requests.")).toBeDefined();
  });

  it("narrows the protocol catalog to the pinned version's era", async () => {
    const user = userEvent.setup();
    render(<ConformanceTab server={createHttpServer()} />);

    await user.click(screen.getByRole("button", { name: /Protocol/ }));

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

    fireEvent.click(screen.getByText("Run available checks"));
    await screen.findByText("Protocol summary");

    // The suite auto-opens on completion and the preview line is gone.
    expect(screen.queryByText(/checks in this suite — not run yet/)).toBeNull();
  });

  it("keeps a running suite open instead of falling back to the catalog", async () => {
    const pending = createDeferred<{
      success: true;
      result: MCPConformanceResult;
    }>();
    setupSuccessfulRunMocks();
    mockRunProtocol.mockReturnValue(pending.promise);

    render(<ConformanceTab server={createHttpServer()} />);
    fireEvent.click(screen.getByText("Run available checks"));

    // Mid-run the section opens itself and says so. The catalog line would
    // read "not run yet", which is exactly wrong while the run is live.
    await screen.findByText(/Running \d+ checks/);
    expect(screen.queryByText(/checks in this suite — not run yet/)).toBeNull();

    pending.resolve({ success: true, result: createProtocolResult() });
    await screen.findByText("Protocol summary");
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
    fireEvent.click(screen.getByText("Run available checks"));

    await screen.findByText("Waiting for browser authorization...");

    // The callback lands and the run moves from "waiting" to polling. Keyed on
    // `hasResult` alone that dropped back to false, snapping the section shut
    // and offering the pre-run catalog for a run already in flight.
    window.dispatchEvent(
      new MessageEvent("message", {
        data: { type: "OAUTH_CALLBACK", code: "auth-code" },
      }),
    );

    await waitFor(() => {
      expect(mockCompleteOAuth).toHaveBeenCalledWith("session-1");
    });
    const oauthHeader = screen.getByRole("button", { name: /OAuth/ });
    expect(oauthHeader.getAttribute("aria-expanded")).toBe("true");
    expect(screen.queryByText(/checks in this suite — not run yet/)).toBeNull();

    poll.resolve({ phase: "complete", result: createOAuthResult() });
    await screen.findByText("OAuth summary");
    openSpy.mockRestore();
  });

  it("runs the OAuth suite without a negative-checks opt-in", async () => {
    setupSuccessfulRunMocks();
    render(<ConformanceTab server={createHttpServer()} />);

    // The negative checks are part of the OAuth suite now — no toggle gates
    // them, and the client sends no opt-in flag.
    expect(screen.queryByText("Run negative OAuth checks")).toBeNull();

    fireEvent.click(screen.getByText("Run available checks"));

    await waitFor(() => {
      expect(mockStartOAuth).toHaveBeenCalledTimes(1);
    });
    expect(mockStartOAuth.mock.calls[0][0]).not.toHaveProperty(
      "runNegativeChecks",
    );
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

    fireEvent.click(screen.getByText("Run available checks"));
    await screen.findByText("Protocol summary");

    expect(screen.queryByText("Protocol detail body")).toBeNull();
    clickRow("Ping");

    expect(screen.queryByText("Protocol detail body")).not.toBeNull();
    expect(screen.queryByText(/Round Trip Ms:/)).not.toBeNull();
    expect(screen.queryByText(/"tools"/)).not.toBeNull();
    expect(screen.queryByText(/"resources"/)).not.toBeNull();
  });

  it("expands failed apps rows and shows description, warnings, and errors", async () => {
    setupSuccessfulRunMocks({
      apps: createAppsResult({
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

    fireEvent.click(screen.getByText("Run available checks"));
    await screen.findByText("Apps summary");

    clickRow("UI Tool Metadata Valid");

    expect(screen.queryByText("Apps detail body")).not.toBeNull();
    expect(screen.queryByText("Warnings")).not.toBeNull();
    expect(
      screen.queryByText("Missing optional output template"),
    ).not.toBeNull();
    expect(
      screen.queryByText("Required tool metadata is missing"),
    ).not.toBeNull();
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

    fireEvent.click(screen.getByText("Run available checks"));
    await screen.findByText("Protocol summary");

    clickRow("Logging Set Level");

    expect(screen.queryByText("Skipped detail body")).not.toBeNull();
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

    fireEvent.click(screen.getByText("Run available checks"));
    await screen.findByText("OAuth summary");

    clickRow("OAuth Check: Invalid Client");
    expect(
      screen.queryByText("Reject an invalid client during token exchange."),
    ).not.toBeNull();
    expect(
      screen.queryByText(
        "Authorization servers should reject unknown clients.",
      ),
    ).not.toBeNull();

    clickRow("OAuth Check: Invalid Redirect URI");
    expect(
      screen.queryByText(
        "Reject mismatched redirect URIs at the token endpoint.",
      ),
    ).not.toBeNull();
    expect(
      screen.queryByText("Server accepted the mismatched redirect URI."),
    ).not.toBeNull();
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

    fireEvent.click(screen.getByText("Run available checks"));
    await screen.findByText("OAuth summary");

    clickRow("OAuth Check: Stale Session Rejection");
    const warning = screen.getByText(
      "Rejected with HTTP 400 (the transport spec prefers 404)",
    );
    expect(warning).not.toBeNull();
    expect(screen.queryByText("Warnings")).not.toBeNull();
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

    fireEvent.click(screen.getByText("Run available checks"));
    await screen.findByText("Protocol summary");

    clickRow("Ping");
    expect(screen.queryByText("Rerun detail body")).not.toBeNull();

    fireEvent.click(screen.getByText("Run available checks"));

    await waitFor(() => {
      expect(screen.queryByText("Rerun detail body")).toBeNull();
    });
  });

  it("resets state on server switch and ignores stale async completions", async () => {
    const staleProtocolRun = createDeferred<{
      success: boolean;
      result: MCPConformanceResult;
    }>();

    mockRunProtocol.mockImplementationOnce(() => staleProtocolRun.promise);
    mockRunApps.mockResolvedValue({
      success: true,
      result: createAppsResult(),
    });
    mockStartOAuth.mockResolvedValue({
      phase: "complete",
      result: createOAuthResult(),
    });

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

    fireEvent.click(screen.getByText("Run available checks"));
    await screen.findByText("Apps summary");

    rerender(<ConformanceTab server={serverB} />);

    expect(screen.queryByText("Apps summary")).toBeNull();
    expect(screen.queryByText("Protocol summary")).toBeNull();
    expect(
      screen.getByText(
        /Run Protocol, Apps, Tasks, and OAuth checks against http-server-b/,
      ),
    ).toBeInTheDocument();

    mockRunProtocol.mockResolvedValueOnce({
      success: true,
      result: createProtocolResult({
        summary: "Fresh protocol summary",
      }),
    });

    fireEvent.click(screen.getByText("Run available checks"));
    await screen.findByText("Fresh protocol summary");

    staleProtocolRun.resolve({
      success: true,
      result: createProtocolResult({
        summary: "Stale protocol summary",
      }),
    });

    await waitFor(() => {
      expect(screen.getByText("Fresh protocol summary")).toBeInTheDocument();
      expect(screen.queryByText("Stale protocol summary")).toBeNull();
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
    fireEvent.click(screen.getByText("Run available checks"));

    await waitFor(() => {
      expect(screen.getByText(/not applicable/i)).toBeDefined();
    });
    // Reported as unavailable rather than a red failure.
    expect(screen.getAllByText("Unavailable").length).toBeGreaterThanOrEqual(1);
  });

  it("badges a finished-but-failing suite as Failed, not green Done", async () => {
    setupSuccessfulRunMocks({
      protocol: createProtocolResult({ passed: false }),
    });

    render(<ConformanceTab server={createHttpServer()} />);
    fireEvent.click(screen.getByText("Run available checks"));

    await screen.findByText("Protocol summary");

    // "Done" only said the run ended; a failing suite must not read as green.
    expect(screen.queryByText("Done")).toBeNull();
    expect(screen.getByText("Failed")).toBeDefined();
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
    fireEvent.click(screen.getByText("Run available checks"));
    await screen.findByText("Protocol summary");

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
    fireEvent.click(screen.getByText("Run available checks"));

    await waitFor(() => {
      expect(screen.getByText("Incomplete")).toBeDefined();
    });
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
    fireEvent.click(screen.getByText("Run available checks"));

    await screen.findByText("Request Resource Metadata");
    clickRow("Request Resource Metadata");

    // Both fallback probes are named, so the reader knows what to implement.
    expect(screen.getByText("Requests tried")).toBeDefined();
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
});
