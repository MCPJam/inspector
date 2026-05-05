import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { useState, type ReactNode } from "react";
import { getDefaultClientCapabilities } from "@mcpjam/sdk/browser";
import type { ServerWithName, ServerUpdateResult } from "@/hooks/use-app-state";
import type { Project } from "@/state/app-types";
import type { ServerFormData } from "@/shared/types.js";
import { mergeProjectClientCapabilities } from "@/lib/client-config";
import {
  captureServerDetailModalOAuthResume,
  writeOpenServerDetailModalState,
} from "@/lib/server-detail-modal-resume";
import { writePendingQuickConnect } from "@/lib/quick-connect-pending";
import type { EnrichedRegistryCatalogCard } from "@/hooks/useRegistryServers";
import { getRegistryServerName } from "@/hooks/useRegistryServers";
import { useClientConfigStore } from "@/stores/client-config-store";

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
let mockJsonRpcPanelVisible = false;
const mockConnectRegistry = vi.fn();
const mockLoggerView = vi.fn();
const mockUseRegistryServers = vi.fn();
const mockUseProjectBillingGate = vi.fn();

vi.mock("posthog-js/react", () => ({
  usePostHog: () => ({
    capture: vi.fn(),
  }),
  useFeatureFlagEnabled: () => false,
}));

vi.mock("@/hooks/use-app-ready", () => ({
  useAppReady: () => ({ status: "ready", projectId: "ws_local" }),
  useAppReadyMessage: () => null,
}));

vi.mock("../client-config/ClientConfigTab", () => ({
  ClientConfigTab: ({ activeProjectId }: { activeProjectId: string }) => (
    <div data-testid="client-config-tab-stub">
      ClientConfigTab:{activeProjectId}
    </div>
  ),
}));

vi.mock("@/lib/billing-gates", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/billing-gates")>();
  return {
    ...actual,
    useProjectBillingGate: (...args: unknown[]) =>
      mockUseProjectBillingGate(...args),
  };
});

vi.mock("convex/react", () => ({
  useConvexAuth: () => ({
    isAuthenticated: mockIsAuthenticated,
  }),
  useQuery: () => undefined,
  useMutation: () => vi.fn(),
  useAction: () => vi.fn(),
}));

vi.mock("@/hooks/useRegistryServers", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("@/hooks/useRegistryServers")
  >();
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
    isVisible: mockJsonRpcPanelVisible,
    toggle: vi.fn(),
  }),
}));

vi.mock("@/hooks/useProjects", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/hooks/useProjects")>();
  return {
    ...actual,
    useProjectServers: () => ({
      serversRecord: {},
    }),
    useProjectQueries: () => ({
      allProjects: undefined,
      projects: [],
      sortedProjects: [],
      isLoading: false,
      hasProjects: false,
      hasAnyProjects: false,
    }),
  };
});

vi.mock("../connection/ServerConnectionCard", () => ({
  ServerConnectionCard: ({
    server,
    needsReconnect,
    onReconnect,
    onOpenDetailModal,
  }: {
    server: ServerWithName;
    needsReconnect?: boolean;
    onReconnect?: (
      serverName: string,
      options?: {
        forceOAuthFlow?: boolean;
        allowInteractiveOAuthFlow?: boolean;
      }
    ) => Promise<void>;
    onOpenDetailModal?: (server: ServerWithName, defaultTab: string) => void;
  }) => (
    <div>
      <button onClick={() => onOpenDetailModal?.(server, "configuration")}>
        Open {server.name}
      </button>
      <button onClick={() => void onReconnect?.(server.name)}>
        Reconnect {server.name}
      </button>
      {needsReconnect ? (
        <span aria-label="Connection settings changed" />
      ) : null}
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
      originalServerName: string
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
              server.name
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
              server.name
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

vi.mock("../connection/ProjectSelector", () => ({
  ProjectSelector: () => <div>Project Selector</div>,
}));

vi.mock("../project/ProjectShareButton", () => ({
  ProjectShareButton: () => null,
}));

vi.mock("../project/ProjectMembersFacepile", () => ({
  ProjectMembersFacepile: () => null,
}));

vi.mock("../logger-view", () => ({
  LoggerView: (props: {
    serverIds?: string[];
    sinceTimestamp?: number;
    onClose?: () => void;
  }) => {
    mockLoggerView(props);
    return <div data-testid="logger-view-stub" />;
  },
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

vi.mock("@mcpjam/design-system/skeleton", () => ({
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

function createProject(servers: Record<string, ServerWithName>): Project {
  return {
    id: "project-1",
    name: "Project",
    servers,
    createdAt: new Date(),
    updatedAt: new Date(),
    isDefault: true,
  };
}

describe("ServersTab shared detail modal", () => {
  const server = createServer();
  const projectServers = { [server.name]: server };
  const projects = {
    "project-1": createProject(projectServers),
  };

  const defaultProps = {
    projectServers,
    onConnect: vi.fn(),
    onDisconnect: vi.fn(),
    onReconnect: vi.fn().mockResolvedValue(undefined),
    onUpdate: vi.fn().mockResolvedValue({
      ok: true,
      serverName: "test-server",
    }),
    onRemove: vi.fn(),
    projects,
    activeProjectId: "project-1",
    organizationId: "org-1",
    isBillingContextPending: false,
    onSwitchProject: vi.fn(),
    onCreateProject: vi.fn().mockResolvedValue("project-2"),
    onUpdateProject: vi.fn(),
    onDeleteProject: vi.fn(),
    isLoadingProjects: false,
    onProjectShared: vi.fn(),
    onLeaveProject: vi.fn(),
    isRegistryEnabled: true,
    onNavigateToRegistry: vi.fn(),
    onSaveClientConfig: vi.fn().mockResolvedValue(undefined),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    sessionStorage.clear();
    useClientConfigStore.setState(
      useClientConfigStore.getInitialState(),
      true,
    );
    mockIsAuthenticated = false;
    mockCatalogCards = [];
    mockRegistryLoading = false;
    mockJsonRpcPanelVisible = false;
    mockLoggerView.mockReset();
    mockUseProjectBillingGate.mockImplementation(
      ({
        organizationId,
        gate,
      }: {
        organizationId: string | null;
        gate: unknown;
      }) => ({
        organizationId,
        gate,
        decision: null,
        currentPlan: "solo",
        upgradePlan: null,
        canManageBilling: true,
        isLoading: false,
        isDenied: false,
        denialMessage: null,
      })
    );
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
      "test-server"
    );
    expect(screen.getByTestId("modal-default-tab")).toHaveTextContent(
      "configuration"
    );
  });

  it("shows a full-tab loading state while billing context is pending", () => {
    render(<ServersTab {...defaultProps} isBillingContextPending={true} />);

    expect(
      screen.getByTestId("servers-billing-context-pending")
    ).toBeInTheDocument();
    expect(screen.queryByText("Add Server")).not.toBeInTheDocument();
    expect(mockUseProjectBillingGate).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: null,
        organizationId: null,
      })
    );
  });

  it("shows a no-project state when there is no selected project", () => {
    render(
      <ServersTab
        {...defaultProps}
        projects={{}}
        activeProjectId="none"
        projectServers={{}}
      />
    );

    expect(screen.getByTestId("servers-no-project")).toBeInTheDocument();
    expect(screen.queryByText("Add Your First Server")).not.toBeInTheDocument();
  });

  it("shows an existing pending dashboard OAuth server as connecting", () => {
    const pendingServer = createServer({
      name: "demo-server",
      connectionStatus: "disconnected",
      enabled: false,
    });

    render(
      <ServersTab
        {...defaultProps}
        projectServers={{ "demo-server": pendingServer }}
        projects={{
          "project-1": createProject({ "demo-server": pendingServer }),
        }}
        pendingDashboardOAuth={{
          serverName: "demo-server",
          serverUrl: "https://example.com/mcp",
          startedAt: Date.now(),
        }}
      />
    );

    expect(screen.getByTestId("server-card-demo-server")).toHaveTextContent(
      "demo-server:connecting"
    );
  });

  it("scopes the logger panel to the reconnect target server", async () => {
    mockJsonRpcPanelVisible = true;

    const linearServer = createServer({ name: "linear" });
    const asanaServer = createServer({ name: "asana" });
    const projectServers = {
      linear: linearServer,
      asana: asanaServer,
    };

    render(
      <ServersTab
        {...defaultProps}
        projectServers={projectServers}
        projects={{
          "project-1": createProject(projectServers),
        }}
      />
    );

    expect(mockLoggerView).toHaveBeenLastCalledWith(
      expect.objectContaining({
        serverIds: undefined,
      })
    );

    fireEvent.click(screen.getByText("Reconnect linear"));

    await waitFor(() => {
      expect(defaultProps.onReconnect).toHaveBeenCalledWith(
        "linear",
        undefined
      );
    });

    expect(mockLoggerView).toHaveBeenLastCalledWith(
      expect.objectContaining({
        serverIds: ["linear"],
        sinceTimestamp: expect.any(Number),
      })
    );
  });

  it("preserves explicit logger focus across remounts and does not widen it to other pending servers", async () => {
    mockJsonRpcPanelVisible = true;

    const linearServer = createServer({ name: "linear" });
    const asanaServer = createServer({ name: "asana" });
    const initialServers = {
      linear: linearServer,
      asana: asanaServer,
    };

    const firstRender = render(
      <ServersTab
        {...defaultProps}
        projectServers={initialServers}
        projects={{
          "project-1": createProject(initialServers),
        }}
      />
    );

    fireEvent.click(screen.getByText("Reconnect linear"));

    await waitFor(() => {
      expect(defaultProps.onReconnect).toHaveBeenCalledWith(
        "linear",
        undefined
      );
    });

    const focusedLoggerProps = mockLoggerView.mock.lastCall?.[0] as
      | {
          serverIds?: string[];
          sinceTimestamp?: number;
        }
      | undefined;
    expect(focusedLoggerProps?.serverIds).toEqual(["linear"]);
    expect(focusedLoggerProps?.sinceTimestamp).toEqual(expect.any(Number));

    firstRender.unmount();
    mockLoggerView.mockReset();

    const remountedServers = {
      linear: createServer({ name: "linear" }),
      asana: createServer({ name: "asana", connectionStatus: "connecting" }),
    };

    render(
      <ServersTab
        {...defaultProps}
        projectServers={remountedServers}
        projects={{
          "project-1": createProject(remountedServers),
        }}
      />
    );

    expect(mockLoggerView).toHaveBeenLastCalledWith(
      expect.objectContaining({
        serverIds: ["linear"],
        sinceTimestamp: focusedLoggerProps?.sinceTimestamp,
      })
    );
  });

  it("keeps persisted logger focus until the matching hosted project hydrates", async () => {
    mockJsonRpcPanelVisible = true;
    const persistedSinceTimestamp = Date.now();

    const asanaServer = createServer({ name: "asana" });
    const projectOne = createProject({ asana: asanaServer });
    const projectTwo = {
      ...createProject({ asana: asanaServer }),
      id: "project-2",
      name: "Hosted Project",
    };

    sessionStorage.setItem(
      "mcp-server-logger-focus",
      JSON.stringify({
        projectId: "project-2",
        serverName: "asana",
        sinceTimestamp: persistedSinceTimestamp,
      })
    );

    const { rerender } = render(
      <ServersTab
        {...defaultProps}
        activeProjectId="project-1"
        projectServers={{ asana: asanaServer }}
        projects={{
          "project-1": projectOne,
          "project-2": projectTwo,
        }}
      />
    );

    expect(sessionStorage.getItem("mcp-server-logger-focus")).toContain(
      "\"projectId\":\"project-2\""
    );

    rerender(
      <ServersTab
        {...defaultProps}
        activeProjectId="project-2"
        projectServers={{ asana: asanaServer }}
        projects={{
          "project-1": projectOne,
          "project-2": projectTwo,
        }}
      />
    );

    await waitFor(() => {
      expect(mockLoggerView).toHaveBeenLastCalledWith(
        expect.objectContaining({
          serverIds: ["asana"],
          sinceTimestamp: persistedSinceTimestamp,
        })
      );
    });
  });

  it("keeps the shared modal open after saving without a rename", async () => {
    render(<ServersTab {...defaultProps} />);

    fireEvent.click(screen.getByText("Open test-server"));
    fireEvent.click(screen.getByText("Save Same"));

    await waitFor(() => {
      expect(defaultProps.onUpdate).toHaveBeenCalledWith(
        "test-server",
        expect.objectContaining({ name: "test-server" })
      );
    });
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByTestId("modal-server-name")).toHaveTextContent(
      "test-server"
    );
  });

  it("keeps the shared modal open with the latest connection state after save churn", async () => {
    function TestHarness() {
      const [servers, setServers] = useState(projectServers);

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
          projectServers={servers}
          projects={{
            "project-1": createProject(servers),
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
        "connecting"
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
        expect.objectContaining({ name: "renamed-server" })
      );
    });
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByTestId("modal-server-name")).toHaveTextContent(
      "renamed-server"
    );
  });

  it("reopens the shared modal on configuration after returning from OAuth", async () => {
    writeOpenServerDetailModalState("test-server");
    captureServerDetailModalOAuthResume("test-server");

    render(<ServersTab {...defaultProps} />);

    await waitFor(() => {
      expect(screen.getByRole("dialog")).toBeInTheDocument();
      expect(screen.getByTestId("modal-server-name")).toHaveTextContent(
        "test-server"
      );
      expect(screen.getByTestId("modal-default-tab")).toHaveTextContent(
        "configuration"
      );
    });
    expect(
      localStorage.getItem("mcp-server-detail-modal-oauth-resume")
    ).toBeNull();
  });

  it("closes the shared modal only through explicit close actions", () => {
    render(<ServersTab {...defaultProps} />);

    fireEvent.click(screen.getByText("Open test-server"));
    fireEvent.click(screen.getByText("Close Modal"));

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("surfaces connection settings update indicators when project client capabilities changed", () => {
    const initializedCapabilities = getDefaultClientCapabilities() as Record<
      string,
      unknown
    >;

    const { rerender } = render(
      <ServersTab
        {...defaultProps}
        projectServers={{
          "test-server": createServer({
            initializationInfo: {
              clientCapabilities: initializedCapabilities,
            } as any,
          }),
        }}
        projects={{
          "project-1": createProject({
            "test-server": createServer({
              initializationInfo: {
                clientCapabilities: initializedCapabilities,
              } as any,
            }),
          }),
        }}
      />
    );

    expect(screen.queryByText("Needs reconnect")).not.toBeInTheDocument();
    expect(
      screen.queryByLabelText("Connection settings changed")
    ).not.toBeInTheDocument();

    rerender(
      <ServersTab
        {...defaultProps}
        projectServers={{
          "test-server": createServer({
            initializationInfo: {
              clientCapabilities: initializedCapabilities,
            } as any,
          }),
        }}
        projects={{
          "project-1": {
            ...createProject({
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
      />
    );

    expect(screen.queryByText("Needs reconnect")).not.toBeInTheDocument();
    expect(
      screen.getByLabelText("Connection settings changed")
    ).toBeInTheDocument();
  });

  it("does not surface connection settings update indicators when server capability overrides already match initialize payload", () => {
    const serverCapabilities = {
      experimental: {
        serverOverride: { enabled: true },
      },
    };
    const initializedCapabilities = mergeProjectClientCapabilities(
      getDefaultClientCapabilities() as Record<string, unknown>,
      serverCapabilities
    );

    render(
      <ServersTab
        {...defaultProps}
        projectServers={{
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
        projects={{
          "project-1": createProject({
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
      />
    );

    expect(screen.queryByText("Needs reconnect")).not.toBeInTheDocument();
    expect(
      screen.queryByLabelText("Connection settings changed")
    ).not.toBeInTheDocument();
  });

  it("renders Quick Connect module helper copy and Browse Registry in the section header", () => {
    mockIsAuthenticated = true;
    mockCatalogCards = [createLinearCatalogCard()];

    render(<ServersTab {...defaultProps} projectServers={{}} />);

    expect(screen.getByText("Quick Connect")).toBeInTheDocument();
    expect(
      screen.getByTestId("servers-quick-connect-browse-registry")
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("servers-quick-connect-mini-card")
    ).toBeInTheDocument();
  });

  it("keeps quick connect visible after clicking a quick connect server", () => {
    mockIsAuthenticated = true;
    mockCatalogCards = [createLinearCatalogCard()];

    render(<ServersTab {...defaultProps} projectServers={{}} />);

    fireEvent.click(screen.getByRole("button", { name: "Connect Linear" }));

    expect(defaultProps.onConnect).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "Linear",
        type: "http",
        url: "https://mcp.linear.app/mcp",
        useOAuth: true,
        registryServerId: "linear-1",
      })
    );
    expect(screen.getByText("Quick Connect")).toBeInTheDocument();
    expect(screen.getByText("Connecting Linear...")).toBeInTheDocument();
    expect(screen.getAllByText("Authorizing...").length).toBeGreaterThanOrEqual(
      1
    );
    expect(
      screen.getByRole("button", { name: "Connect Linear" })
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
        projectServers={{
          Linear: createServer({
            name: "Linear",
            connectionStatus: "oauth-flow",
            useOAuth: true,
          }),
        }}
        projects={{
          "project-1": createProject({
            Linear: createServer({
              name: "Linear",
              connectionStatus: "oauth-flow",
              useOAuth: true,
            }),
          }),
        }}
      />
    );

    expect(screen.getByText("Quick Connect")).toBeInTheDocument();
    expect(screen.getByText("Connecting Linear...")).toBeInTheDocument();
    expect(screen.getAllByText("Authorizing...").length).toBeGreaterThanOrEqual(
      1
    );
    expect(screen.getByTestId("server-card-Linear")).toHaveTextContent(
      "Linear:oauth-flow"
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
        projectServers={{
          Linear: createServer({
            name: "Linear",
            connectionStatus: "connecting",
            useOAuth: true,
          }),
        }}
        projects={{
          "project-1": createProject({
            Linear: createServer({
              name: "Linear",
              connectionStatus: "connecting",
              useOAuth: true,
            }),
          }),
        }}
      />
    );

    expect(
      screen.getAllByText("Finishing setup...").length
    ).toBeGreaterThanOrEqual(1);
    expect(screen.getByTestId("server-card-Linear")).toHaveTextContent(
      "Linear:connecting"
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
        projectServers={{
          Linear: createServer({
            name: "Linear",
            connectionStatus: "connected",
            useOAuth: true,
          }),
        }}
        projects={{
          "project-1": createProject({
            Linear: createServer({
              name: "Linear",
              connectionStatus: "connected",
              useOAuth: true,
            }),
          }),
        }}
      />
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
        projectServers={{ a: s1 }}
        projects={{
          "project-1": createProject({ a: s1 }),
        }}
      />
    );
    expect(
      screen.getByTestId("servers-quick-connect-section")
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("servers-quick-connect-section")
    ).not.toHaveAttribute("data-minimized", "true");
    expect(
      screen.getByTestId("servers-quick-connect-mini-card")
    ).toBeInTheDocument();

    rerender(
      <ServersTab
        {...defaultProps}
        projectServers={{ a: s1, b: s2 }}
        projects={{
          "project-1": createProject({ a: s1, b: s2 }),
        }}
      />
    );
    expect(
      screen.getByTestId("servers-quick-connect-section")
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("servers-quick-connect-section")
    ).not.toHaveAttribute("data-minimized", "true");
    expect(
      screen.getByTestId("servers-quick-connect-mini-card")
    ).toBeInTheDocument();

    rerender(
      <ServersTab
        {...defaultProps}
        projectServers={three}
        projects={{
          "project-1": createProject(three),
        }}
      />
    );
    const minimized = screen.getByTestId("servers-quick-connect-section");
    expect(minimized).toBeInTheDocument();
    expect(minimized).toHaveAttribute("data-minimized", "true");
    expect(
      screen.getByTestId("servers-quick-connect-mini-cards-toggle")
    ).toHaveTextContent(/Show \(1\)/);
    expect(
      screen.queryByTestId("servers-tab-browse-registry-header-fallback")
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTestId("servers-quick-connect-mini-card")
    ).not.toBeInTheDocument();
    fireEvent.click(
      screen.getByTestId("servers-quick-connect-mini-cards-toggle")
    );
    expect(
      screen.getByTestId("servers-quick-connect-mini-card")
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("servers-quick-connect-mini-cards-toggle")
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
        projectServers={{
          ...three,
          Linear: createServer({
            name: "Linear",
            connectionStatus: "oauth-flow",
            useOAuth: true,
          }),
        }}
        projects={{
          "project-1": createProject({
            ...three,
            Linear: createServer({
              name: "Linear",
              connectionStatus: "oauth-flow",
              useOAuth: true,
            }),
          }),
        }}
      />
    );

    expect(
      screen.getByTestId("servers-quick-connect-section")
    ).toBeInTheDocument();
    expect(
      screen.queryByTestId("servers-tab-browse-registry-header-fallback")
    ).not.toBeInTheDocument();
  });

  it("renders mini-card metadata and read-only star count on the Servers tab", () => {
    mockIsAuthenticated = true;
    mockCatalogCards = [createLinearCatalogCard()];

    render(<ServersTab {...defaultProps} projectServers={{}} />);

    expect(screen.getByText("Linear")).toBeInTheDocument();
    expect(screen.getByText("MCPJam")).toBeInTheDocument();
    expect(screen.getByLabelText("Verified publisher")).toBeInTheDocument();
    expect(screen.getByLabelText("42 stars")).toBeInTheDocument();
    expect(
      screen.getByText("Interact with Linear issues.")
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /star this server/i })
    ).not.toBeInTheDocument();
  });

  it("renders a compact connect dropdown for dual-type catalog cards", () => {
    mockIsAuthenticated = true;
    mockCatalogCards = [createDualTypeCatalogCard()];

    render(<ServersTab {...defaultProps} projectServers={{}} />);

    expect(screen.getByTestId("connect-dropdown-trigger")).toBeInTheDocument();
  });

  it("shows quick connect and browse registry for guests when catalog is available", () => {
    mockIsAuthenticated = false;
    mockCatalogCards = [createLinearCatalogCard()];

    const { rerender } = render(
      <ServersTab {...defaultProps} projectServers={{}} />
    );
    expect(
      screen.getByTestId("servers-quick-connect-section")
    ).toBeInTheDocument();

    const s1 = createServer({ name: "a" });
    const s2 = createServer({ name: "b" });
    const s3 = createServer({ name: "c" });
    const three = { a: s1, b: s2, c: s3 };

    rerender(
      <ServersTab
        {...defaultProps}
        projectServers={three}
        projects={{
          "project-1": createProject(three),
        }}
      />
    );

    const minimized = screen.getByTestId("servers-quick-connect-section");
    expect(minimized).toBeInTheDocument();
    expect(minimized).toHaveAttribute("data-minimized", "true");
    expect(
      screen.queryByTestId("servers-tab-browse-registry-header-fallback")
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
        projectServers={{}}
      />
    );

    expect(
      screen.queryByTestId("servers-quick-connect-section")
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTestId("servers-tab-browse-registry-header-fallback")
    ).not.toBeInTheDocument();
    expect(mockUseRegistryServers).toHaveBeenCalledWith(
      expect.objectContaining({
        enabled: false,
      })
    );
  });

  it("passes the shared project id to registry queries instead of the local project key", () => {
    mockIsAuthenticated = true;
    mockCatalogCards = [createLinearCatalogCard()];

    render(
      <ServersTab
        {...defaultProps}
        projects={{
          "project-1": {
            ...createProject(defaultProps.projectServers),
            sharedProjectId: "ws_shared_123",
          },
        }}
      />
    );

    expect(mockUseRegistryServers).toHaveBeenCalledWith(
      expect.objectContaining({
        enabled: true,
        projectId: "ws_shared_123",
      })
    );
  });

  it("skips Convex project registry queries when the active project is local-only", () => {
    mockIsAuthenticated = true;
    mockCatalogCards = [createLinearCatalogCard()];

    render(
      <ServersTab
        {...defaultProps}
        projects={{
          "project-1": createProject(defaultProps.projectServers),
        }}
      />
    );

    expect(mockUseRegistryServers).toHaveBeenCalledWith(
      expect.objectContaining({
        enabled: true,
        projectId: null,
      })
    );
  });

  it("excludes single-variant quick connect cards when that server is already in the project", () => {
    mockIsAuthenticated = true;
    mockCatalogCards = [createLinearCatalogCard()];

    render(
      <ServersTab
        {...defaultProps}
        projectServers={{
          Linear: createServer({ name: "Linear" }),
        }}
        projects={{
          "project-1": createProject({
            Linear: createServer({ name: "Linear" }),
          }),
        }}
      />
    );

    expect(
      screen.queryByTestId("servers-quick-connect-section")
    ).not.toBeInTheDocument();
  });

  it("shows the Connection Settings button and opens the dialog", () => {
    render(<ServersTab {...defaultProps} />);

    const button = screen.getByRole("button", { name: /connection settings/i });
    expect(button).toBeInTheDocument();
    expect(
      screen.queryByTestId("client-config-tab-stub")
    ).not.toBeInTheDocument();

    fireEvent.click(button);

    expect(screen.getByTestId("client-config-tab-stub")).toHaveTextContent(
      "ClientConfigTab:project-1"
    );
  });

  it("discards unsaved connection settings when the dialog is closed", () => {
    const defaultConfig = {
      version: 1 as const,
      connectionDefaults: {
        headers: {},
        requestTimeout: 10000,
      },
      clientCapabilities: getDefaultClientCapabilities() as Record<
        string,
        unknown
      >,
    };
    useClientConfigStore.getState().loadProjectConfig({
      projectId: "project-1",
      defaultConfig,
      savedConfig: undefined,
    });
    useClientConfigStore.getState().setSectionText(
      "connectionDefaults",
      '{ "headers": { "x-test": "1" }, "requestTimeout": 1234 }',
    );

    expect(useClientConfigStore.getState().isDirty).toBe(true);

    render(<ServersTab {...defaultProps} />);

    fireEvent.click(
      screen.getByRole("button", { name: /connection settings/i }),
    );
    fireEvent.click(screen.getByRole("button", { name: /close/i }));

    expect(useClientConfigStore.getState().isDirty).toBe(false);
    expect(
      useClientConfigStore.getState().draftConfig?.connectionDefaults,
    ).toEqual(defaultConfig.connectionDefaults);
  });

  it("hides the Connection Settings button when no save handler is provided", () => {
    render(<ServersTab {...defaultProps} onSaveClientConfig={undefined} />);

    expect(
      screen.queryByRole("button", { name: /connection settings/i })
    ).not.toBeInTheDocument();
  });

  it("excludes a dual-type quick connect card when any variant is already in the project", () => {
    mockIsAuthenticated = true;
    mockCatalogCards = [createDualTypeCatalogCard()];

    render(
      <ServersTab
        {...defaultProps}
        projectServers={{
          "DualServer (App)": createServer({ name: "DualServer (App)" }),
        }}
        projects={{
          "project-1": createProject({
            "DualServer (App)": createServer({ name: "DualServer (App)" }),
          }),
        }}
      />
    );

    expect(
      screen.queryByTestId("servers-quick-connect-section")
    ).not.toBeInTheDocument();
  });
});
