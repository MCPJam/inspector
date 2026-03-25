import { renderHook, waitFor, act } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ServerWithName } from "@/hooks/use-app-state";
import { useUiAppServers } from "../use-ui-app-servers";

const { mockListTools } = vi.hoisted(() => ({
  mockListTools: vi.fn(),
}));

vi.mock("@/lib/apis/mcp-tools-api", () => ({
  listTools: mockListTools,
}));

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
