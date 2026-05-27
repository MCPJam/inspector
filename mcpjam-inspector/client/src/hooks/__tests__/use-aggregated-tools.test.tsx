import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAggregatedTools } from "../use-aggregated-tools";
import { setApiContext } from "@/lib/apis/web/context";
import { listTools } from "@/lib/apis/mcp-tools-api";

vi.mock("@/lib/apis/mcp-tools-api", () => ({
  listTools: vi.fn(),
}));

describe("useAggregatedTools", () => {
  beforeEach(() => {
    vi.mocked(listTools).mockImplementation(async ({ serverId }) => ({
      tools: [
        {
          name: `${serverId}_tool`,
          description: `${serverId} tool`,
          inputSchema: { type: "object", properties: {} },
        },
      ],
    }));
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
          "server-stateless": "DRAFT-2026-v1",
        },
        getAccessToken: async () => null,
      });
    });

    await waitFor(() => {
      expect(listTools).toHaveBeenCalledTimes(4);
    });

    unmount();
  });
});
