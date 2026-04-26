import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import type {
  MCPConformanceResult,
  MCPAppsConformanceResult,
  ConformanceResult as OAuthConformanceResult,
} from "@mcpjam/sdk";
import { toConformanceReport } from "@mcpjam/sdk/browser";
import type { ServerWithName } from "@/hooks/use-app-state";

const mockRunProtocol = vi.fn();
const mockRunApps = vi.fn();
const mockStartOAuth = vi.fn();
const mockSubmitCode = vi.fn();
const mockCompleteOAuth = vi.fn();

vi.mock("@/lib/apis/mcp-conformance-api", () => ({
  runProtocolConformance: (...args: unknown[]) => mockRunProtocol(...args),
  runAppsConformance: (...args: unknown[]) => mockRunApps(...args),
  startOAuthConformance: (...args: unknown[]) => mockStartOAuth(...args),
  submitOAuthConformanceCode: (...args: unknown[]) => mockSubmitCode(...args),
  completeOAuthConformance: (...args: unknown[]) => mockCompleteOAuth(...args),
}));

vi.mock("@/lib/apis/mode-client", () => ({
  isHostedMode: () => false,
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

function createOAuthResult(
  overrides: Partial<OAuthConformanceResult> = {},
): OAuthConformanceResult {
  return {
    passed: true,
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
  mockRunProtocol.mockResolvedValue({
    success: true,
    result: protocol,
    report: toConformanceReport(protocol),
  });
  mockRunApps.mockResolvedValue({
    success: true,
    result: apps,
    report: toConformanceReport(apps),
  });
  mockStartOAuth.mockResolvedValue({
    phase: "complete",
    result: oauth,
    report: toConformanceReport(oauth),
  });
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
  it("renders the tab title for an HTTP server", () => {
    render(<ConformanceTab server={createHttpServer()} />);

    expect(screen.getByText("Conformance")).toBeDefined();
    expect(screen.getByText("Run available checks")).toBeDefined();
    expect(
      screen.getByText(/Run Protocol, Apps, and OAuth checks against/),
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

  it("shows all three suite sections", () => {
    render(<ConformanceTab server={createHttpServer()} />);

    expect(screen.getByText("Protocol")).toBeDefined();
    expect(screen.getByText("Apps")).toBeDefined();
    expect(screen.getByText("OAuth")).toBeDefined();
  });

  it("marks Protocol and OAuth as unavailable for stdio servers", () => {
    render(<ConformanceTab server={createStdioServer()} />);

    // Both suites share the same reason from the SDK's canRunConformance.
    const unavailableMessages = screen.getAllByText(
      /requires an HTTP transport/i,
    );
    expect(unavailableMessages.length).toBeGreaterThanOrEqual(2);
  });

  it("shows the negative checks toggle", () => {
    render(<ConformanceTab server={createHttpServer()} />);

    expect(screen.getByText("Run negative OAuth checks")).toBeDefined();
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
    mockRunApps.mockResolvedValue({ success: true, result: createAppsResult() });
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
      screen.getByText(/Run Protocol, Apps, and OAuth checks against http-server-b/),
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
});
