import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";
import type { AppAction, AppState, Workspace } from "@/state/app-types";
import { useWorkspaceState } from "../use-workspace-state";
import { useClientConfigStore } from "@/stores/client-config-store";
import type { WorkspaceClientConfig } from "@/lib/client-config";

const {
  bootstrapGuestServerImportMock,
  createWorkspaceMock,
  ensureDefaultWorkspaceMock,
  updateClientConfigMock,
  updateWorkspaceMock,
  deleteWorkspaceMock,
  workspaceServersState,
  workspaceQueryState,
  organizationBillingStatusState,
  useOrganizationBillingStatusMock,
} = vi.hoisted(() => ({
  bootstrapGuestServerImportMock: vi.fn(),
  createWorkspaceMock: vi.fn(),
  ensureDefaultWorkspaceMock: vi.fn(),
  updateClientConfigMock: vi.fn(),
  updateWorkspaceMock: vi.fn(),
  deleteWorkspaceMock: vi.fn(),
  workspaceServersState: {
    servers: undefined as any,
    isLoading: false,
  },
  workspaceQueryState: {
    allWorkspaces: undefined as any,
    workspaces: undefined as any,
    isLoading: false,
  },
  organizationBillingStatusState: {
    value: undefined as
      | {
          canManageBilling: boolean;
        }
      | undefined,
  },
  useOrganizationBillingStatusMock: vi.fn(),
}));

vi.mock("sonner", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
  },
}));

vi.mock("../useWorkspaces", () => ({
  useWorkspaceQueries: ({
    enabled = true,
  }: {
    enabled?: boolean;
  }) =>
    enabled
      ? workspaceQueryState
      : {
          allWorkspaces: undefined,
          workspaces: undefined,
          isLoading: false,
        },
  useWorkspaceMutations: () => ({
    createWorkspace: createWorkspaceMock,
    bootstrapGuestServerImport: bootstrapGuestServerImportMock,
    ensureDefaultWorkspace: ensureDefaultWorkspaceMock,
    updateWorkspace: updateWorkspaceMock,
    updateClientConfig: updateClientConfigMock,
    deleteWorkspace: deleteWorkspaceMock,
  }),
  useWorkspaceServers: ({
    workspaceId,
    enabled = true,
  }: {
    workspaceId: string | null;
    enabled?: boolean;
  }) => ({
    servers:
      enabled && workspaceId ? workspaceServersState.servers : undefined,
    isLoading: enabled ? workspaceServersState.isLoading : false,
  }),
}));

vi.mock("../useOrganizationBilling", () => ({
  useOrganizationBillingStatus: (...args: unknown[]) =>
    useOrganizationBillingStatusMock(...args),
}));

vi.mock("@/lib/workspace-serialization", () => ({
  deserializeServersFromConvex: vi.fn((servers) => servers ?? {}),
}));

function createSyntheticDefaultWorkspace(): Workspace {
  return {
    id: "default",
    name: "Default",
    description: "Default workspace",
    servers: {},
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    isDefault: true,
  };
}

function createLocalWorkspace(
  id: string,
  overrides: Partial<Workspace> = {},
): Workspace {
  return {
    id,
    name: `Workspace ${id}`,
    servers: {},
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    ...overrides,
  };
}

function createAppState(workspaces: Record<string, Workspace>): AppState {
  const firstWorkspaceId = Object.keys(workspaces)[0] ?? "none";
  return {
    workspaces,
    activeWorkspaceId: firstWorkspaceId,
    servers: {},
    selectedServer: "none",
    selectedMultipleServers: [],
    isMultiSelectMode: false,
  };
}

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });

  return { promise, resolve, reject };
}

function renderUseWorkspaceState({
  appState,
  activeOrganizationId,
  routeOrganizationId,
  isAuthenticated = true,
  isAuthLoading = false,
}: {
  appState: AppState;
  activeOrganizationId?: string;
  routeOrganizationId?: string;
  isAuthenticated?: boolean;
  isAuthLoading?: boolean;
}) {
  const dispatch = vi.fn<(action: AppAction) => void>();
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };

  const result = renderHook(
    ({
      organizationId,
      isAuthLoading,
      isAuthenticated,
    }: {
      organizationId?: string;
      isAuthLoading: boolean;
      isAuthenticated: boolean;
    }) =>
      useWorkspaceState({
        appState,
        dispatch,
        isAuthenticated,
        isAuthLoading,
        activeOrganizationId: organizationId,
        routeOrganizationId,
        logger,
      }),
    {
      initialProps: {
        organizationId: activeOrganizationId,
        isAuthLoading,
        isAuthenticated,
      },
    },
  );

  return {
    ...result,
    rerender: ({
      organizationId = activeOrganizationId,
      isAuthLoading: nextIsAuthLoading = isAuthLoading,
      isAuthenticated: nextIsAuthenticated = isAuthenticated,
    }: {
      organizationId?: string;
      isAuthLoading?: boolean;
      isAuthenticated?: boolean;
    } = {}) =>
      result.rerender({
        organizationId,
        isAuthLoading: nextIsAuthLoading,
        isAuthenticated: nextIsAuthenticated,
      }),
    dispatch,
    logger,
  };
}

describe("useWorkspaceState automatic workspace creation", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
    localStorage.clear();
    bootstrapGuestServerImportMock.mockImplementation(
      async ({
        organizationId,
        preferredWorkspaceId,
        sourceWorkspaces,
      }: {
        organizationId?: string;
        preferredWorkspaceId?: string;
        sourceWorkspaces: Array<{
          localWorkspaceId: string;
          servers: Array<{ name: string }>;
        }>;
      }) => ({
        targetWorkspaceId: preferredWorkspaceId ?? "remote-workspace-id",
        targetOrganizationId: organizationId,
        createdWorkspace: !preferredWorkspaceId,
        importedServerNames: sourceWorkspaces.flatMap((workspace) =>
          workspace.servers.map((server) => server.name),
        ),
        skippedExistingNameServerNames: [],
        failedServerNames: [],
        importedSourceWorkspaceIds: sourceWorkspaces.map(
          (workspace) => workspace.localWorkspaceId,
        ),
        timedOut: false,
      }),
    );
    createWorkspaceMock.mockResolvedValue("remote-workspace-id");
    ensureDefaultWorkspaceMock.mockResolvedValue("default-workspace-id");
    updateClientConfigMock.mockResolvedValue(undefined);
    updateWorkspaceMock.mockResolvedValue("remote-workspace-id");
    deleteWorkspaceMock.mockResolvedValue(undefined);
    workspaceServersState.servers = undefined;
    workspaceServersState.isLoading = false;
    workspaceQueryState.allWorkspaces = [];
    workspaceQueryState.workspaces = [];
    workspaceQueryState.isLoading = false;
    organizationBillingStatusState.value = undefined;
    useOrganizationBillingStatusMock.mockImplementation(
      () => organizationBillingStatusState.value,
    );
    useClientConfigStore.setState({
      activeWorkspaceId: null,
      defaultConfig: null,
      savedConfig: undefined,
      draftConfig: null,
      clientCapabilitiesText: "{}",
      hostContextText: "{}",
      clientCapabilitiesError: null,
      hostContextError: null,
      isSaving: false,
      isDirty: false,
      pendingWorkspaceId: null,
      pendingSavedConfig: undefined,
      isAwaitingRemoteEcho: false,
    });
  });

  it("ensures one initial workspace per empty organization and dedupes rerenders", async () => {
    workspaceQueryState.allWorkspaces = [
      {
        _id: "remote-1",
        name: "Existing workspace",
        servers: {},
        ownerId: "user-1",
        organizationId: "org-a",
        createdAt: 1,
        updatedAt: 1,
      },
    ];
    workspaceQueryState.workspaces = [];

    const appState = createAppState({
      default: createSyntheticDefaultWorkspace(),
    });
    const { rerender } = renderUseWorkspaceState({
      appState,
      activeOrganizationId: "org-b",
    });

    await waitFor(() => {
      expect(ensureDefaultWorkspaceMock).toHaveBeenCalledTimes(1);
    });

    expect(ensureDefaultWorkspaceMock).toHaveBeenLastCalledWith({
      organizationId: "org-b",
    });
    expect(createWorkspaceMock).not.toHaveBeenCalled();

    rerender({ organizationId: "org-b" });
    await waitFor(() => {
      expect(ensureDefaultWorkspaceMock).toHaveBeenCalledTimes(1);
    });

    rerender({ organizationId: "org-c" });
    await waitFor(() => {
      expect(ensureDefaultWorkspaceMock).toHaveBeenCalledTimes(2);
    });

    expect(ensureDefaultWorkspaceMock).toHaveBeenLastCalledWith({
      organizationId: "org-c",
    });
  });

  it("skips organization billing status queries while Convex auth is unavailable", () => {
    const appState = createAppState({
      default: createSyntheticDefaultWorkspace(),
    });

    renderUseWorkspaceState({
      appState,
      activeOrganizationId: "org-auth",
      isAuthenticated: false,
    });

    expect(useOrganizationBillingStatusMock).toHaveBeenCalledWith("org-auth", {
      enabled: false,
    });
  });

  it("prefers the route organization for workspace actions while active org state catches up", async () => {
    workspaceQueryState.allWorkspaces = [
      {
        _id: "remote-1",
        name: "Existing workspace",
        servers: {},
        ownerId: "user-1",
        organizationId: "org-stale",
        createdAt: 1,
        updatedAt: 1,
      },
    ];
    workspaceQueryState.workspaces = [];

    const appState = createAppState({
      default: createSyntheticDefaultWorkspace(),
    });
    const { result } = renderUseWorkspaceState({
      appState,
      activeOrganizationId: "org-stale",
      routeOrganizationId: "org-route",
    });

    await waitFor(() => {
      expect(ensureDefaultWorkspaceMock).toHaveBeenCalledWith({
        organizationId: "org-route",
      });
    });

    await act(async () => {
      await result.current.handleCreateWorkspace("Workspace Two");
    });

    expect(createWorkspaceMock).toHaveBeenCalledWith({
      organizationId: "org-route",
      name: "Workspace Two",
      clientConfig: undefined,
      servers: {},
    });
  });

  it("bootstraps the active local workspace servers into the signed-in workspace", async () => {
    const appState = createAppState({
      default: createLocalWorkspace("default", {
        name: "Imported workspace",
        description: "Needs migration",
        isDefault: true,
        servers: {
          demo: {
            name: "demo",
            config: {
              url: "https://example.com/mcp",
              requestInit: {
                headers: {
                  Authorization: "Bearer secret",
                  "X-Custom": "1",
                },
              },
              timeout: 30_000,
            } as any,
            lastConnectionTime: new Date("2026-01-01T00:00:00.000Z"),
            connectionStatus: "disconnected",
            retryCount: 0,
            enabled: true,
            useOAuth: true,
            oauthFlowProfile: {
              scopes: "read,write",
              clientId: "demo-client",
            } as any,
          },
        },
      }),
    });

    const { dispatch } = renderUseWorkspaceState({
      appState,
      activeOrganizationId: "org-migrate",
    });

    await waitFor(() => {
      expect(bootstrapGuestServerImportMock).toHaveBeenCalledWith({
        organizationId: "org-migrate",
        sourceWorkspaces: [
          {
            localWorkspaceId: "default",
            servers: [
              {
                name: "demo",
                enabled: true,
                transportType: "http",
                command: undefined,
                args: undefined,
                url: "https://example.com/mcp",
                headers: undefined,
                timeout: 30_000,
                useOAuth: true,
                oauthScopes: ["read", "write"],
                clientId: "demo-client",
              },
            ],
          },
        ],
      });
    });

    await waitFor(() => {
      expect(dispatch).toHaveBeenCalledWith({
        type: "UPDATE_WORKSPACE",
        workspaceId: "default",
        updates: {
          sharedWorkspaceId: "remote-workspace-id",
          organizationId: "org-migrate",
        },
      });
    });
    expect(localStorage.getItem("convex-active-workspace-id")).toBe(
      "remote-workspace-id",
    );
    expect(createWorkspaceMock).not.toHaveBeenCalled();
    expect(ensureDefaultWorkspaceMock).not.toHaveBeenCalled();
  });

  it("waits for auth loading to finish before bootstrapping local workspace servers", async () => {
    const appState = createAppState({
      default: createLocalWorkspace("default", {
        name: "Imported workspace",
        description: "Needs migration",
        isDefault: true,
        servers: {
          demo: {
            name: "demo",
            config: { url: "https://example.com/mcp" } as any,
            lastConnectionTime: new Date("2026-01-01T00:00:00.000Z"),
            connectionStatus: "disconnected",
            retryCount: 0,
          },
        },
      }),
    });

    const { rerender } = renderUseWorkspaceState({
      appState,
      isAuthLoading: true,
    });

    await Promise.resolve();
    expect(bootstrapGuestServerImportMock).not.toHaveBeenCalled();

    rerender({ organizationId: undefined, isAuthLoading: false });

    await waitFor(() => {
      expect(bootstrapGuestServerImportMock).toHaveBeenCalledWith({
        sourceWorkspaces: [
          {
            localWorkspaceId: "default",
            servers: [
              {
                name: "demo",
                enabled: false,
                transportType: "http",
                command: undefined,
                args: undefined,
                url: "https://example.com/mcp",
                headers: undefined,
                timeout: undefined,
                useOAuth: undefined,
                oauthScopes: undefined,
                clientId: undefined,
              },
            ],
          },
        ],
      });
    });
  });

  it("carries guest-created servers into the active signed-in workspace", async () => {
    workspaceQueryState.allWorkspaces = [
      {
        _id: "remote-1",
        name: "Remote workspace",
        servers: {},
        ownerId: "user-1",
        createdAt: 1,
        updatedAt: 1,
      },
    ];
    workspaceQueryState.workspaces = [...workspaceQueryState.allWorkspaces];
    workspaceServersState.servers = [];
    localStorage.setItem("convex-active-workspace-id", "remote-1");

    const appState = createAppState({
      default: createLocalWorkspace("default", {
        name: "Default",
        description: "Default workspace",
        isDefault: true,
        servers: {
          linear: {
            name: "linear",
            config: {
              url: "https://mcp.linear.app/mcp",
              requestInit: {
                headers: {
                  Authorization: "Bearer secret",
                  "X-Custom": "1",
                },
              },
              timeout: 30_000,
            } as any,
            lastConnectionTime: new Date("2026-01-01T00:00:00.000Z"),
            connectionStatus: "disconnected",
            retryCount: 0,
            enabled: true,
            useOAuth: true,
            oauthFlowProfile: {
              scopes: "read,write",
              clientId: "linear-client",
            } as any,
          },
        },
      }),
    });

    const { dispatch } = renderUseWorkspaceState({ appState });

    await waitFor(() => {
      expect(bootstrapGuestServerImportMock).toHaveBeenCalledWith({
        preferredWorkspaceId: "remote-1",
        sourceWorkspaces: [
          {
            localWorkspaceId: "default",
            servers: [
              {
                name: "linear",
                enabled: true,
                transportType: "http",
                command: undefined,
                args: undefined,
                url: "https://mcp.linear.app/mcp",
                headers: undefined,
                timeout: 30_000,
                useOAuth: true,
                oauthScopes: ["read", "write"],
                clientId: "linear-client",
              },
            ],
          },
        ],
      });
    });

    await waitFor(() => {
      expect(dispatch).toHaveBeenCalledWith({
        type: "UPDATE_WORKSPACE",
        workspaceId: "default",
        updates: {
          sharedWorkspaceId: "remote-1",
        },
      });
    });
  });

  it("does not wait for active workspace server hydration before bootstrapping guest servers", async () => {
    workspaceQueryState.allWorkspaces = [
      {
        _id: "remote-1",
        name: "Remote workspace",
        servers: {},
        ownerId: "user-1",
        createdAt: 1,
        updatedAt: 1,
      },
    ];
    workspaceQueryState.workspaces = [...workspaceQueryState.allWorkspaces];
    workspaceServersState.servers = undefined;
    workspaceServersState.isLoading = true;
    localStorage.removeItem("convex-active-workspace-id");

    const appState = createAppState({
      default: createLocalWorkspace("default", {
        name: "Default",
        description: "Default workspace",
        isDefault: true,
        servers: {
          demo: {
            name: "demo",
            config: { url: "https://example.com/mcp" } as any,
            lastConnectionTime: new Date("2026-01-01T00:00:00.000Z"),
            connectionStatus: "disconnected",
            retryCount: 0,
          },
        },
      }),
    });

    renderUseWorkspaceState({ appState });

    await waitFor(() => {
      expect(bootstrapGuestServerImportMock).toHaveBeenCalledWith({
        sourceWorkspaces: [
          {
            localWorkspaceId: "default",
            servers: [
              {
                name: "demo",
                enabled: false,
                transportType: "http",
                command: undefined,
                args: undefined,
                url: "https://example.com/mcp",
                headers: undefined,
                timeout: undefined,
                useOAuth: undefined,
                oauthScopes: undefined,
                clientId: undefined,
              },
            ],
          },
        ],
      });
    });
  });

  it("uses the active workspace even when the local workspace still points at an old shared workspace", async () => {
    workspaceQueryState.allWorkspaces = [
      {
        _id: "remote-1",
        name: "Active remote workspace",
        servers: {},
        ownerId: "user-1",
        createdAt: 1,
        updatedAt: 1,
      },
      {
        _id: "remote-2",
        name: "Previously linked workspace",
        ownerId: "user-1",
        createdAt: 2,
        updatedAt: 2,
        servers: {},
      },
    ];
    workspaceQueryState.workspaces = [...workspaceQueryState.allWorkspaces];
    workspaceServersState.servers = [
      {
        _id: "srv-linear",
        workspaceId: "remote-1",
        name: "linear",
        enabled: true,
        transportType: "http",
        url: "https://mcp.linear.app/mcp",
        headers: { "X-Different": "remote-value" },
        timeout: 30_000,
        useOAuth: true,
        oauthScopes: ["read", "write"],
        clientId: "linear-client",
        createdAt: 1,
        updatedAt: 1,
      },
    ];
    localStorage.setItem("convex-active-workspace-id", "remote-1");

    const appState = createAppState({
      default: createLocalWorkspace("default", {
        name: "Default",
        description: "Default workspace",
        isDefault: true,
        sharedWorkspaceId: "remote-2",
        servers: {
          linear: {
            name: "linear",
            config: {
              url: "https://mcp.linear.app/mcp",
              requestInit: {
                headers: {
                  Authorization: "Bearer secret",
                  "X-Custom": "1",
                },
              },
              timeout: 30_000,
            } as any,
            lastConnectionTime: new Date("2026-01-01T00:00:00.000Z"),
            connectionStatus: "disconnected",
            retryCount: 0,
            enabled: true,
            useOAuth: true,
            oauthFlowProfile: {
              scopes: "read,write",
              clientId: "linear-client",
            } as any,
          },
        },
      }),
    });

    const { dispatch } = renderUseWorkspaceState({ appState });

    await waitFor(() => {
      expect(bootstrapGuestServerImportMock).toHaveBeenCalledWith({
        preferredWorkspaceId: "remote-1",
        sourceWorkspaces: [
          {
            localWorkspaceId: "default",
            servers: [
              {
                name: "linear",
                enabled: true,
                transportType: "http",
                command: undefined,
                args: undefined,
                url: "https://mcp.linear.app/mcp",
                headers: undefined,
                timeout: 30_000,
                useOAuth: true,
                oauthScopes: ["read", "write"],
                clientId: "linear-client",
              },
            ],
          },
        ],
      });
    });

    expect(dispatch).toHaveBeenCalledWith({
      type: "UPDATE_WORKSPACE",
      workspaceId: "default",
      updates: {
        sharedWorkspaceId: "remote-1",
      },
    });
    expect(dispatch).not.toHaveBeenCalledWith(
      expect.objectContaining({
        type: "UPDATE_WORKSPACE",
        workspaceId: "default",
        updates: expect.objectContaining({
          sharedWorkspaceId: "remote-2",
        }),
      }),
    );
  });

  it("waits for auth loading to finish before importing guest servers", async () => {
    workspaceQueryState.allWorkspaces = [
      {
        _id: "remote-1",
        name: "Remote workspace",
        servers: {},
        ownerId: "user-1",
        createdAt: 1,
        updatedAt: 1,
      },
    ];
    workspaceQueryState.workspaces = [...workspaceQueryState.allWorkspaces];
    workspaceServersState.servers = [];
    localStorage.setItem("convex-active-workspace-id", "remote-1");

    const appState = createAppState({
      default: createLocalWorkspace("default", {
        name: "Default",
        description: "Default workspace",
        isDefault: true,
        servers: {
          demo: {
            name: "demo",
            config: { url: "https://example.com/mcp" } as any,
            lastConnectionTime: new Date("2026-01-01T00:00:00.000Z"),
            connectionStatus: "disconnected",
            retryCount: 0,
          },
        },
      }),
    });

    const { rerender } = renderUseWorkspaceState({
      appState,
      isAuthLoading: true,
    });

    await Promise.resolve();
    expect(bootstrapGuestServerImportMock).not.toHaveBeenCalled();

    rerender({ organizationId: undefined, isAuthLoading: false });

    await waitFor(() => {
      expect(bootstrapGuestServerImportMock).toHaveBeenCalledWith({
        preferredWorkspaceId: "remote-1",
        sourceWorkspaces: [
          {
            localWorkspaceId: "default",
            servers: [
              {
                name: "demo",
                enabled: false,
                transportType: "http",
                command: undefined,
                args: undefined,
                url: "https://example.com/mcp",
                headers: undefined,
                timeout: undefined,
                useOAuth: undefined,
                oauthScopes: undefined,
                clientId: undefined,
              },
            ],
          },
        ],
      });
    });
  });

  it("treats a same-name remote server as already imported", async () => {
    workspaceQueryState.allWorkspaces = [
      {
        _id: "remote-1",
        name: "Remote workspace",
        servers: {},
        ownerId: "user-1",
        createdAt: 1,
        updatedAt: 1,
      },
    ];
    workspaceQueryState.workspaces = [...workspaceQueryState.allWorkspaces];
    localStorage.setItem("convex-active-workspace-id", "remote-1");
    bootstrapGuestServerImportMock.mockResolvedValueOnce({
      targetWorkspaceId: "remote-1",
      targetOrganizationId: undefined,
      createdWorkspace: false,
      importedServerNames: [],
      skippedExistingNameServerNames: ["linear"],
      failedServerNames: [],
      importedSourceWorkspaceIds: ["default"],
      timedOut: false,
    });

    const appState = createAppState({
      default: createLocalWorkspace("default", {
        name: "Default",
        description: "Default workspace",
        isDefault: true,
        servers: {
          linear: {
            name: "linear",
            config: {
              url: "https://mcp.linear.app/mcp",
              requestInit: {
                headers: {
                  Authorization: "Bearer secret",
                  "X-Custom": "1",
                },
              },
              timeout: 30_000,
            } as any,
            lastConnectionTime: new Date("2026-01-01T00:00:00.000Z"),
            connectionStatus: "disconnected",
            retryCount: 0,
            enabled: true,
            useOAuth: true,
            oauthFlowProfile: {
              scopes: "read,write",
              clientId: "linear-client",
            } as any,
          },
        },
      }),
    });

    const { dispatch } = renderUseWorkspaceState({ appState });

    await waitFor(() => {
      expect(dispatch).toHaveBeenCalledWith({
        type: "UPDATE_WORKSPACE",
        workspaceId: "default",
        updates: {
          sharedWorkspaceId: "remote-1",
        },
      });
    });
  });

  it("silently skips a same-name remote server even when headers differ", async () => {
    workspaceQueryState.allWorkspaces = [
      {
        _id: "remote-1",
        name: "Remote workspace",
        servers: {},
        ownerId: "user-1",
        createdAt: 1,
        updatedAt: 1,
      },
    ];
    workspaceQueryState.workspaces = [...workspaceQueryState.allWorkspaces];
    localStorage.setItem("convex-active-workspace-id", "remote-1");
    bootstrapGuestServerImportMock.mockResolvedValueOnce({
      targetWorkspaceId: "remote-1",
      targetOrganizationId: undefined,
      createdWorkspace: false,
      importedServerNames: [],
      skippedExistingNameServerNames: ["linear"],
      failedServerNames: [],
      importedSourceWorkspaceIds: ["default"],
      timedOut: false,
    });

    const appState = createAppState({
      default: createLocalWorkspace("default", {
        name: "Default",
        description: "Default workspace",
        isDefault: true,
        servers: {
          linear: {
            name: "linear",
            config: {
              url: "https://mcp.linear.app/mcp",
              requestInit: {
                headers: {
                  Authorization: "Bearer secret",
                  "X-Custom": "1",
                },
              },
              timeout: 30_000,
            } as any,
            lastConnectionTime: new Date("2026-01-01T00:00:00.000Z"),
            connectionStatus: "disconnected",
            retryCount: 0,
            enabled: true,
            useOAuth: true,
            oauthFlowProfile: {
              scopes: "read,write",
              clientId: "linear-client",
            } as any,
          },
        },
      }),
    });

    const { dispatch } = renderUseWorkspaceState({ appState });

    await waitFor(() => {
      expect(dispatch).toHaveBeenCalledWith({
        type: "UPDATE_WORKSPACE",
        workspaceId: "default",
        updates: {
          sharedWorkspaceId: "remote-1",
        },
      });
    });
  });

  it("falls back to the active authed workspace when the old shared workspace link is stale", async () => {
    workspaceQueryState.allWorkspaces = [
      {
        _id: "remote-1",
        name: "Remote workspace",
        servers: {},
        ownerId: "user-1",
        createdAt: 1,
        updatedAt: 1,
      },
    ];
    workspaceQueryState.workspaces = [...workspaceQueryState.allWorkspaces];
    workspaceServersState.servers = [];
    localStorage.setItem("convex-active-workspace-id", "remote-1");

    const appState = createAppState({
      default: createLocalWorkspace("default", {
        name: "Default",
        description: "Default workspace",
        isDefault: true,
        sharedWorkspaceId: "remote-missing",
        servers: {
          linear: {
            name: "linear",
            config: {
              url: "https://mcp.linear.app/mcp",
              requestInit: {
                headers: {
                  Authorization: "Bearer secret",
                  "X-Custom": "1",
                },
              },
              timeout: 30_000,
            } as any,
            lastConnectionTime: new Date("2026-01-01T00:00:00.000Z"),
            connectionStatus: "disconnected",
            retryCount: 0,
            enabled: true,
            useOAuth: true,
            oauthFlowProfile: {
              scopes: "read,write",
              clientId: "linear-client",
            } as any,
          },
        },
      }),
    });

    const { dispatch } = renderUseWorkspaceState({ appState });

    await waitFor(() => {
      expect(bootstrapGuestServerImportMock).toHaveBeenCalledWith({
        preferredWorkspaceId: "remote-1",
        sourceWorkspaces: [
          {
            localWorkspaceId: "default",
            servers: [
              {
                name: "linear",
                enabled: true,
                transportType: "http",
                command: undefined,
                args: undefined,
                url: "https://mcp.linear.app/mcp",
                headers: undefined,
                timeout: 30_000,
                useOAuth: true,
                oauthScopes: ["read", "write"],
                clientId: "linear-client",
              },
            ],
          },
        ],
      });
    });

    await waitFor(() => {
      expect(dispatch).toHaveBeenCalledWith({
        type: "UPDATE_WORKSPACE",
        workspaceId: "default",
        updates: {
          sharedWorkspaceId: "remote-1",
        },
      });
    });
  });

  it("bootstraps into a backend-created default workspace when no remote workspace exists yet", async () => {
    workspaceQueryState.allWorkspaces = [];
    workspaceQueryState.workspaces = [];
    workspaceServersState.servers = undefined;
    bootstrapGuestServerImportMock.mockResolvedValueOnce({
      targetWorkspaceId: "remote-1",
      targetOrganizationId: undefined,
      createdWorkspace: true,
      importedServerNames: ["linear"],
      skippedExistingNameServerNames: [],
      failedServerNames: [],
      importedSourceWorkspaceIds: ["default"],
      timedOut: false,
    });

    const appState = createAppState({
      default: createLocalWorkspace("default", {
        name: "Default",
        description: "Default workspace",
        isDefault: true,
        sharedWorkspaceId: "remote-missing",
        servers: {
          linear: {
            name: "linear",
            config: {
              url: "https://mcp.linear.app/mcp",
              requestInit: {
                headers: {
                  Authorization: "Bearer secret",
                  "X-Custom": "1",
                },
              },
              timeout: 30_000,
            } as any,
            lastConnectionTime: new Date("2026-01-01T00:00:00.000Z"),
            connectionStatus: "disconnected",
            retryCount: 0,
            enabled: true,
            useOAuth: true,
            oauthFlowProfile: {
              scopes: "read,write",
              clientId: "linear-client",
            } as any,
          },
        },
      }),
    });

    const { dispatch } = renderUseWorkspaceState({ appState });

    await waitFor(() => {
      expect(bootstrapGuestServerImportMock).toHaveBeenCalledWith({
        sourceWorkspaces: [
          {
            localWorkspaceId: "default",
            servers: [
              {
                name: "linear",
                enabled: true,
                transportType: "http",
                command: undefined,
                args: undefined,
                url: "https://mcp.linear.app/mcp",
                headers: undefined,
                timeout: 30_000,
                useOAuth: true,
                oauthScopes: ["read", "write"],
                clientId: "linear-client",
              },
            ],
          },
        ],
      });
    });

    await waitFor(() => {
      expect(dispatch).toHaveBeenCalledWith({
        type: "UPDATE_WORKSPACE",
        workspaceId: "default",
        updates: {
          sharedWorkspaceId: "remote-1",
        },
      });
    });
  });

  it("silently skips guest servers when the remote workspace already has the same name", async () => {
    workspaceQueryState.allWorkspaces = [
      {
        _id: "remote-1",
        name: "Remote workspace",
        servers: {},
        ownerId: "user-1",
        createdAt: 1,
        updatedAt: 1,
      },
    ];
    workspaceQueryState.workspaces = [...workspaceQueryState.allWorkspaces];
    localStorage.setItem("convex-active-workspace-id", "remote-1");
    bootstrapGuestServerImportMock.mockResolvedValueOnce({
      targetWorkspaceId: "remote-1",
      targetOrganizationId: undefined,
      createdWorkspace: false,
      importedServerNames: [],
      skippedExistingNameServerNames: ["linear"],
      failedServerNames: [],
      importedSourceWorkspaceIds: ["default"],
      timedOut: false,
    });

    const appState = createAppState({
      default: createLocalWorkspace("default", {
        name: "Default",
        description: "Default workspace",
        isDefault: true,
        servers: {
          linear: {
            name: "linear",
            config: { url: "https://mcp.linear.app/mcp" } as any,
            lastConnectionTime: new Date("2026-01-01T00:00:00.000Z"),
            connectionStatus: "disconnected",
            retryCount: 0,
          },
        },
      }),
    });

    const { dispatch } = renderUseWorkspaceState({ appState });

    await waitFor(() => {
      expect(dispatch).toHaveBeenCalledWith({
        type: "UPDATE_WORKSPACE",
        workspaceId: "default",
        updates: {
          sharedWorkspaceId: "remote-1",
        },
      });
    });

    expect(vi.mocked(toast.error)).not.toHaveBeenCalled();
    expect(dispatch).toHaveBeenCalledWith({
      type: "UPDATE_WORKSPACE",
      workspaceId: "default",
      updates: {
        sharedWorkspaceId: "remote-1",
      },
    });
  });

  it("keeps workspace bootstrap loading active until the guest import pass finishes", async () => {
    workspaceQueryState.allWorkspaces = [
      {
        _id: "remote-1",
        name: "Remote workspace",
        servers: {},
        ownerId: "user-1",
        createdAt: 1,
        updatedAt: 1,
      },
    ];
    workspaceQueryState.workspaces = [...workspaceQueryState.allWorkspaces];
    workspaceServersState.servers = [];
    localStorage.setItem("convex-active-workspace-id", "remote-1");

    let resolveBootstrapImport:
      | ((value: {
          targetWorkspaceId: string;
          targetOrganizationId?: string;
          createdWorkspace: boolean;
          importedServerNames: string[];
          skippedExistingNameServerNames: string[];
          failedServerNames: string[];
          importedSourceWorkspaceIds: string[];
          timedOut: boolean;
        }) => void)
      | null = null;
    bootstrapGuestServerImportMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveBootstrapImport = resolve;
        }),
    );

    const appState = createAppState({
      default: createLocalWorkspace("default", {
        name: "Default",
        description: "Default workspace",
        isDefault: true,
        servers: {
          demo: {
            name: "demo",
            config: { url: "https://example.com/mcp" } as any,
            lastConnectionTime: new Date("2026-01-01T00:00:00.000Z"),
            connectionStatus: "disconnected",
            retryCount: 0,
          },
        },
      }),
    });

    const { result, dispatch } = renderUseWorkspaceState({ appState });

    await waitFor(() => {
      expect(result.current.isWorkspaceBootstrapLoading).toBe(true);
    });

    await act(async () => {
      resolveBootstrapImport?.({
        targetWorkspaceId: "remote-1",
        targetOrganizationId: undefined,
        createdWorkspace: false,
        importedServerNames: ["demo"],
        skippedExistingNameServerNames: [],
        failedServerNames: [],
        importedSourceWorkspaceIds: ["default"],
        timedOut: false,
      });
    });

    await waitFor(() => {
      expect(result.current.isWorkspaceBootstrapLoading).toBe(false);
      expect(dispatch).toHaveBeenCalledWith({
        type: "UPDATE_WORKSPACE",
        workspaceId: "default",
        updates: {
          sharedWorkspaceId: "remote-1",
        },
      });
    });
  });

  it("stops workspace bootstrap loading after 5 seconds if guest import hangs", async () => {
    vi.useFakeTimers();

    workspaceQueryState.allWorkspaces = [
      {
        _id: "remote-1",
        name: "Remote workspace",
        servers: {},
        ownerId: "user-1",
        createdAt: 1,
        updatedAt: 1,
      },
    ];
    workspaceQueryState.workspaces = [...workspaceQueryState.allWorkspaces];
    workspaceServersState.servers = [];
    localStorage.setItem("convex-active-workspace-id", "remote-1");

    bootstrapGuestServerImportMock.mockImplementationOnce(
      () => new Promise(() => {}),
    );

    const appState = createAppState({
      default: createLocalWorkspace("default", {
        name: "Default",
        description: "Default workspace",
        isDefault: true,
        servers: {
          demo: {
            name: "demo",
            config: { url: "https://example.com/mcp" } as any,
            lastConnectionTime: new Date("2026-01-01T00:00:00.000Z"),
            connectionStatus: "disconnected",
            retryCount: 0,
          },
        },
      }),
    });

    const { result, rerender } = renderUseWorkspaceState({ appState });

    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current.isWorkspaceBootstrapLoading).toBe(true);

    await act(async () => {
      vi.advanceTimersByTime(5000);
      await Promise.resolve();
    });

    expect(result.current.isWorkspaceBootstrapLoading).toBe(false);
    expect(vi.mocked(toast.warning)).toHaveBeenCalledWith(
      "Importing your servers took too long. Opened app without waiting.",
    );

    workspaceQueryState.workspaces = [...workspaceQueryState.workspaces];
    rerender({ organizationId: undefined });

    expect(bootstrapGuestServerImportMock).toHaveBeenCalledTimes(1);
  });

  it("does not relink a local workspace when bootstrap times out before that workspace finishes", async () => {
    workspaceQueryState.allWorkspaces = [
      {
        _id: "remote-1",
        name: "Remote workspace",
        servers: {},
        ownerId: "user-1",
        createdAt: 1,
        updatedAt: 1,
      },
    ];
    workspaceQueryState.workspaces = [...workspaceQueryState.allWorkspaces];
    localStorage.setItem("convex-active-workspace-id", "remote-1");
    bootstrapGuestServerImportMock.mockResolvedValueOnce({
      targetWorkspaceId: "remote-1",
      targetOrganizationId: undefined,
      createdWorkspace: false,
      importedServerNames: [],
      skippedExistingNameServerNames: [],
      failedServerNames: [],
      importedSourceWorkspaceIds: [],
      timedOut: true,
    });

    const appState = createAppState({
      default: createLocalWorkspace("default", {
        name: "Default",
        description: "Default workspace",
        isDefault: true,
        servers: {
          demo: {
            name: "demo",
            config: { url: "https://example.com/mcp" } as any,
            lastConnectionTime: new Date("2026-01-01T00:00:00.000Z"),
            connectionStatus: "disconnected",
            retryCount: 0,
          },
        },
      }),
    });

    const { dispatch } = renderUseWorkspaceState({ appState });

    await waitFor(() => {
      expect(vi.mocked(toast.warning)).toHaveBeenCalledWith(
        "Importing your servers took too long. Opened app without waiting.",
      );
    });

    expect(dispatch).not.toHaveBeenCalledWith({
      type: "UPDATE_WORKSPACE",
      workspaceId: "default",
      updates: {
        sharedWorkspaceId: "remote-1",
      },
    });
  });

  it("stops workspace bootstrap loading if the bootstrap import mutation fails", async () => {
    workspaceQueryState.allWorkspaces = [];
    workspaceQueryState.workspaces = [];
    bootstrapGuestServerImportMock.mockRejectedValueOnce(
      new Error("bootstrap failed"),
    );

    const appState = createAppState({
      default: createLocalWorkspace("default", {
        name: "Default",
        description: "Needs migration",
        isDefault: true,
        servers: {
          demo: {
            name: "demo",
            config: { url: "https://example.com/mcp" } as any,
            lastConnectionTime: new Date("2026-01-01T00:00:00.000Z"),
            connectionStatus: "disconnected",
            retryCount: 0,
          },
        },
      }),
    });

    const { result, rerender } = renderUseWorkspaceState({ appState });

    await waitFor(() => {
      expect(bootstrapGuestServerImportMock).toHaveBeenCalledTimes(1);
      expect(result.current.isWorkspaceBootstrapLoading).toBe(false);
      expect(vi.mocked(toast.error)).toHaveBeenCalledWith(
        "Could not import guest servers after sign-in",
      );
    });

    rerender({ organizationId: undefined });

    await waitFor(() => {
      expect(bootstrapGuestServerImportMock).toHaveBeenCalledTimes(1);
    });
  });

  it("does not retry failed guest imports on a later rerender", async () => {
    workspaceQueryState.allWorkspaces = [
      {
        _id: "remote-1",
        name: "Remote workspace",
        servers: {},
        ownerId: "user-1",
        createdAt: 1,
        updatedAt: 1,
      },
    ];
    workspaceQueryState.workspaces = [...workspaceQueryState.allWorkspaces];
    workspaceServersState.servers = [];
    localStorage.setItem("convex-active-workspace-id", "remote-1");

    bootstrapGuestServerImportMock
      .mockRejectedValueOnce(new Error("network down"))
      .mockResolvedValueOnce({
        targetWorkspaceId: "remote-1",
        targetOrganizationId: undefined,
        createdWorkspace: false,
        importedServerNames: ["demo"],
        skippedExistingNameServerNames: [],
        failedServerNames: [],
        importedSourceWorkspaceIds: ["default"],
        timedOut: false,
      });

    const appState = createAppState({
      default: createLocalWorkspace("default", {
        name: "Default",
        description: "Default workspace",
        isDefault: true,
        servers: {
          demo: {
            name: "demo",
            config: { url: "https://example.com/mcp" } as any,
            lastConnectionTime: new Date("2026-01-01T00:00:00.000Z"),
            connectionStatus: "disconnected",
            retryCount: 0,
          },
        },
      }),
    });

    const { dispatch, rerender } = renderUseWorkspaceState({ appState });

    await waitFor(() => {
      expect(vi.mocked(toast.error)).toHaveBeenCalledWith(
        "Could not import guest servers after sign-in",
      );
    });

    expect(dispatch).not.toHaveBeenCalledWith(
      expect.objectContaining({
        type: "UPDATE_WORKSPACE",
        workspaceId: "default",
      }),
    );

    workspaceQueryState.workspaces = [...workspaceQueryState.workspaces];
    rerender({ organizationId: undefined });

    await waitFor(() => {
      expect(bootstrapGuestServerImportMock).toHaveBeenCalledTimes(1);
      expect(dispatch).not.toHaveBeenCalledWith({
        type: "UPDATE_WORKSPACE",
        workspaceId: "default",
        updates: {
          sharedWorkspaceId: "remote-1",
        },
      });
    });
  });

  it("does not retry successful guest imports on a later rerender", async () => {
    workspaceQueryState.allWorkspaces = [
      {
        _id: "remote-1",
        name: "Remote workspace",
        servers: {},
        ownerId: "user-1",
        createdAt: 1,
        updatedAt: 1,
      },
    ];
    workspaceQueryState.workspaces = [...workspaceQueryState.allWorkspaces];
    workspaceServersState.servers = [];
    localStorage.setItem("convex-active-workspace-id", "remote-1");

    const appState = createAppState({
      default: createLocalWorkspace("default", {
        name: "Default",
        description: "Default workspace",
        isDefault: true,
        servers: {
          demo: {
            name: "demo",
            config: { url: "https://example.com/mcp" } as any,
            lastConnectionTime: new Date("2026-01-01T00:00:00.000Z"),
            connectionStatus: "disconnected",
            retryCount: 0,
          },
        },
      }),
    });

    const { rerender } = renderUseWorkspaceState({ appState });

    await waitFor(() => {
      expect(bootstrapGuestServerImportMock).toHaveBeenCalledTimes(1);
    });

    workspaceQueryState.workspaces = [...workspaceQueryState.workspaces];
    rerender({ organizationId: undefined });

    await waitFor(() => {
      expect(bootstrapGuestServerImportMock).toHaveBeenCalledTimes(1);
    });
  });

  it("does not retry same-name skipped guest imports on a later rerender", async () => {
    workspaceQueryState.allWorkspaces = [
      {
        _id: "remote-1",
        name: "Remote workspace",
        servers: {},
        ownerId: "user-1",
        createdAt: 1,
        updatedAt: 1,
      },
    ];
    workspaceQueryState.workspaces = [...workspaceQueryState.allWorkspaces];
    localStorage.setItem("convex-active-workspace-id", "remote-1");
    bootstrapGuestServerImportMock.mockResolvedValueOnce({
      targetWorkspaceId: "remote-1",
      targetOrganizationId: undefined,
      createdWorkspace: false,
      importedServerNames: [],
      skippedExistingNameServerNames: ["linear"],
      failedServerNames: [],
      importedSourceWorkspaceIds: ["default"],
      timedOut: false,
    });

    const appState = createAppState({
      default: createLocalWorkspace("default", {
        name: "Default",
        description: "Default workspace",
        isDefault: true,
        servers: {
          linear: {
            name: "linear",
            config: { url: "https://mcp.linear.app/mcp" } as any,
            lastConnectionTime: new Date("2026-01-01T00:00:00.000Z"),
            connectionStatus: "disconnected",
            retryCount: 0,
          },
        },
      }),
    });

    const { rerender } = renderUseWorkspaceState({ appState });

    await waitFor(() => {
      expect(bootstrapGuestServerImportMock).toHaveBeenCalledTimes(1);
    });

    expect(vi.mocked(toast.error)).not.toHaveBeenCalled();

    workspaceQueryState.workspaces = [...workspaceQueryState.workspaces];
    rerender({ organizationId: undefined });

    await waitFor(() => {
      expect(bootstrapGuestServerImportMock).toHaveBeenCalledTimes(1);
      expect(vi.mocked(toast.error)).not.toHaveBeenCalled();
    });
  });

  it("ignores a stale bootstrap import result that resolves after sign-out", async () => {
    workspaceQueryState.allWorkspaces = [
      {
        _id: "remote-1",
        name: "Remote workspace",
        servers: {},
        ownerId: "user-1",
        createdAt: 1,
        updatedAt: 1,
      },
    ];
    workspaceQueryState.workspaces = [...workspaceQueryState.allWorkspaces];
    workspaceServersState.servers = [];
    localStorage.setItem("convex-active-workspace-id", "remote-1");

    const deferred = createDeferred<{
      targetWorkspaceId: string;
      targetOrganizationId?: string;
      createdWorkspace: boolean;
      importedServerNames: string[];
      skippedExistingNameServerNames: string[];
      failedServerNames: string[];
      importedSourceWorkspaceIds: string[];
      timedOut: boolean;
    }>();
    bootstrapGuestServerImportMock.mockImplementationOnce(() => deferred.promise);

    const appState = createAppState({
      default: createLocalWorkspace("default", {
        name: "Default",
        description: "Default workspace",
        isDefault: true,
        servers: {
          demo: {
            name: "demo",
            config: { url: "https://example.com/mcp" } as any,
            lastConnectionTime: new Date("2026-01-01T00:00:00.000Z"),
            connectionStatus: "disconnected",
            retryCount: 0,
          },
        },
      }),
    });

    const { dispatch, rerender } = renderUseWorkspaceState({ appState });

    await waitFor(() => {
      expect(bootstrapGuestServerImportMock).toHaveBeenCalledTimes(1);
    });

    rerender({ isAuthenticated: false });

    await act(async () => {
      deferred.resolve({
        targetWorkspaceId: "remote-stale",
        targetOrganizationId: undefined,
        createdWorkspace: false,
        importedServerNames: ["demo"],
        skippedExistingNameServerNames: [],
        failedServerNames: [],
        importedSourceWorkspaceIds: ["default"],
        timedOut: false,
      });
      await Promise.resolve();
    });

    expect(dispatch).not.toHaveBeenCalledWith({
      type: "UPDATE_WORKSPACE",
      workspaceId: "default",
      updates: {
        sharedWorkspaceId: "remote-stale",
      },
    });
    expect(localStorage.getItem("convex-active-workspace-id")).toBe("remote-1");
    expect(vi.mocked(toast.error)).not.toHaveBeenCalledWith(
      "Could not import guest servers after sign-in",
    );
  });

  it("ignores a stale bootstrap result after sign-out and allows a new sign-in pass", async () => {
    workspaceQueryState.allWorkspaces = [
      {
        _id: "remote-1",
        name: "Remote workspace",
        servers: {},
        ownerId: "user-1",
        createdAt: 1,
        updatedAt: 1,
      },
    ];
    workspaceQueryState.workspaces = [...workspaceQueryState.allWorkspaces];
    workspaceServersState.servers = [];
    localStorage.setItem("convex-active-workspace-id", "remote-1");

    const firstDeferred = createDeferred<{
      targetWorkspaceId: string;
      targetOrganizationId?: string;
      createdWorkspace: boolean;
      importedServerNames: string[];
      skippedExistingNameServerNames: string[];
      failedServerNames: string[];
      importedSourceWorkspaceIds: string[];
      timedOut: boolean;
    }>();
    const secondDeferred = createDeferred<{
      targetWorkspaceId: string;
      targetOrganizationId?: string;
      createdWorkspace: boolean;
      importedServerNames: string[];
      skippedExistingNameServerNames: string[];
      failedServerNames: string[];
      importedSourceWorkspaceIds: string[];
      timedOut: boolean;
    }>();
    bootstrapGuestServerImportMock
      .mockImplementationOnce(() => firstDeferred.promise)
      .mockImplementationOnce(() => secondDeferred.promise);

    const appState = createAppState({
      default: createLocalWorkspace("default", {
        name: "Default",
        description: "Default workspace",
        isDefault: true,
        servers: {
          demo: {
            name: "demo",
            config: { url: "https://example.com/mcp" } as any,
            lastConnectionTime: new Date("2026-01-01T00:00:00.000Z"),
            connectionStatus: "disconnected",
            retryCount: 0,
          },
        },
      }),
    });

    const { dispatch, rerender } = renderUseWorkspaceState({ appState });

    await waitFor(() => {
      expect(bootstrapGuestServerImportMock).toHaveBeenCalledTimes(1);
    });

    rerender({ isAuthenticated: false });
    rerender({ isAuthenticated: true });

    await waitFor(() => {
      expect(bootstrapGuestServerImportMock).toHaveBeenCalledTimes(2);
    });

    await act(async () => {
      firstDeferred.resolve({
        targetWorkspaceId: "remote-stale",
        targetOrganizationId: undefined,
        createdWorkspace: false,
        importedServerNames: ["demo"],
        skippedExistingNameServerNames: [],
        failedServerNames: [],
        importedSourceWorkspaceIds: ["default"],
        timedOut: false,
      });
      await Promise.resolve();
    });

    expect(dispatch).not.toHaveBeenCalledWith({
      type: "UPDATE_WORKSPACE",
      workspaceId: "default",
      updates: {
        sharedWorkspaceId: "remote-stale",
      },
    });
    expect(localStorage.getItem("convex-active-workspace-id")).toBe("remote-1");

    await act(async () => {
      secondDeferred.resolve({
        targetWorkspaceId: "remote-2",
        targetOrganizationId: undefined,
        createdWorkspace: false,
        importedServerNames: ["demo"],
        skippedExistingNameServerNames: [],
        failedServerNames: [],
        importedSourceWorkspaceIds: ["default"],
        timedOut: false,
      });
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(dispatch).toHaveBeenCalledWith({
        type: "UPDATE_WORKSPACE",
        workspaceId: "default",
        updates: {
          sharedWorkspaceId: "remote-2",
        },
      });
    });
  });

  it("clears the completed bootstrap guard after sign-out", async () => {
    workspaceQueryState.allWorkspaces = [
      {
        _id: "remote-1",
        name: "Remote workspace",
        servers: {},
        ownerId: "user-1",
        createdAt: 1,
        updatedAt: 1,
      },
    ];
    workspaceQueryState.workspaces = [...workspaceQueryState.allWorkspaces];
    workspaceServersState.servers = [];
    localStorage.setItem("convex-active-workspace-id", "remote-1");

    const appState = createAppState({
      default: createLocalWorkspace("default", {
        name: "Default",
        description: "Default workspace",
        isDefault: true,
        servers: {
          demo: {
            name: "demo",
            config: { url: "https://example.com/mcp" } as any,
            lastConnectionTime: new Date("2026-01-01T00:00:00.000Z"),
            connectionStatus: "disconnected",
            retryCount: 0,
          },
        },
      }),
    });

    const { rerender } = renderUseWorkspaceState({ appState });

    await waitFor(() => {
      expect(bootstrapGuestServerImportMock).toHaveBeenCalledTimes(1);
    });

    rerender({ isAuthenticated: false });
    rerender({ isAuthenticated: true });

    await waitFor(() => {
      expect(bootstrapGuestServerImportMock).toHaveBeenCalledTimes(2);
    });
  });

  it("ignores a stale workspace migration result that resolves after sign-out", async () => {
    workspaceQueryState.allWorkspaces = [];
    workspaceQueryState.workspaces = [];

    const deferred = createDeferred<string>();
    createWorkspaceMock.mockImplementationOnce(() => deferred.promise);

    const appState = createAppState({
      "workspace-1": createLocalWorkspace("workspace-1", {
        name: "Needs migration",
        description: "Needs migration",
      }),
    });

    const { dispatch, rerender } = renderUseWorkspaceState({ appState });

    await waitFor(() => {
      expect(createWorkspaceMock).toHaveBeenCalledTimes(1);
    });

    rerender({ isAuthenticated: false });

    await act(async () => {
      deferred.resolve("remote-stale");
      await Promise.resolve();
    });

    expect(dispatch).not.toHaveBeenCalledWith({
      type: "UPDATE_WORKSPACE",
      workspaceId: "workspace-1",
      updates: {
        sharedWorkspaceId: "remote-stale",
      },
    });
  });

  it("does not send ensure-default twice on a same-org sign-out/sign-in flicker", async () => {
    workspaceQueryState.allWorkspaces = [];
    workspaceQueryState.workspaces = [];

    const deferred = createDeferred<string>();
    ensureDefaultWorkspaceMock.mockImplementationOnce(() => deferred.promise);

    const appState = createAppState({
      default: createSyntheticDefaultWorkspace(),
    });

    const { rerender } = renderUseWorkspaceState({
      appState,
      activeOrganizationId: "org-empty",
    });

    await waitFor(() => {
      expect(ensureDefaultWorkspaceMock).toHaveBeenCalledTimes(1);
      expect(ensureDefaultWorkspaceMock).toHaveBeenLastCalledWith({
        organizationId: "org-empty",
      });
    });

    rerender({ isAuthenticated: false });

    await act(async () => {
      deferred.resolve("default-workspace-id-stale");
      await Promise.resolve();
    });

    rerender({ isAuthenticated: true, organizationId: "org-empty" });

    await waitFor(() => {
      expect(ensureDefaultWorkspaceMock).toHaveBeenCalledTimes(1);
      expect(ensureDefaultWorkspaceMock).toHaveBeenCalledWith({
        organizationId: "org-empty",
      });
    });
  });

  it("allows ensure-default to run again after an org change even if the old org request finishes later", async () => {
    workspaceQueryState.allWorkspaces = [];
    workspaceQueryState.workspaces = [];

    const deferred = createDeferred<string>();
    ensureDefaultWorkspaceMock
      .mockImplementationOnce(() => deferred.promise)
      .mockResolvedValueOnce("default-workspace-id-org-b");

    const appState = createAppState({
      default: createSyntheticDefaultWorkspace(),
    });

    const { rerender } = renderUseWorkspaceState({
      appState,
      activeOrganizationId: "org-a",
    });

    await waitFor(() => {
      expect(ensureDefaultWorkspaceMock).toHaveBeenCalledTimes(1);
      expect(ensureDefaultWorkspaceMock).toHaveBeenLastCalledWith({
        organizationId: "org-a",
      });
    });

    rerender({ organizationId: "org-b" });

    await waitFor(() => {
      expect(ensureDefaultWorkspaceMock).toHaveBeenCalledTimes(2);
      expect(ensureDefaultWorkspaceMock).toHaveBeenLastCalledWith({
        organizationId: "org-b",
      });
    });

    await act(async () => {
      deferred.resolve("default-workspace-id-org-a");
      await Promise.resolve();
    });

    expect(ensureDefaultWorkspaceMock).toHaveBeenCalledTimes(2);
  });

  it("clears ensure-default in-flight dedupe after a failure so a later retry is allowed", async () => {
    workspaceQueryState.allWorkspaces = [];
    workspaceQueryState.workspaces = [];

    ensureDefaultWorkspaceMock
      .mockRejectedValueOnce(new Error("ensure failed"))
      .mockResolvedValueOnce("default-workspace-id-next");

    const appState = createAppState({
      default: createSyntheticDefaultWorkspace(),
    });

    const { rerender } = renderUseWorkspaceState({
      appState,
      activeOrganizationId: "org-empty",
    });

    await waitFor(() => {
      expect(ensureDefaultWorkspaceMock).toHaveBeenCalledTimes(1);
    });

    rerender({ isAuthenticated: false });
    rerender({ isAuthenticated: true, organizationId: "org-empty" });

    await waitFor(() => {
      expect(ensureDefaultWorkspaceMock).toHaveBeenCalledTimes(2);
      expect(ensureDefaultWorkspaceMock).toHaveBeenLastCalledWith({
        organizationId: "org-empty",
      });
    });
  });

  it("treats the empty synthetic default as ensure-default only, not a migration candidate", async () => {
    const appState = createAppState({
      default: createSyntheticDefaultWorkspace(),
    });
    const { rerender } = renderUseWorkspaceState({
      appState,
      activeOrganizationId: "org-empty",
    });

    await waitFor(() => {
      expect(ensureDefaultWorkspaceMock).toHaveBeenCalledTimes(1);
    });

    expect(ensureDefaultWorkspaceMock).toHaveBeenCalledWith({
      organizationId: "org-empty",
    });
    expect(createWorkspaceMock).not.toHaveBeenCalled();

    rerender({ organizationId: "org-empty" });
    await waitFor(() => {
      expect(ensureDefaultWorkspaceMock).toHaveBeenCalledTimes(1);
    });
  });

  it("keeps authenticated client-config saves pending until the remote echo arrives", async () => {
    const savedConfig: WorkspaceClientConfig = {
      version: 1,
      clientCapabilities: {
        experimental: {
          inspectorProfile: true,
        },
      },
      hostContext: {},
    };

    workspaceQueryState.allWorkspaces = [
      {
        _id: "remote-1",
        name: "Remote workspace",
        servers: {},
        ownerId: "user-1",
        createdAt: 1,
        updatedAt: 1,
        clientConfig: undefined,
      },
    ];
    workspaceQueryState.workspaces = [...workspaceQueryState.allWorkspaces];
    localStorage.setItem("convex-active-workspace-id", "remote-1");

    const appState = createAppState({
      default: createSyntheticDefaultWorkspace(),
    });
    const { result, rerender } = renderUseWorkspaceState({ appState });

    let resolved = false;
    const savePromise = result.current
      .handleUpdateClientConfig("remote-1", savedConfig)
      .then(() => {
        resolved = true;
      });

    await waitFor(() => {
      expect(updateClientConfigMock).toHaveBeenCalledWith({
        workspaceId: "remote-1",
        clientConfig: savedConfig,
      });
    });

    expect(useClientConfigStore.getState().isAwaitingRemoteEcho).toBe(true);
    expect(resolved).toBe(false);

    workspaceQueryState.allWorkspaces = [
      {
        ...workspaceQueryState.allWorkspaces[0],
        clientConfig: savedConfig,
      },
    ];
    workspaceQueryState.workspaces = [...workspaceQueryState.allWorkspaces];
    rerender({ organizationId: undefined });

    await waitFor(() => {
      expect(resolved).toBe(true);
    });

    await savePromise;
  });

  it("fails authenticated client-config saves when the remote echo times out", async () => {
    vi.useFakeTimers();

    const savedConfig: WorkspaceClientConfig = {
      version: 1,
      clientCapabilities: {
        experimental: {
          inspectorProfile: true,
        },
      },
      hostContext: {},
    };

    workspaceQueryState.allWorkspaces = [
      {
        _id: "remote-1",
        name: "Remote workspace",
        servers: {},
        ownerId: "user-1",
        createdAt: 1,
        updatedAt: 1,
        clientConfig: undefined,
      },
    ];
    workspaceQueryState.workspaces = [...workspaceQueryState.allWorkspaces];
    localStorage.setItem("convex-active-workspace-id", "remote-1");

    const appState = createAppState({
      default: createSyntheticDefaultWorkspace(),
    });
    const { result } = renderUseWorkspaceState({ appState });

    const savePromise = result.current.handleUpdateClientConfig(
      "remote-1",
      savedConfig,
    );
    const saveError = savePromise.catch((error) => error);

    await Promise.resolve();
    expect(updateClientConfigMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });

    await expect(saveError).resolves.toBeInstanceOf(Error);
    await expect(savePromise).rejects.toThrow(
      "Timed out waiting for workspace client config to sync.",
    );
    expect(useClientConfigStore.getState().isAwaitingRemoteEcho).toBe(false);
    expect(useClientConfigStore.getState().isSaving).toBe(false);
  });

  it("formats workspace create billing errors for organization owners", async () => {
    workspaceQueryState.allWorkspaces = [
      {
        _id: "remote-1",
        name: "Existing workspace",
        servers: {},
        ownerId: "user-1",
        organizationId: "org-owner",
        createdAt: 1,
        updatedAt: 1,
      },
    ];
    workspaceQueryState.workspaces = [...workspaceQueryState.allWorkspaces];
    organizationBillingStatusState.value = {
      canManageBilling: true,
    };
    createWorkspaceMock.mockRejectedValue(
      new Error(
        JSON.stringify({
          code: "billing_limit_reached",
          limit: "maxWorkspaces",
          allowedValue: 1,
        }),
      ),
    );

    const appState = createAppState({
      default: createSyntheticDefaultWorkspace(),
    });
    const { result } = renderUseWorkspaceState({
      appState,
      activeOrganizationId: "org-owner",
    });

    await act(async () => {
      await result.current.handleCreateWorkspace("Workspace Two");
    });

    expect(toast.error).toHaveBeenCalledWith(
      "This organization has reached its workspace limit (1). Upgrade to create more workspaces.",
    );
  });

  it("formats workspace create billing errors for non-billing-admin members", async () => {
    workspaceQueryState.allWorkspaces = [
      {
        _id: "remote-1",
        name: "Existing workspace",
        servers: {},
        ownerId: "user-1",
        organizationId: "org-member",
        createdAt: 1,
        updatedAt: 1,
      },
    ];
    workspaceQueryState.workspaces = [...workspaceQueryState.allWorkspaces];
    organizationBillingStatusState.value = {
      canManageBilling: false,
    };
    createWorkspaceMock.mockRejectedValue(
      new Error(
        JSON.stringify({
          code: "billing_limit_reached",
          limit: "maxWorkspaces",
          allowedValue: 1,
        }),
      ),
    );

    const appState = createAppState({
      default: createSyntheticDefaultWorkspace(),
    });
    const { result } = renderUseWorkspaceState({
      appState,
      activeOrganizationId: "org-member",
    });

    await act(async () => {
      await result.current.handleCreateWorkspace("Workspace Two");
    });

    expect(toast.error).toHaveBeenCalledWith(
      "This organization has reached its workspace limit (1). Ask an organization owner to upgrade.",
    );
  });

  it("shows only one toast when multiple local workspace migrations fail in the same burst", async () => {
    organizationBillingStatusState.value = {
      canManageBilling: false,
    };
    createWorkspaceMock.mockRejectedValue(
      new Error(
        JSON.stringify({
          code: "billing_limit_reached",
          limit: "maxWorkspaces",
          allowedValue: 1,
        }),
      ),
    );

    const appState = createAppState({
      default: createSyntheticDefaultWorkspace(),
      "local-1": createLocalWorkspace("local-1", {
        name: "Local One",
      }),
      "local-2": createLocalWorkspace("local-2", {
        name: "Local Two",
      }),
    });
    const { logger } = renderUseWorkspaceState({
      appState,
      activeOrganizationId: "org-member",
    });

    await waitFor(() => {
      expect(createWorkspaceMock).toHaveBeenCalledTimes(2);
    });

    expect(toast.error).toHaveBeenCalledTimes(1);
    expect(toast.error).toHaveBeenCalledWith(
      "This organization has reached its workspace limit (1). Ask an organization owner to upgrade.",
    );
    expect(logger.error).toHaveBeenCalledTimes(2);
  });

  it("rejects authenticated client-config saves when the hook unmounts mid-sync", async () => {
    const savedConfig: WorkspaceClientConfig = {
      version: 1,
      clientCapabilities: {
        experimental: {
          inspectorProfile: true,
        },
      },
      hostContext: {},
    };

    workspaceQueryState.allWorkspaces = [
      {
        _id: "remote-1",
        name: "Remote workspace",
        servers: {},
        ownerId: "user-1",
        createdAt: 1,
        updatedAt: 1,
        clientConfig: undefined,
      },
    ];
    workspaceQueryState.workspaces = [...workspaceQueryState.allWorkspaces];
    localStorage.setItem("convex-active-workspace-id", "remote-1");

    const appState = createAppState({
      default: createSyntheticDefaultWorkspace(),
    });
    const { result, unmount } = renderUseWorkspaceState({ appState });

    const savePromise = result.current.handleUpdateClientConfig(
      "remote-1",
      savedConfig,
    );

    await waitFor(() => {
      expect(updateClientConfigMock).toHaveBeenCalledWith({
        workspaceId: "remote-1",
        clientConfig: savedConfig,
      });
    });

    unmount();

    await expect(savePromise).rejects.toThrow(
      "Workspace client config sync was interrupted.",
    );
    await waitFor(() => {
      expect(useClientConfigStore.getState().isAwaitingRemoteEcho).toBe(false);
      expect(useClientConfigStore.getState().isSaving).toBe(false);
    });
  });
});
