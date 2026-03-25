import { renderHook, waitFor, act } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ServerWithName } from "@/hooks/use-app-state";
import { useUiAppServers } from "../use-ui-app-servers";

const { mockListTools, mockIsMCPApp } = vi.hoisted(() => ({
  mockListTools: vi.fn(),
  mockIsMCPApp: vi.fn(() => false),
}));

vi.mock("@/lib/apis/mcp-tools-api", () => ({
  listTools: mockListTools,
}));

vi.mock("@/lib/mcp-ui/mcp-apps-utils", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/mcp-ui/mcp-apps-utils")>();
  return {
    ...actual,
    isMCPApp: mockIsMCPApp,
  };
});

function createServer(
  name: string,
  overrides: Partial<ServerWithName> = {},
): ServerWithName {
  return {
    name,
    lastConnectionTime: new Date(),
    connectionStatus: "connected",
    enabled: true,
    retryCount: 0,
    useOAuth: false,
    config: {
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-test"],
    },
    ...overrides,
  };
}

describe("useUiAppServers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("marks a connected server as resolved when tools metadata has no UI", async () => {
    mockListTools.mockResolvedValue({
      tools: [],
      toolsMetadata: {},
    });

    const servers = {
      "test-server": createServer("test-server"),
    };

    const { result } = renderHook(() => useUiAppServers(servers));

    await waitFor(() => {
      expect(result.current.resolvedServerNames).toEqual(["test-server"]);
    });

    expect(result.current.appServerNames).toEqual([]);
    expect(result.current.hasAppServer).toBe(false);
  });

  it("marks a connected server as resolved when the UI capability check fails", async () => {
    mockListTools.mockRejectedValue(new Error("tools/list failed"));

    const servers = {
      "test-server": createServer("test-server"),
    };

    const { result } = renderHook(() => useUiAppServers(servers));

    await waitFor(() => {
      expect(result.current.resolvedServerNames).toEqual(["test-server"]);
    });

    expect(result.current.appServerNames).toEqual([]);
    expect(result.current.hasAppServer).toBe(false);
  });

  it("identifies a server as a UI app when isMCPApp returns true", async () => {
    mockListTools.mockResolvedValue({
      tools: [],
      toolsMetadata: { "render-ui": { "ui.resourceUri": "ui://app" } },
    });
    mockIsMCPApp.mockReturnValue(true);

    const servers = {
      "test-server": createServer("test-server"),
    };

    const { result } = renderHook(() => useUiAppServers(servers));

    await waitFor(() => {
      expect(result.current.resolvedServerNames).toEqual(["test-server"]);
    });

    expect(result.current.appServerNames).toEqual(["test-server"]);
    expect(result.current.hasAppServer).toBe(true);

    mockIsMCPApp.mockReturnValue(false);
  });

  it("marks a server as resolved after 5s timeout when listTools hangs", async () => {
    vi.useFakeTimers();

    // listTools never resolves
    mockListTools.mockReturnValue(new Promise(() => {}));

    const servers = {
      "test-server": createServer("test-server"),
    };

    const { result } = renderHook(() => useUiAppServers(servers));

    // Not resolved yet
    expect(result.current.resolvedServerNames).toEqual([]);

    // Advance past the 5s timeout
    await act(async () => {
      vi.advanceTimersByTime(5_000);
    });

    expect(result.current.resolvedServerNames).toEqual(["test-server"]);
    expect(result.current.appServerNames).toEqual([]);

    vi.useRealTimers();
  });
});
