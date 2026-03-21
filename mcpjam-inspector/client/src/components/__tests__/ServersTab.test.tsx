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

vi.mock("posthog-js/react", () => ({
  usePostHog: () => ({
    capture: vi.fn(),
  }),
}));

vi.mock("convex/react", () => ({
  useConvexAuth: () => ({
    isAuthenticated: false,
  }),
  useQuery: () => undefined,
}));

vi.mock("@workos-inc/authkit-react", () => ({
  useAuth: () => ({
    user: null,
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
  };

  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
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
});
