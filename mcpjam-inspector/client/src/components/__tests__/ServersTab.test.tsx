import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { useState, type ReactNode } from "react";
import { getDefaultClientCapabilities } from "@mcpjam/sdk/browser";
import type { ServerWithName, ServerUpdateResult } from "@/hooks/use-app-state";
import type { Workspace } from "@/state/app-types";
import type { ServerFormData } from "@/shared/types.js";
import { mergeWorkspaceClientCapabilities } from "@/lib/client-config";
import {
  captureServerDetailModalOAuthResume,
  writeOpenServerDetailModalState,
} from "@/lib/server-detail-modal-resume";
import { writePendingQuickConnect } from "@/lib/quick-connect-pending";
import type { EnrichedRegistryCatalogCard } from "@/hooks/useRegistryServers";
import { getRegistryServerName } from "@/hooks/useRegistryServers";

function createLinearCatalogCard(): EnrichedRegistryCatalogCard {
  const server = {
    _id: "linear-1",
    name: "app.linear.mcp",
    displayName: "Linear",
    description: "Interact with Linear issues.",
    publisher: "MCPJam",
    publishStatus: "verified" as const,
    scope: "global" as const,
    transport: {
      transportType: "http" as const,
      url: "https://mcp.linear.app/mcp",
      useOAuth: true,
      oauthScopes: ["read", "write"],
    },
    status: "approved" as const,
    createdBy: "u",
    createdAt: 0,
    updatedAt: 0,
    connectionStatus: "not_connected" as const,
  };
  return {
    registryCardKey: "card-linear",
    catalogSortOrder: 1,
    variants: [server],
    starCount: 42,
    isStarred: false,
    hasDualType: false,
  };
}

function createNotionCatalogCard(): EnrichedRegistryCatalogCard {
  const server = {
    _id: "notion-1",
    name: "com.notion.mcp",
    displayName: "Notion",
    description: "Access Notion pages.",
    publisher: "MCPJam",
    publishStatus: "verified" as const,
    scope: "global" as const,
    transport: {
      transportType: "http" as const,
      url: "https://mcp.notion.com/mcp",
      useOAuth: true,
    },
    status: "approved" as const,
    createdBy: "u",
    createdAt: 0,
    updatedAt: 0,
    connectionStatus: "not_connected" as const,
  };
  return {
    registryCardKey: "card-notion",
    catalogSortOrder: 2,
    variants: [server],
    starCount: 5,
    isStarred: false,
    hasDualType: false,
  };
}

function createDualTypeCatalogCard(): EnrichedRegistryCatalogCard {
  const shared = {
    name: "app.dual.mcp",
    displayName: "DualServer",
    description: "Dual-type MCP.",
    publisher: "Acme",
    publishStatus: "verified" as const,
    scope: "global" as const,
    status: "approved" as const,
    createdBy: "u",
    createdAt: 0,
    updatedAt: 0,
    connectionStatus: "not_connected" as const,
  };
  const app = {
    ...shared,
    _id: "dual-app",
    clientType: "app" as const,
    transport: {
      transportType: "http" as const,
      url: "https://example.com/app",
      useOAuth: true,
    },
  };
  const text = {
    ...shared,
    _id: "dual-text",
    clientType: "text" as const,
    transport: {
      transportType: "http" as const,
      url: "https://example.com/text",
      useOAuth: true,
    },
  };
  return {
    registryCardKey: "card-dual",
    catalogSortOrder: 1,
    variants: [app, text],
    starCount: 10,
    isStarred: false,
    hasDualType: true,
  };
}

let mockIsAuthenticated = false;
let mockCatalogCards: EnrichedRegistryCatalogCard[] = [];
let mockRegistryLoading = false;
const mockConnectRegistry = vi.fn();
const mockUseRegistryServers = vi.fn();

vi.mock("posthog-js/react", () => ({
  usePostHog: () => ({
    capture: vi.fn(),
  }),
  useFeatureFlagEnabled: () => false,
}));

vi.mock("convex/react", () => ({
  useConvexAuth: () => ({
    isAuthenticated: mockIsAuthenticated,
  }),
  useQuery: () => undefined,
  useMutation: () => vi.fn(),
}));

vi.mock("@/hooks/useRegistryServers", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/hooks/useRegistryServers")>();
  return {
    ...actual,
    useRegistryServers: (args: unknown) => {
      mockUseRegistryServers(args);
      return {
        catalogCards: mockCatalogCards,
        isLoading: mockRegistryLoading,
        connect: mockConnectRegistry,
      };
    },
  };
});

vi.mock("@workos-inc/authkit-react", () => ({
  useAuth: () => ({
    getAccessToken: vi.fn().mockResolvedValue("mock-access-token"),
    user: null,
  }),
}));

vi.mock("@/hooks/use-ai-provider-keys", () => ({
  useAiProviderKeys: () => ({
    getToken: vi.fn().mockReturnValue("mock-api-key"),
    hasToken: vi.fn().mockReturnValue(true),
  }),
}));

vi.mock("@/hooks/use-json-rpc-panel", () => ({
  useJsonRpcPanelVisibility: () => ({
    isVisible: false,
    toggle: vi.fn(),
  }),
}));

vi.mock("@/hooks/useWorkspaces", () => ({
  useWorkspaceServers: () => ({
    serversRecord: {},
  }),
  useWorkspaceQueries: () => ({
    allWorkspaces: undefined,
    workspaces: [],
    sortedWorkspaces: [],
    isLoading: false,
    hasWorkspaces: false,
  }),
}));

vi.mock("../connection/ServerConnectionCard", () => ({
  ServerConnectionCard: ({
    server,
    needsReconnect,
    onOpenDetailModal,
  }: {
    server: ServerWithName;
    needsReconnect?: boolean;
    onOpenDetailModal?: (server: ServerWithName, defaultTab: string) => void;
  }) => (
    <div>
      <button onClick={() => onOpenDetailModal?.(server, "configuration")}>
        Open {server.name}
      </button>
      {needsReconnect ? <span>Needs reconnect</span> : null}
      <div data-testid={`server-card-${server.name}`}>
        {server.name}:{server.connectionStatus}
      </div>
    </div>
  ),
}));

vi.mock("../connection/ServerDetailModal", () => ({
  ServerDetailModal: ({
    isOpen,
    server,
    defaultTab,
    onSubmit,
    onClose,
  }: {
    isOpen: boolean;
    server: ServerWithName;
    defaultTab: string;
    onSubmit: (
      formData: ServerFormData,
      originalServerName: string,
    ) => Promise<ServerUpdateResult>;
    onClose: () => void;
  }) =>
    isOpen ? (
      <div role="dialog">
        <div data-testid="modal-server-name">{server.name}</div>
        <div data-testid="modal-connection-status">
          {server.connectionStatus}
        </div>
        <div data-testid="modal-default-tab">{defaultTab}</div>
        <button
          onClick={() =>
            void onSubmit(
              {
                name: server.name,
                type: "stdio",
                command: "npx",
                args: ["-y", "@modelcontextprotocol/server-test"],
              },
              server.name,
            )
          }
        >
          Save Same
        </button>
        <button
          onClick={() =>
            void onSubmit(
              {
                name: "renamed-server",
                type: "stdio",
                command: "npx",
                args: ["-y", "@modelcontextprotocol/server-test"],
              },
              server.name,
            )
          }
        >
          Save Rename
        </button>
        <button onClick={onClose}>Close Modal</button>
      </div>
    ) : null,
}));

vi.mock("../connection/AddServerModal", () => ({
  AddServerModal: () => null,
}));

vi.mock("../connection/JsonImportModal", () => ({
  JsonImportModal: () => null,
}));

vi.mock("../connection/WorkspaceSelector", () => ({
  WorkspaceSelector: () => <div>Workspace Selector</div>,
}));

vi.mock("../workspace/WorkspaceShareButton", () => ({
  WorkspaceShareButton: () => null,
}));

vi.mock("../workspace/WorkspaceMembersFacepile", () => ({
  WorkspaceMembersFacepile: () => null,
}));

vi.mock("../logger-view", () => ({
  LoggerView: () => null,
}));

vi.mock("../ui/resizable", () => ({
  ResizablePanelGroup: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  ResizablePanel: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  ResizableHandle: () => null,
}));

vi.mock("../ui/collapsed-panel-strip", () => ({
  CollapsedPanelStrip: () => null,
}));

vi.mock("../ui/skeleton", () => ({
  Skeleton: () => <div>Skeleton</div>,
}));

vi.mock("@dnd-kit/core", () => ({
  DndContext: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  closestCenter: vi.fn(),
  PointerSensor: class PointerSensor {},
  useSensor: vi.fn().mockReturnValue({}),
  useSensors: vi.fn().mockReturnValue([]),
  DragOverlay: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

vi.mock("@dnd-kit/sortable", () => ({
  arrayMove: (items: string[]) => items,
  SortableContext: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  useSortable: () => ({
    listeners: {},
    setNodeRef: vi.fn(),
    transform: null,
    transition: undefined,
    isDragging: false,
  }),
  rectSortingStrategy: {},
}));

vi.mock("@dnd-kit/utilities", () => ({
  CSS: {
    Translate: {
      toString: () => "",
    },
  },
}));

import { ServersTab } from "../ServersTab";

function createServer(overrides: Partial<ServerWithName> = {}): ServerWithName {
  return {
    name: "test-server",
    config: {
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-test"],
    },
    lastConnectionTime: new Date(),
    connectionStatus: "connected",
    retryCount: 0,
    enabled: true,
    useOAuth: false,
    ...overrides,
  };
}

function createWorkspace(servers: Record<string, ServerWithName>): Workspace {
  return {
    id: "workspace-1",
    name: "Workspace",
    servers,
    createdAt: new Date(),
    updatedAt: new Date(),
    isDefault: true,
  };
}

describe("ServersTab shared detail modal", () => {
  const server = createServer();
  const workspaceServers = { [server.name]: server };
  const workspaces = {
    "workspace-1": createWorkspace(workspaceServers),
  };

  const defaultProps = {
    workspaceServers,
    onConnect: vi.fn(),
    onDisconnect: vi.fn(),
    onReconnect: vi.fn().mockResolvedValue(undefined),
    onUpdate: vi.fn().mockResolvedValue({
      ok: true,
      serverName: "test-server",
    }),
    onRemove: vi.fn(),
    workspaces,
    activeWorkspaceId: "workspace-1",
    onSwitchWorkspace: vi.fn(),
    onCreateWorkspace: vi.fn().mockResolvedValue("workspace-2"),
    onUpdateWorkspace: vi.fn(),
    onDeleteWorkspace: vi.fn(),
    isLoadingWorkspaces: false,
    onWorkspaceShared: vi.fn(),
    onLeaveWorkspace: vi.fn(),
    isRegistryEnabled: true,
    onNavigateToRegistry: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    mockIsAuthenticated = false;
    mockCatalogCards = [];
    mockRegistryLoading = false;
    mockConnectRegistry.mockReset();
    mockConnectRegistry.mockImplementation(async (server) => {
      defaultProps.onConnect({
        name: getRegistryServerName(server),
        type: server.transport.transportType,
        url: server.transport.url,
        useOAuth: server.transport.useOAuth,
        oauthScopes: server.transport.oauthScopes,
        oauthCredentialKey: server.transport.oauthCredentialKey,
        registryServerId: server._id,
      });
    });
  });

  it("opens the shared modal from a server card on configuration", () => {
    render(<ServersTab {...defaultProps} />);

    fireEvent.click(screen.getByText("Open test-server"));

    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByTestId("modal-server-name")).toHaveTextContent(
      "test-server",
    );
    expect(screen.getByTestId("modal-default-tab")).toHaveTextContent(
      "configuration",
    );
  });

  it("keeps the shared modal open after saving without a rename", async () => {
    render(<ServersTab {...defaultProps} />);

    fireEvent.click(screen.getByText("Open test-server"));
    fireEvent.click(screen.getByText("Save Same"));

    await waitFor(() => {
      expect(defaultProps.onUpdate).toHaveBeenCalledWith(
        "test-server",
        expect.objectContaining({ name: "test-server" }),
      );
    });
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByTestId("modal-server-name")).toHaveTextContent(
      "test-server",
    );
  });

  it("keeps the shared modal open with the latest connection state after save churn", async () => {
    function TestHarness() {
      const [servers, setServers] = useState(workspaceServers);

      const onUpdate = vi.fn().mockImplementation(async () => {
        setServers({
          "test-server": createServer({
            connectionStatus: "connecting",
          }),
        });
        await Promise.resolve();
        setServers({});

        return {
          ok: true,
          serverName: "test-server",
        } satisfies ServerUpdateResult;
      });

      return (
        <ServersTab
          {...defaultProps}
          workspaceServers={servers}
          workspaces={{
            "workspace-1": createWorkspace(servers),
          }}
          onUpdate={onUpdate}
        />
      );
    }

    render(<TestHarness />);

    fireEvent.click(screen.getByText("Open test-server"));
    fireEvent.click(screen.getByText("Save Same"));

    await waitFor(() => {
      expect(screen.getByRole("dialog")).toBeInTheDocument();
      expect(screen.getByTestId("modal-connection-status")).toHaveTextContent(
        "connecting",
      );
    });
  });

  it("keeps the shared modal open and retargets it after a rename", async () => {
    const onUpdate = vi.fn().mockResolvedValue({
      ok: true,
      serverName: "renamed-server",
    });

    render(<ServersTab {...defaultProps} onUpdate={onUpdate} />);

    fireEvent.click(screen.getByText("Open test-server"));
    fireEvent.click(screen.getByText("Save Rename"));

    await waitFor(() => {
      expect(onUpdate).toHaveBeenCalledWith(
        "test-server",
        expect.objectContaining({ name: "renamed-server" }),
      );
    });
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByTestId("modal-server-name")).toHaveTextContent(
      "renamed-server",
    );
  });

  it("reopens the shared modal on configuration after returning from OAuth", async () => {
    writeOpenServerDetailModalState("test-server");
    captureServerDetailModalOAuthResume("test-server");

    render(<ServersTab {...defaultProps} />);

    await waitFor(() => {
      expect(screen.getByRole("dialog")).toBeInTheDocument();
      expect(screen.getByTestId("modal-server-name")).toHaveTextContent(
        "test-server",
      );
      expect(screen.getByTestId("modal-default-tab")).toHaveTextContent(
        "configuration",
      );
    });
    expect(
      localStorage.getItem("mcp-server-detail-modal-oauth-resume"),
    ).toBeNull();
  });

  it("closes the shared modal only through explicit close actions", () => {
    render(<ServersTab {...defaultProps} />);

    fireEvent.click(screen.getByText("Open test-server"));
    fireEvent.click(screen.getByText("Close Modal"));

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("surfaces reconnect warnings when workspace client capabilities changed", () => {
    const initializedCapabilities = getDefaultClientCapabilities() as Record<
      string,
      unknown
    >;

    const { rerender } = render(
      <ServersTab
        {...defaultProps}
        workspaceServers={{
          "test-server": createServer({
            initializationInfo: {
              clientCapabilities: initializedCapabilities,
            } as any,
          }),
        }}
        workspaces={{
          "workspace-1": createWorkspace({
            "test-server": createServer({
              initializationInfo: {
                clientCapabilities: initializedCapabilities,
              } as any,
            }),
          }),
        }}
      />,
    );

    expect(screen.queryByText("Needs reconnect")).not.toBeInTheDocument();

    rerender(
      <ServersTab
        {...defaultProps}
        workspaceServers={{
          "test-server": createServer({
            initializationInfo: {
              clientCapabilities: initializedCapabilities,
            } as any,
          }),
        }}
        workspaces={{
          "workspace-1": {
            ...createWorkspace({
              "test-server": createServer({
                initializationInfo: {
                  clientCapabilities: initializedCapabilities,
                } as any,
              }),
            }),
            clientConfig: {
              version: 1,
              clientCapabilities: {
                elicitation: {},
                experimental: {
                  inspectorProfile: true,
                },
              },
              hostContext: {},
            },
          },
        }}
      />,
    );

    expect(screen.getByText("Needs reconnect")).toBeInTheDocument();
  });

  it("does not surface reconnect warnings when server capability overrides already match initialize payload", () => {
    const serverCapabilities = {
      experimental: {
        serverOverride: { enabled: true },
      },
    };
    const initializedCapabilities = mergeWorkspaceClientCapabilities(
      getDefaultClientCapabilities() as Record<string, unknown>,
      serverCapabilities,
    );

    render(
      <ServersTab
        {...defaultProps}
        workspaceServers={{
          "test-server": createServer({
            config: {
              command: "npx",
              args: ["-y", "@modelcontextprotocol/server-test"],
              capabilities: serverCapabilities,
            },
            initializationInfo: {
              clientCapabilities: initializedCapabilities,
            } as any,
          }),
        }}
        workspaces={{
          "workspace-1": createWorkspace({
            "test-server": createServer({
              config: {
                command: "npx",
                args: ["-y", "@modelcontextprotocol/server-test"],
                capabilities: serverCapabilities,
              },
              initializationInfo: {
                clientCapabilities: initializedCapabilities,
              } as any,
            }),
          }),
        }}
      />,
    );

    expect(screen.queryByText("Needs reconnect")).not.toBeInTheDocument();
  });

  it("renders Quick Connect module helper copy and Browse Registry in the section header", () => {
    mockIsAuthenticated = true;
    mockCatalogCards = [createLinearCatalogCard()];

    render(<ServersTab {...defaultProps} workspaceServers={{}} />);

    expect(screen.getByText("Quick Connect")).toBeInTheDocument();
    expect(
      screen.getByTestId("servers-quick-connect-browse-registry"),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("servers-quick-connect-mini-card"),
    ).toBeInTheDocument();
  });

  it("keeps quick connect visible after clicking a quick connect server", () => {
    mockIsAuthenticated = true;
    mockCatalogCards = [createLinearCatalogCard()];

    render(<ServersTab {...defaultProps} workspaceServers={{}} />);

    fireEvent.click(screen.getByRole("button", { name: "Connect Linear" }));

    expect(defaultProps.onConnect).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "Linear",
        type: "http",
        url: "https://mcp.linear.app/mcp",
        useOAuth: true,
        registryServerId: "linear-1",
      }),
    );
    expect(screen.getByText("Quick Connect")).toBeInTheDocument();
    expect(screen.getByText("Connecting Linear...")).toBeInTheDocument();
    expect(screen.getAllByText("Authorizing...").length).toBeGreaterThanOrEqual(
      1,
    );
    expect(
      screen.getByRole("button", { name: "Connect Linear" }),
    ).toBeDisabled();
  });

  it("keeps quick connect visible during oauth-flow after return", () => {
    mockIsAuthenticated = true;
    mockCatalogCards = [createLinearCatalogCard()];
    writePendingQuickConnect({
      serverName: "Linear",
      registryServerId: "linear-1",
      displayName: "Linear",
      sourceTab: "servers",
      createdAt: 123,
    });

    render(
      <ServersTab
        {...defaultProps}
        workspaceServers={{
          Linear: createServer({
            name: "Linear",
            connectionStatus: "oauth-flow",
            useOAuth: true,
          }),
        }}
        workspaces={{
          "workspace-1": createWorkspace({
            Linear: createServer({
              name: "Linear",
              connectionStatus: "oauth-flow",
              useOAuth: true,
            }),
          }),
        }}
      />,
    );

    expect(screen.getByText("Quick Connect")).toBeInTheDocument();
    expect(screen.getByText("Connecting Linear...")).toBeInTheDocument();
    expect(screen.getAllByText("Authorizing...").length).toBeGreaterThanOrEqual(
      1,
    );
    expect(screen.getByTestId("server-card-Linear")).toHaveTextContent(
      "Linear:oauth-flow",
    );
  });

  it("shows finishing setup copy while the pending quick connect is connecting", () => {
    mockIsAuthenticated = true;
    mockCatalogCards = [createLinearCatalogCard()];
    writePendingQuickConnect({
      serverName: "Linear",
      registryServerId: "linear-1",
      displayName: "Linear",
      sourceTab: "servers",
      createdAt: 123,
    });

    render(
      <ServersTab
        {...defaultProps}
        workspaceServers={{
          Linear: createServer({
            name: "Linear",
            connectionStatus: "connecting",
            useOAuth: true,
          }),
        }}
        workspaces={{
          "workspace-1": createWorkspace({
            Linear: createServer({
              name: "Linear",
              connectionStatus: "connecting",
              useOAuth: true,
            }),
          }),
        }}
      />,
    );

    expect(
      screen.getAllByText("Finishing setup...").length,
    ).toBeGreaterThanOrEqual(1);
    expect(screen.getByTestId("server-card-Linear")).toHaveTextContent(
      "Linear:connecting",
    );
  });

  it("clears pending quick connect UI once the server is fully connected", () => {
    mockIsAuthenticated = true;
    mockCatalogCards = [createLinearCatalogCard(), createNotionCatalogCard()];
    writePendingQuickConnect({
      serverName: "Linear",
      registryServerId: "linear-1",
      displayName: "Linear",
      sourceTab: "servers",
      createdAt: 123,
    });

    render(
      <ServersTab
        {...defaultProps}
        workspaceServers={{
          Linear: createServer({
            name: "Linear",
            connectionStatus: "connected",
            useOAuth: true,
          }),
        }}
        workspaces={{
          "workspace-1": createWorkspace({
            Linear: createServer({
              name: "Linear",
              connectionStatus: "connected",
              useOAuth: true,
            }),
          }),
        }}
      />,
    );

    expect(screen.queryByText("Connecting Linear...")).not.toBeInTheDocument();
    expect(screen.getByText("Quick Connect")).toBeInTheDocument();
    const mini = screen.getAllByTestId("servers-quick-connect-mini-card");
    expect(mini).toHaveLength(1);
    expect(mini[0]).toHaveTextContent("Notion");
    expect(localStorage.getItem("mcp-quick-connect-pending")).toBeNull();
  });

  it("shows full quick connect with one or two servers and a minimized strip with three or more", () => {
    mockIsAuthenticated = true;
    mockCatalogCards = [createLinearCatalogCard()];

    const s1 = createServer({ name: "a" });
    const s2 = createServer({ name: "b" });
    const three = { a: s1, b: s2, c: createServer({ name: "c" }) };

    const { rerender } = render(
      <ServersTab
        {...defaultProps}
        workspaceServers={{ a: s1 }}
        workspaces={{
          "workspace-1": createWorkspace({ a: s1 }),
        }}
      />,
    );
    expect(
      screen.getByTestId("servers-quick-connect-section"),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("servers-quick-connect-section"),
    ).not.toHaveAttribute("data-minimized", "true");
    expect(
      screen.getByTestId("servers-quick-connect-mini-card"),
    ).toBeInTheDocument();

    rerender(
      <ServersTab
        {...defaultProps}
        workspaceServers={{ a: s1, b: s2 }}
        workspaces={{
          "workspace-1": createWorkspace({ a: s1, b: s2 }),
        }}
      />,
    );
    expect(
      screen.getByTestId("servers-quick-connect-section"),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("servers-quick-connect-section"),
    ).not.toHaveAttribute("data-minimized", "true");
    expect(
      screen.getByTestId("servers-quick-connect-mini-card"),
    ).toBeInTheDocument();

    rerender(
      <ServersTab
        {...defaultProps}
        workspaceServers={three}
        workspaces={{
          "workspace-1": createWorkspace(three),
        }}
      />,
    );
    const minimized = screen.getByTestId("servers-quick-connect-section");
    expect(minimized).toBeInTheDocument();
    expect(minimized).toHaveAttribute("data-minimized", "true");
    expect(
      screen.getByTestId("servers-quick-connect-mini-cards-toggle"),
    ).toHaveTextContent(/Show \(1\)/);
    expect(
      screen.queryByTestId("servers-tab-browse-registry-header-fallback"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTestId("servers-quick-connect-mini-card"),
    ).not.toBeInTheDocument();
    fireEvent.click(
      screen.getByTestId("servers-quick-connect-mini-cards-toggle"),
    );
    expect(
      screen.getByTestId("servers-quick-connect-mini-card"),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("servers-quick-connect-mini-cards-toggle"),
    ).toHaveTextContent(/Hide \(1\)/);
  });

  it("keeps quick connect visible with three or more servers while a quick connect is pending", () => {
    mockIsAuthenticated = true;
    mockCatalogCards = [createLinearCatalogCard()];
    writePendingQuickConnect({
      serverName: "Linear",
      registryServerId: "linear-1",
      displayName: "Linear",
      sourceTab: "servers",
      createdAt: 123,
    });

    const s1 = createServer({ name: "a" });
    const s2 = createServer({ name: "b" });
    const s3 = createServer({ name: "c" });
    const three = { a: s1, b: s2, c: s3 };

    render(
      <ServersTab
        {...defaultProps}
        workspaceServers={{
          ...three,
          Linear: createServer({
            name: "Linear",
            connectionStatus: "oauth-flow",
            useOAuth: true,
          }),
        }}
        workspaces={{
          "workspace-1": createWorkspace({
            ...three,
            Linear: createServer({
              name: "Linear",
              connectionStatus: "oauth-flow",
              useOAuth: true,
            }),
          }),
        }}
      />,
    );

    expect(
      screen.getByTestId("servers-quick-connect-section"),
    ).toBeInTheDocument();
    expect(
      screen.queryByTestId("servers-tab-browse-registry-header-fallback"),
    ).not.toBeInTheDocument();
  });

  it("renders mini-card metadata and read-only star count on the Servers tab", () => {
    mockIsAuthenticated = true;
    mockCatalogCards = [createLinearCatalogCard()];

    render(<ServersTab {...defaultProps} workspaceServers={{}} />);

    expect(screen.getByText("Linear")).toBeInTheDocument();
    expect(screen.getByText("MCPJam")).toBeInTheDocument();
    expect(screen.getByLabelText("Verified publisher")).toBeInTheDocument();
    expect(screen.getByLabelText("42 stars")).toBeInTheDocument();
    expect(
      screen.getByText("Interact with Linear issues."),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /star this server/i }),
    ).not.toBeInTheDocument();
  });

  it("renders a compact connect dropdown for dual-type catalog cards", () => {
    mockIsAuthenticated = true;
    mockCatalogCards = [createDualTypeCatalogCard()];

    render(<ServersTab {...defaultProps} workspaceServers={{}} />);

    expect(screen.getByTestId("connect-dropdown-trigger")).toBeInTheDocument();
  });

  it("shows quick connect and browse registry for guests when catalog is available", () => {
    mockIsAuthenticated = false;
    mockCatalogCards = [createLinearCatalogCard()];

    const { rerender } = render(
      <ServersTab {...defaultProps} workspaceServers={{}} />,
    );
    expect(
      screen.getByTestId("servers-quick-connect-section"),
    ).toBeInTheDocument();

    const s1 = createServer({ name: "a" });
    const s2 = createServer({ name: "b" });
    const s3 = createServer({ name: "c" });
    const three = { a: s1, b: s2, c: s3 };

    rerender(
      <ServersTab
        {...defaultProps}
        workspaceServers={three}
        workspaces={{
          "workspace-1": createWorkspace(three),
        }}
      />,
    );

    const minimized = screen.getByTestId("servers-quick-connect-section");
    expect(minimized).toBeInTheDocument();
    expect(minimized).toHaveAttribute("data-minimized", "true");
    expect(
      screen.queryByTestId("servers-tab-browse-registry-header-fallback"),
    ).not.toBeInTheDocument();
  });

  it("hides quick connect and browse registry when the registry flag is disabled", () => {
    mockIsAuthenticated = true;
    mockCatalogCards = [createLinearCatalogCard()];

    render(
      <ServersTab
        {...defaultProps}
        isRegistryEnabled={false}
        onNavigateToRegistry={undefined}
        workspaceServers={{}}
      />,
    );

    expect(
      screen.queryByTestId("servers-quick-connect-section"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTestId("servers-tab-browse-registry-header-fallback"),
    ).not.toBeInTheDocument();
    expect(mockUseRegistryServers).toHaveBeenCalledWith(
      expect.objectContaining({
        enabled: false,
      }),
    );
  });

  it("passes the shared workspace id to registry queries instead of the local workspace key", () => {
    mockIsAuthenticated = true;
    mockCatalogCards = [createLinearCatalogCard()];

    render(
      <ServersTab
        {...defaultProps}
        workspaces={{
          "workspace-1": {
            ...createWorkspace(defaultProps.workspaceServers),
            sharedWorkspaceId: "ws_shared_123",
          },
        }}
      />,
    );

    expect(mockUseRegistryServers).toHaveBeenCalledWith(
      expect.objectContaining({
        enabled: true,
        workspaceId: "ws_shared_123",
      }),
    );
  });

  it("skips Convex workspace registry queries when the active workspace is local-only", () => {
    mockIsAuthenticated = true;
    mockCatalogCards = [createLinearCatalogCard()];

    render(
      <ServersTab
        {...defaultProps}
        workspaces={{
          "workspace-1": createWorkspace(defaultProps.workspaceServers),
        }}
      />,
    );

    expect(mockUseRegistryServers).toHaveBeenCalledWith(
      expect.objectContaining({
        enabled: true,
        workspaceId: null,
      }),
    );
  });

  it("excludes single-variant quick connect cards when that server is already in the workspace", () => {
    mockIsAuthenticated = true;
    mockCatalogCards = [createLinearCatalogCard()];

    render(
      <ServersTab
        {...defaultProps}
        workspaceServers={{
          Linear: createServer({ name: "Linear" }),
        }}
        workspaces={{
          "workspace-1": createWorkspace({
            Linear: createServer({ name: "Linear" }),
          }),
        }}
      />,
    );

    expect(
      screen.queryByTestId("servers-quick-connect-section"),
    ).not.toBeInTheDocument();
  });

  it("excludes a dual-type quick connect card when any variant is already in the workspace", () => {
    mockIsAuthenticated = true;
    mockCatalogCards = [createDualTypeCatalogCard()];

    render(
      <ServersTab
        {...defaultProps}
        workspaceServers={{
          "DualServer (App)": createServer({ name: "DualServer (App)" }),
        }}
        workspaces={{
          "workspace-1": createWorkspace({
            "DualServer (App)": createServer({ name: "DualServer (App)" }),
          }),
        }}
      />,
    );

    expect(
      screen.queryByTestId("servers-quick-connect-section"),
    ).not.toBeInTheDocument();
  });
});
