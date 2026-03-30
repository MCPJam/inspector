import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";
import type { AppAction, AppState, Workspace } from "@/state/app-types";
import { useWorkspaceState } from "../use-workspace-state";
import { useClientConfigStore } from "@/stores/client-config-store";
import type { WorkspaceClientConfig } from "@/lib/client-config";

const {
  createServerMock,
  createWorkspaceMock,
  ensureDefaultWorkspaceMock,
  updateClientConfigMock,
  updateWorkspaceMock,
  deleteWorkspaceMock,
  workspaceServersState,
  workspaceQueryState,
  organizationBillingStatusState,
  useOrganizationBillingStatusMock,
  serializeServersForSharingMock,
} = vi.hoisted(() => ({
  createServerMock: vi.fn(),
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
  serializeServersForSharingMock: vi.fn((servers) => servers),
}));

vi.mock("sonner", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
  },
}));

vi.mock("../useWorkspaces", () => ({
  useWorkspaceQueries: () => workspaceQueryState,
  useWorkspaceMutations: () => ({
    createWorkspace: createWorkspaceMock,
    ensureDefaultWorkspace: ensureDefaultWorkspaceMock,
    updateWorkspace: updateWorkspaceMock,
    updateClientConfig: updateClientConfigMock,
    deleteWorkspace: deleteWorkspaceMock,
  }),
  useServerMutations: () => ({
    createServer: createServerMock,
  }),
  useWorkspaceServers: ({
    workspaceId,
  }: {
    workspaceId: string | null;
  }) => ({
    servers: workspaceId ? workspaceServersState.servers : undefined,
    isLoading: workspaceServersState.isLoading,
  }),
}));

vi.mock("../useOrganizationBilling", () => ({
  useOrganizationBillingStatus: (...args: unknown[]) =>
    useOrganizationBillingStatusMock(...args),
}));

vi.mock("@/lib/workspace-serialization", () => ({
  deserializeServersFromConvex: vi.fn((servers) => servers ?? {}),
  serializeServersForSharing: serializeServersForSharingMock,
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

function renderUseWorkspaceState({
  appState,
  activeOrganizationId,
  routeOrganizationId,
  isAuthenticated = true,
}: {
  appState: AppState;
  activeOrganizationId?: string;
  routeOrganizationId?: string;
  isAuthenticated?: boolean;
}) {
  const dispatch = vi.fn<(action: AppAction) => void>();
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };

  const result = renderHook(
    ({ organizationId }: { organizationId?: string }) =>
      useWorkspaceState({
        appState,
        dispatch,
        isAuthenticated,
        isAuthLoading: false,
        activeOrganizationId: organizationId,
        routeOrganizationId,
        logger,
      }),
    {
      initialProps: {
        organizationId: activeOrganizationId,
      },
    },
  );

  return {
    ...result,
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
    createWorkspaceMock.mockResolvedValue("remote-workspace-id");
    createServerMock.mockResolvedValue("remote-server-id");
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

  it("migrates real local workspaces with createWorkspace and persists the shared workspace id", async () => {
    const appState = createAppState({
      default: createSyntheticDefaultWorkspace(),
      "local-1": createLocalWorkspace("local-1", {
        name: "Imported workspace",
        description: "Needs migration",
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

    const { dispatch } = renderUseWorkspaceState({
      appState,
      activeOrganizationId: "org-migrate",
    });

    await waitFor(() => {
      expect(createWorkspaceMock).toHaveBeenCalledTimes(1);
    });

    expect(serializeServersForSharingMock).toHaveBeenCalledWith(
      appState.workspaces["local-1"].servers,
    );
    expect(createWorkspaceMock).toHaveBeenCalledWith({
      organizationId: "org-migrate",
      name: "Imported workspace",
      description: "Needs migration",
      servers: appState.workspaces["local-1"].servers,
    });
    await waitFor(() => {
      expect(dispatch).toHaveBeenCalledWith({
        type: "UPDATE_WORKSPACE",
        workspaceId: "local-1",
        updates: {
          sharedWorkspaceId: "remote-workspace-id",
          organizationId: "org-migrate",
        },
      });
    });
    expect(ensureDefaultWorkspaceMock).not.toHaveBeenCalled();
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
      expect(createServerMock).toHaveBeenCalledWith({
        workspaceId: "remote-1",
        name: "linear",
        enabled: true,
        transportType: "http",
        command: undefined,
        args: undefined,
        url: "https://mcp.linear.app/mcp",
        headers: { "X-Custom": "1" },
        timeout: 30_000,
        useOAuth: true,
        oauthScopes: ["read", "write"],
        clientId: "linear-client",
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

  it("waits for active workspace server hydration before importing guest servers", async () => {
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

    const { rerender } = renderUseWorkspaceState({ appState });

    await Promise.resolve();
    expect(createServerMock).not.toHaveBeenCalled();

    workspaceServersState.servers = [];
    workspaceServersState.isLoading = false;
    rerender({ organizationId: undefined });

    await waitFor(() => {
      expect(createServerMock).toHaveBeenCalledWith({
        workspaceId: "remote-1",
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
      });
    });
  });

  it("treats an equivalent remote server as already imported", async () => {
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
    workspaceServersState.servers = [
      {
        _id: "srv-linear",
        workspaceId: "remote-1",
        name: "linear",
        enabled: true,
        transportType: "http",
        url: "https://mcp.linear.app/mcp",
        headers: { "X-Custom": "1" },
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
      expect(createServerMock).not.toHaveBeenCalled();
      expect(dispatch).toHaveBeenCalledWith({
        type: "UPDATE_WORKSPACE",
        workspaceId: "default",
        updates: {
          sharedWorkspaceId: "remote-1",
        },
      });
    });
  });

  it("does not overwrite conflicting remote servers with the same name", async () => {
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
    workspaceServersState.servers = [
      {
        _id: "srv-linear",
        workspaceId: "remote-1",
        name: "linear",
        enabled: true,
        transportType: "http",
        url: "https://different.example.com/mcp",
        headers: undefined,
        timeout: undefined,
        useOAuth: false,
        oauthScopes: undefined,
        clientId: undefined,
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
      expect(createServerMock).not.toHaveBeenCalled();
      expect(vi.mocked(toast.error)).toHaveBeenCalledWith(
        "Some guest servers were not imported because those names already exist: linear",
      );
    });

    expect(dispatch).not.toHaveBeenCalledWith(
      expect.objectContaining({
        type: "UPDATE_WORKSPACE",
        workspaceId: "default",
      }),
    );
  });

  it("keeps failed guest imports retryable on a later rerender", async () => {
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

    createServerMock
      .mockRejectedValueOnce(new Error("network down"))
      .mockResolvedValueOnce("remote-demo");

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
        "Could not import some guest servers after sign-in: demo",
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
      expect(createServerMock).toHaveBeenCalledTimes(2);
      expect(dispatch).toHaveBeenCalledWith({
        type: "UPDATE_WORKSPACE",
        workspaceId: "default",
        updates: {
          sharedWorkspaceId: "remote-1",
        },
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
    expect(serializeServersForSharingMock).not.toHaveBeenCalled();
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
