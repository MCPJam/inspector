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
import { subscribeToOAuthDebuggerRequests } from "@/lib/oauth/oauth-debugger-navigation";

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

  it("renders oauth sequence steps as log entries", () => {
    useTrafficLogStore.getState().addMcpServerLog({
      id: "oauth:srv-1:interactive_connect:request_client_registration:1",
      serverId: "srv-1",
      serverName: "Notion",
      direction: "OAUTH",
      method: "Dynamic Client Registration",
      timestamp: "2026-04-10T12:00:02.000Z",
      payload: {
        source: "interactive_connect",
        step: "request_client_registration",
        title: "Dynamic Client Registration",
        status: "success",
      },
      kind: "oauth",
      oauthStatus: "success",
    });

    render(<LoggerView serverIds={["srv-1"]} />);

    expect(screen.getByText("Dynamic Client Registration")).toBeInTheDocument();
    expect(screen.getByText("Notion")).toBeInTheDocument();
  });

  it("shows oauth failure detail inline for collapsed rows", () => {
    useTrafficLogStore.getState().addMcpServerLog({
      id: "oauth:srv-1:interactive_connect:request_client_registration:2",
      serverId: "srv-1",
      serverName: "Notion",
      direction: "OAUTH",
      method: "Dynamic Client Registration",
      timestamp: "2026-04-10T12:00:03.000Z",
      payload: {
        source: "interactive_connect",
        step: "request_client_registration",
        title: "Dynamic Client Registration",
        status: "success",
        error: "Dynamic Client Registration is not enabled for this project.",
        recovered: true,
        recoveryMessage:
          "Using pre-registered client credentials after registration failed.",
      },
      kind: "oauth",
      oauthStatus: "success",
      oauthRecovered: true,
    });

    render(<LoggerView serverIds={["srv-1"]} />);

    expect(
      screen.getByText(
        "Dynamic Client Registration - Dynamic Client Registration is not enabled for this project."
      )
    ).toBeInTheDocument();
  });

  it("shows an OAuth Debugger CTA when an oauth log row has error status", async () => {
    const user = userEvent.setup();
    const onOpenOAuthDebugger = vi.fn();
    const unsubscribe = subscribeToOAuthDebuggerRequests(onOpenOAuthDebugger);
    useTrafficLogStore.getState().addMcpServerLog({
      id: "oauth:srv-1:interactive_connect:request_client_registration:err",
      serverId: "srv-1",
      serverName: "Learn",
      direction: "OAUTH",
      method: "Dynamic Client Registration",
      timestamp: "2026-04-10T12:00:04.000Z",
      payload: {
        source: "interactive_connect",
        step: "request_client_registration",
        title: "Dynamic Client Registration",
        status: "error",
        message:
          "The client submits metadata to register a public client with the authorization server.",
        error: "dynamic_client_registration",
      },
      kind: "oauth",
      oauthStatus: "error",
    });

    render(<LoggerView serverIds={["srv-1"]} />);

    const rowLabel = screen.getByText(
      "Dynamic Client Registration - dynamic_client_registration"
    );
    const entry = rowLabel.closest(".group");
    expect(entry).toBeTruthy();
    await user.hover(entry!);

    const cta = screen.getByRole("link", {
      name: "Continue in OAuth Debugger",
    });
    expect(cta).toHaveAttribute("href", "#oauth-flow");
    await user.click(cta);
    expect(onOpenOAuthDebugger).toHaveBeenCalledWith({
      serverName: "Learn",
    });
    unsubscribe();
  });

  it("filters logs to the current session when sinceTimestamp is provided", () => {
    useTrafficLogStore.getState().addMcpServerLog({
      id: "oauth:srv-1:interactive_connect:request_client_registration:1",
      serverId: "srv-1",
      serverName: "Notion",
      direction: "OAUTH",
      method: "Old OAuth Flow",
      timestamp: "2026-04-10T12:00:00.000Z",
      payload: {
        source: "interactive_connect",
        step: "request_client_registration",
        title: "Old OAuth Flow",
        status: "success",
      },
      kind: "oauth",
      oauthStatus: "success",
    });
    useTrafficLogStore.getState().addMcpServerLog({
      id: "rpc:srv-1:initialize:2",
      serverId: "srv-1",
      serverName: "Notion",
      direction: "SEND",
      method: "initialize",
      timestamp: "2026-04-10T12:00:02.000Z",
      payload: { ok: true },
    });

    render(
      <LoggerView
        serverIds={["srv-1"]}
        sinceTimestamp={Date.parse("2026-04-10T12:00:01.000Z")}
      />
    );

    expect(screen.getByText("initialize")).toBeInTheDocument();
    expect(screen.queryByText("Old OAuth Flow")).not.toBeInTheDocument();
  });
});
