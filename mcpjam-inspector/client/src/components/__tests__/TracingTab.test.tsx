/**
 * The Tracing screen: the traffic log a user reads, and the snapshot the agent
 * reads of the same traffic. The snapshot reports entries by shape (method,
 * direction, server, time) and never a request or response payload.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { readSurfaceSnapshot } from "@/lib/webmcp/surface-snapshot-registry";

const SECRET_PAYLOAD = "SECRET-TOOL-RESULT-do-not-leak";

vi.mock("@/state/app-state-context", () => ({
  useSharedAppState: () => ({
    servers: {
      "srv-1": { connectionStatus: "connected", name: "Notion" },
    },
  }),
}));

vi.mock("@/stores/traffic-log-store", async () => {
  const actual = await vi.importActual<
    typeof import("@/stores/traffic-log-store")
  >("@/stores/traffic-log-store");
  return {
    ...actual,
    subscribeToRpcStream: vi.fn(() => () => {}),
  };
});

import { TracingTab } from "../TracingTab";
import { useTrafficLogStore } from "@/stores/traffic-log-store";

describe("TracingTab", () => {
  beforeEach(() => {
    useTrafficLogStore.getState().clear();
  });

  it("shows the empty state and an empty snapshot before any traffic", async () => {
    render(<TracingTab />);

    expect(screen.getByText("No logs yet")).toBeInTheDocument();
    const snapshot = await readSurfaceSnapshot("tracing");
    expect(snapshot).toMatchObject({
      ok: true,
      data: { totalItems: 0, recent: [] },
    });
  });

  it("lists server and app traffic, and snapshots it without payloads", async () => {
    useTrafficLogStore.getState().addMcpServerLog({
      serverId: "srv-1",
      serverName: "Notion",
      direction: "RECEIVE",
      method: "tools/call",
      timestamp: "2026-04-10T12:00:00.000Z",
      payload: { result: { content: [{ text: SECRET_PAYLOAD }] } },
    });
    useTrafficLogStore.getState().addLog({
      serverId: "srv-1",
      serverName: "Notion",
      direction: "ui-to-host",
      protocol: "mcp-apps",
      method: "ui/message",
      message: { text: SECRET_PAYLOAD },
    });

    render(<TracingTab />);

    expect(screen.getByText("tools/call")).toBeInTheDocument();
    expect(screen.getByText("ui/message")).toBeInTheDocument();
    expect(screen.queryByText("No logs yet")).not.toBeInTheDocument();

    const snapshot = await readSurfaceSnapshot("tracing");
    expect(snapshot).toMatchObject({
      ok: true,
      data: {
        totalItems: 2,
        counts: { mcpServer: 1, mcpApps: 1 },
        recent: expect.arrayContaining([
          expect.objectContaining({
            source: "mcp-apps",
            method: "ui/message",
            direction: "UI→HOST",
            server: "Notion",
          }),
          expect.objectContaining({
            source: "mcp-server",
            method: "tools/call",
            direction: "RECEIVE",
            server: "Notion",
          }),
        ]),
      },
    });
    expect(JSON.stringify(snapshot)).not.toContain(SECRET_PAYLOAD);
  });
});
