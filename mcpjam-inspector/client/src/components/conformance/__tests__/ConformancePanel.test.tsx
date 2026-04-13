import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
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

function createHttpServer(overrides: Partial<ServerWithName> = {}): ServerWithName {
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

function createStdioServer(overrides: Partial<ServerWithName> = {}): ServerWithName {
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
});
