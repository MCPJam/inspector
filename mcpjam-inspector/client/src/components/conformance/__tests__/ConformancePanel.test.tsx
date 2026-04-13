import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import type {
  MCPConformanceResult,
  MCPAppsConformanceResult,
  ConformanceResult as OAuthConformanceResult,
} from "@mcpjam/sdk";
import type { ServerWithName } from "@/hooks/use-app-state";

// Mock the conformance API
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

import { ConformancePanel } from "../ConformancePanel";

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
  mockRunProtocol.mockResolvedValue({ success: true, result: protocol });
  mockRunApps.mockResolvedValue({ success: true, result: apps });
  mockStartOAuth.mockResolvedValue({ phase: "complete", result: oauth });
}

function clickRow(title: string) {
  const button = screen.getByText(title).closest("button");
  expect(button).not.toBeNull();
  fireEvent.click(button!);
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

describe("ConformancePanel", () => {
  it("renders panel title for HTTP server", () => {
    render(
      <ConformancePanel
        open={true}
        onOpenChange={vi.fn()}
        server={createHttpServer()}
      />,
    );

    expect(screen.getByText("Conformance")).toBeDefined();
    expect(screen.getByText("Run available checks")).toBeDefined();
  });

  it("shows all three suite sections", () => {
    render(
      <ConformancePanel
        open={true}
        onOpenChange={vi.fn()}
        server={createHttpServer()}
      />,
    );

    expect(screen.getByText("Protocol")).toBeDefined();
    expect(screen.getByText("Apps")).toBeDefined();
    expect(screen.getByText("OAuth")).toBeDefined();
  });

  it("marks Protocol and OAuth as unavailable for stdio servers", () => {
    render(
      <ConformancePanel
        open={true}
        onOpenChange={vi.fn()}
        server={createStdioServer()}
      />,
    );

    const unavailableText = screen.getAllByText("Unavailable");
    expect(unavailableText.length).toBeGreaterThanOrEqual(2);
  });

  it("shows negative checks toggle", () => {
    render(
      <ConformancePanel
        open={true}
        onOpenChange={vi.fn()}
        server={createHttpServer()}
      />,
    );

    expect(screen.getByText("Run negative OAuth checks")).toBeDefined();
  });

  it("does not render when closed", () => {
    const { container } = render(
      <ConformancePanel
        open={false}
        onOpenChange={vi.fn()}
        server={createHttpServer()}
      />,
    );

    // Sheet content should not be visible
    expect(container.querySelector("[data-slot='sheet-content']")).toBeNull();
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

    render(
      <ConformancePanel
        open={true}
        onOpenChange={vi.fn()}
        server={createHttpServer()}
      />,
    );

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

    render(
      <ConformancePanel
        open={true}
        onOpenChange={vi.fn()}
        server={createHttpServer()}
      />,
    );

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

    render(
      <ConformancePanel
        open={true}
        onOpenChange={vi.fn()}
        server={createHttpServer()}
      />,
    );

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

    render(
      <ConformancePanel
        open={true}
        onOpenChange={vi.fn()}
        server={createHttpServer()}
      />,
    );

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

    render(
      <ConformancePanel
        open={true}
        onOpenChange={vi.fn()}
        server={createHttpServer()}
      />,
    );

    fireEvent.click(screen.getByText("Run available checks"));
    await screen.findByText("Protocol summary");

    clickRow("Ping");
    expect(screen.queryByText("Rerun detail body")).not.toBeNull();

    fireEvent.click(screen.getByText("Run available checks"));

    await waitFor(() => {
      expect(screen.queryByText("Rerun detail body")).toBeNull();
    });
  });
});
