import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { initialAppState } from "@/state/app-types";
import { buildDisconnectedRuntimeServers, useAppState } from "../use-app-state";

const {
  loadAppStateMock,
  saveAppStateMock,
  useProjectStateMock,
  useServerStateMock,
  projectStateValue,
  serverStateValue,
} = vi.hoisted(() => ({
  loadAppStateMock: vi.fn(),
  saveAppStateMock: vi.fn(),
  useProjectStateMock: vi.fn(),
  useServerStateMock: vi.fn(),
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
  useConvexAuth: () => ({
    isAuthenticated: true,
    isLoading: false,
  }),
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
    | "failed" = "connected"
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
        selectedServerState.connectionStatus
      ),
    },
    selectedServer: selectedServerState.name,
  };
}

function createProject(
  id: string,
  options: {
    organizationId?: string;
    servers?: Record<string, ReturnType<typeof createServer>>;
    isDefault?: boolean;
  } = {}
) {
  return {
    ...initialAppState.projects.default,
    id,
    name: id,
    organizationId: options.organizationId,
    servers: options.servers ?? {},
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    isDefault: options.isDefault ?? false,
  };
}

function renderDefaultUseAppState() {
  return renderHook(() =>
    useAppState({
      currentUserId: "user-1",
      routeOrganizationId: undefined,
      hasOrganizations: false,
      isLoadingOrganizations: false,
      validOrganizations: [],
    })
  );
}

describe("useAppState active organization recovery", () => {
  beforeEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
    localStorage.clear();
    window.history.replaceState({}, "", "/");
    loadAppStateMock.mockReturnValue(initialAppState);
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
      })
    );

    await waitFor(() => {
      expect(result.current.activeOrganizationId).toBe("org-owned");
    });

    expect(useProjectStateMock).toHaveBeenLastCalledWith(
      expect.objectContaining({
        activeOrganizationId: "org-owned",
        validOrganizationIds: ["org-member", "org-owned"],
      })
    );
    expect(localStorage.getItem("active-organization-id:user-1")).toBe(
      "org-owned"
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
      })
    );

    expect(useProjectStateMock).toHaveBeenCalled();
    expect(useProjectStateMock.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        activeOrganizationId: undefined,
      })
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
      })
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
      })
    );

    await waitFor(() => {
      expect(result.current.activeOrganizationId).toBeUndefined();
    });

    expect(useProjectStateMock).toHaveBeenLastCalledWith(
      expect.objectContaining({
        activeOrganizationId: undefined,
        validOrganizationIds: [],
      })
    );
    expect(localStorage.getItem("active-organization-id:user-1")).toBeNull();
  });

  it("builds disconnected runtime servers from cached project servers", () => {
    expect(
      buildDisconnectedRuntimeServers({
        champions: createServer("champions"),
        linear: createServer("linear", "disconnected"),
      })
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

  it("disconnects previous runtime servers when the active project changes", async () => {
    const zombieServer = createServer("zombie-server", "connected");
    const connectingServer = createServer("connecting-server", "connecting");
    const oauthServer = createServer("oauth-server", "oauth-flow");
    const disconnectedServer = createServer(
      "disconnected-server",
      "disconnected"
    );
    const nextServer = createServer("next-server", "disconnected");
    const projectA = createProject("p1", {
      organizationId: "org-a",
      servers: {
        "zombie-server": zombieServer,
        "connecting-server": connectingServer,
        "oauth-server": oauthServer,
        "disconnected-server": disconnectedServer,
      },
      isDefault: true,
    });
    const projectB = createProject("p2", {
      organizationId: "org-b",
      servers: { "next-server": nextServer },
    });

    loadAppStateMock.mockReturnValue({
      ...initialAppState,
      projects: { p1: projectA, p2: projectB },
      activeProjectId: "p1",
      servers: {
        "zombie-server": zombieServer,
        "connecting-server": connectingServer,
        "oauth-server": oauthServer,
        "disconnected-server": disconnectedServer,
      },
      selectedServer: "zombie-server",
    });
    Object.assign(projectStateValue, {
      effectiveProjects: { p1: projectA, p2: projectB },
      effectiveActiveProjectId: "p1",
      useLocalFallback: true,
    });

    const { result } = renderDefaultUseAppState();

    expect(serverStateValue.handleDisconnect).not.toHaveBeenCalled();

    act(() => {
      Object.assign(projectStateValue, {
        effectiveProjects: { p2: projectB },
        effectiveActiveProjectId: "p2",
      });
      result.current.clearLocalFallbackProjectSelection("org-a", "org-b");
    });

    await waitFor(() => {
      expect(serverStateValue.handleDisconnect).toHaveBeenCalledWith(
        "zombie-server"
      );
      expect(serverStateValue.handleDisconnect).toHaveBeenCalledWith(
        "connecting-server"
      );
      expect(serverStateValue.handleDisconnect).toHaveBeenCalledWith(
        "oauth-server"
      );
    });
    expect(serverStateValue.handleDisconnect).not.toHaveBeenCalledWith(
      "disconnected-server"
    );
  });

  it("does not disconnect servers when the active project id is unchanged", () => {
    const connectedServer = createServer("steady-server", "connected");
    const project = createProject("p1", {
      servers: { "steady-server": connectedServer },
      isDefault: true,
    });

    loadAppStateMock.mockReturnValue({
      ...initialAppState,
      projects: { p1: project },
      activeProjectId: "p1",
      servers: { "steady-server": connectedServer },
      selectedServer: "steady-server",
    });
    Object.assign(projectStateValue, {
      effectiveProjects: { p1: project },
      effectiveActiveProjectId: "p1",
      useLocalFallback: true,
    });

    const { rerender } = renderDefaultUseAppState();
    rerender();

    expect(serverStateValue.handleDisconnect).not.toHaveBeenCalled();
  });

  it("does not disconnect when the initial empty project selection resolves", () => {
    const connectedServer = createServer("loading-server", "connected");
    const project = createProject("p1", {
      servers: { "loading-server": connectedServer },
      isDefault: true,
    });

    loadAppStateMock.mockReturnValue({
      ...initialAppState,
      projects: { p1: project },
      activeProjectId: "p1",
      servers: { "loading-server": connectedServer },
      selectedServer: "loading-server",
    });
    Object.assign(projectStateValue, {
      effectiveProjects: {},
      effectiveActiveProjectId: "none",
      useLocalFallback: true,
    });

    const { rerender } = renderDefaultUseAppState();

    Object.assign(projectStateValue, {
      effectiveProjects: { p1: project },
      effectiveActiveProjectId: "p1",
    });
    rerender();

    expect(serverStateValue.handleDisconnect).not.toHaveBeenCalled();
  });

  it("keeps the syncing flag on while a runtime-only selected server is still awaiting cloud echo", async () => {
    loadAppStateMock.mockReturnValue(
      createLoadedAppState({
        name: "pending-server",
        connectionStatus: "connected",
      })
    );
    Object.assign(projectStateValue, {
      effectiveProjects: {
        default: {
          ...initialAppState.projects.default,
          servers: {},
          createdAt: new Date("2026-01-01T00:00:00.000Z"),
          updatedAt: new Date("2026-01-01T00:00:00.000Z"),
        },
      },
      effectiveActiveProjectId: "default",
      remoteProjects: [],
      useLocalFallback: false,
    });
    Object.assign(serverStateValue, {
      projectServers: {},
      selectedMCPConfig: undefined,
    });

    const { result } = renderHook(() =>
      useAppState({
        currentUserId: "user-1",
        currentActorKey: "user-1",
        routeOrganizationId: undefined,
        hasOrganizations: false,
        isLoadingOrganizations: false,
        validOrganizations: [],
      })
    );

    await waitFor(() => {
      expect(result.current.isSelectedServerSyncing).toBe(true);
    });
  });

  it("drops the syncing flag once the runtime-only selected server has already failed", async () => {
    const failedServer = {
      ...createServer("failed-server"),
      connectionStatus: "failed" as const,
      enabled: true,
    };

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
      servers: {
        "failed-server": failedServer,
      },
      selectedServer: "failed-server",
    });
    Object.assign(projectStateValue, {
      effectiveProjects: {
        default: {
          ...initialAppState.projects.default,
          servers: {},
          createdAt: new Date("2026-01-01T00:00:00.000Z"),
          updatedAt: new Date("2026-01-01T00:00:00.000Z"),
        },
      },
      effectiveActiveProjectId: "default",
      remoteProjects: [],
      useLocalFallback: false,
    });
    Object.assign(serverStateValue, {
      projectServers: {},
      selectedMCPConfig: undefined,
    });

    const { result } = renderHook(() =>
      useAppState({
        currentUserId: "user-1",
        currentActorKey: "user-1",
        routeOrganizationId: undefined,
        hasOrganizations: false,
        isLoadingOrganizations: false,
        validOrganizations: [],
      })
    );

    await waitFor(() => {
      expect(result.current.isSelectedServerSyncing).toBe(false);
    });
  });

  it.each(["chatbox", "shared"] as const)(
    "does not patch dashboard server state for hosted %s OAuth callbacks",
    async (surface) => {
      loadAppStateMock.mockReturnValue(
        createLoadedAppState({
          name: "demo-server",
          connectionStatus: "disconnected",
        })
      );
      localStorage.setItem(
        "mcp-hosted-oauth-pending",
        JSON.stringify({
          surface,
          serverName: "demo-server",
          serverUrl: "https://example.com/mcp",
          returnHash: "#demo",
          startedAt: Date.now(),
        })
      );
      localStorage.setItem("mcp-oauth-pending", "demo-server");
      window.history.replaceState({}, "", "/oauth/callback?code=test-code");

      renderHook(() =>
        useAppState({
          currentUserId: "user-1",
          currentActorKey: "user-1",
          routeOrganizationId: undefined,
          hasOrganizations: false,
          isLoadingOrganizations: false,
          validOrganizations: [],
        })
      );

      await waitFor(() => {
        const lastProjectArgs = useProjectStateMock.mock.calls.at(-1)?.[0];
        expect(
          lastProjectArgs?.appState.servers["demo-server"]?.connectionStatus
        ).toBe("disconnected");
      });
    }
  );

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
    localStorage.setItem(
      "mcp-serverUrl-demo-server",
      "https://example.com/mcp"
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
      })
    );

    await waitFor(() => {
      expect(result.current.pendingDashboardOAuth).toEqual(
        expect.objectContaining({
          serverName: "demo-server",
          serverUrl: "https://example.com/mcp",
        })
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
        "https://example.com/mcp"
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
        })
      );

      expect(result.current.pendingDashboardOAuth).toEqual(
        expect.objectContaining({
          serverName: "demo-server",
          serverUrl: "https://example.com/mcp",
        })
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
