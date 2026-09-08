import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  Children,
  cloneElement,
  isValidElement,
  type ReactElement,
  type ReactNode,
} from "react";

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

// Real dropdown menu is a Radix popover; swap it for plain markup so the
// source-filter radio items are directly clickable in jsdom.
vi.mock("@mcpjam/design-system/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children: ReactNode }) => <>{children}</>,
  DropdownMenuTrigger: ({ children }: { children: ReactNode }) => (
    <>{children}</>
  ),
  DropdownMenuContent: ({ children }: { children: ReactNode }) => (
    <>{children}</>
  ),
  DropdownMenuRadioGroup: ({
    children,
    onValueChange,
  }: {
    children: ReactNode;
    onValueChange: (value: string) => void;
  }) => (
    <div data-testid="source-filter-group">
      {Children.map(children, (child) =>
        isValidElement(child)
          ? cloneElement(child as ReactElement<{ value: string }>, {
              onClick: () => onValueChange((child.props as { value: string }).value),
            } as Record<string, unknown>)
          : child,
      )}
    </div>
  ),
  DropdownMenuRadioItem: ({
    children,
    onClick,
  }: {
    children: ReactNode;
    onClick?: () => void;
  }) => (
    <button type="button" role="menuitemradio" onClick={onClick}>
      {children}
    </button>
  ),
}));

import { LoggerView } from "../logger-view";
import {
  ingestOAuthTraceLogs,
  useTrafficLogStore,
} from "@/stores/traffic-log-store";
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

  it("renders automatic OAuth decisions as their own log entry", () => {
    ingestOAuthTraceLogs({
      serverId: "srv-1",
      serverName: "Notion",
      trace: {
        version: 1,
        source: "interactive_connect",
        currentStep: "authorization_request",
        steps: [
          {
            step: "received_authorization_server_metadata",
            title: "Authorization Server Metadata Received",
            status: "success",
            message:
              "Automatic resolved to DCR for this run. The authorization server advertised registration_endpoint, and CIMD support was not advertised.",
            details: {
              "Automatic Decision": "DCR",
            },
            startedAt: Date.parse("2026-04-10T12:00:02.000Z"),
            completedAt: Date.parse("2026-04-10T12:00:02.000Z"),
          },
        ],
        httpHistory: [],
      },
    });

    render(<LoggerView serverIds={["srv-1"]} />);

    expect(
      screen.getByText(
        /Automatic Resolution - Automatic resolved to DCR for this run\./
      )
    ).toBeInTheDocument();
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

  it("exports logs as a JSON file when the download button is clicked", async () => {
    const user = userEvent.setup();

    // Stub URL.createObjectURL / revokeObjectURL
    const createObjectURL = vi.fn(() => "blob:mock-url");
    const revokeObjectURL = vi.fn();
    vi.stubGlobal("URL", {
      ...URL,
      createObjectURL,
      revokeObjectURL,
    });

    // Capture the anchor click
    const anchorClick = vi.fn();
    const origCreate = document.createElement.bind(document);
    vi
      .spyOn(document, "createElement")
      .mockImplementation((tag: string, ...rest) => {
        const el = origCreate(tag, ...rest);
        if (tag === "a") {
          vi.spyOn(el as HTMLAnchorElement, "click").mockImplementation(
            anchorClick,
          );
        }
        return el;
      });

    useTrafficLogStore.getState().addMcpServerLog({
      serverId: "srv-1",
      serverName: "Notion",
      direction: "SEND",
      method: "tools/list",
      timestamp: "2026-04-10T12:00:00.000Z",
      payload: { ok: true },
    });

    render(<LoggerView />);

    await user.click(screen.getByTitle("Export logs as JSON file"));

    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(anchorClick).toHaveBeenCalledTimes(1);
    await waitFor(() =>
      expect(revokeObjectURL).toHaveBeenCalledWith("blob:mock-url"),
    );

    vi.restoreAllMocks();
    vi.unstubAllGlobals();
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

  it("surfaces a hidden-matches banner when the source filter hides a search match, and clears it on click", async () => {
    const user = userEvent.setup();

    // Only lives on an `http` exchange row, not a JSON-RPC frame.
    useTrafficLogStore.getState().addMcpServerLog({
      serverId: "srv-1",
      serverName: "Notion",
      direction: "SEND",
      method: "POST",
      timestamp: "2026-04-10T12:00:00.000Z",
      payload: { headers: { "mcp-session-id": "abc-123" } },
      kind: "http",
    });

    render(<LoggerView />);

    await user.click(screen.getByTitle("Filter Source"));
    await user.click(screen.getByRole("menuitemradio", { name: "Server" }));

    await user.type(
      screen.getByPlaceholderText("Search logs"),
      "mcp-session-id",
    );

    expect(
      screen.getByText("1 match hidden by the source filter"),
    ).toBeInTheDocument();
    expect(screen.getByText("No matches in this view")).toBeInTheDocument();

    await user.click(screen.getByText("Clear filter"));

    expect(
      screen.queryByText("1 match hidden by the source filter"),
    ).not.toBeInTheDocument();
    expect(screen.getByText("POST")).toBeInTheDocument();
  });

  it("shows 'No matches in this view' (not 'No logs yet') when the source filter hides all logs and search is empty", async () => {
    const user = userEvent.setup();

    useTrafficLogStore.getState().addMcpServerLog({
      serverId: "srv-1",
      serverName: "Notion",
      direction: "SEND",
      method: "POST",
      timestamp: "2026-04-10T12:00:00.000Z",
      payload: { headers: {} },
      kind: "http",
    });

    render(<LoggerView />);

    await user.click(screen.getByTitle("Filter Source"));
    await user.click(screen.getByRole("menuitemradio", { name: "Server" }));

    expect(screen.getByText("No matches in this view")).toBeInTheDocument();
    expect(screen.queryByText("No logs yet")).not.toBeInTheDocument();
  });

  it("still shows 'No logs yet' when there are no logs at all", () => {
    render(<LoggerView />);

    expect(screen.getByText("No logs yet")).toBeInTheDocument();
  });
});

// A row whose body was dropped at a retention cap still opens, and has to say
// why it is empty rather than show a bare `_truncated` field the reader has to
// decode.
describe("LoggerView truncated payloads", () => {
  beforeEach(() => {
    useTrafficLogStore.getState().clear();
  });

  async function expandRow(label: string) {
    const user = userEvent.setup();
    await user.click(screen.getByText(label));
  }

  it("explains a truncated body and still renders the envelope that survived", async () => {
    useTrafficLogStore.getState().addMcpServerLog({
      serverId: "srv-1",
      serverName: "Notion",
      direction: "RECEIVE",
      method: "tools/call",
      timestamp: "2026-04-10T12:00:00.000Z",
      payload: {
        jsonrpc: "2.0",
        id: 14,
        result: { _truncated: true },
        _truncated: true,
        limitBytes: 256 * 1024,
      },
    });

    render(<LoggerView serverIds={["srv-1"]} />);
    await expandRow("tools/call");

    expect(
      screen.getByText("Payload not recorded — over the 256 KB log limit.")
    ).toBeInTheDocument();
    // The id is what correlates the row to its request, so it has to survive
    // the drop and reach the reader.
    expect(screen.getByText("14")).toBeInTheDocument();
  });

  it("shows no notice for an ordinary payload", async () => {
    useTrafficLogStore.getState().addMcpServerLog({
      serverId: "srv-1",
      serverName: "Notion",
      direction: "SEND",
      method: "tools/list",
      timestamp: "2026-04-10T12:00:00.000Z",
      payload: { jsonrpc: "2.0", id: 1, method: "tools/list" },
    });

    render(<LoggerView serverIds={["srv-1"]} />);
    await expandRow("tools/list");

    expect(screen.queryByText(/Payload not recorded/)).not.toBeInTheDocument();
  });

  it("opens rows with a null or empty payload without a notice", async () => {
    useTrafficLogStore.getState().addMcpServerLog({
      serverId: "srv-1",
      serverName: "Notion",
      direction: "SEND",
      method: "notifications/cancelled",
      timestamp: "2026-04-10T12:00:00.000Z",
      payload: null,
    });
    useTrafficLogStore.getState().addMcpServerLog({
      serverId: "srv-1",
      serverName: "Notion",
      direction: "SEND",
      method: "notifications/initialized",
      timestamp: "2026-04-10T12:00:01.000Z",
      payload: {},
    });

    render(<LoggerView serverIds={["srv-1"]} />);
    await expandRow("notifications/cancelled");
    await expandRow("notifications/initialized");

    expect(screen.queryByText(/Payload not recorded/)).not.toBeInTheDocument();
  });
});
