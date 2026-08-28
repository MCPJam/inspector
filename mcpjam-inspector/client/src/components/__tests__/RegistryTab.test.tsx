import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  act,
  render,
  screen,
  fireEvent,
  waitFor,
  within,
} from "@testing-library/react";
import { RegistryTab } from "../RegistryTab";
import {
  sortRegistryVariantsAppBeforeText,
  type EnrichedRegistryServer,
  type EnrichedRegistryCatalogCard,
} from "@/hooks/useRegistryServers";
import {
  DirectoryConnectError,
  type DirectoryServer,
} from "@/hooks/useServerDirectory";
import {
  readPendingQuickConnect,
  writePendingQuickConnect,
} from "@/lib/quick-connect-pending";
import { executeInspectorCommand } from "@/lib/inspector-command-handlers";
import { readSurfaceSnapshot } from "@/lib/webmcp/surface-snapshot-registry";
import type {
  InspectorCommand,
  InspectorCommandResponse,
} from "@/shared/inspector-command.js";

// Mock the useRegistryServers hook
const mockConnect = vi.fn();
const mockDisconnect = vi.fn();
const mockToggleStar = vi.fn();
let mockHookReturn: {
  catalogCards: EnrichedRegistryCatalogCard[];
  categories: string[];
  isLoading: boolean;
  connect: typeof mockConnect;
  disconnect: typeof mockDisconnect;
  toggleStar: typeof mockToggleStar;
};

function toCatalogCard(
  variants: EnrichedRegistryServer[],
  key = "card-1"
): EnrichedRegistryCatalogCard {
  const hasDualType = variants.length > 1;
  const ordered = hasDualType
    ? sortRegistryVariantsAppBeforeText(variants)
    : variants;
  return {
    registryCardKey: key,
    catalogSortOrder: 0,
    variants: ordered,
    starCount: 0,
    isStarred: false,
    hasDualType,
  };
}

vi.mock("@/hooks/useRegistryServers", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("@/hooks/useRegistryServers")
  >();
  return {
    ...actual,
    useRegistryServers: () => mockHookReturn,
  };
});

// The directory half is mocked the same way as the curated half: the real
// module keeps its pure helpers (`requiresEndpointChoice`,
// `normalizeDirectoryConnectError`, the tier list) because the component and
// the tests both rely on those being the SHIPPING implementations — only the
// Convex-backed hook is replaced.
const mockDirectoryConnect = vi.fn();
const mockLoadMore = vi.fn();
const mockSetQuery = vi.fn();
const mockSetTier = vi.fn();
const mockSetSource = vi.fn();
const mockSetConnectableOnly = vi.fn();
let mockDirectoryReturn: Record<string, unknown>;

function directoryHookReturn(
  overrides: Partial<Record<string, unknown>> = {}
): Record<string, unknown> {
  return {
    items: [],
    status: "Exhausted",
    isLoadingFirstPage: false,
    canLoadMore: false,
    loadMore: mockLoadMore,
    query: "",
    setQuery: mockSetQuery,
    tier: "all",
    setTier: mockSetTier,
    source: "anthropic-directory",
    setSource: mockSetSource,
    connectableOnly: false,
    setConnectableOnly: mockSetConnectableOnly,
    hasTiers: true,
    lastSyncedAt: null,
    connect: mockDirectoryConnect,
    connections: [],
    connectedCatalogIds: new Set<string>(),
    ...overrides,
  };
}

vi.mock("@/hooks/useServerDirectory", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("@/hooks/useServerDirectory")
  >();
  return {
    ...actual,
    useServerDirectory: () => mockDirectoryReturn,
    // The real hook is Convex-backed; the mock answers only once a card is
    // actually open (a null id must stay `undefined`, like the real skip).
    useDirectoryServerDetail: (catalogServerId: string | null) =>
      catalogServerId ? mockDirectoryDetail : undefined,
  };
});

/** What the mocked detail hook serves once a card is open. */
let mockDirectoryDetail: unknown;

function createDirectoryServer(
  overrides: Partial<DirectoryServer> = {}
): DirectoryServer {
  return {
    _id: "cat_1",
    source: "anthropic-directory",
    sourceId: "srv-0001",
    serverName: "com.mcpjam/anthropic-linear-1a2b3c4d",
    displayName: "Linear",
    description: "Track issues and cycles.",
    verifiedTier: "partner",
    rowType: "remote",
    endpointKind: "fixed",
    remoteUrl: "https://mcp.linear.app/mcp",
    isAuthless: false,
    curatedOverlap: false,
    ...overrides,
  };
}

/**
 * The third Convex-backed hook in this tab, mocked like the other two: this
 * suite renders `RegistryTab` with no `ConvexProvider`, so a real `useQuery`
 * throws before the component draws anything.
 *
 * The default is a project with NO organization, which is what makes every
 * other test in this file keep asserting what it already asserted — the org
 * section renders nothing at all in that state. Tests that care about the
 * shelf override it.
 */
const mockOrgRegistryAdd = vi.fn();
const mockOrgRegistryConnect = vi.fn();
let mockOrgRegistryReturn: Record<string, unknown>;

function orgRegistryHookReturn(
  overrides: Partial<Record<string, unknown>> = {}
): Record<string, unknown> {
  return {
    servers: [],
    isLoading: false,
    organizationId: null,
    canAdd: false,
    add: mockOrgRegistryAdd,
    update: vi.fn(),
    remove: vi.fn(),
    connect: mockOrgRegistryConnect,
    disconnect: vi.fn(),
    ...overrides,
  };
}

vi.mock("@/hooks/useOrgRegistryServers", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("@/hooks/useOrgRegistryServers")
  >();
  return {
    ...actual,
    useOrgRegistryServers: () => mockOrgRegistryReturn,
  };
});

// Mock dropdown menu to simplify testing
vi.mock("@mcpjam/design-system/dropdown-menu", () => ({
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
  overrides: Partial<EnrichedRegistryServer> = {}
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
    projectId: "ws_123",
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
    mockDirectoryConnect.mockResolvedValue({
      serverId: "srv_1",
      serverName: "Linear",
    });
    mockDirectoryReturn = directoryHookReturn();
    mockOrgRegistryReturn = orgRegistryHookReturn();
    mockDirectoryDetail = null;
    mockHookReturn = {
      catalogCards: [],
      categories: [],
      isLoading: false,
      connect: mockConnect,
      disconnect: mockDisconnect,
      toggleStar: mockToggleStar,
    };
  });

  describe("visibility without authentication", () => {
    it("renders directory servers when not authenticated", () => {
      mockDirectoryReturn = directoryHookReturn({
        items: [createDirectoryServer({ displayName: "Linear" })],
      });

      render(<RegistryTab {...defaultProps} isAuthenticated={false} />);

      expect(screen.getByText("Registry")).toBeInTheDocument();
      expect(screen.getByText("Linear")).toBeInTheDocument();
      expect(screen.getByText("Connect")).toBeInTheDocument();
    });

    it("shows header and description when not authenticated", () => {
      mockDirectoryReturn = directoryHookReturn({
        items: [createDirectoryServer()],
      });

      render(<RegistryTab {...defaultProps} isAuthenticated={false} />);

      expect(screen.getByText("Registry")).toBeInTheDocument();
      expect(
        screen.getByText(
          "Servers your organization has shared, plus connector directories you can connect from."
        )
      ).toBeInTheDocument();
    });
  });

  describe("organization shelf", () => {
    const orgEntry = {
      _id: "reg_1",
      name: "org/org_1/internal-docs",
      displayName: "Internal Docs",
      description: "What the team uses.",
      scope: "organization" as const,
      status: "approved" as const,
      transport: {
        transportType: "http" as const,
        url: "https://mcp.example.com/mcp",
        useOAuth: true,
      },
      createdBy: "user_1",
      createdAt: 1,
      updatedAt: 1,
      connectionStatus: "not_connected" as const,
      connectedServerName: null,
      derived: {
        probedAt: 1,
        endpointUrl: "https://mcp.example.com/mcp",
        serverVersion: "1.4.2",
        authRequired: true,
        supportsDcr: true,
      },
      editedFields: [],
    };

    it("renders nothing at all for a project with no organization", () => {
      render(<RegistryTab {...defaultProps} />);

      expect(screen.queryByText("Your organization")).not.toBeInTheDocument();
    });

    it("renders the org's entries with their derived version, and no star control", () => {
      mockOrgRegistryReturn = orgRegistryHookReturn({
        organizationId: "org_1",
        canAdd: true,
        servers: [orgEntry],
      });

      render(<RegistryTab {...defaultProps} />);

      expect(screen.getByText("Your organization")).toBeInTheDocument();
      expect(screen.getByText("Internal Docs")).toBeInTheDocument();
      // Version comes off the probe snapshot, not off anything typed.
      expect(screen.getByText("v1.4.2")).toBeInTheDocument();
      // An org row has no `registryCardKey`, so it can never carry a star.
      expect(
        screen.queryByRole("button", { name: /star this server/i })
      ).not.toBeInTheDocument();
    });

    it("invites a member with an empty shelf to add one", () => {
      mockOrgRegistryReturn = orgRegistryHookReturn({
        organizationId: "org_1",
        canAdd: true,
        servers: [],
      });

      render(<RegistryTab {...defaultProps} />);

      expect(screen.getByText("Nothing shared yet")).toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: "Add a server" })
      ).toBeInTheDocument();
    });

    it("hides the shelf from a member who cannot add and has nothing to see", () => {
      mockOrgRegistryReturn = orgRegistryHookReturn({
        organizationId: "org_1",
        canAdd: false,
        servers: [],
      });

      render(<RegistryTab {...defaultProps} />);

      expect(screen.queryByText("Your organization")).not.toBeInTheDocument();
    });
  });

  describe("loading state", () => {
    it("shows loading skeleton when the directory is loading", () => {
      mockDirectoryReturn = directoryHookReturn({
        isLoadingFirstPage: true,
      });

      const { container } = render(<RegistryTab {...defaultProps} />);

      const skeletons = container.querySelectorAll("[data-slot='skeleton']");
      expect(skeletons.length).toBeGreaterThan(0);
    });
  });

  describe("empty state", () => {
    it("shows empty state when no servers are available", () => {
      render(<RegistryTab {...defaultProps} />);

      expect(screen.getByText("No servers available")).toBeInTheDocument();
      expect(
        screen.getByText(
          "Share a server with your organization, or search a connector directory."
        )
      ).toBeInTheDocument();
    });
  });

  describe.skip("auth badges (curated catalog retired)", () => {
    it("shows OAuth badge with key icon for OAuth servers", () => {
      mockHookReturn = {
        catalogCards: [
          toCatalogCard([
            createMockServer({
              transport: {
                transportType: "http",
                url: "https://mcp.test.com/sse",
                useOAuth: true,
              },
            }),
          ]),
        ],
        categories: ["Productivity"],
        isLoading: false,
        connect: mockConnect,
        disconnect: mockDisconnect,
        toggleStar: mockToggleStar,
      };

      render(<RegistryTab {...defaultProps} />);

      expect(screen.getByText("OAuth")).toBeInTheDocument();
    });

    it("shows No auth badge for servers without OAuth", () => {
      mockHookReturn = {
        catalogCards: [toCatalogCard([createMockServer()])],
        categories: ["Productivity"],
        isLoading: false,
        connect: mockConnect,
        disconnect: mockDisconnect,
        toggleStar: mockToggleStar,
      };

      render(<RegistryTab {...defaultProps} />);

      expect(screen.getByText("No auth")).toBeInTheDocument();
    });
  });

  describe.skip("server cards (curated catalog retired)", () => {
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
        catalogCards: [toCatalogCard([server])],
        categories: ["Project Management"],
        isLoading: false,
        connect: mockConnect,
        disconnect: mockDisconnect,
        toggleStar: mockToggleStar,
      };

      render(<RegistryTab {...defaultProps} />);

      expect(screen.getByText("Linear")).toBeInTheDocument();
      expect(
        screen.getByText("Manage Linear issues and projects.")
      ).toBeInTheDocument();
      expect(screen.getByText("MCPJam")).toBeInTheDocument();
    });

    it("shows verified star when publishStatus is verified", () => {
      mockHookReturn = {
        catalogCards: [
          toCatalogCard([createMockServer({ publishStatus: "verified" })]),
        ],
        categories: ["Productivity"],
        isLoading: false,
        connect: mockConnect,
        disconnect: mockDisconnect,
        toggleStar: mockToggleStar,
      };

      render(<RegistryTab {...defaultProps} />);

      expect(screen.getByLabelText("Verified publisher")).toBeInTheDocument();
    });

    it("does not show verified star when publishStatus is not verified", () => {
      mockHookReturn = {
        catalogCards: [
          toCatalogCard([createMockServer({ publishStatus: "unverified" })]),
        ],
        categories: ["Productivity"],
        isLoading: false,
        connect: mockConnect,
        disconnect: mockDisconnect,
        toggleStar: mockToggleStar,
      };

      render(<RegistryTab {...defaultProps} />);

      expect(
        screen.queryByLabelText("Verified publisher")
      ).not.toBeInTheDocument();
    });

    it("does not show raw URL by default", () => {
      mockHookReturn = {
        catalogCards: [toCatalogCard([createMockServer()])],
        categories: ["Productivity"],
        isLoading: false,
        connect: mockConnect,
        disconnect: mockDisconnect,
        toggleStar: mockToggleStar,
      };

      render(<RegistryTab {...defaultProps} />);

      expect(
        screen.queryByText("https://mcp.test.com/sse")
      ).not.toBeInTheDocument();
    });

    it("shows Connect button for not_connected servers", () => {
      mockHookReturn = {
        catalogCards: [toCatalogCard([createMockServer()])],
        categories: ["Productivity"],
        isLoading: false,
        connect: mockConnect,
        disconnect: mockDisconnect,
        toggleStar: mockToggleStar,
      };

      render(<RegistryTab {...defaultProps} />);

      expect(screen.getByText("Connect")).toBeInTheDocument();
    });

    it("shows Connected badge for connected servers", () => {
      mockHookReturn = {
        catalogCards: [
          toCatalogCard([createMockServer({ connectionStatus: "connected" })]),
        ],
        categories: ["Productivity"],
        isLoading: false,
        connect: mockConnect,
        disconnect: mockDisconnect,
        toggleStar: mockToggleStar,
      };

      render(<RegistryTab {...defaultProps} />);

      expect(screen.getByText("Connected")).toBeInTheDocument();
    });

    it("shows Connect for servers in project but not live", () => {
      mockHookReturn = {
        catalogCards: [
          toCatalogCard([createMockServer({ connectionStatus: "added" })]),
        ],
        categories: ["Productivity"],
        isLoading: false,
        connect: mockConnect,
        disconnect: mockDisconnect,
        toggleStar: mockToggleStar,
      };

      render(<RegistryTab {...defaultProps} />);

      const connectBtn = screen.getByRole("button", { name: "Connect" });
      expect(connectBtn).toBeInTheDocument();
      expect(connectBtn).toHaveAttribute(
        "title",
        "Server is in your project — click to connect"
      );
    });
  });

  describe("upstream directory section", () => {
    it("renders a directory card with its tier and provenance", () => {
      mockDirectoryReturn = directoryHookReturn({
        items: [createDirectoryServer()],
      });

      render(<RegistryTab {...defaultProps} />);

      expect(screen.getByText("Linear")).toBeInTheDocument();
      expect(screen.getByText("From Claude directory")).toBeInTheDocument();
      expect(screen.getByText("Partner")).toBeInTheDocument();
      expect(screen.getByText("Track issues and cycles.")).toBeInTheDocument();
    });

    it("badges a row whose probe resolved to pre-registered-only OAuth", () => {
      mockDirectoryReturn = directoryHookReturn({
        items: [
          createDirectoryServer({
            oauthProbe: {
              probedAt: Date.now(),
              endpointUrl: "https://mcp.linear.app/mcp",
              outcome: "resolved",
              supportsDcr: false,
              supportsCimd: false,
            },
          }),
        ],
      });

      render(<RegistryTab {...defaultProps} />);
      expect(
        screen.getByText("Requires pre-registered client")
      ).toBeInTheDocument();
    });

    it("shows no pre-registration badge for a self-registering server or an unprobed row", () => {
      // A resolved verdict WITH a registration path, and a row the sweep has
      // not reached: both must render nothing — the badge is a probe fact,
      // not a default.
      mockDirectoryReturn = directoryHookReturn({
        items: [
          createDirectoryServer({
            _id: "cat_dcr",
            displayName: "Self Registering",
            oauthProbe: {
              probedAt: Date.now(),
              endpointUrl: "https://mcp.linear.app/mcp",
              outcome: "resolved",
              supportsDcr: true,
            },
          }),
          createDirectoryServer({ _id: "cat_unprobed" }),
        ],
      });

      render(<RegistryTab {...defaultProps} />);
      expect(
        screen.queryByText("Requires pre-registered client")
      ).not.toBeInTheDocument();
    });

    it("renders the search box and the tier filter", () => {
      mockDirectoryReturn = directoryHookReturn({
        items: [createDirectoryServer()],
      });

      render(<RegistryTab {...defaultProps} />);

      expect(
        screen.getByRole("searchbox", {
          name: "Search the Claude directory…",
        })
      ).toBeInTheDocument();
      expect(screen.getByTestId("directory-tier-filter")).toBeInTheDocument();
    });

    it("typing in the search box drives the hook's query", () => {
      mockDirectoryReturn = directoryHookReturn({
        items: [createDirectoryServer()],
      });

      render(<RegistryTab {...defaultProps} />);
      fireEvent.change(
        screen.getByRole("searchbox", {
          name: "Search the Claude directory…",
        }),
        { target: { value: "linear" } }
      );

      expect(mockSetQuery).toHaveBeenCalledWith("linear");
    });

    it("shows directory rows even when a leftover overlap flag is set", () => {
      // The hook hands back only non-overlapping rows; a card that reached the
      // component is a card that should render. Asserting that here keeps the
      // canonical-wins rule in ONE place instead of two that can disagree.
      mockDirectoryReturn = directoryHookReturn({
        items: [createDirectoryServer({ displayName: "Only Survivor" })],
      });

      render(<RegistryTab {...defaultProps} />);
      expect(screen.getByText("Only Survivor")).toBeInTheDocument();
    });

    it("shows Load more only when another page exists", () => {
      mockDirectoryReturn = directoryHookReturn({
        items: [createDirectoryServer()],
      });
      const { unmount } = render(<RegistryTab {...defaultProps} />);
      expect(
        screen.queryByRole("button", { name: "Load more" })
      ).not.toBeInTheDocument();
      unmount();

      mockDirectoryReturn = directoryHookReturn({
        items: [createDirectoryServer()],
        canLoadMore: true,
      });
      render(<RegistryTab {...defaultProps} />);
      fireEvent.click(screen.getByRole("button", { name: "Load more" }));
      expect(mockLoadMore).toHaveBeenCalled();
    });

    it("an empty organization shelf does not blank the directory", () => {
      // The two halves have independent backends. A per-SCREEN early return
      // (what this used to be) meant one empty catalog hid a directory that
      // had loaded perfectly well.
      mockHookReturn = { ...mockHookReturn, catalogCards: [] };
      mockDirectoryReturn = directoryHookReturn({
        items: [createDirectoryServer()],
      });

      render(<RegistryTab {...defaultProps} />);
      expect(
        screen.getByTestId("server-directory-section")
      ).toBeInTheDocument();
      expect(screen.getByText("Linear")).toBeInTheDocument();
    });

    it("says so when a search matches nothing, instead of vanishing", () => {
      mockDirectoryReturn = directoryHookReturn({ items: [], query: "zzzz" });

      render(<RegistryTab {...defaultProps} />);
      expect(
        screen.getByText("No directory connectors match that search.")
      ).toBeInTheDocument();
    });

    it("stays out of the way when nothing is loaded and nothing was asked", () => {
      mockHookReturn = { ...mockHookReturn, catalogCards: [] };
      mockDirectoryReturn = directoryHookReturn({ items: [] });

      render(<RegistryTab {...defaultProps} />);
      expect(
        screen.queryByTestId("server-directory-section")
      ).not.toBeInTheDocument();
    });

    it("offers the source facet", () => {
      mockDirectoryReturn = directoryHookReturn({
        items: [createDirectoryServer()],
      });
      render(<RegistryTab {...defaultProps} />);
      expect(screen.getByTestId("directory-source-filter")).toBeInTheDocument();
    });

    it("hides the tier filter on a source that publishes no tiers", () => {
      // An always-empty filter is worse than no filter: it reads as "this
      // directory has no partners", which is a claim we would be inventing.
      mockDirectoryReturn = directoryHookReturn({
        items: [createDirectoryServer({ source: "chatgpt-directory" })],
        source: "chatgpt-directory",
        hasTiers: false,
      });
      render(<RegistryTab {...defaultProps} />);
      expect(screen.getByTestId("directory-source-filter")).toBeInTheDocument();
      expect(
        screen.queryByTestId("directory-tier-filter")
      ).not.toBeInTheDocument();
    });

    it("keeps an options row on screen while Connectable only is on", () => {
      // The toggle hides what cannot be installed, not what needs a dialog
      // first. A regional connector is connectable.
      mockDirectoryReturn = directoryHookReturn({
        items: [
          createDirectoryServer({
            displayName: "Braze",
            endpointKind: "options",
            remoteUrl: undefined,
            remoteUrlOptions: ["https://mcp.braze.com/mcp"],
          }),
        ],
        connectableOnly: true,
      });
      render(<RegistryTab {...defaultProps} />);

      expect(screen.getByText("Braze")).toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: "Connect" })
      ).toBeInTheDocument();
      expect(
        screen.queryByRole("button", { name: "Not connectable" })
      ).not.toBeInTheDocument();
    });

    it("can hide the rows that cannot be installed", () => {
      // Off by default — hiding a third of the ChatGPT directory before
      // anyone asked would make it look smaller than it is.
      mockDirectoryReturn = directoryHookReturn({
        items: [createDirectoryServer()],
      });
      render(<RegistryTab {...defaultProps} />);
      const toggle = screen.getByTestId("directory-connectable-filter");
      expect(toggle).toHaveAttribute("aria-pressed", "false");

      fireEvent.click(toggle);
      expect(mockSetConnectableOnly).toHaveBeenCalledWith(true);
    });

    it("says how fresh the selected directory is", () => {
      mockDirectoryReturn = directoryHookReturn({
        items: [createDirectoryServer()],
        lastSyncedAt: Date.parse("2026-08-14T00:00:00.000Z"),
      });
      render(<RegistryTab {...defaultProps} />);
      expect(screen.getByTestId("directory-as-of")).toHaveTextContent(
        /Claude directory as of/
      );
    });

    it("badges a ChatGPT row as listed, never as verified", () => {
      mockDirectoryReturn = directoryHookReturn({
        items: [
          createDirectoryServer({
            source: "chatgpt-directory",
            displayName: "Acme",
            verifiedTier: undefined,
          }),
        ],
        source: "chatgpt-directory",
        hasTiers: false,
      });
      render(<RegistryTab {...defaultProps} />);
      expect(screen.getByText("Listed in ChatGPT")).toBeInTheDocument();
    });
  });

  describe("upstream directory — rows with no endpoint", () => {
    const hiddenRow = () =>
      createDirectoryServer({
        source: "chatgpt-directory",
        displayName: "Proxied App",
        verifiedTier: undefined,
        endpointKind: "none",
        remoteUrl: undefined,
        rowType: "remote",
        unavailableReason: "endpoint_hidden",
      });

    it("shows the row, disabled, rather than hiding it", () => {
      // Ingesting the full census is the point; a card that simply vanished
      // would make the directory look smaller than it is.
      mockDirectoryReturn = directoryHookReturn({
        items: [hiddenRow()],
        source: "chatgpt-directory",
        hasTiers: false,
      });
      render(<RegistryTab {...defaultProps} />);

      expect(screen.getByText("Proxied App")).toBeInTheDocument();
      const action = screen.getByRole("button", { name: "Not connectable" });
      expect(action).toBeDisabled();
      expect(
        screen.queryByRole("button", { name: "Connect" })
      ).not.toBeInTheDocument();
    });

    it("says WHY, in terms true of that row", () => {
      mockDirectoryReturn = directoryHookReturn({
        items: [hiddenRow()],
        source: "chatgpt-directory",
        hasTiers: false,
      });
      render(<RegistryTab {...defaultProps} />);

      const reason = screen.getByTestId("directory-unavailable-reason");
      expect(reason).toHaveTextContent(/not published/i);
      // The copy this replaced. A hosted server OpenAI proxies is not a
      // desktop extension, and saying so sends people hunting for an
      // installer that does not exist.
      expect(reason).not.toHaveTextContent(/desktop extension/i);
    });

    it("still calls a genuine local extension what it is", () => {
      mockDirectoryReturn = directoryHookReturn({
        items: [
          createDirectoryServer({
            displayName: "PDF Tools",
            rowType: "local",
            endpointKind: "none",
            remoteUrl: undefined,
          }),
        ],
      });
      render(<RegistryTab {...defaultProps} />);
      expect(
        screen.getByTestId("directory-unavailable-reason")
      ).toHaveTextContent(/local desktop extension/i);
    });
  });

  describe("claude directory detail dialog", () => {
    it("clicking a card opens the detail dialog with the listing body", () => {
      mockDirectoryReturn = directoryHookReturn({
        items: [createDirectoryServer()],
      });
      mockDirectoryDetail = {
        description: "The long-form listing description.",
        authorName: "Linear",
        authorUrl: "https://linear.app",
        categories: ["productivity"],
        toolNames: ["create_issue", "list_issues"],
        promptNames: [],
        permissions: "Read and write",
        sensitiveDataTypes: [],
        links: [],
        authPosture: "auth_required",
        requiredFields: [],
      };

      render(<RegistryTab {...defaultProps} />);
      fireEvent.click(screen.getByTestId("directory-server-card"));

      expect(screen.getByTestId("directory-detail-dialog")).toBeInTheDocument();
      expect(
        screen.getByText("The long-form listing description.")
      ).toBeInTheDocument();
      expect(screen.getByText("Tools (2)")).toBeInTheDocument();
      expect(screen.getByText("create_issue")).toBeInTheDocument();
    });

    it("the card's Connect button connects without opening the dialog", async () => {
      const server = createDirectoryServer();
      mockDirectoryReturn = directoryHookReturn({ items: [server] });

      render(<RegistryTab {...defaultProps} />);
      fireEvent.click(screen.getByRole("button", { name: "Connect" }));

      await waitFor(() => {
        expect(mockDirectoryConnect).toHaveBeenCalledWith(server, undefined);
      });
      expect(
        screen.queryByTestId("directory-detail-dialog")
      ).not.toBeInTheDocument();
    });

    it("connecting from the dialog closes it and runs the connect flow", async () => {
      const server = createDirectoryServer();
      mockDirectoryReturn = directoryHookReturn({ items: [server] });

      render(<RegistryTab {...defaultProps} />);
      fireEvent.click(screen.getByTestId("directory-server-card"));
      // Two Connects exist now (card + dialog); the dialog's is inside it.
      const dialog = screen.getByTestId("directory-detail-dialog");
      fireEvent.click(within(dialog).getByRole("button", { name: "Connect" }));

      await waitFor(() => {
        expect(mockDirectoryConnect).toHaveBeenCalledWith(server, undefined);
      });
      expect(
        screen.queryByTestId("directory-detail-dialog")
      ).not.toBeInTheDocument();
    });
  });

  describe("claude directory connect", () => {
    it("calls the mutation, then hands the returned NAME to onConnect", async () => {
      const server = createDirectoryServer();
      mockDirectoryReturn = directoryHookReturn({ items: [server] });

      render(<RegistryTab {...defaultProps} />);
      fireEvent.click(screen.getByRole("button", { name: "Connect" }));

      await waitFor(() => {
        expect(mockDirectoryConnect).toHaveBeenCalledWith(server, undefined);
      });
    });

    it("opens the endpoint dialog for an options row BEFORE calling connect", async () => {
      mockDirectoryReturn = directoryHookReturn({
        items: [
          createDirectoryServer({
            displayName: "Braze",
            endpointKind: "options",
            remoteUrl: undefined,
            remoteUrlOptions: [
              "https://mcp.braze.com/mcp",
              "https://mcp.braze.eu/mcp",
            ],
          }),
        ],
      });

      render(<RegistryTab {...defaultProps} />);
      fireEvent.click(screen.getByRole("button", { name: "Connect" }));

      await waitFor(() => {
        expect(
          screen.getByTestId("directory-endpoint-select")
        ).toBeInTheDocument();
      });
      // A URL the user has not picked is not a URL we may send.
      expect(mockDirectoryConnect).not.toHaveBeenCalled();
    });

    it("opens a pattern input for a tenant row", async () => {
      mockDirectoryReturn = directoryHookReturn({
        items: [
          createDirectoryServer({
            displayName: "Smartsheet",
            endpointKind: "tenant",
            remoteUrl: undefined,
            remoteUrlRegex: "^https://mcp\\.smartsheet\\.(com|eu)/?$",
          }),
        ],
      });

      render(<RegistryTab {...defaultProps} />);
      fireEvent.click(screen.getByRole("button", { name: "Connect" }));

      await waitFor(() => {
        expect(
          screen.getByTestId("directory-endpoint-url")
        ).toBeInTheDocument();
      });
      expect(mockDirectoryConnect).not.toHaveBeenCalled();
    });

    it("re-seeds the dialog from the ERROR when connect asks for an endpoint", async () => {
      // The row was rendered before the last sync; the error carries the
      // authoritative set, so the dialog must follow the error, not the card.
      mockDirectoryConnect.mockRejectedValueOnce(
        new DirectoryConnectError(
          "endpoint_url_required",
          "This connector offers several endpoints — choose one.",
          { options: ["https://fresh.example/mcp"] }
        )
      );
      mockDirectoryReturn = directoryHookReturn({
        items: [createDirectoryServer({ endpointKind: "fixed" })],
      });

      render(<RegistryTab {...defaultProps} />);
      fireEvent.click(screen.getByRole("button", { name: "Connect" }));

      await waitFor(() => {
        expect(
          screen.getByTestId("directory-endpoint-select")
        ).toBeInTheDocument();
      });
    });

    it("keeps the dialog open with the refusal inline on a rejected URL", async () => {
      mockDirectoryConnect.mockRejectedValueOnce(
        new DirectoryConnectError(
          "endpoint_url_not_allowed",
          "That URL is not one of this connector’s endpoints."
        )
      );
      mockDirectoryReturn = directoryHookReturn({
        items: [
          createDirectoryServer({
            endpointKind: "tenant",
            remoteUrl: undefined,
            remoteUrlRegex: ".*",
          }),
        ],
      });

      render(<RegistryTab {...defaultProps} />);
      fireEvent.click(screen.getByRole("button", { name: "Connect" }));
      await waitFor(() => {
        expect(
          screen.getByTestId("directory-endpoint-url")
        ).toBeInTheDocument();
      });

      fireEvent.change(screen.getByTestId("directory-endpoint-url"), {
        target: { value: "https://wrong.example/mcp" },
      });
      fireEvent.click(
        screen.getAllByRole("button", { name: "Connect" }).slice(-1)[0]
      );

      await waitFor(() => {
        expect(
          screen.getByTestId("directory-endpoint-error")
        ).toHaveTextContent("not one of this connector");
      });
      // Still open — the user is one correction away.
      expect(screen.getByTestId("directory-endpoint-url")).toBeInTheDocument();
    });

    it("does not open the dialog for a conflict — that needs a different fix", async () => {
      mockDirectoryConnect.mockRejectedValueOnce(
        new DirectoryConnectError(
          "already_connected_to_different_endpoint",
          "Already connected elsewhere.",
          { connectedUrl: "https://mcp.braze.eu/mcp" }
        )
      );
      mockDirectoryReturn = directoryHookReturn({
        items: [createDirectoryServer()],
      });

      render(<RegistryTab {...defaultProps} />);
      fireEvent.click(screen.getByRole("button", { name: "Connect" }));

      await waitFor(() => expect(mockDirectoryConnect).toHaveBeenCalled());
      expect(
        screen.queryByTestId("directory-endpoint-url")
      ).not.toBeInTheDocument();
      expect(
        screen.queryByTestId("directory-endpoint-select")
      ).not.toBeInTheDocument();
    });
  });

  describe("claude directory card state", () => {
    it("reads `added` from the connection rows, not from the live map", () => {
      mockDirectoryReturn = directoryHookReturn({
        items: [createDirectoryServer()],
        connections: [
          {
            _id: "conn_1",
            catalogServerId: "cat_1",
            serverId: "srv_1",
            serverName: "Linear",
            endpointUrl: "https://mcp.linear.app/mcp",
            endpointKind: "fixed",
          },
        ],
      });

      render(<RegistryTab {...defaultProps} />);
      // Installed but not live: the button invites a connect.
      expect(screen.getByRole("button", { name: "Connect" })).toHaveAttribute(
        "title",
        "Server is in your project — click to connect"
      );
    });

    it("shows Connecting on an OAuth return, before the live map catches up", () => {
      // The component remounted through the redirect, so the in-memory
      // connecting set is gone and the server has not reappeared live yet.
      // Without the pending marker the card would offer Connect again on a
      // server the user just authorized.
      writePendingQuickConnect({
        serverName: "Linear",
        displayName: "Linear",
        sourceTab: "registry",
        createdAt: Date.now(),
        catalogServerId: "cat_1",
      });
      mockDirectoryReturn = directoryHookReturn({
        items: [createDirectoryServer()],
      });

      render(<RegistryTab {...defaultProps} />);
      expect(
        screen.getByRole("button", { name: "Connecting" })
      ).toBeInTheDocument();
    });

    it("a pending marker for a DIFFERENT entry leaves this card alone", () => {
      writePendingQuickConnect({
        serverName: "Something Else",
        displayName: "Something Else",
        sourceTab: "registry",
        createdAt: Date.now(),
        catalogServerId: "cat_other",
      });
      mockDirectoryReturn = directoryHookReturn({
        items: [createDirectoryServer()],
      });

      render(<RegistryTab {...defaultProps} />);
      expect(
        screen.getByRole("button", { name: "Connect" })
      ).toBeInTheDocument();
    });

    it("reads connected/connecting/error from the LIVE servers map", () => {
      const connections = [
        {
          _id: "conn_1",
          catalogServerId: "cat_1",
          serverId: "srv_1",
          serverName: "Linear",
          endpointUrl: "https://mcp.linear.app/mcp",
          endpointKind: "fixed" as const,
        },
      ];
      mockDirectoryReturn = directoryHookReturn({
        items: [createDirectoryServer()],
        connections,
      });

      const cases: Array<[string, string]> = [
        ["connected", "Connected"],
        ["connecting", "Connecting"],
        ["oauth-flow", "Connecting"],
        ["failed", "Retry"],
      ];
      for (const [connectionStatus, label] of cases) {
        mockDirectoryReturn = directoryHookReturn({
          items: [createDirectoryServer()],
          connections,
        });
        const { unmount } = render(
          <RegistryTab
            {...defaultProps}
            servers={
              { Linear: { connectionStatus } } as unknown as Record<
                string,
                never
              >
            }
          />
        );
        expect(screen.getByRole("button", { name: label })).toBeInTheDocument();
        unmount();
      }
    });
  });

  describe.skip("connect/disconnect actions (curated catalog retired)", () => {
    it("calls connect when Connect button is clicked", async () => {
      const server = createMockServer();
      mockHookReturn = {
        catalogCards: [toCatalogCard([server])],
        categories: ["Productivity"],
        isLoading: false,
        connect: mockConnect,
        disconnect: mockDisconnect,
        toggleStar: mockToggleStar,
      };

      render(<RegistryTab {...defaultProps} />);

      fireEvent.click(screen.getByText("Connect"));

      await waitFor(() => {
        expect(mockConnect).toHaveBeenCalledWith(server);
      });
    });

    it("calls connect when Connect is clicked for added-but-not-live server", async () => {
      const server = createMockServer({ connectionStatus: "added" });
      mockHookReturn = {
        catalogCards: [toCatalogCard([server])],
        categories: ["Productivity"],
        isLoading: false,
        connect: mockConnect,
        disconnect: mockDisconnect,
        toggleStar: mockToggleStar,
      };

      render(<RegistryTab {...defaultProps} />);

      fireEvent.click(screen.getByRole("button", { name: "Connect" }));

      await waitFor(() => {
        expect(mockConnect).toHaveBeenCalledWith(server);
      });
    });

    it("calls disconnect from overflow menu", async () => {
      const server = createMockServer({ connectionStatus: "connected" });
      mockHookReturn = {
        catalogCards: [toCatalogCard([server])],
        categories: ["Productivity"],
        isLoading: false,
        connect: mockConnect,
        disconnect: mockDisconnect,
        toggleStar: mockToggleStar,
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

  describe.skip("pending quick connect cleanup (curated catalog retired)", () => {
    it("clears registry pending when server auth fails so the card leaves Connecting", async () => {
      const server = createMockServer({
        displayName: "PostHog",
        clientType: "text",
        _id: "ph-1",
      });
      const serverName = "PostHog (Text)";
      writePendingQuickConnect({
        serverName,
        registryServerId: "ph-1",
        displayName: "PostHog",
        sourceTab: "registry",
        createdAt: Date.now(),
      });
      mockHookReturn = {
        catalogCards: [toCatalogCard([server], "posthog")],
        categories: ["Productivity"],
        isLoading: false,
        connect: mockConnect,
        disconnect: mockDisconnect,
        toggleStar: mockToggleStar,
      };

      render(
        <RegistryTab
          {...defaultProps}
          servers={{
            [serverName]: {
              name: serverName,
              connectionStatus: "failed",
              config: {} as any,
              lastConnectionTime: new Date(),
              retryCount: 0,
            },
          }}
        />
      );

      await waitFor(() => {
        expect(readPendingQuickConnect()).toBeNull();
      });
      expect(screen.queryByText("Connecting")).not.toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: "Connect" })
      ).toBeInTheDocument();
    });

    it("clears registry pending when the server lands on needs-auth", async () => {
      // `needs-auth` is a terminal outcome for a quick connect: the attempt
      // is over and the ball is in the user's court. Holding the pending
      // marker open would spin "Connecting" at someone whose next move is
      // to click Authorize, and the marker would only clear on a timeout.
      const server = createMockServer({
        displayName: "PostHog",
        clientType: "text",
        _id: "ph-1",
      });
      const serverName = "PostHog (Text)";
      writePendingQuickConnect({
        serverName,
        registryServerId: "ph-1",
        displayName: "PostHog",
        sourceTab: "registry",
        createdAt: Date.now(),
      });
      mockHookReturn = {
        catalogCards: [toCatalogCard([server], "posthog")],
        categories: ["Productivity"],
        isLoading: false,
        connect: mockConnect,
        disconnect: mockDisconnect,
        toggleStar: mockToggleStar,
      };

      render(
        <RegistryTab
          {...defaultProps}
          servers={{
            [serverName]: {
              name: serverName,
              connectionStatus: "needs-auth",
              config: {} as any,
              lastConnectionTime: new Date(),
              retryCount: 0,
            },
          }}
        />
      );

      await waitFor(() => {
        expect(readPendingQuickConnect()).toBeNull();
      });
      expect(screen.queryByText("Connecting")).not.toBeInTheDocument();
    });

    it("clears registry pending when oauth-flow exceeds the stale window", async () => {
      const server = createMockServer({
        displayName: "PostHog",
        clientType: "text",
        _id: "ph-1",
      });
      const serverName = "PostHog (Text)";
      writePendingQuickConnect({
        serverName,
        registryServerId: "ph-1",
        displayName: "PostHog",
        sourceTab: "registry",
        createdAt: Date.now() - 46 * 60 * 1000,
      });
      mockHookReturn = {
        catalogCards: [toCatalogCard([server], "posthog")],
        categories: ["Productivity"],
        isLoading: false,
        connect: mockConnect,
        disconnect: mockDisconnect,
        toggleStar: mockToggleStar,
      };

      render(
        <RegistryTab
          {...defaultProps}
          servers={{
            [serverName]: {
              name: serverName,
              connectionStatus: "oauth-flow",
              config: {} as any,
              lastConnectionTime: new Date(),
              retryCount: 0,
            },
          }}
        />
      );

      await waitFor(() => {
        expect(readPendingQuickConnect()).toBeNull();
      });
    });
  });

  describe.skip("auto-redirect to Playground (curated catalog retired)", () => {
    it("navigates to playground when a pending server becomes connected", async () => {
      const server = createMockServer({ displayName: "Asana" });
      mockHookReturn = {
        catalogCards: [toCatalogCard([server])],
        categories: ["Productivity"],
        isLoading: false,
        connect: mockConnect,
        disconnect: mockDisconnect,
        toggleStar: mockToggleStar,
      };

      const onNavigate = vi.fn();
      const { rerender } = render(
        <RegistryTab {...defaultProps} onNavigate={onNavigate} servers={{}} />
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
        />
      );

      await waitFor(() => {
        expect(onNavigate).toHaveBeenCalledWith("playground");
      });
      // localStorage should be cleaned up
      expect(readPendingQuickConnect()).toBeNull();
    });

    it("survives page remount (OAuth redirect) and still auto-redirects", async () => {
      // Simulate: user clicked Connect, got redirected to OAuth, page remounted
      localStorage.setItem("registry-pending-redirect", "Linear");

      const server = createMockServer({ displayName: "Linear" });
      mockHookReturn = {
        catalogCards: [toCatalogCard([server])],
        categories: ["Productivity"],
        isLoading: false,
        connect: mockConnect,
        disconnect: mockDisconnect,
        toggleStar: mockToggleStar,
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
        />
      );

      await waitFor(() => {
        expect(onNavigate).toHaveBeenCalledWith("playground");
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
        catalogCards: [toCatalogCard([server])],
        categories: ["Productivity"],
        isLoading: false,
        connect: mockConnect,
        disconnect: mockDisconnect,
        toggleStar: mockToggleStar,
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
        />
      );

      await waitFor(() => {
        expect(onNavigate).toHaveBeenCalledWith("playground");
      });
      expect(readPendingQuickConnect()).toBeNull();
    });
  });

  describe.skip("consolidated cards — dual-type servers (curated catalog retired)", () => {
    function createFullServer(
      overrides: Partial<EnrichedRegistryServer> & {
        _id: string;
        displayName: string;
      }
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
        catalogCards: [
          toCatalogCard(
            [
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
            "asana"
          ),
          toCatalogCard(
            [
              createFullServer({
                _id: "linear-1",
                displayName: "Linear",
                clientType: "text",
              }),
            ],
            "linear"
          ),
        ],
        categories: ["Productivity"],
        isLoading: false,
        connect: mockConnect,
        disconnect: mockDisconnect,
        toggleStar: mockToggleStar,
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
        catalogCards: [
          toCatalogCard(
            [
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
            "asana"
          ),
        ],
        categories: ["Productivity"],
        isLoading: false,
        connect: mockConnect,
        disconnect: mockDisconnect,
        toggleStar: mockToggleStar,
      };

      render(<RegistryTab {...defaultProps} />);

      expect(screen.getByText("Text")).toBeInTheDocument();
      expect(screen.getByText("App")).toBeInTheDocument();
    });

    it("shows dropdown trigger for dual-type card", () => {
      mockHookReturn = {
        catalogCards: [
          toCatalogCard(
            [
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
            "asana"
          ),
        ],
        categories: ["Productivity"],
        isLoading: false,
        connect: mockConnect,
        disconnect: mockDisconnect,
        toggleStar: mockToggleStar,
      };

      render(<RegistryTab {...defaultProps} />);

      expect(
        screen.getByTestId("connect-dropdown-trigger")
      ).toBeInTheDocument();
    });

    it("does not show dropdown trigger for single-type card", () => {
      mockHookReturn = {
        catalogCards: [
          toCatalogCard(
            [
              createFullServer({
                _id: "linear-1",
                displayName: "Linear",
                clientType: "text",
              }),
            ],
            "linear"
          ),
        ],
        categories: ["Productivity"],
        isLoading: false,
        connect: mockConnect,
        disconnect: mockDisconnect,
        toggleStar: mockToggleStar,
      };

      render(<RegistryTab {...defaultProps} />);

      expect(screen.queryByTestId("connect-dropdown-trigger")).toBeNull();
    });

    it("dropdown contains Connect as Text and Connect as App options", async () => {
      mockHookReturn = {
        catalogCards: [
          toCatalogCard(
            [
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
            "asana"
          ),
        ],
        categories: ["Productivity"],
        isLoading: false,
        connect: mockConnect,
        disconnect: mockDisconnect,
        toggleStar: mockToggleStar,
      };

      render(<RegistryTab {...defaultProps} />);

      // With the mocked dropdown, items are always visible
      const items = screen.getAllByTestId("dropdown-item");
      const itemTexts = items.map((el) => el.textContent);
      expect(itemTexts.some((t) => t?.includes("Text"))).toBe(true);
      expect(itemTexts.some((t) => t?.includes("App"))).toBe(true);
      const appIdx = itemTexts.findIndex((t) => t?.includes("App"));
      const textIdx = itemTexts.findIndex((t) => t?.includes("Text"));
      expect(appIdx).toBeGreaterThanOrEqual(0);
      expect(textIdx).toBeGreaterThanOrEqual(0);
      expect(appIdx).toBeLessThan(textIdx);
    });

    it("stores the suffixed runtime name when connecting a dual-type variant", async () => {
      mockHookReturn = {
        catalogCards: [
          toCatalogCard(
            [
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
            "asana"
          ),
        ],
        categories: ["Productivity"],
        isLoading: false,
        connect: mockConnect,
        disconnect: mockDisconnect,
        toggleStar: mockToggleStar,
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

  describe("agent bridge handlers", () => {
    function dualTypeCards(): EnrichedRegistryCatalogCard[] {
      return [
        toCatalogCard(
          [
            createMockServer({
              _id: "asana-text",
              displayName: "Asana",
              name: "com.asana.mcp",
              clientType: "text",
            }),
            createMockServer({
              _id: "asana-app",
              displayName: "Asana",
              name: "com.asana.mcp",
              clientType: "app",
            }),
          ],
          "asana"
        ),
      ];
    }

    function renderWithCards(cards: EnrichedRegistryCatalogCard[]) {
      mockHookReturn = { ...mockHookReturn, catalogCards: cards };
      return render(<RegistryTab {...defaultProps} />);
    }

    let commandSeq = 0;
    async function dispatch(command: Omit<InspectorCommand, "id">) {
      commandSeq += 1;
      let response!: InspectorCommandResponse;
      // Handlers call the component's own callbacks (setConnectingIds & co),
      // so the dispatch is a React state update and belongs inside act().
      await act(async () => {
        response = await executeInspectorCommand({
          ...command,
          id: `bridge-test-${commandSeq}`,
        } as InspectorCommand);
      });
      return response;
    }

    it("connectRegistryServer rejects unknown names as unknown_server", async () => {
      mockDirectoryReturn = directoryHookReturn({
        items: [createDirectoryServer({ isAuthless: true })],
      });
      render(<RegistryTab {...defaultProps} />);

      const unknown = await dispatch({
        type: "connectRegistryServer",
        payload: { serverName: "Not In Catalog" },
      });
      expect(unknown).toMatchObject({
        status: "error",
        error: { code: "unknown_server" },
      });
    });

    it("disconnectRegistryServer and toggleRegistryStar are retired with the curated catalog", async () => {
      mockDirectoryReturn = directoryHookReturn({
        items: [createDirectoryServer({ isAuthless: true })],
      });
      render(<RegistryTab {...defaultProps} />);

      const disconnect = await dispatch({
        type: "disconnectRegistryServer",
        payload: { serverName: "Linear" },
      });
      expect(disconnect).toMatchObject({
        status: "error",
        error: { code: "unsupported_in_mode" },
      });

      const star = await dispatch({
        type: "toggleRegistryStar",
        payload: { serverName: "Linear", starred: true },
      });
      expect(star).toMatchObject({
        status: "error",
        error: { code: "unsupported_in_mode" },
      });
    });

    it("snapshot reports redacted directory state, never transport URLs", async () => {
      mockDirectoryReturn = directoryHookReturn({
        items: [createDirectoryServer({ isAuthless: true })],
      });
      render(<RegistryTab {...defaultProps} />);

      const snapshot = await readSurfaceSnapshot("registry");
      expect(snapshot).toMatchObject({
        ok: true,
        data: {
          directory: expect.objectContaining({
            loadedCount: 1,
            visible: [expect.objectContaining({ name: "Linear" })],
          }),
        },
      });
      expect(JSON.stringify(snapshot)).not.toContain("https://");
    });

    it("connectRegistryServer resolves a DIRECTORY entry", async () => {
      mockDirectoryReturn = directoryHookReturn({
        items: [createDirectoryServer({ isAuthless: true })],
      });
      render(<RegistryTab {...defaultProps} />);

      const response = await dispatch({
        type: "connectRegistryServer",
        payload: { serverName: "linear" },
      });

      expect(response).toMatchObject({
        status: "success",
        result: { status: "connecting", serverName: "Linear" },
      });
      await waitFor(() => expect(mockDirectoryConnect).toHaveBeenCalled());
    });

    it("reports endpoint_choice_required instead of guessing a region", async () => {
      mockDirectoryReturn = directoryHookReturn({
        items: [
          createDirectoryServer({
            displayName: "Braze",
            endpointKind: "options",
            remoteUrl: undefined,
            isAuthless: true,
            remoteUrlOptions: [
              "https://mcp.braze.com/mcp",
              "https://mcp.braze.eu/mcp",
            ],
          }),
        ],
      });
      renderWithCards([toCatalogCard([createMockServer()])]);

      const response = await dispatch({
        type: "connectRegistryServer",
        payload: { serverName: "Braze" },
      });

      expect(response).toMatchObject({
        status: "success",
        result: { status: "endpoint_choice_required", serverName: "Braze" },
      });
      expect(mockDirectoryConnect).not.toHaveBeenCalled();
    });

    it("reports authorization_required rather than redirecting mid-turn", async () => {
      mockDirectoryReturn = directoryHookReturn({
        items: [createDirectoryServer({ isAuthless: false })],
      });
      renderWithCards([toCatalogCard([createMockServer()])]);

      const response = await dispatch({
        type: "connectRegistryServer",
        payload: { serverName: "Linear" },
      });

      expect(response).toMatchObject({
        status: "success",
        result: { status: "authorization_required", serverName: "Linear" },
      });
      expect(mockDirectoryConnect).not.toHaveBeenCalled();
    });

    it("an UNKNOWN authless flag is treated as expecting auth", async () => {
      // Same posture the connect mutation takes: absent means expect auth.
      mockDirectoryReturn = directoryHookReturn({
        items: [createDirectoryServer({ isAuthless: undefined })],
      });
      renderWithCards([toCatalogCard([createMockServer()])]);

      const response = await dispatch({
        type: "connectRegistryServer",
        payload: { serverName: "Linear" },
      });

      expect(response).toMatchObject({
        result: { status: "authorization_required" },
      });
    });

    it("a local extension is reported as not connectable", async () => {
      mockDirectoryReturn = directoryHookReturn({
        items: [
          createDirectoryServer({
            displayName: "PDF Tools",
            rowType: "local",
            endpointKind: "none",
            remoteUrl: undefined,
          }),
        ],
      });
      renderWithCards([toCatalogCard([createMockServer()])]);

      const response = await dispatch({
        type: "connectRegistryServer",
        payload: { serverName: "PDF Tools" },
      });

      expect(response).toMatchObject({
        result: { status: "not_connectable", serverName: "PDF Tools" },
      });
    });

    it("directory resolution is exact and case-insensitive, never fuzzy", async () => {
      mockDirectoryReturn = directoryHookReturn({
        items: [createDirectoryServer({ isAuthless: true })],
      });
      renderWithCards([toCatalogCard([createMockServer()])]);

      const byCatalogName = await dispatch({
        type: "connectRegistryServer",
        payload: { serverName: "COM.MCPJAM/ANTHROPIC-LINEAR-1A2B3C4D" },
      });
      expect(byCatalogName).toMatchObject({
        result: { status: "connecting", serverName: "Linear" },
      });

      const prefix = await dispatch({
        type: "connectRegistryServer",
        payload: { serverName: "Line" },
      });
      expect(prefix).toMatchObject({ status: "error" });
    });

    it("searchRegistryDirectory drives the screen's own search box", async () => {
      mockDirectoryReturn = directoryHookReturn({
        items: [createDirectoryServer()],
      });
      renderWithCards([toCatalogCard([createMockServer()])]);

      const response = await dispatch({
        type: "searchRegistryDirectory",
        payload: { query: "invoice", tier: "partner" },
      });

      expect(response).toMatchObject({
        status: "success",
        result: { status: "searching", query: "invoice", tier: "partner" },
      });
      expect(mockSetQuery).toHaveBeenCalledWith("invoice");
      expect(mockSetTier).toHaveBeenCalledWith("partner");
    });

    it("searchRegistryDirectory switches source, and the tier survives it", async () => {
      // Switching TO a tier-publishing source with a tier in the same call is
      // where the ordering is load-bearing: `setSource` runs first, and
      // reversing the two statements would let the switch wipe the tier that
      // arrived with it.
      mockDirectoryReturn = directoryHookReturn({
        items: [createDirectoryServer()],
        source: "chatgpt-directory",
        hasTiers: false,
      });
      renderWithCards([toCatalogCard([createMockServer()])]);

      const response = await dispatch({
        type: "searchRegistryDirectory",
        payload: {
          query: "invoice",
          source: "anthropic-directory",
          tier: "partner",
        },
      });

      expect(response).toMatchObject({
        status: "success",
        result: {
          status: "searching",
          source: "anthropic-directory",
          tier: "partner",
        },
      });
      expect(mockSetSource).toHaveBeenCalledWith("anthropic-directory");
      expect(mockSetTier).toHaveBeenCalledWith("partner");
      expect(mockSetSource.mock.invocationCallOrder[0]).toBeLessThan(
        mockSetTier.mock.invocationCallOrder[0]
      );
    });

    it("searchRegistryDirectory reports the tier that will actually be in force", async () => {
      // Switching to a tier-less source clears the tier the screen was
      // showing. Echoing `directory.tier` here would report a filter that had
      // just been dropped — this render's closure still holds the old value —
      // and the model would tell the user it had narrowed a view it had not.
      mockDirectoryReturn = directoryHookReturn({
        items: [createDirectoryServer()],
        tier: "partner",
      });
      renderWithCards([toCatalogCard([createMockServer()])]);

      const response = await dispatch({
        type: "searchRegistryDirectory",
        payload: { source: "chatgpt-directory" },
      });

      expect(response).toMatchObject({
        status: "success",
        result: {
          status: "searching",
          source: "chatgpt-directory",
          tier: "all",
        },
      });
    });

    it("searchRegistryDirectory ignores a tier the target source cannot use", async () => {
      // Applying it would park an inert value in state that springs back the
      // moment the user returns to a source that DOES publish tiers, silently
      // narrowing a view they never filtered.
      mockDirectoryReturn = directoryHookReturn({
        items: [createDirectoryServer()],
      });
      renderWithCards([toCatalogCard([createMockServer()])]);

      const response = await dispatch({
        type: "searchRegistryDirectory",
        payload: { source: "chatgpt-directory", tier: "partner" },
      });

      expect(mockSetSource).toHaveBeenCalledWith("chatgpt-directory");
      expect(mockSetTier).not.toHaveBeenCalled();
      expect(response).toMatchObject({
        result: { source: "chatgpt-directory", tier: "all" },
      });
    });

    it("searchRegistryDirectory rejects an unknown source", async () => {
      mockDirectoryReturn = directoryHookReturn({
        items: [createDirectoryServer()],
      });
      renderWithCards([toCatalogCard([createMockServer()])]);

      const response = await dispatch({
        type: "searchRegistryDirectory",
        payload: { source: "bing-directory" },
      });
      expect(response).toMatchObject({ status: "error" });
      expect(mockSetSource).not.toHaveBeenCalled();
    });

    it("leaves the source alone when the model does not name one", async () => {
      mockDirectoryReturn = directoryHookReturn({
        items: [createDirectoryServer()],
      });
      renderWithCards([toCatalogCard([createMockServer()])]);

      await dispatch({
        type: "searchRegistryDirectory",
        payload: { query: "invoice" },
      });
      expect(mockSetSource).not.toHaveBeenCalled();
    });

    it("searchRegistryDirectory with no query clears the box (browse)", async () => {
      mockDirectoryReturn = directoryHookReturn({
        items: [createDirectoryServer()],
        query: "stale",
      });
      renderWithCards([toCatalogCard([createMockServer()])]);

      await dispatch({ type: "searchRegistryDirectory", payload: {} });
      expect(mockSetQuery).toHaveBeenCalledWith("");
    });

    it("searchRegistryDirectory rejects an unknown tier", async () => {
      mockDirectoryReturn = directoryHookReturn({
        items: [createDirectoryServer()],
      });
      renderWithCards([toCatalogCard([createMockServer()])]);

      const response = await dispatch({
        type: "searchRegistryDirectory",
        payload: { tier: "platinum" },
      });
      expect(response).toMatchObject({ status: "error" });
      expect(mockSetTier).not.toHaveBeenCalled();
    });

    it("snapshot carries a bounded, URL-free directory block", async () => {
      mockDirectoryReturn = directoryHookReturn({
        items: Array.from({ length: 20 }, (_, i) =>
          createDirectoryServer({
            _id: `cat_${i}`,
            displayName: `Directory ${i}`,
            serverName: `com.mcpjam/anthropic-d${i}-0000000${i}`,
            remoteUrl: `https://mcp.directory-${i}.example/mcp`,
          })
        ),
        query: "dir",
        tier: "community",
        canLoadMore: true,
      });
      renderWithCards([]);

      const snapshot = (await readSurfaceSnapshot("registry")) as {
        ok: boolean;
        data: {
          directory: {
            query: string;
            tier: string;
            loadedCount: number;
            hasMore: boolean;
            visible: Array<Record<string, unknown>>;
          };
        };
      };

      expect(snapshot.data.directory).toMatchObject({
        query: "dir",
        tier: "community",
        loadedCount: 20,
        hasMore: true,
      });
      expect(snapshot.data.directory.visible).toHaveLength(15);
      expect(snapshot.data.directory.visible[0]).toMatchObject({
        name: "Directory 0",
        tier: "partner",
        status: "not_connected",
        requiresEndpointChoice: false,
      });
      // Same redaction rule as the curated half: no endpoint ever.
      expect(JSON.stringify(snapshot)).not.toContain("https://");
    });
  });
});
