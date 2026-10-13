import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAggregatedTools } from "../use-aggregated-tools";
import { setApiContext } from "@/lib/apis/web/context";
import { listToolsForServers } from "@/lib/apis/mcp-tools-api";

vi.mock("@/lib/apis/mcp-tools-api", () => ({
  listToolsForServers: vi.fn(),
}));

function toolsFor(serverIds: string[]) {
  return {
    results: Object.fromEntries(
      serverIds.map((serverId) => [
        serverId,
        {
          tools: [
            {
              name: `${serverId}_tool`,
              description: `${serverId} tool`,
              inputSchema: { type: "object", properties: {} },
            },
          ],
        },
      ]),
    ),
    errors: {},
  };
}

describe("useAggregatedTools", () => {
  beforeEach(() => {
    vi.mocked(listToolsForServers).mockImplementation(async (serverIds) =>
      toolsFor(serverIds),
    );
  });

  afterEach(() => {
    setApiContext(null);
    vi.clearAllMocks();
  });

  it("refetches when hosted API context changes", async () => {
    const { result, unmount } = renderHook(() =>
      useAggregatedTools(["Excalidraw", "stateless"])
    );

    await waitFor(() => {
      expect(result.current.flat.map((entry) => entry.toolName).sort()).toEqual(
        ["Excalidraw_tool", "stateless_tool"]
      );
    });

    await act(async () => {
      setApiContext({
        projectId: "project-1",
        serverIdsByName: {
          Excalidraw: "server-stateful",
          stateless: "server-stateless",
        },
        mcpProtocolVersionsByServerId: {
          "server-stateful": "2025-11-25",
          "server-stateless": "2026-07-28",
        },
        getAccessToken: async () => null,
      });
    });

    // One batch per fetch, never one request per server (PLB-158).
    await waitFor(() => {
      expect(listToolsForServers).toHaveBeenCalledTimes(2);
    });
    for (const [serverIds] of vi.mocked(listToolsForServers).mock.calls) {
      expect([...serverIds].sort()).toEqual(["Excalidraw", "stateless"]);
    }

    unmount();
  });

  it("keeps the other servers' tools when one server fails inside the batch", async () => {
    vi.mocked(listToolsForServers).mockResolvedValue({
      ...toolsFor(["stateless"]),
      errors: { Excalidraw: new Error("connect ECONNREFUSED") },
    });

    const { result } = renderHook(() =>
      useAggregatedTools(["Excalidraw", "stateless"]),
    );

    await waitFor(() => {
      expect(result.current.flat.map((entry) => entry.toolName)).toEqual([
        "stateless_tool",
      ]);
    });
    expect(result.current.errorByServer).toEqual({
      Excalidraw: "connect ECONNREFUSED",
    });
    expect(result.current.loadingByServer).toEqual({
      Excalidraw: false,
      stateless: false,
    });
  });

  it("marks every server failed when the batch request itself fails", async () => {
    vi.mocked(listToolsForServers).mockRejectedValue(
      new Error("Too many requests. Slow down and retry."),
    );

    const { result } = renderHook(() =>
      useAggregatedTools(["Excalidraw", "stateless"]),
    );

    await waitFor(() => {
      expect(result.current.errorByServer).toEqual({
        Excalidraw: "Too many requests. Slow down and retry.",
        stateless: "Too many requests. Slow down and retry.",
      });
    });
    expect(result.current.flat).toEqual([]);
  });

  it("clears tools while a server is temporarily unavailable, then refetches", async () => {
    const { result, rerender } = renderHook(
      ({
        unavailableServerNames,
      }: {
        unavailableServerNames: ReadonlyArray<string>;
      }) =>
        useAggregatedTools(["Excalidraw"], {
          unavailableServerNames,
        }),
      {
        initialProps: { unavailableServerNames: [] },
      }
    );

    await waitFor(() => {
      expect(result.current.flat.map((entry) => entry.toolName)).toEqual([
        "Excalidraw_tool",
      ]);
    });

    rerender({ unavailableServerNames: ["Excalidraw"] });

    await waitFor(() => {
      expect(result.current.flat).toEqual([]);
      expect(result.current.loadingByServer.Excalidraw).toBe(true);
    });

    rerender({ unavailableServerNames: [] });

    await waitFor(() => {
      expect(result.current.flat.map((entry) => entry.toolName)).toEqual([
        "Excalidraw_tool",
      ]);
      expect(result.current.loadingByServer.Excalidraw).toBe(false);
    });
  });
});
