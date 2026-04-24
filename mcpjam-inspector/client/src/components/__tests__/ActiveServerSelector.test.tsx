import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  render,
  screen,
  fireEvent,
  waitFor,
  within,
} from "@testing-library/react";
import {
  ActiveServerSelector,
  type ActiveServerSelectorProps,
} from "../ActiveServerSelector";
import type { ServerWithName } from "@/hooks/use-app-state";
import { hasOAuthConfig } from "@/lib/oauth/mcp-oauth";

// Mock posthog
vi.mock("posthog-js/react", () => ({
  usePostHog: () => ({
    capture: vi.fn(),
  }),
}));

// Mock PosthogUtils
vi.mock("@/lib/PosthogUtils", () => ({
  detectEnvironment: vi.fn().mockReturnValue("test"),
  detectPlatform: vi.fn().mockReturnValue("web"),
}));

// Mock OAuth utilities
vi.mock("@/lib/oauth/mcp-oauth", () => ({
  hasOAuthConfig: vi.fn().mockReturnValue(false),
}));

// Mock AddServerModal to simplify testing
vi.mock("../connection/AddServerModal", () => ({
  AddServerModal: ({
    isOpen,
    onClose,
    onSubmit,
  }: {
    isOpen: boolean;
    onClose: () => void;
    onSubmit: (data: unknown) => void;
  }) =>
    isOpen ? (
      <div data-testid="add-server-modal">
        <button onClick={onClose}>Close</button>
        <button
          onClick={() => onSubmit({ name: "new-server", command: "node" })}
        >
          Submit
        </button>
      </div>
    ) : null,
}));

describe("ActiveServerSelector", () => {
  const createServer = (
    overrides: Partial<ServerWithName> = {},
  ): ServerWithName =>
    ({
      name: "test-server",
      connectionStatus: "connected",
      enabled: true,
      retryCount: 0,
      useOAuth: false,
      lastConnectionTime: new Date("2024-01-01"),
      config: {
        transportType: "stdio",
        command: "node",
        args: ["server.js"],
      },
      ...overrides,
    }) as ServerWithName;

  const defaultProps: ActiveServerSelectorProps = {
    serverConfigs: {},
    selectedServer: "",
    selectedMultipleServers: [],
    isMultiSelectEnabled: false,
    onServerChange: vi.fn(),
    onMultiServerToggle: vi.fn(),
    onConnect: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("rendering", () => {
    it("renders server names", () => {
      const serverConfigs = {
        "server-1": createServer({ name: "server-1" }),
        "server-2": createServer({ name: "server-2" }),
      };

      render(
        <ActiveServerSelector
          {...defaultProps}
          serverConfigs={serverConfigs}
          selectedServer="server-1"
        />,
      );

      expect(screen.getByText("server-1")).toBeInTheDocument();
      expect(screen.getByText("server-2")).toBeInTheDocument();
    });

    it("renders Add Server button", () => {
      render(<ActiveServerSelector {...defaultProps} />);

      expect(screen.getByText("Add Server")).toBeInTheDocument();
    });

    it("renders transport type for STDIO servers", () => {
      const serverConfigs = {
        "stdio-server": createServer({
          name: "stdio-server",
          config: {
            transportType: "stdio",
            command: "node",
            args: ["server.js"],
          },
        }),
      };

      render(
        <ActiveServerSelector
          {...defaultProps}
          serverConfigs={serverConfigs}
          selectedServer="stdio-server"
        />,
      );

      expect(screen.getByText("STDIO")).toBeInTheDocument();
    });

    it("renders transport type for HTTP servers", () => {
      const serverConfigs = {
        "http-server": createServer({
          name: "http-server",
          config: {
            transportType: "streamableHttp",
            url: "http://localhost:3000/mcp",
          },
        }),
      };

      render(
        <ActiveServerSelector
          {...defaultProps}
          serverConfigs={serverConfigs}
          selectedServer="http-server"
        />,
      );

      expect(screen.getByText("HTTP")).toBeInTheDocument();
    });

    it("hides the selector when the views filter has no matching servers", () => {
      const serverConfigs = {
        "server-1": createServer({ name: "server-1" }),
        "server-2": createServer({ name: "server-2" }),
      };

      render(
        <ActiveServerSelector
          {...defaultProps}
          serverConfigs={serverConfigs}
          selectedServer="server-1"
          showOnlyServersWithViews={true}
          serversWithViews={new Set()}
        />,
      );

      expect(screen.queryByText("server-1")).not.toBeInTheDocument();
      expect(screen.queryByText("server-2")).not.toBeInTheDocument();
      expect(screen.queryByText("Add Server")).not.toBeInTheDocument();
    });

    it("filters to servers with saved views when saved views exist", () => {
      const serverConfigs = {
        "server-1": createServer({ name: "server-1" }),
        "server-2": createServer({ name: "server-2" }),
      };

      render(
        <ActiveServerSelector
          {...defaultProps}
          serverConfigs={serverConfigs}
          selectedServer="server-1"
          showOnlyServersWithViews={true}
          serversWithViews={new Set(["server-2"])}
        />,
      );

      expect(screen.queryByText("server-1")).not.toBeInTheDocument();
      expect(screen.getByText("server-2")).toBeInTheDocument();
    });

    it("filters to OAuth HTTP servers when requested", () => {
      vi.mocked(hasOAuthConfig).mockImplementation(
        (serverName) => serverName === "stored-config-oauth",
      );
      const httpConfig = {
        transportType: "streamableHttp",
        url: "http://localhost:3000/mcp",
      } as const;
      const oauthTokens = {
        client_id: "client-id",
        client_secret: "client-secret",
        access_token: "access-token",
        refresh_token: "refresh-token",
        expires_in: 3600,
        scope: "read",
      };
      const serverConfigs = {
        "explicit-oauth": createServer({
          name: "explicit-oauth",
          config: httpConfig,
          useOAuth: true,
        }),
        "token-oauth": createServer({
          name: "token-oauth",
          config: httpConfig,
          oauthTokens,
        }),
        "stored-config-oauth": createServer({
          name: "stored-config-oauth",
          config: httpConfig,
        }),
        "flow-oauth": createServer({
          name: "flow-oauth",
          config: httpConfig,
          connectionStatus: "oauth-flow",
        }),
        "plain-http": createServer({
          name: "plain-http",
          config: httpConfig,
        }),
        "stdio-with-oauth-state": createServer({
          name: "stdio-with-oauth-state",
          useOAuth: true,
          oauthTokens,
        }),
      };

      render(
        <ActiveServerSelector
          {...defaultProps}
          serverConfigs={serverConfigs}
          selectedServer="explicit-oauth"
          showOnlyOAuthServers={true}
        />,
      );

      expect(screen.getByText("explicit-oauth")).toBeInTheDocument();
      expect(screen.getByText("token-oauth")).toBeInTheDocument();
      expect(screen.getByText("stored-config-oauth")).toBeInTheDocument();
      expect(screen.getByText("flow-oauth")).toBeInTheDocument();
      expect(screen.queryByText("plain-http")).not.toBeInTheDocument();
      expect(
        screen.queryByText("stdio-with-oauth-state"),
      ).not.toBeInTheDocument();
    });
  });

  describe("server selection - single mode", () => {
    it("calls onServerChange when clicking a server", () => {
      const onServerChange = vi.fn();
      const serverConfigs = {
        "server-1": createServer({ name: "server-1" }),
        "server-2": createServer({ name: "server-2" }),
      };

      render(
        <ActiveServerSelector
          {...defaultProps}
          serverConfigs={serverConfigs}
          selectedServer="server-1"
          onServerChange={onServerChange}
        />,
      );

      fireEvent.click(screen.getByText("server-2"));

      expect(onServerChange).toHaveBeenCalledWith("server-2");
    });

    it("calls onServerChange even when clicking already selected server", () => {
      const onServerChange = vi.fn();
      const serverConfigs = {
        "server-1": createServer({ name: "server-1" }),
      };

      render(
        <ActiveServerSelector
          {...defaultProps}
          serverConfigs={serverConfigs}
          selectedServer="server-1"
          onServerChange={onServerChange}
        />,
      );

      // Click on the same server
      fireEvent.click(screen.getByText("server-1"));

      // Component calls onServerChange even for already-selected server
      expect(onServerChange).toHaveBeenCalledWith("server-1");
    });

    it("applies selected styles to selected server", () => {
      const serverConfigs = {
        "server-1": createServer({ name: "server-1" }),
        "server-2": createServer({ name: "server-2" }),
      };

      render(
        <ActiveServerSelector
          {...defaultProps}
          serverConfigs={serverConfigs}
          selectedServer="server-1"
        />,
      );

      const selectedButton = screen.getByText("server-1").closest("button");
      expect(selectedButton?.className).toContain("bg-muted");
    });
  });

  describe("multi-select mode", () => {
    it("shows checkboxes in multi-select mode", () => {
      const serverConfigs = {
        "server-1": createServer({ name: "server-1" }),
      };

      render(
        <ActiveServerSelector
          {...defaultProps}
          serverConfigs={serverConfigs}
          isMultiSelectEnabled={true}
          selectedMultipleServers={[]}
        />,
      );

      // Check icon should be present (inside checkbox area)
      const serverButton = screen.getByText("server-1").closest("button");
      expect(
        serverButton?.querySelector(".w-4.h-4.rounded"),
      ).toBeInTheDocument();
    });

    it("calls onMultiServerToggle in multi-select mode", () => {
      const onMultiServerToggle = vi.fn();
      const serverConfigs = {
        "server-1": createServer({ name: "server-1" }),
      };

      render(
        <ActiveServerSelector
          {...defaultProps}
          serverConfigs={serverConfigs}
          isMultiSelectEnabled={true}
          selectedMultipleServers={[]}
          onMultiServerToggle={onMultiServerToggle}
        />,
      );

      fireEvent.click(screen.getByText("server-1"));

      expect(onMultiServerToggle).toHaveBeenCalledWith("server-1");
    });

    it("shows check mark for selected servers in multi-select mode", () => {
      const serverConfigs = {
        "server-1": createServer({ name: "server-1" }),
        "server-2": createServer({ name: "server-2" }),
      };

      render(
        <ActiveServerSelector
          {...defaultProps}
          serverConfigs={serverConfigs}
          isMultiSelectEnabled={true}
          selectedMultipleServers={["server-1"]}
        />,
      );

      // The selected server should have a check icon
      const selectedButton = screen.getByText("server-1").closest("button");
      expect(
        selectedButton?.querySelector("svg.lucide-check"),
      ).toBeInTheDocument();

      // Unselected server should not have check icon
      const unselectedButton = screen.getByText("server-2").closest("button");
      expect(
        unselectedButton?.querySelector("svg.lucide-check"),
      ).not.toBeInTheDocument();
    });
  });

  describe("connection status", () => {
    it("shows green indicator for connected servers", () => {
      const serverConfigs = {
        "server-1": createServer({
          name: "server-1",
          connectionStatus: "connected",
        }),
      };

      render(
        <ActiveServerSelector
          {...defaultProps}
          serverConfigs={serverConfigs}
          selectedServer="server-1"
        />,
      );

      const indicator = screen.getByTitle("Connected").closest(".rounded-full");
      expect(indicator?.className).toContain("bg-green");
    });

    it("shows yellow indicator for connecting servers", () => {
      const serverConfigs = {
        "server-1": createServer({
          name: "server-1",
          connectionStatus: "connecting",
        }),
      };

      render(
        <ActiveServerSelector
          {...defaultProps}
          serverConfigs={serverConfigs}
          selectedServer="server-1"
        />,
      );

      const indicator = screen
        .getByTitle("Connecting...")
        .closest(".rounded-full");
      expect(indicator?.className).toContain("bg-yellow");
    });

    it("shows red indicator for failed servers", () => {
      const serverConfigs = {
        "server-1": createServer({
          name: "server-1",
          connectionStatus: "failed",
        }),
      };

      render(
        <ActiveServerSelector
          {...defaultProps}
          serverConfigs={serverConfigs}
          selectedServer="server-1"
        />,
      );

      const indicator = screen.getByTitle("Failed").closest(".rounded-full");
      expect(indicator?.className).toContain("bg-red");
    });
  });

  describe("Add Server modal", () => {
    it("opens Add Server modal when clicking Add Server button", () => {
      render(<ActiveServerSelector {...defaultProps} />);

      expect(screen.queryByTestId("add-server-modal")).not.toBeInTheDocument();

      fireEvent.click(screen.getByText("Add Server"));

      expect(screen.getByTestId("add-server-modal")).toBeInTheDocument();
    });

    it("closes modal when close button clicked", () => {
      render(<ActiveServerSelector {...defaultProps} />);

      fireEvent.click(screen.getByText("Add Server"));
      expect(screen.getByTestId("add-server-modal")).toBeInTheDocument();

      fireEvent.click(screen.getByText("Close"));
      expect(screen.queryByTestId("add-server-modal")).not.toBeInTheDocument();
    });

    it("calls onConnect when form is submitted", () => {
      const onConnect = vi.fn();

      render(<ActiveServerSelector {...defaultProps} onConnect={onConnect} />);

      fireEvent.click(screen.getByText("Add Server"));
      fireEvent.click(screen.getByText("Submit"));

      expect(onConnect).toHaveBeenCalled();
    });
  });

  describe("server changes with existing messages", () => {
    it("changes server immediately even when the chat already has messages", () => {
      const serverConfigs = {
        "server-1": createServer({ name: "server-1" }),
        "server-2": createServer({ name: "server-2" }),
      };
      const onServerChange = vi.fn();

      render(
        <ActiveServerSelector
          {...defaultProps}
          serverConfigs={serverConfigs}
          selectedServer="server-1"
          onServerChange={onServerChange}
          hasMessages={true}
        />,
      );

      fireEvent.click(screen.getByText("server-2"));

      expect(onServerChange).toHaveBeenCalledWith("server-2");
    });

    it("toggles servers immediately in multi-select mode when the chat already has messages", () => {
      const onMultiServerToggle = vi.fn();
      const serverConfigs = {
        "server-1": createServer({ name: "server-1" }),
        "server-2": createServer({ name: "server-2" }),
      };

      render(
        <ActiveServerSelector
          {...defaultProps}
          serverConfigs={serverConfigs}
          isMultiSelectEnabled={true}
          selectedMultipleServers={["server-1"]}
          hasMessages={true}
          onMultiServerToggle={onMultiServerToggle}
        />,
      );

      fireEvent.click(screen.getByText("server-2"));

      expect(onMultiServerToggle).toHaveBeenCalledWith("server-2");
    });
  });

  describe("auto-selection", () => {
    it("auto-selects most recently connected server when current selection is invalid", async () => {
      const onServerChange = vi.fn();
      const serverConfigs = {
        "server-1": createServer({
          name: "server-1",
          lastConnectionTime: new Date("2024-01-01"),
        }),
        "server-2": createServer({
          name: "server-2",
          lastConnectionTime: new Date("2024-01-03"),
        }),
        "server-3": createServer({
          name: "server-3",
          lastConnectionTime: new Date("2024-01-02"),
        }),
      };

      render(
        <ActiveServerSelector
          {...defaultProps}
          serverConfigs={serverConfigs}
          selectedServer="non-existent"
          onServerChange={onServerChange}
        />,
      );

      await waitFor(() => {
        expect(onServerChange).toHaveBeenCalledWith("server-2");
      });
    });

    it("does not auto-select in multi-select mode", async () => {
      const onServerChange = vi.fn();
      const serverConfigs = {
        "server-1": createServer({ name: "server-1" }),
      };

      render(
        <ActiveServerSelector
          {...defaultProps}
          serverConfigs={serverConfigs}
          selectedServer="non-existent"
          isMultiSelectEnabled={true}
          onServerChange={onServerChange}
        />,
      );

      // Give time for any effects to run
      await new Promise((r) => setTimeout(r, 50));

      expect(onServerChange).not.toHaveBeenCalled();
    });

    it("does not auto-select a filtered server when auto-selection is disabled", async () => {
      const onServerChange = vi.fn();
      const httpConfig = {
        transportType: "streamableHttp",
        url: "http://localhost:3000/mcp",
      } as const;
      const serverConfigs = {
        "selected-plain-http": createServer({
          name: "selected-plain-http",
          config: httpConfig,
        }),
        "visible-oauth": createServer({
          name: "visible-oauth",
          config: httpConfig,
          useOAuth: true,
          lastConnectionTime: new Date("2024-01-03"),
        }),
      };

      render(
        <ActiveServerSelector
          {...defaultProps}
          serverConfigs={serverConfigs}
          selectedServer="selected-plain-http"
          onServerChange={onServerChange}
          showOnlyOAuthServers={true}
          autoSelectFilteredServer={false}
        />,
      );

      expect(screen.queryByText("selected-plain-http")).not.toBeInTheDocument();
      expect(screen.getByText("visible-oauth")).toBeInTheDocument();

      await new Promise((r) => setTimeout(r, 50));

      expect(onServerChange).not.toHaveBeenCalled();
    });
  });

  describe("reconnect button", () => {
    const clickReconnectButton = (serverName: string) => {
      const row = screen.getByText(serverName).closest("button");
      if (!row) throw new Error(`Server row not found for ${serverName}`);
      const btn = within(row).getByTitle("Reconnect");
      fireEvent.click(btn);
    };

    it("renders reconnect button for servers", () => {
      const serverConfigs = {
        "server-1": createServer({
          name: "server-1",
          connectionStatus: "connected",
        }),
        "server-2": createServer({
          name: "server-2",
          connectionStatus: "disconnected",
        }),
      };

      const onReconnect = vi.fn().mockResolvedValue(undefined);

      render(
        <ActiveServerSelector
          {...defaultProps}
          serverConfigs={serverConfigs}
          onReconnect={onReconnect}
        />,
      );

      // Should render reconnect button for both
      const buttons = screen.getAllByTitle("Reconnect");
      expect(buttons).toHaveLength(2);
    });

    it("calls onReconnect when clicked", () => {
      const onReconnect = vi.fn().mockResolvedValue(undefined);
      const serverConfigs = {
        "server-1": createServer({ name: "server-1" }),
      };

      render(
        <ActiveServerSelector
          {...defaultProps}
          serverConfigs={serverConfigs}
          onReconnect={onReconnect}
        />,
      );

      clickReconnectButton("server-1");
      expect(onReconnect).toHaveBeenCalledWith("server-1");
    });

    it("does not change selection when reconnecting a non-active server", () => {
      const onReconnect = vi.fn().mockResolvedValue(undefined);
      const onServerChange = vi.fn();
      const serverConfigs = {
        "active-server": createServer({
          name: "active-server",
          connectionStatus: "connected",
        }),
        "inactive-server": createServer({
          name: "inactive-server",
          connectionStatus: "disconnected",
        }),
      };

      render(
        <ActiveServerSelector
          {...defaultProps}
          serverConfigs={serverConfigs}
          selectedServer="active-server"
          onReconnect={onReconnect}
          onServerChange={onServerChange}
        />,
      );

      clickReconnectButton("inactive-server");

      expect(onReconnect).toHaveBeenCalledWith("inactive-server");
      expect(onReconnect).not.toHaveBeenCalledWith("active-server");
      expect(onServerChange).not.toHaveBeenCalled();
    });

    it("keeps selection when reconnecting the active server", () => {
      const onReconnect = vi.fn().mockResolvedValue(undefined);
      const onServerChange = vi.fn();
      const serverConfigs = {
        "active-server": createServer({
          name: "active-server",
          connectionStatus: "disconnected",
        }),
        "other-server": createServer({
          name: "other-server",
          connectionStatus: "connected",
        }),
      };

      render(
        <ActiveServerSelector
          {...defaultProps}
          serverConfigs={serverConfigs}
          selectedServer="active-server"
          onReconnect={onReconnect}
          onServerChange={onServerChange}
        />,
      );

      clickReconnectButton("active-server");

      expect(onReconnect).toHaveBeenCalledWith("active-server");
      expect(onReconnect).not.toHaveBeenCalledWith("other-server");
      expect(onServerChange).not.toHaveBeenCalled();
    });
  });
});
