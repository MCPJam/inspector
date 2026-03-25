import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppAction, AppState, Workspace } from "@/state/app-types";
import { useWorkspaceState } from "../use-workspace-state";
import { useClientConfigStore } from "@/stores/client-config-store";
import type { WorkspaceClientConfig } from "@/lib/client-config";

const {
  createWorkspaceMock,
  ensureDefaultWorkspaceMock,
  updateClientConfigMock,
  updateWorkspaceMock,
  deleteWorkspaceMock,
  workspaceQueryState,
  serializeServersForSharingMock,
} = vi.hoisted(() => ({
  createWorkspaceMock: vi.fn(),
  ensureDefaultWorkspaceMock: vi.fn(),
  updateClientConfigMock: vi.fn(),
  updateWorkspaceMock: vi.fn(),
  deleteWorkspaceMock: vi.fn(),
  workspaceQueryState: {
    allWorkspaces: undefined as any,
    workspaces: undefined as any,
    isLoading: false,
  },
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
  useWorkspaceServers: () => ({
    servers: undefined,
    isLoading: false,
  }),
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
}: {
  appState: AppState;
  activeOrganizationId?: string;
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
        isAuthenticated: true,
        isAuthLoading: false,
        activeOrganizationId: organizationId,
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
    ensureDefaultWorkspaceMock.mockResolvedValue("default-workspace-id");
    updateClientConfigMock.mockResolvedValue(undefined);
    updateWorkspaceMock.mockResolvedValue("remote-workspace-id");
    deleteWorkspaceMock.mockResolvedValue(undefined);
    workspaceQueryState.allWorkspaces = [];
    workspaceQueryState.workspaces = [];
    workspaceQueryState.isLoading = false;
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
