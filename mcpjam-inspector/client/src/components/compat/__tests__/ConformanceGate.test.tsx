import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import type {
  MCPConformanceResult,
  MCPAppsConformanceResult,
} from "@mcpjam/sdk";
import type { ServerWithName } from "@/state/app-types";

const mockRunProtocol = vi.fn();
const mockRunApps = vi.fn();

vi.mock("@/lib/apis/mcp-conformance-api", () => ({
  runProtocolConformance: (...args: unknown[]) => mockRunProtocol(...args),
  runAppsConformance: (...args: unknown[]) => mockRunApps(...args),
}));

import { ConformanceGate } from "../ConformanceGate";

// Minimal valid results; only `passed` + `checks[].{status,title}` are read.
const protocolResult = (
  over: Partial<MCPConformanceResult> = {},
): MCPConformanceResult =>
  ({ passed: true, checks: [], summary: "", durationMs: 1, ...over }) as MCPConformanceResult;

const appsResult = (
  over: Partial<MCPAppsConformanceResult> = {},
): MCPAppsConformanceResult =>
  ({ passed: true, checks: [], summary: "", durationMs: 1, ...over }) as MCPAppsConformanceResult;

const httpServer = (over: Partial<ServerWithName> = {}): ServerWithName =>
  ({
    name: "http-server",
    lastConnectionTime: new Date(),
    connectionStatus: "connected",
    config: { url: "https://example.com/mcp", timeout: 30000 },
    ...over,
  }) as ServerWithName;

const stdioServer = (over: Partial<ServerWithName> = {}): ServerWithName =>
  ({
    name: "stdio-server",
    lastConnectionTime: new Date(),
    connectionStatus: "connected",
    config: { command: "node", args: ["server.js"] },
    ...over,
  }) as ServerWithName;

const renderGate = (server: ServerWithName) =>
  render(
    <MemoryRouter>
      <ConformanceGate server={server} />
    </MemoryRouter>,
  );

beforeEach(() => {
  vi.clearAllMocks();
  mockRunProtocol.mockResolvedValue({ success: true, result: protocolResult() });
  mockRunApps.mockResolvedValue({ success: true, result: appsResult() });
});

describe("ConformanceGate", () => {
  it("disables the run button and prompts to connect when disconnected", () => {
    renderGate(httpServer({ connectionStatus: "disconnected" }));
    expect(
      screen.getByText(/Connect the server to run spec checks/),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Run checks/ })).toBeDisabled();
  });

  it("reports a clean pass — gaps below are host-specific, not spec problems", async () => {
    renderGate(httpServer());
    fireEvent.click(screen.getByRole("button", { name: /Run checks/ }));
    await waitFor(() =>
      expect(screen.getByText(/Passes spec checks/)).toBeInTheDocument(),
    );
    expect(mockRunProtocol).toHaveBeenCalledWith("http-server");
    expect(mockRunApps).toHaveBeenCalledWith("http-server");
  });

  it("surfaces a spec failure as 'fix first — breaks on every host'", async () => {
    mockRunApps.mockResolvedValue({
      success: true,
      result: appsResult({
        passed: false,
        checks: [
          {
            status: "failed",
            title: "UI resource contents valid",
          } as MCPAppsConformanceResult["checks"][number],
        ],
      }),
    });
    renderGate(httpServer());
    fireEvent.click(screen.getByRole("button", { name: /Run checks/ }));
    await waitFor(() =>
      expect(
        screen.getByText(/Fix these spec failures first/),
      ).toBeInTheDocument(),
    );
    expect(
      screen.getByText(/UI resource contents valid/),
    ).toBeInTheDocument();
  });

  it("resets when the active server switches — no stale results bleed across", async () => {
    const { rerender } = renderGate(httpServer({ name: "server-a" }));
    fireEvent.click(screen.getByRole("button", { name: /Run checks/ }));
    await waitFor(() =>
      expect(screen.getByText(/Passes spec checks/)).toBeInTheDocument(),
    );

    // Same component instance, new active server (the page's selector, not a
    // remount): prior results must clear, button returns to "Run checks".
    rerender(
      <MemoryRouter>
        <ConformanceGate server={httpServer({ name: "server-b" })} />
      </MemoryRouter>,
    );
    expect(screen.queryByText(/Passes spec checks/)).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Run checks/ }),
    ).toBeInTheDocument();
  });

  it("marks protocol 'not runnable here' for stdio (never failed) but still runs apps", async () => {
    renderGate(stdioServer());
    fireEvent.click(screen.getByRole("button", { name: /Run checks/ }));
    await waitFor(() =>
      expect(screen.getByText(/Not runnable here/)).toBeInTheDocument(),
    );
    // Protocol is HTTP-only — never invoked over stdio…
    expect(mockRunProtocol).not.toHaveBeenCalled();
    // …but Apps conformance still runs.
    expect(mockRunApps).toHaveBeenCalledWith("stdio-server");
    // …and a skipped (unsupported) protocol suite must NOT be counted as a
    // pass: no blanket green "Passes spec checks" when protocol never ran.
    expect(
      screen.queryByText(/Passes spec checks/),
    ).not.toBeInTheDocument();
  });
});
