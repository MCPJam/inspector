import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { RegistryTab } from "../RegistryTab";
import type { EnrichedRegistryServer } from "@/hooks/useRegistryServers";

// Mock the useRegistryServers hook
const mockConnect = vi.fn();
const mockDisconnect = vi.fn();
let mockHookReturn: {
  registryServers: EnrichedRegistryServer[];
  categories: string[];
  isLoading: boolean;
  connect: typeof mockConnect;
  disconnect: typeof mockDisconnect;
};

vi.mock("@/hooks/useRegistryServers", () => ({
  useRegistryServers: () => mockHookReturn,
}));

// Mock dropdown menu to simplify testing
vi.mock("../ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="dropdown-menu">{children}</div>
  ),
  DropdownMenuTrigger: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="dropdown-trigger">{children}</div>
  ),
  DropdownMenuContent: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="dropdown-content">{children}</div>
  ),
  DropdownMenuItem: ({
    children,
    onClick,
  }: {
    children: React.ReactNode;
    onClick?: () => void;
  }) => (
    <button data-testid="dropdown-item" onClick={onClick}>
      {children}
    </button>
  ),
}));

function createMockServer(
  overrides: Partial<EnrichedRegistryServer> = {},
): EnrichedRegistryServer {
  return {
    _id: "server_1",
    slug: "test-server",
    displayName: "Test Server",
    description: "A test MCP server for unit tests.",
    publisher: "TestCo",
    category: "Productivity",
    transport: { type: "http", url: "https://mcp.test.com/sse" },
    approved: true,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    connectionStatus: "not_connected",
    ...overrides,
  };
}

describe("RegistryTab", () => {
  const defaultProps = {
    workspaceId: "ws_123",
    isAuthenticated: true,
    onConnect: vi.fn(),
    onDisconnect: vi.fn(),
    onNavigate: vi.fn(),
    servers: {},
  };

  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    mockConnect.mockResolvedValue(undefined);
    mockDisconnect.mockResolvedValue(undefined);
    mockHookReturn = {
      registryServers: [],
      categories: [],
      isLoading: false,
      connect: mockConnect,
      disconnect: mockDisconnect,
    };
  });

  describe("visibility without authentication", () => {
    it("renders registry servers when not authenticated", () => {
      const server = createMockServer();
      mockHookReturn = {
        registryServers: [server],
        categories: ["Productivity"],
        isLoading: false,
        connect: mockConnect,
        disconnect: mockDisconnect,
      };

      render(<RegistryTab {...defaultProps} isAuthenticated={false} />);

      expect(screen.getByText("Registry")).toBeInTheDocument();
      expect(screen.getByText("Test Server")).toBeInTheDocument();
      expect(screen.getByText("TestCo")).toBeInTheDocument();
      expect(screen.getByText("Connect")).toBeInTheDocument();
    });

    it("shows header and description when not authenticated", () => {
      mockHookReturn = {
        registryServers: [createMockServer()],
        categories: ["Productivity"],
        isLoading: false,
        connect: mockConnect,
        disconnect: mockDisconnect,
      };

      render(<RegistryTab {...defaultProps} isAuthenticated={false} />);

      expect(screen.getByText("Registry")).toBeInTheDocument();
      expect(
        screen.getByText(
          "Pre-configured MCP servers you can connect with one click.",
        ),
      ).toBeInTheDocument();
    });
  });

  describe("loading state", () => {
    it("shows loading skeleton when data is loading", () => {
      mockHookReturn = {
        registryServers: [],
        categories: [],
        isLoading: true,
        connect: mockConnect,
        disconnect: mockDisconnect,
      };

      const { container } = render(<RegistryTab {...defaultProps} />);

      const skeletons = container.querySelectorAll("[data-slot='skeleton']");
      expect(skeletons.length).toBeGreaterThan(0);
    });
  });

  describe("empty state", () => {
    it("shows empty state when no servers are available", () => {
      render(<RegistryTab {...defaultProps} />);

      expect(screen.getByText("No servers available")).toBeInTheDocument();
    });
  });

  describe("auth badges", () => {
    it("shows OAuth badge with key icon for OAuth servers", () => {
      mockHookReturn = {
        registryServers: [
          createMockServer({
            transport: {
              type: "http",
              url: "https://mcp.test.com/sse",
              useOAuth: true,
            },
          }),
        ],
        categories: ["Productivity"],
        isLoading: false,
        connect: mockConnect,
        disconnect: mockDisconnect,
      };

      render(<RegistryTab {...defaultProps} />);

      expect(screen.getByText("OAuth")).toBeInTheDocument();
    });

    it("shows No auth badge for servers without OAuth", () => {
      mockHookReturn = {
        registryServers: [createMockServer()],
        categories: ["Productivity"],
        isLoading: false,
        connect: mockConnect,
        disconnect: mockDisconnect,
      };

      render(<RegistryTab {...defaultProps} />);

      expect(screen.getByText("No auth")).toBeInTheDocument();
    });
  });

  describe("server cards", () => {
    it("renders server cards with correct information", () => {
      const server = createMockServer({
        displayName: "Linear",
        description: "Manage Linear issues and projects.",
        publisher: "MCPJam",
        category: "Project Management",
        transport: {
          type: "http",
          url: "https://mcp.linear.app/sse",
          useOAuth: true,
        },
      });
      mockHookReturn = {
        registryServers: [server],
        categories: ["Project Management"],
        isLoading: false,
        connect: mockConnect,
        disconnect: mockDisconnect,
      };

      render(<RegistryTab {...defaultProps} />);

      expect(screen.getByText("Linear")).toBeInTheDocument();
      expect(
        screen.getByText("Manage Linear issues and projects."),
      ).toBeInTheDocument();
      expect(screen.getByText("MCPJam")).toBeInTheDocument();
      expect(screen.getByText("Project Management")).toBeInTheDocument();
    });

    it("does not show raw URL by default", () => {
      mockHookReturn = {
        registryServers: [createMockServer()],
        categories: ["Productivity"],
        isLoading: false,
        connect: mockConnect,
        disconnect: mockDisconnect,
      };

      render(<RegistryTab {...defaultProps} />);

      expect(
        screen.queryByText("https://mcp.test.com/sse"),
      ).not.toBeInTheDocument();
    });

    it("shows Connect button for not_connected servers", () => {
      mockHookReturn = {
        registryServers: [createMockServer()],
        categories: ["Productivity"],
        isLoading: false,
        connect: mockConnect,
        disconnect: mockDisconnect,
      };

      render(<RegistryTab {...defaultProps} />);

      expect(screen.getByText("Connect")).toBeInTheDocument();
    });

    it("shows Connected badge for connected servers", () => {
      mockHookReturn = {
        registryServers: [createMockServer({ connectionStatus: "connected" })],
        categories: ["Productivity"],
        isLoading: false,
        connect: mockConnect,
        disconnect: mockDisconnect,
      };

      render(<RegistryTab {...defaultProps} />);

      expect(screen.getByText("Connected")).toBeInTheDocument();
    });

    it("shows Added badge for servers added but not live", () => {
      mockHookReturn = {
        registryServers: [createMockServer({ connectionStatus: "added" })],
        categories: ["Productivity"],
        isLoading: false,
        connect: mockConnect,
        disconnect: mockDisconnect,
      };

      render(<RegistryTab {...defaultProps} />);

      expect(screen.getByText("Added")).toBeInTheDocument();
    });
  });

  describe("category filtering", () => {
    it("does not render category filter pills", () => {
      mockHookReturn = {
        registryServers: [
          createMockServer({ _id: "1", category: "Productivity" }),
          createMockServer({ _id: "2", category: "Developer Tools" }),
        ],
        categories: ["Developer Tools", "Productivity"],
        isLoading: false,
        connect: mockConnect,
        disconnect: mockDisconnect,
      };

      render(<RegistryTab {...defaultProps} />);

      expect(
        screen.queryByRole("button", { name: "All" }),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByRole("button", { name: "Productivity" }),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByRole("button", { name: "Developer Tools" }),
      ).not.toBeInTheDocument();
    });

    it("shows all servers without filtering", () => {
      const prodServer = createMockServer({
        _id: "1",
        displayName: "Notion",
        category: "Productivity",
      });
      const devServer = createMockServer({
        _id: "2",
        displayName: "GitHub",
        category: "Developer Tools",
      });
      mockHookReturn = {
        registryServers: [prodServer, devServer],
        categories: ["Developer Tools", "Productivity"],
        isLoading: false,
        connect: mockConnect,
        disconnect: mockDisconnect,
      };

      render(<RegistryTab {...defaultProps} />);

      expect(screen.getByText("Notion")).toBeInTheDocument();
      expect(screen.getByText("GitHub")).toBeInTheDocument();
    });
  });

  describe("connect/disconnect actions", () => {
    it("calls connect when Connect button is clicked", async () => {
      const server = createMockServer();
      mockHookReturn = {
        registryServers: [server],
        categories: ["Productivity"],
        isLoading: false,
        connect: mockConnect,
        disconnect: mockDisconnect,
      };

      render(<RegistryTab {...defaultProps} />);

      fireEvent.click(screen.getByText("Connect"));

      await waitFor(() => {
        expect(mockConnect).toHaveBeenCalledWith(server);
      });
    });

    it("calls disconnect from overflow menu", async () => {
      const server = createMockServer({ connectionStatus: "connected" });
      mockHookReturn = {
        registryServers: [server],
        categories: ["Productivity"],
        isLoading: false,
        connect: mockConnect,
        disconnect: mockDisconnect,
      };

      render(<RegistryTab {...defaultProps} />);

      // Click disconnect in the mocked dropdown
      const disconnectItem = screen.getByText("Disconnect");
      fireEvent.click(disconnectItem);

      await waitFor(() => {
        expect(mockDisconnect).toHaveBeenCalledWith(server);
      });
    });
  });

  describe("auto-redirect to App Builder", () => {
    it("navigates to app-builder when a pending server becomes connected", async () => {
      const server = createMockServer({ displayName: "Asana" });
      mockHookReturn = {
        registryServers: [server],
        categories: ["Productivity"],
        isLoading: false,
        connect: mockConnect,
        disconnect: mockDisconnect,
      };

      const onNavigate = vi.fn();
      const { rerender } = render(
        <RegistryTab {...defaultProps} onNavigate={onNavigate} servers={{}} />,
      );

      // Click connect — stores pending redirect in localStorage
      fireEvent.click(screen.getByText("Connect"));
      await waitFor(() => expect(mockConnect).toHaveBeenCalled());
      expect(localStorage.getItem("registry-pending-redirect")).toBe("Asana");

      // Simulate server becoming connected via props update
      rerender(
        <RegistryTab
          {...defaultProps}
          onNavigate={onNavigate}
          servers={{
            Asana: {
              name: "Asana",
              connectionStatus: "connected",
              config: {} as any,
              lastConnectionTime: new Date(),
              retryCount: 0,
            },
          }}
        />,
      );

      await waitFor(() => {
        expect(onNavigate).toHaveBeenCalledWith("app-builder");
      });
      // localStorage should be cleaned up
      expect(localStorage.getItem("registry-pending-redirect")).toBeNull();
    });

    it("survives page remount (OAuth redirect) and still auto-redirects", async () => {
      // Simulate: user clicked Connect, got redirected to OAuth, page remounted
      localStorage.setItem("registry-pending-redirect", "Linear");

      const server = createMockServer({ displayName: "Linear" });
      mockHookReturn = {
        registryServers: [server],
        categories: ["Productivity"],
        isLoading: false,
        connect: mockConnect,
        disconnect: mockDisconnect,
      };

      const onNavigate = vi.fn();

      // Mount with server already connected (OAuth callback completed)
      render(
        <RegistryTab
          {...defaultProps}
          onNavigate={onNavigate}
          servers={{
            Linear: {
              name: "Linear",
              connectionStatus: "connected",
              config: {} as any,
              lastConnectionTime: new Date(),
              retryCount: 0,
            },
          }}
        />,
      );

      await waitFor(() => {
        expect(onNavigate).toHaveBeenCalledWith("app-builder");
      });
      expect(localStorage.getItem("registry-pending-redirect")).toBeNull();
    });
  });
});
