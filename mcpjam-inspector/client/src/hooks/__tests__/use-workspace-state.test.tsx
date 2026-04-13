import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";
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
  organizationBillingStatusState,
  useOrganizationBillingStatusMock,
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
  useWorkspaceServers: () => ({
    servers: undefined,
    isLoading: false,
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
  hasOrganizations = true,
  isLoadingOrganizations = false,
  validOrganizationIds,
}: {
  appState: AppState;
  activeOrganizationId?: string;
  routeOrganizationId?: string;
  isAuthenticated?: boolean;
  hasOrganizations?: boolean;
  isLoadingOrganizations?: boolean;
  validOrganizationIds?: string[];
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
      hasOrganizationsOverride,
      isLoadingOrganizationsOverride,
      routeOrganizationIdOverride,
      validOrganizationIdsOverride,
    }: {
      organizationId?: string;
      hasOrganizationsOverride?: boolean;
      isLoadingOrganizationsOverride?: boolean;
      routeOrganizationIdOverride?: string;
      validOrganizationIdsOverride?: string[];
    }) =>
      useWorkspaceState({
        appState,
        dispatch,
        isAuthenticated,
        isAuthLoading: false,
        hasOrganizations: hasOrganizationsOverride ?? hasOrganizations,
        isLoadingOrganizations:
          isLoadingOrganizationsOverride ?? isLoadingOrganizations,
        validOrganizationIds:
          validOrganizationIdsOverride ??
          validOrganizationIds ??
          [
            routeOrganizationIdOverride ?? routeOrganizationId,
            organizationId,
          ].filter(
            (organizationId): organizationId is string => !!organizationId,
          ),
        activeOrganizationId: organizationId,
        routeOrganizationId: routeOrganizationIdOverride ?? routeOrganizationId,
        logger,
      }),
    {
      initialProps: {
        organizationId: activeOrganizationId,
        hasOrganizationsOverride: hasOrganizations,
        isLoadingOrganizationsOverride: isLoadingOrganizations,
        routeOrganizationIdOverride: routeOrganizationId,
        validOrganizationIdsOverride: validOrganizationIds,
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

  it("skips organization billing status queries for a stale stored org", () => {
    const appState = createAppState({
      default: createSyntheticDefaultWorkspace(),
    });

    renderUseWorkspaceState({
      appState,
      activeOrganizationId: "org-stale",
      validOrganizationIds: ["org-live"],
    });

    expect(useOrganizationBillingStatusMock).toHaveBeenCalledWith(null, {
      enabled: true,
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

  it("does not ensure a default workspace until organization selection resolves", async () => {
    workspaceQueryState.allWorkspaces = [];
    workspaceQueryState.workspaces = [];

    const appState = createAppState({
      default: createSyntheticDefaultWorkspace(),
    });
    const { rerender } = renderUseWorkspaceState({
      appState,
      activeOrganizationId: undefined,
      hasOrganizations: true,
      isLoadingOrganizations: true,
      validOrganizationIds: [],
    });

    await act(async () => {});
    expect(ensureDefaultWorkspaceMock).not.toHaveBeenCalled();

    rerender({
      organizationId: "org-live",
      hasOrganizationsOverride: true,
      isLoadingOrganizationsOverride: false,
      routeOrganizationIdOverride: undefined,
      validOrganizationIdsOverride: ["org-live"],
    });

    await waitFor(() => {
      expect(ensureDefaultWorkspaceMock).toHaveBeenCalledWith({
        organizationId: "org-live",
      });
    });
  });

  it("does not migrate local workspaces until organization selection resolves", async () => {
    workspaceQueryState.allWorkspaces = [];
    workspaceQueryState.workspaces = [];

    const appState = createAppState({
      default: createSyntheticDefaultWorkspace(),
      "local-1": createLocalWorkspace("local-1", {
        name: "Imported workspace",
        organizationId: "org-live",
      }),
    });
    const { rerender } = renderUseWorkspaceState({
      appState,
      activeOrganizationId: undefined,
      hasOrganizations: true,
      isLoadingOrganizations: true,
      validOrganizationIds: [],
    });

    await act(async () => {});
    expect(createWorkspaceMock).not.toHaveBeenCalled();

    rerender({
      organizationId: "org-live",
      hasOrganizationsOverride: true,
      isLoadingOrganizationsOverride: false,
      routeOrganizationIdOverride: undefined,
      validOrganizationIdsOverride: ["org-live"],
    });

    await waitFor(() => {
      expect(createWorkspaceMock).toHaveBeenCalledWith({
        organizationId: "org-live",
        name: "Imported workspace",
        description: undefined,
        clientConfig: undefined,
        servers: {},
      });
    });
  });

  it("does not create a cloud workspace until organization selection resolves", async () => {
    workspaceQueryState.allWorkspaces = [];
    workspaceQueryState.workspaces = [];

    const appState = createAppState({
      default: createSyntheticDefaultWorkspace(),
    });
    const { result } = renderUseWorkspaceState({
      appState,
      activeOrganizationId: undefined,
      hasOrganizations: true,
      isLoadingOrganizations: true,
      validOrganizationIds: [],
    });

    await act(async () => {
      await result.current.handleCreateWorkspace("Workspace Two");
    });

    expect(createWorkspaceMock).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledWith(
      "Create or join an organization to create workspaces.",
    );
  });

  it("does not duplicate a cloud workspace until organization selection resolves", async () => {
    workspaceQueryState.allWorkspaces = [
      {
        _id: "remote-1",
        name: "Workspace One",
        servers: {},
        ownerId: "user-1",
        organizationId: "org-pending",
        createdAt: 1,
        updatedAt: 1,
      },
    ];
    workspaceQueryState.workspaces = [...workspaceQueryState.allWorkspaces];

    const appState = createAppState({
      default: createSyntheticDefaultWorkspace(),
    });
    const { result } = renderUseWorkspaceState({
      appState,
      activeOrganizationId: undefined,
      hasOrganizations: true,
      isLoadingOrganizations: true,
      validOrganizationIds: [],
    });

    await act(async () => {
      await result.current.handleDuplicateWorkspace(
        "remote-1",
        "Workspace Copy",
      );
    });

    expect(createWorkspaceMock).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledWith(
      "Create or join an organization to create workspaces.",
    );
  });

  it("does not import a cloud workspace until organization selection resolves", async () => {
    workspaceQueryState.allWorkspaces = [];
    workspaceQueryState.workspaces = [];

    const appState = createAppState({
      default: createSyntheticDefaultWorkspace(),
    });
    const { result } = renderUseWorkspaceState({
      appState,
      activeOrganizationId: undefined,
      hasOrganizations: true,
      isLoadingOrganizations: true,
      validOrganizationIds: [],
    });

    await act(async () => {
      await result.current.handleImportWorkspace(
        createLocalWorkspace("import-1", {
          name: "Imported Workspace",
        }),
      );
    });

    expect(createWorkspaceMock).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledWith(
      "Create or join an organization to create workspaces.",
    );
  });

  it("migrates real local workspaces with createWorkspace and persists the shared workspace id", async () => {
    const appState = createAppState({
      default: createSyntheticDefaultWorkspace(),
      "local-1": createLocalWorkspace("local-1", {
        name: "Imported workspace",
        description: "Needs migration",
        organizationId: "org-migrate",
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

  it("treats the authenticated zero-org state as empty remote workspaces and clears stale synced selection", async () => {
    workspaceQueryState.allWorkspaces = [
      {
        _id: "remote-1",
        name: "Deleted org workspace",
        servers: {},
        ownerId: "user-1",
        organizationId: "deleted-org",
        createdAt: 1,
        updatedAt: 1,
      },
    ];
    workspaceQueryState.workspaces = [...workspaceQueryState.allWorkspaces];
    localStorage.setItem("convex-active-workspace-id", "remote-1");

    const appState = createAppState({
      default: createSyntheticDefaultWorkspace(),
    });
    const { result } = renderUseWorkspaceState({
      appState,
      activeOrganizationId: undefined,
      hasOrganizations: false,
      isLoadingOrganizations: false,
    });

    await waitFor(() => {
      expect(result.current.effectiveWorkspaces).toEqual({});
      expect(result.current.effectiveActiveWorkspaceId).toBe("none");
    });

    expect(localStorage.getItem("convex-active-workspace-id")).toBeNull();
    expect(ensureDefaultWorkspaceMock).not.toHaveBeenCalled();
  });

  it("keeps zero-org recovery empty even after local fallback activated while org loading was still pending", async () => {
    vi.useFakeTimers();
    workspaceQueryState.allWorkspaces = [
      {
        _id: "remote-1",
        name: "Deleted org workspace",
        servers: {},
        ownerId: "user-1",
        organizationId: "deleted-org",
        createdAt: 1,
        updatedAt: 1,
      },
    ];
    workspaceQueryState.workspaces = undefined;
    localStorage.setItem("convex-active-workspace-id", "remote-1");

    const appState = createAppState({
      "local-1": createLocalWorkspace("local-1", {
        organizationId: "org-live",
      }),
    });
    const { result, rerender } = renderUseWorkspaceState({
      appState,
      activeOrganizationId: undefined,
      hasOrganizations: false,
      isLoadingOrganizations: true,
      validOrganizationIds: [],
    });

    act(() => {
      vi.advanceTimersByTime(10001);
    });

    expect(result.current.useLocalFallback).toBe(true);
    expect(result.current.effectiveWorkspaces).toEqual(appState.workspaces);

    rerender({
      organizationId: undefined,
      hasOrganizationsOverride: false,
      isLoadingOrganizationsOverride: false,
      routeOrganizationIdOverride: undefined,
      validOrganizationIdsOverride: [],
    });

    expect(result.current.effectiveWorkspaces).toEqual({});
    expect(result.current.effectiveActiveWorkspaceId).toBe("none");

    await act(async () => {});
    expect(localStorage.getItem("convex-active-workspace-id")).toBeNull();
    expect(ensureDefaultWorkspaceMock).not.toHaveBeenCalled();
  });

  it("still uses local fallback when a valid org exists and cloud sync times out", async () => {
    vi.useFakeTimers();
    workspaceQueryState.allWorkspaces = undefined;
    workspaceQueryState.workspaces = undefined;

    const appState = createAppState({
      "local-1": createLocalWorkspace("local-1", {
        organizationId: "org-live",
      }),
    });
    const { result } = renderUseWorkspaceState({
      appState,
      activeOrganizationId: "org-live",
      hasOrganizations: true,
      isLoadingOrganizations: false,
      validOrganizationIds: ["org-live"],
    });

    act(() => {
      vi.advanceTimersByTime(10001);
    });

    expect(result.current.useLocalFallback).toBe(true);
    expect(result.current.effectiveWorkspaces).toEqual(appState.workspaces);
    expect(result.current.effectiveActiveWorkspaceId).toBe(
      appState.activeWorkspaceId,
    );
  });

  it("scopes local fallback workspaces to the current org and ignores an active workspace from another org", async () => {
    vi.useFakeTimers();
    workspaceQueryState.allWorkspaces = undefined;
    workspaceQueryState.workspaces = undefined;

    const appState = {
      ...createAppState({
        "local-org-a": createLocalWorkspace("local-org-a", {
          organizationId: "org-a",
        }),
        "local-org-b": createLocalWorkspace("local-org-b", {
          organizationId: "org-b",
        }),
      }),
      activeWorkspaceId: "local-org-b",
    };

    const { result } = renderUseWorkspaceState({
      appState,
      activeOrganizationId: "org-a",
      hasOrganizations: true,
      isLoadingOrganizations: false,
      validOrganizationIds: ["org-a"],
    });

    act(() => {
      vi.advanceTimersByTime(10001);
    });

    expect(result.current.useLocalFallback).toBe(true);
    expect(result.current.effectiveWorkspaces).toEqual({
      "local-org-a": appState.workspaces["local-org-a"],
    });
    expect(result.current.effectiveActiveWorkspaceId).toBe("local-org-a");
  });

  it("hides unscoped and wrong-org local fallback workspaces when the current org has no local matches", async () => {
    vi.useFakeTimers();
    workspaceQueryState.allWorkspaces = undefined;
    workspaceQueryState.workspaces = undefined;

    const appState = createAppState({
      "local-unscoped": createLocalWorkspace("local-unscoped"),
      "local-org-b": createLocalWorkspace("local-org-b", {
        organizationId: "org-b",
      }),
    });

    const { result } = renderUseWorkspaceState({
      appState,
      activeOrganizationId: "org-a",
      hasOrganizations: true,
      isLoadingOrganizations: false,
      validOrganizationIds: ["org-a"],
    });

    act(() => {
      vi.advanceTimersByTime(10001);
    });

    expect(result.current.useLocalFallback).toBe(true);
    expect(result.current.effectiveWorkspaces).toEqual({});
    expect(result.current.effectiveActiveWorkspaceId).toBe("none");
  });

  it("keeps unauthenticated local workspaces visible without org scoping", () => {
    const appState = createAppState({
      "local-unscoped": createLocalWorkspace("local-unscoped"),
      "local-org-b": createLocalWorkspace("local-org-b", {
        organizationId: "org-b",
      }),
    });

    const { result } = renderUseWorkspaceState({
      appState,
      isAuthenticated: false,
      activeOrganizationId: "org-a",
      hasOrganizations: true,
      isLoadingOrganizations: false,
      validOrganizationIds: ["org-a"],
    });

    expect(result.current.effectiveWorkspaces).toEqual(appState.workspaces);
    expect(result.current.effectiveActiveWorkspaceId).toBe(
      appState.activeWorkspaceId,
    );
  });

  it("stamps the current org id on local fallback create, duplicate, and import actions", async () => {
    vi.useFakeTimers();
    workspaceQueryState.allWorkspaces = undefined;
    workspaceQueryState.workspaces = undefined;

    const appState = createAppState({
      "local-org-a": createLocalWorkspace("local-org-a", {
        name: "Workspace A",
        organizationId: "org-a",
      }),
    });

    const { result, dispatch } = renderUseWorkspaceState({
      appState,
      activeOrganizationId: "org-a",
      hasOrganizations: true,
      isLoadingOrganizations: false,
      validOrganizationIds: ["org-a"],
    });

    act(() => {
      vi.advanceTimersByTime(10001);
    });

    await act(async () => {
      await result.current.handleCreateWorkspace("Created locally");
    });

    expect(createWorkspaceMock).not.toHaveBeenCalled();
    expect(dispatch).toHaveBeenCalledWith({
      type: "CREATE_WORKSPACE",
      workspace: expect.objectContaining({
        name: "Created locally",
        organizationId: "org-a",
      }),
    });

    dispatch.mockClear();

    await act(async () => {
      await result.current.handleDuplicateWorkspace(
        "local-org-a",
        "Duplicated locally",
      );
    });

    expect(dispatch).toHaveBeenCalledWith({
      type: "CREATE_WORKSPACE",
      workspace: expect.objectContaining({
        name: "Duplicated locally",
        organizationId: "org-a",
      }),
    });

    dispatch.mockClear();

    await act(async () => {
      await result.current.handleImportWorkspace(
        createLocalWorkspace("import-me", {
          name: "Imported locally",
        }),
      );
    });

    expect(dispatch).toHaveBeenCalledWith({
      type: "IMPORT_WORKSPACE",
      workspace: expect.objectContaining({
        name: "Imported locally",
        organizationId: "org-a",
      }),
    });
  });

  it("updates workspaces locally in authenticated fallback mode", async () => {
    vi.useFakeTimers();
    workspaceQueryState.allWorkspaces = undefined;
    workspaceQueryState.workspaces = undefined;

    const appState = createAppState({
      "local-org-a": createLocalWorkspace("local-org-a", {
        name: "Workspace A",
        organizationId: "org-a",
      }),
    });

    const { result, dispatch } = renderUseWorkspaceState({
      appState,
      activeOrganizationId: "org-a",
      hasOrganizations: true,
      isLoadingOrganizations: false,
      validOrganizationIds: ["org-a"],
    });

    act(() => {
      vi.advanceTimersByTime(10001);
    });

    dispatch.mockClear();

    await act(async () => {
      await result.current.handleUpdateWorkspace("local-org-a", {
        name: "Workspace A Renamed",
      });
    });

    expect(updateWorkspaceMock).not.toHaveBeenCalled();
    expect(dispatch).toHaveBeenCalledWith({
      type: "UPDATE_WORKSPACE",
      workspaceId: "local-org-a",
      updates: {
        name: "Workspace A Renamed",
      },
    });
  });

  it("deletes active workspaces locally in authenticated fallback mode", async () => {
    vi.useFakeTimers();
    workspaceQueryState.allWorkspaces = undefined;
    workspaceQueryState.workspaces = undefined;

    const appState = {
      ...createAppState({
        "local-org-a-1": createLocalWorkspace("local-org-a-1", {
          name: "Workspace A1",
          organizationId: "org-a",
        }),
        "local-org-a-2": createLocalWorkspace("local-org-a-2", {
          name: "Workspace A2",
          organizationId: "org-a",
        }),
      }),
      activeWorkspaceId: "local-org-a-1",
    };

    const { result, dispatch } = renderUseWorkspaceState({
      appState,
      activeOrganizationId: "org-a",
      hasOrganizations: true,
      isLoadingOrganizations: false,
      validOrganizationIds: ["org-a"],
    });

    act(() => {
      vi.advanceTimersByTime(10001);
    });

    dispatch.mockClear();

    await act(async () => {
      await result.current.handleDeleteWorkspace("local-org-a-1");
    });

    expect(deleteWorkspaceMock).not.toHaveBeenCalled();
    expect(dispatch).toHaveBeenNthCalledWith(1, {
      type: "SWITCH_WORKSPACE",
      workspaceId: "local-org-a-2",
    });
    expect(dispatch).toHaveBeenNthCalledWith(2, {
      type: "DELETE_WORKSPACE",
      workspaceId: "local-org-a-1",
    });
  });

  it("does not migrate local workspaces from another org into the current organization", async () => {
    workspaceQueryState.allWorkspaces = [];
    workspaceQueryState.workspaces = [];

    const appState = createAppState({
      default: createSyntheticDefaultWorkspace(),
      "local-org-b": createLocalWorkspace("local-org-b", {
        name: "Org B workspace",
        organizationId: "org-b",
      }),
    });

    renderUseWorkspaceState({
      appState,
      activeOrganizationId: "org-a",
      hasOrganizations: true,
      isLoadingOrganizations: false,
      validOrganizationIds: ["org-a", "org-b"],
    });

    await waitFor(() => {
      expect(ensureDefaultWorkspaceMock).toHaveBeenCalledWith({
        organizationId: "org-a",
      });
    });

    expect(createWorkspaceMock).not.toHaveBeenCalled();
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
        organizationId: "org-member",
      }),
      "local-2": createLocalWorkspace("local-2", {
        name: "Local Two",
        organizationId: "org-member",
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
