import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { ServerConnectionCard } from "../ServerConnectionCard";
import type { ServerWithName } from "@/hooks/use-app-state";

// Mock posthog
vi.mock("posthog-js/react", () => ({
  usePostHog: () => ({
    capture: vi.fn(),
  }),
}));

// Mock the APIs
vi.mock("@/lib/apis/mcp-tools-api", () => ({
  listTools: vi.fn().mockResolvedValue({ tools: [], toolsMetadata: {} }),
}));

vi.mock("@/lib/apis/mcp-export-api", () => ({
  exportServerApi: vi.fn().mockResolvedValue({}),
}));

// Mock sonner toast
vi.mock("sonner", () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
    loading: vi.fn().mockReturnValue("toast-id"),
  },
}));

// Mock navigator.clipboard
const mockClipboard = {
  writeText: vi.fn().mockResolvedValue(undefined),
};
Object.assign(navigator, { clipboard: mockClipboard });

describe("ServerConnectionCard", () => {
  const createServer = (overrides: Partial<ServerWithName> = {}): ServerWithName => ({
    name: "test-server",
    connectionStatus: "connected",
    enabled: true,
    retryCount: 0,
    useOAuth: false,
    config: {
      transportType: "stdio",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-test"],
    },
    ...overrides,
  });

  const defaultProps = {
    onDisconnect: vi.fn(),
    onReconnect: vi.fn(),
    onEdit: vi.fn(),
    onRemove: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("rendering", () => {
    it("renders server name", () => {
      const server = createServer({ name: "my-server" });
      render(<ServerConnectionCard server={server} {...defaultProps} />);

      expect(screen.getByText("my-server")).toBeInTheDocument();
    });

    it("renders transport type label", () => {
      const server = createServer();
      render(<ServerConnectionCard server={server} {...defaultProps} />);

      expect(screen.getByText("STDIO")).toBeInTheDocument();
    });

    it("renders command display for stdio transport", () => {
      const server = createServer({
        config: {
          transportType: "stdio",
          command: "node",
          args: ["server.js"],
        },
      });
      render(<ServerConnectionCard server={server} {...defaultProps} />);

      expect(screen.getByText("node server.js")).toBeInTheDocument();
    });

    it("renders URL for http transport", () => {
      const server = createServer({
        config: {
          transportType: "streamableHttp",
          url: "http://localhost:3000/mcp",
        },
      });
      render(<ServerConnectionCard server={server} {...defaultProps} />);

      expect(screen.getByText("http://localhost:3000/mcp")).toBeInTheDocument();
    });
  });

  describe("connection status", () => {
    it("shows connected status indicator", () => {
      const server = createServer({ connectionStatus: "connected" });
      render(<ServerConnectionCard server={server} {...defaultProps} />);

      expect(screen.getByText("Connected")).toBeInTheDocument();
    });

    it("shows disconnected status indicator", () => {
      const server = createServer({ connectionStatus: "disconnected" });
      render(<ServerConnectionCard server={server} {...defaultProps} />);

      expect(screen.getByText("Disconnected")).toBeInTheDocument();
    });

    it("shows connecting status indicator", () => {
      const server = createServer({ connectionStatus: "connecting" });
      render(<ServerConnectionCard server={server} {...defaultProps} />);

      expect(screen.getByText("Connecting...")).toBeInTheDocument();
    });

    it("shows failed status with retry count", () => {
      const server = createServer({
        connectionStatus: "failed",
        retryCount: 3,
        lastError: "Connection refused",
      });
      render(<ServerConnectionCard server={server} {...defaultProps} />);

      expect(screen.getByText("Failed (3)")).toBeInTheDocument();
    });
  });

  describe("toggle switch", () => {
    it("switch is checked when server is connected", () => {
      const server = createServer({ connectionStatus: "connected" });
      render(<ServerConnectionCard server={server} {...defaultProps} />);

      const toggle = screen.getByRole("switch");
      expect(toggle).toBeChecked();
    });

    it("switch is unchecked when server is disconnected", () => {
      const server = createServer({ connectionStatus: "disconnected" });
      render(<ServerConnectionCard server={server} {...defaultProps} />);

      const toggle = screen.getByRole("switch");
      expect(toggle).not.toBeChecked();
    });

    it("calls onDisconnect when toggling off", () => {
      const server = createServer({ connectionStatus: "connected" });
      const onDisconnect = vi.fn();
      render(
        <ServerConnectionCard
          server={server}
          {...defaultProps}
          onDisconnect={onDisconnect}
        />
      );

      const toggle = screen.getByRole("switch");
      fireEvent.click(toggle);

      expect(onDisconnect).toHaveBeenCalledWith("test-server");
    });

    it("calls onReconnect when toggling on", () => {
      const server = createServer({ connectionStatus: "disconnected" });
      const onReconnect = vi.fn();
      render(
        <ServerConnectionCard
          server={server}
          {...defaultProps}
          onReconnect={onReconnect}
        />
      );

      const toggle = screen.getByRole("switch");
      fireEvent.click(toggle);

      expect(onReconnect).toHaveBeenCalledWith("test-server", undefined);
    });
  });

  describe("error display", () => {
    it("shows error message when connection failed", () => {
      const server = createServer({
        connectionStatus: "failed",
        lastError: "Connection refused",
      });
      render(<ServerConnectionCard server={server} {...defaultProps} />);

      expect(screen.getByText("Connection refused")).toBeInTheDocument();
    });

    it("truncates long error messages", () => {
      const longError = "A".repeat(150);
      const server = createServer({
        connectionStatus: "failed",
        lastError: longError,
      });
      render(<ServerConnectionCard server={server} {...defaultProps} />);

      // Should show truncated version
      expect(screen.getByText(`${"A".repeat(100)}...`)).toBeInTheDocument();
    });

    it("shows troubleshooting link when connection failed", () => {
      const server = createServer({
        connectionStatus: "failed",
        lastError: "Error",
      });
      render(<ServerConnectionCard server={server} {...defaultProps} />);

      expect(screen.getByText("Having trouble?")).toBeInTheDocument();
      expect(
        screen.getByText("Check out our troubleshooting page")
      ).toBeInTheDocument();
    });
  });

  describe("copy functionality", () => {
    it("copies command to clipboard when copy button is clicked", async () => {
      const server = createServer({
        config: {
          transportType: "stdio",
          command: "node",
          args: ["server.js"],
        },
      });
      render(<ServerConnectionCard server={server} {...defaultProps} />);

      // Find the copy button (it's inside the command display area)
      const copyButtons = screen.getAllByRole("button");
      const copyButton = copyButtons.find((btn) =>
        btn.querySelector("svg")?.classList.contains("lucide-copy") ||
        btn.className.includes("absolute")
      );

      if (copyButton) {
        fireEvent.click(copyButton);
        await waitFor(() => {
          expect(mockClipboard.writeText).toHaveBeenCalledWith("node server.js");
        });
      }
    });
  });

  describe("server info", () => {
    it("shows server version when available", () => {
      const server = createServer({
        initializationInfo: {
          serverVersion: {
            version: "1.0.0",
            title: "Test Server",
          },
          protocolVersion: "2024-11-05",
        },
      });
      render(<ServerConnectionCard server={server} {...defaultProps} />);

      expect(screen.getByText("v1.0.0")).toBeInTheDocument();
    });

    it("shows view server info button when initialization info exists", () => {
      const server = createServer({
        initializationInfo: {
          serverCapabilities: { tools: {} },
          protocolVersion: "2024-11-05",
        },
      });
      render(<ServerConnectionCard server={server} {...defaultProps} />);

      expect(screen.getByText("View server info")).toBeInTheDocument();
    });
  });

  describe("tunnel URL", () => {
    it("shows copy tunnel URL button when connected with tunnel", () => {
      const server = createServer({ connectionStatus: "connected" });
      render(
        <ServerConnectionCard
          server={server}
          {...defaultProps}
          sharedTunnelUrl="https://tunnel.example.com"
        />
      );

      expect(screen.getByText("Copy Tunnel Url")).toBeInTheDocument();
    });

    it("does not show tunnel URL when disconnected", () => {
      const server = createServer({ connectionStatus: "disconnected" });
      render(
        <ServerConnectionCard
          server={server}
          {...defaultProps}
          sharedTunnelUrl="https://tunnel.example.com"
        />
      );

      expect(screen.queryByText("Copy Tunnel Url")).not.toBeInTheDocument();
    });
  });
});
