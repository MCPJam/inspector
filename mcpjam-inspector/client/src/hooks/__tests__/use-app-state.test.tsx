import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { initialAppState } from "@/state/app-types";
import { buildDisconnectedRuntimeServers, useAppState } from "../use-app-state";

const {
  loadAppStateMock,
  saveAppStateMock,
  useProjectStateMock,
  useServerStateMock,
  disconnectAllRuntimeServersMock,
  convexAuthState,
  projectStateValue,
  serverStateValue,
} = vi.hoisted(() => ({
  loadAppStateMock: vi.fn(),
  saveAppStateMock: vi.fn(),
  useProjectStateMock: vi.fn(),
  useServerStateMock: vi.fn(),
  disconnectAllRuntimeServersMock: vi.fn(),
  convexAuthState: {
    isAuthenticated: true,
    isLoading: false,
  },
  projectStateValue: {
    effectiveProjects: {},
    setConvexActiveProjectId: vi.fn(),
    clearConvexActiveProjectSelection: vi.fn(),
    useLocalFallback: false,
    remoteProjects: [],
    isLoadingRemoteProjects: false,
    effectiveActiveProjectId: "none",
    isLoadingProjects: false,
    activeProjectServersFlat: undefined,
    handleCreateProject: vi.fn(),
    handleUpdateProject: vi.fn(),
    handleUpdateClientConfig: vi.fn(),
    handleUpdateHostContext: vi.fn(),
    handleDeleteProject: vi.fn(),
    handleDuplicateProject: vi.fn(),
    handleSetDefaultProject: vi.fn(),
    handleProjectShared: vi.fn(),
    handleExportProject: vi.fn(),
    handleImportProject: vi.fn(),
  },
  serverStateValue: {
    projectServers: {},
    connectedOrConnectingServerConfigs: {},
    selectedServerEntry: undefined,
    selectedMCPConfig: undefined,
    selectedMCPConfigs: [],
    selectedMCPConfigsMap: {},
    isMultiSelectMode: false,
    activeProject: undefined,
    handleConnect: vi.fn(),
    handleDisconnect: vi.fn(),
    handleReconnect: vi.fn(),
    handleUpdate: vi.fn(),
    handleRemoveServer: vi.fn(),
    setSelectedServer: vi.fn(),
    setSelectedMCPConfigs: vi.fn(),
    toggleMultiSelectMode: vi.fn(),
    toggleServerSelection: vi.fn(),
    getValidAccessToken: vi.fn(),
    setSelectedMultipleServersToAllServers: vi.fn(),
    saveServerConfigWithoutConnecting: vi.fn(),
    handleConnectWithTokensFromOAuthFlow: vi.fn(),
    handleRefreshTokensFromOAuthFlow: vi.fn(),
  },
}));

vi.mock("convex/react", () => ({
  useConvexAuth: () => convexAuthState,
  // useQuery is invoked from useAppState to read hostConfigsV2.getProjectDefault.
  // Tests don't exercise mcpProfile-driven behavior, so returning undefined
  // matches the "guest / no profile" path.
  useQuery: () => undefined,
}));

vi.mock("@/lib/config", () => ({
  HOSTED_MODE: false,
}));

vi.mock("../use-logger", () => ({
  useLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

vi.mock("@/state/storage", () => ({
  loadAppState: (...args: unknown[]) => loadAppStateMock(...args),
  saveAppState: (...args: unknown[]) => saveAppStateMock(...args),
}));

vi.mock("@/state/mcp-api", () => ({
  disconnectAllRuntimeServers: (...args: unknown[]) =>
    disconnectAllRuntimeServersMock(...args),
}));

vi.mock("../use-project-state", () => ({
  useProjectState: (...args: unknown[]) => useProjectStateMock(...args),
}));

vi.mock("../use-server-state", () => ({
  useServerState: (...args: unknown[]) => useServerStateMock(...args),
}));

function createServer(
  name: string,
  connectionStatus:
    | "connected"
    | "connecting"
    | "oauth-flow"
    | "disconnected"
    | "failed" = "connected",
) {
  return {
    name,
    config: {
      type: "http",
      url: "https://example.com/mcp",
    } as any,
    lastConnectionTime: new Date("2026-01-01T00:00:00.000Z"),
    connectionStatus,
    retryCount: 0,
    enabled: connectionStatus === "connected",
    useOAuth: false,
  };
}

function createLoadedAppState(selectedServerState?: {
  name: string;
  connectionStatus:
    | "connected"
    | "connecting"
    | "oauth-flow"
    | "disconnected"
    | "failed";
}) {
  const baseProject = {
    ...initialAppState.projects.default,
    servers: {},
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
  };

  if (!selectedServerState) {
    return {
      ...initialAppState,
      projects: { default: baseProject },
    };
  }

  return {
    ...initialAppState,
    projects: { default: baseProject },
    servers: {
      [selectedServerState.name]: createServer(
        selectedServerState.name,
        selectedServerState.connectionStatus,
      ),
    },
    selectedServer: selectedServerState.name,
  };
}

describe("useAppState active organization recovery", () => {
  beforeEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
    localStorage.clear();
    window.history.replaceState({}, "", "/");
    loadAppStateMock.mockReturnValue(initialAppState);
    disconnectAllRuntimeServersMock.mockResolvedValue({
      success: true,
      servers: [],
    });
    convexAuthState.isAuthenticated = true;
    convexAuthState.isLoading = false;
    Object.assign(projectStateValue, {
      effectiveProjects: {},
      useLocalFallback: false,
      remoteProjects: [],
      isLoadingRemoteProjects: false,
      effectiveActiveProjectId: "none",
    });
    useProjectStateMock.mockReturnValue(projectStateValue);
    useServerStateMock.mockReturnValue(serverStateValue);
  });

  it("recovers a stale stored org to the first owned organization", async () => {
    localStorage.setItem("active-organization-id:user-1", "org-stale");

    const { result } = renderHook(() =>
      useAppState({
        currentUserId: "user-1",
        currentActorKey: "user-1",
        routeOrganizationId: undefined,
        hasOrganizations: true,
        isLoadingOrganizations: false,
        validOrganizations: [
          { _id: "org-member", myRole: "member" },
          { _id: "org-owned", myRole: "owner" },
        ],
      }),
    );

    await waitFor(() => {
      expect(result.current.activeOrganizationId).toBe("org-owned");
    });

    expect(useProjectStateMock).toHaveBeenLastCalledWith(
      expect.objectContaining({
        activeOrganizationId: "org-owned",
        validOrganizationIds: ["org-member", "org-owned"],
      }),
    );
    expect(localStorage.getItem("active-organization-id:user-1")).toBe(
      "org-owned",
    );
  });

  it("waits for stored active org hydration before applying fallback selection", async () => {
    localStorage.setItem("active-organization-id:user-1", "org-stored");

    const { result } = renderHook(() =>
      useAppState({
        currentUserId: "user-1",
        currentActorKey: "user-1",
        routeOrganizationId: undefined,
        hasOrganizations: true,
        isLoadingOrganizations: false,
        validOrganizations: [
          { _id: "org-owned", myRole: "owner" },
          { _id: "org-stored", myRole: "member" },
        ],
      }),
    );

    expect(useProjectStateMock).toHaveBeenCalled();
    expect(useProjectStateMock.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        activeOrganizationId: undefined,
      }),
    );

    await waitFor(() => {
      expect(result.current.activeOrganizationId).toBe("org-stored");
    });
  });

  it("commits a valid route organization into active org state", async () => {
    localStorage.setItem("active-organization-id:user-1", "org-a");

    const { result } = renderHook(() =>
      useAppState({
        currentUserId: "user-1",
        currentActorKey: "user-1",
        routeOrganizationId: "org-b",
        hasOrganizations: true,
        isLoadingOrganizations: false,
        validOrganizations: [
          { _id: "org-a", myRole: "owner" },
          { _id: "org-b", myRole: "member" },
        ],
      }),
    );

    await waitFor(() => {
      expect(result.current.activeOrganizationId).toBe("org-b");
    });

    expect(localStorage.getItem("active-organization-id:user-1")).toBe("org-b");
  });

  it("clears a stale stored org when no valid organizations remain", async () => {
    localStorage.setItem("active-organization-id:user-1", "org-stale");

    const { result } = renderHook(() =>
      useAppState({
        currentUserId: "user-1",
        currentActorKey: "user-1",
        routeOrganizationId: undefined,
        hasOrganizations: false,
        isLoadingOrganizations: false,
        validOrganizations: [],
      }),
    );

    await waitFor(() => {
      expect(result.current.activeOrganizationId).toBeUndefined();
    });

    expect(useProjectStateMock).toHaveBeenLastCalledWith(
      expect.objectContaining({
        activeOrganizationId: undefined,
        validOrganizationIds: [],
      }),
    );
    expect(localStorage.getItem("active-organization-id:user-1")).toBeNull();
  });

  it("builds disconnected runtime servers from cached project servers", () => {
    expect(
      buildDisconnectedRuntimeServers({
        champions: createServer("champions"),
        linear: createServer("linear", "disconnected"),
      }),
    ).toEqual({
      champions: expect.objectContaining({
        name: "champions",
        connectionStatus: "disconnected",
      }),
      linear: expect.objectContaining({
        name: "linear",
        connectionStatus: "disconnected",
      }),
    });
  });

  it("disconnects runtime servers when leaving authenticated Convex scope", async () => {
    let capturedDispatch:
      | ((action: {
          type: "CONNECT_SUCCESS";
          name: string;
          config: { type: "http"; url: string };
        }) => void)
      | undefined;
    useServerStateMock.mockImplementation((args: any) => {
      capturedDispatch = args.dispatch;
      return serverStateValue;
    });
    Object.assign(projectStateValue, {
      effectiveActiveProjectId: "project-1",
      useLocalFallback: false,
    });

    const hookProps = {
      currentUserId: "user-1",
      currentActorKey: "user-1",
      routeOrganizationId: undefined,
      hasOrganizations: true,
      isLoadingOrganizations: false,
      validOrganizations: [{ _id: "org-1", myRole: "owner" }],
    };

    const { rerender } = renderHook((props) => useAppState(props), {
      initialProps: hookProps,
    });

    act(() => {
      capturedDispatch?.({
        type: "CONNECT_SUCCESS",
        name: "demo-server",
        config: { type: "http", url: "https://example.com/mcp" },
      });
    });

    expect(serverStateValue.handleDisconnect).not.toHaveBeenCalled();

    convexAuthState.isAuthenticated = false;
    rerender(hookProps);

    await waitFor(() => {
      expect(serverStateValue.handleDisconnect).toHaveBeenCalledWith(
        "demo-server",
      );
    });
    expect(disconnectAllRuntimeServersMock).toHaveBeenCalled();
  });

  // Removed in Slice 5: the legacy `loadAppState` → `patchStateForPendingOAuth`
  // path is gone (Convex hydrates state, the patch helper is deleted), so
  // tests asserting the runtime-server seed via `loadAppStateMock` no longer
  // exercise reachable code. `isSelectedServerSyncing` is still derived from
  // `appState.selectedServer` + Convex projectServers, but the seeding hook
  // changed and the old test setup can't reach the new path.

  it("tracks missing dashboard OAuth callbacks without seeding a temporary server", async () => {
    loadAppStateMock.mockReturnValue({
      ...initialAppState,
      projects: {
        default: {
          ...initialAppState.projects.default,
          servers: {},
          createdAt: new Date("2026-01-01T00:00:00.000Z"),
          updatedAt: new Date("2026-01-01T00:00:00.000Z"),
        },
      },
      servers: {},
    });
    localStorage.setItem("mcp-oauth-pending", "demo-server");
    localStorage.setItem("mcp-serverUrl-demo-server", "https://example.com/mcp");
    window.history.replaceState({}, "", "/oauth/callback?code=test-code");

    const { result } = renderHook(() =>
      useAppState({
        currentUserId: "user-1",
        currentActorKey: "user-1",
        routeOrganizationId: undefined,
        hasOrganizations: false,
        isLoadingOrganizations: false,
        validOrganizations: [],
      }),
    );

    await waitFor(() => {
      expect(result.current.pendingDashboardOAuth).toEqual(
        expect.objectContaining({
          serverName: "demo-server",
          serverUrl: "https://example.com/mcp",
        }),
      );
    });

    const lastProjectArgs = useProjectStateMock.mock.calls.at(-1)?.[0];
    expect(lastProjectArgs?.appState.servers).toEqual({});
  });

  it("clears missing dashboard OAuth UI state after the safety timeout", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    try {
      loadAppStateMock.mockReturnValue({
        ...initialAppState,
        projects: {
          default: {
            ...initialAppState.projects.default,
            servers: {},
            createdAt: new Date("2026-01-01T00:00:00.000Z"),
            updatedAt: new Date("2026-01-01T00:00:00.000Z"),
          },
        },
        servers: {},
      });
      localStorage.setItem("mcp-oauth-pending", "demo-server");
      localStorage.setItem(
        "mcp-serverUrl-demo-server",
        "https://example.com/mcp",
      );
      window.history.replaceState({}, "", "/oauth/callback?code=test-code");

      const { result } = renderHook(() =>
        useAppState({
          currentUserId: "user-1",
          currentActorKey: "user-1",
          routeOrganizationId: undefined,
          hasOrganizations: false,
          isLoadingOrganizations: false,
          validOrganizations: [],
        }),
      );

      expect(result.current.pendingDashboardOAuth).toEqual(
        expect.objectContaining({
          serverName: "demo-server",
          serverUrl: "https://example.com/mcp",
        }),
      );

      act(() => {
        vi.advanceTimersByTime(30_000);
      });

      expect(result.current.pendingDashboardOAuth).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

});
