import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("@/state/app-state-context", () => ({
  useSharedAppState: () => ({
    servers: {
      "srv-1": { connectionStatus: "connected", name: "Notion" },
      "srv-2": { connectionStatus: "connected", name: "GitHub" },
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

import { LoggerView } from "../logger-view";
import { useTrafficLogStore } from "@/stores/traffic-log-store";

describe("LoggerView hosted rpc logs", () => {
  beforeEach(() => {
    useTrafficLogStore.getState().clear();
  });

  it("renders hosted server names and filters by server name prop", () => {
    useTrafficLogStore.getState().addMcpServerLog({
      serverId: "srv-1",
      serverName: "Notion",
      direction: "SEND",
      method: "tools/list",
      timestamp: "2026-04-10T12:00:00.000Z",
      payload: { ok: true },
    });
    useTrafficLogStore.getState().addMcpServerLog({
      serverId: "srv-2",
      serverName: "GitHub",
      direction: "SEND",
      method: "tools/list",
      timestamp: "2026-04-10T12:00:01.000Z",
      payload: { ok: true },
    });

    render(<LoggerView serverIds={["Notion"]} />);

    expect(screen.getByText("Notion")).toBeInTheDocument();
    expect(screen.queryByText("GitHub")).not.toBeInTheDocument();
  });

  it("searches by hosted server name and copies both server name and id", async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(window.navigator, "clipboard", {
      configurable: true,
      value: {
        writeText,
      },
    });

    useTrafficLogStore.getState().addMcpServerLog({
      serverId: "srv-1",
      serverName: "Notion",
      direction: "SEND",
      method: "tools/list",
      timestamp: "2026-04-10T12:00:00.000Z",
      payload: { ok: true },
    });
    useTrafficLogStore.getState().addMcpServerLog({
      serverId: "srv-2",
      serverName: "GitHub",
      direction: "RECEIVE",
      method: "result",
      timestamp: "2026-04-10T12:00:01.000Z",
      payload: { ok: false },
    });

    render(<LoggerView />);

    await user.type(screen.getByPlaceholderText("Search logs"), "git");

    expect(screen.getByText("GitHub")).toBeInTheDocument();
    expect(screen.queryByText("Notion")).not.toBeInTheDocument();

    await user.click(screen.getByTitle("Copy logs to clipboard"));

    expect(writeText).toHaveBeenCalledTimes(1);
    expect(JSON.parse(writeText.mock.calls[0][0])).toEqual([
      expect.objectContaining({
        serverId: "srv-2",
        serverName: "GitHub",
      }),
    ]);
  });
});
