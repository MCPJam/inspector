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

// Mock ConfirmChatResetDialog
vi.mock("../chat-v2/chat-input/dialogs/confirm-chat-reset-dialog", () => ({
  ConfirmChatResetDialog: ({
    open,
    onConfirm,
    onCancel,
  }: {
    open: boolean;
    onConfirm: () => void;
    onCancel: () => void;
  }) =>
    open ? (
      <div data-testid="confirm-dialog">
        <button onClick={onConfirm}>Confirm</button>
        <button onClick={onCancel}>Cancel</button>
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

  describe("confirmation dialog", () => {
    it("shows confirmation dialog when changing server with messages", () => {
      const serverConfigs = {
        "server-1": createServer({ name: "server-1" }),
        "server-2": createServer({ name: "server-2" }),
      };

      render(
        <ActiveServerSelector
          {...defaultProps}
          serverConfigs={serverConfigs}
          selectedServer="server-1"
          hasMessages={true}
        />,
      );

      fireEvent.click(screen.getByText("server-2"));

      expect(screen.getByTestId("confirm-dialog")).toBeInTheDocument();
    });

    it("changes server after confirming dialog", () => {
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
          hasMessages={true}
          onServerChange={onServerChange}
        />,
      );

      fireEvent.click(screen.getByText("server-2"));
      fireEvent.click(screen.getByText("Confirm"));

      expect(onServerChange).toHaveBeenCalledWith("server-2");
    });

    it("does not change server after canceling dialog", () => {
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
          hasMessages={true}
          onServerChange={onServerChange}
        />,
      );

      fireEvent.click(screen.getByText("server-2"));
      fireEvent.click(screen.getByText("Cancel"));

      expect(onServerChange).not.toHaveBeenCalled();
    });
  });

  describe("filtering", () => {
    it("filters servers by OpenAI apps", () => {
      const serverConfigs = {
        "openai-server": createServer({ name: "openai-server" }),
        "regular-server": createServer({ name: "regular-server" }),
      };

      render(
        <ActiveServerSelector
          {...defaultProps}
          serverConfigs={serverConfigs}
          showOnlyOpenAIAppsServers={true}
          openAiAppOrMcpAppsServers={new Set(["openai-server"])}
        />,
      );

      expect(screen.getByText("openai-server")).toBeInTheDocument();
      expect(screen.queryByText("regular-server")).not.toBeInTheDocument();
    });
  });

  describe("auto-selection", () => {
    it("auto-selects first server when current selection is invalid", async () => {
      const onServerChange = vi.fn();
      const serverConfigs = {
        "server-1": createServer({ name: "server-1" }),
        "server-2": createServer({ name: "server-2" }),
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
        expect(onServerChange).toHaveBeenCalledWith("server-1");
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

      const onReconnect = vi.fn();

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
      const onReconnect = vi.fn();
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
      const onReconnect = vi.fn();
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
      const onReconnect = vi.fn();
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
