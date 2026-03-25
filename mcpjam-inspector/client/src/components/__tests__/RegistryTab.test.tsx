import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { RegistryTab } from "../RegistryTab";
import type { EnrichedRegistryServer } from "@/hooks/useRegistryServers";
import { readPendingQuickConnect } from "@/lib/quick-connect-pending";

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

vi.mock("@/hooks/useRegistryServers", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/hooks/useRegistryServers")>();
  return {
    ...actual,
    useRegistryServers: () => mockHookReturn,
  };
});

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
  DropdownMenuSeparator: () => <hr data-testid="dropdown-separator" />,
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
    name: "com.test.server",
    displayName: "Test Server",
    description: "A test MCP server for unit tests.",
    publisher: "TestCo",
    category: "Productivity",
    scope: "global",
    transport: {
      transportType: "http",
      url: "https://mcp.test.com/sse",
    },
    status: "approved",
    createdBy: "test-user",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    connectionStatus: "not_connected",
    ...overrides,
  } as EnrichedRegistryServer;
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
        screen.getByText("Pre-configured MCP servers you can connect quickly."),
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
              transportType: "http",
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
          transportType: "http",
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
    });

    it("shows verified star when publishStatus is verified", () => {
      mockHookReturn = {
        registryServers: [createMockServer({ publishStatus: "verified" })],
        categories: ["Productivity"],
        isLoading: false,
        connect: mockConnect,
        disconnect: mockDisconnect,
      };

      render(<RegistryTab {...defaultProps} />);

      expect(screen.getByLabelText("Verified publisher")).toBeInTheDocument();
    });

    it("does not show verified star when publishStatus is not verified", () => {
      mockHookReturn = {
        registryServers: [
          createMockServer({ publishStatus: "unverified" }),
        ],
        categories: ["Productivity"],
        isLoading: false,
        connect: mockConnect,
        disconnect: mockDisconnect,
      };

      render(<RegistryTab {...defaultProps} />);

      expect(
        screen.queryByLabelText("Verified publisher"),
      ).not.toBeInTheDocument();
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

      // Click connect — stores structured pending state in localStorage
      fireEvent.click(screen.getByText("Connect"));
      await waitFor(() => expect(mockConnect).toHaveBeenCalled());
      expect(readPendingQuickConnect()).toEqual({
        serverName: "Asana",
        registryServerId: "server_1",
        displayName: "Asana",
        sourceTab: "registry",
        createdAt: expect.any(Number),
      });

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
      expect(readPendingQuickConnect()).toBeNull();
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
      expect(readPendingQuickConnect()).toBeNull();
    });

    it("redirects when a legacy pending display name matches a suffixed connected variant", async () => {
      localStorage.setItem("registry-pending-redirect", "Asana");

      const server = createMockServer({
        displayName: "Asana",
        clientType: "app" as any,
      });
      mockHookReturn = {
        registryServers: [server],
        categories: ["Productivity"],
        isLoading: false,
        connect: mockConnect,
        disconnect: mockDisconnect,
      };

      const onNavigate = vi.fn();

      render(
        <RegistryTab
          {...defaultProps}
          onNavigate={onNavigate}
          servers={{
            "Asana (App)": {
              name: "Asana (App)",
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
      expect(readPendingQuickConnect()).toBeNull();
    });
  });

  describe("consolidated cards — dual-type servers", () => {
    function createFullServer(
      overrides: Partial<EnrichedRegistryServer> & {
        _id: string;
        displayName: string;
      },
    ): EnrichedRegistryServer {
      return {
        name: `com.test.${overrides.displayName.toLowerCase()}`,
        description: `${overrides.displayName} description`,
        scope: "global" as const,
        transport: {
          transportType: "http" as const,
          url: `https://${overrides.displayName.toLowerCase()}.example.com`,
          useOAuth: true,
        },
        category: "Productivity",
        publisher: overrides.displayName,
        status: "approved" as const,
        createdBy: "test",
        createdAt: Date.now(),
        updatedAt: Date.now(),
        connectionStatus: "not_connected",
        clientType: "text",
        ...overrides,
      };
    }

    it("renders one card per consolidated server (dual-type = 1 card)", () => {
      mockHookReturn = {
        registryServers: [
          createFullServer({
            _id: "asana-text",
            displayName: "Asana",
            clientType: "text",
          }),
          createFullServer({
            _id: "asana-app",
            displayName: "Asana",
            clientType: "app",
          }),
          createFullServer({
            _id: "linear-1",
            displayName: "Linear",
            clientType: "text",
          }),
        ],
        categories: ["Productivity"],
        isLoading: false,
        connect: mockConnect,
        disconnect: mockDisconnect,
      };

      render(<RegistryTab {...defaultProps} />);

      const headings = screen.getAllByRole("heading", { level: 3 });
      const names = headings.map((h) => h.textContent);
      expect(names.filter((n) => n === "Asana")).toHaveLength(1);
      expect(names.filter((n) => n === "Linear")).toHaveLength(1);
      expect(headings).toHaveLength(2);
    });

    it("shows both Text and App badges on dual-type card", () => {
      mockHookReturn = {
        registryServers: [
          createFullServer({
            _id: "asana-text",
            displayName: "Asana",
            clientType: "text",
          }),
          createFullServer({
            _id: "asana-app",
            displayName: "Asana",
            clientType: "app",
          }),
        ],
        categories: ["Productivity"],
        isLoading: false,
        connect: mockConnect,
        disconnect: mockDisconnect,
      };

      render(<RegistryTab {...defaultProps} />);

      expect(screen.getByText("Text")).toBeInTheDocument();
      expect(screen.getByText("App")).toBeInTheDocument();
    });

    it("shows dropdown trigger for dual-type card", () => {
      mockHookReturn = {
        registryServers: [
          createFullServer({
            _id: "asana-text",
            displayName: "Asana",
            clientType: "text",
          }),
          createFullServer({
            _id: "asana-app",
            displayName: "Asana",
            clientType: "app",
          }),
        ],
        categories: ["Productivity"],
        isLoading: false,
        connect: mockConnect,
        disconnect: mockDisconnect,
      };

      render(<RegistryTab {...defaultProps} />);

      expect(
        screen.getByTestId("connect-dropdown-trigger"),
      ).toBeInTheDocument();
    });

    it("does not show dropdown trigger for single-type card", () => {
      mockHookReturn = {
        registryServers: [
          createFullServer({
            _id: "linear-1",
            displayName: "Linear",
            clientType: "text",
          }),
        ],
        categories: ["Productivity"],
        isLoading: false,
        connect: mockConnect,
        disconnect: mockDisconnect,
      };

      render(<RegistryTab {...defaultProps} />);

      expect(screen.queryByTestId("connect-dropdown-trigger")).toBeNull();
    });

    it("dropdown contains Connect as Text and Connect as App options", async () => {
      mockHookReturn = {
        registryServers: [
          createFullServer({
            _id: "asana-text",
            displayName: "Asana",
            clientType: "text",
          }),
          createFullServer({
            _id: "asana-app",
            displayName: "Asana",
            clientType: "app",
          }),
        ],
        categories: ["Productivity"],
        isLoading: false,
        connect: mockConnect,
        disconnect: mockDisconnect,
      };

      render(<RegistryTab {...defaultProps} />);

      // With the mocked dropdown, items are always visible
      const items = screen.getAllByTestId("dropdown-item");
      const itemTexts = items.map((el) => el.textContent);
      expect(itemTexts.some((t) => t?.includes("Text"))).toBe(true);
      expect(itemTexts.some((t) => t?.includes("App"))).toBe(true);
    });

    it("stores the suffixed runtime name when connecting a dual-type variant", async () => {
      mockHookReturn = {
        registryServers: [
          createFullServer({
            _id: "asana-text",
            displayName: "Asana",
            clientType: "text",
          }),
          createFullServer({
            _id: "asana-app",
            displayName: "Asana",
            clientType: "app",
          }),
        ],
        categories: ["Productivity"],
        isLoading: false,
        connect: mockConnect,
        disconnect: mockDisconnect,
      };

      render(<RegistryTab {...defaultProps} />);

      fireEvent.click(screen.getByText("Connect as App"));

      await waitFor(() => {
        expect(mockConnect).toHaveBeenCalled();
      });
      expect(readPendingQuickConnect()).toEqual({
        serverName: "Asana (App)",
        registryServerId: "asana-app",
        displayName: "Asana",
        sourceTab: "registry",
        createdAt: expect.any(Number),
      });
    });
  });
});
