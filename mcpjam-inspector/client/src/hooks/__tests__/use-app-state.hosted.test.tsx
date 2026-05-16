import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { initialAppState } from "@/state/app-types";
import { writePendingQuickConnect } from "@/lib/quick-connect-pending";

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
  // useQuery is invoked from useAppState to read hostConfigsV2.getProjectDefault.
  // Tests don't exercise mcpProfile-driven behavior, so returning undefined
  // matches the "no profile" path.
  useQuery: () => undefined,
}));

vi.mock("@/lib/config", () => ({
  HOSTED_MODE: true,
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

import { useAppState } from "../use-app-state";

function createLoadedAppState() {
  const baseProject = {
    ...initialAppState.projects.default,
    servers: {
      "demo-server": {
        name: "demo-server",
        config: {
          type: "http",
          url: "https://example.com/mcp",
        } as any,
        lastConnectionTime: new Date("2026-01-01T00:00:00.000Z"),
        connectionStatus: "connecting" as const,
        retryCount: 0,
        enabled: false,
        useOAuth: false,
      },
    },
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
  };

  return {
    ...initialAppState,
    projects: {
      default: baseProject,
    },
    activeProjectId: "default",
    servers: baseProject.servers,
    selectedServer: "demo-server",
  };
}

describe("useAppState hosted OAuth browser back", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    window.history.replaceState({}, "", "/");
    loadAppStateMock.mockReturnValue(createLoadedAppState());
    saveAppStateMock.mockResolvedValue(undefined);
    useProjectStateMock.mockImplementation(({ appState }) => ({
      ...projectStateValue,
      effectiveProjects: appState.projects,
      effectiveActiveProjectId: appState.activeProjectId,
    }));
    useServerStateMock.mockImplementation(({ appState }) => ({
      ...serverStateValue,
      projectServers: appState.servers,
    }));
  });

  // Slice 4: this seeds state via the legacy loadAppState path. Skipped
  // pending a rewrite that uses Convex query mocks.
  it.skip("clears hosted OAuth pending state after browser back from consent", async () => {
    localStorage.setItem(
      "mcp-hosted-oauth-pending",
      JSON.stringify({
        surface: "project",
        serverName: "demo-server",
        serverUrl: "https://example.com/mcp",
        returnHash: "#servers",
        startedAt: Date.now(),
      })
    );
    localStorage.setItem("mcp-oauth-pending", "demo-server");
    localStorage.setItem("mcp-oauth-return-hash", "#servers");
    writePendingQuickConnect({
      serverName: "demo-server",
      displayName: "Demo Server",
      sourceTab: "servers",
      createdAt: Date.now(),
    });

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
      expect(useProjectStateMock).toHaveBeenCalled();
    });

    const pageShow = new Event("pageshow") as PageTransitionEvent;
    Object.defineProperty(pageShow, "persisted", { value: true });

    act(() => {
      window.dispatchEvent(pageShow);
    });

    // The legacy `patchStateForPendingOAuth` flow that mirrored the pending
    // OAuth into a "connecting"/"failed" runtime server is gone post-Slice 5
    // (Convex is the source of truth). Browser-back still has to clear the
    // pending markers so the next attempt isn't gated by a stale flag.
    await waitFor(() => {
      expect(localStorage.getItem("mcp-hosted-oauth-pending")).toBeNull();
    });
    expect(localStorage.getItem("mcp-oauth-pending")).toBeNull();
    expect(localStorage.getItem("mcp-oauth-return-hash")).toBeNull();
    expect(localStorage.getItem("mcp-quick-connect-pending")).toBeNull();
  });
});

describe("useAppState pending OAuth marker org preference", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    window.history.replaceState({}, "", "/oauth/callback?code=xyz");
    loadAppStateMock.mockReturnValue(createLoadedAppState());
    saveAppStateMock.mockResolvedValue(undefined);
    useProjectStateMock.mockImplementation(({ appState }) => ({
      ...projectStateValue,
      effectiveProjects: appState.projects,
      effectiveActiveProjectId: appState.activeProjectId,
    }));
    useServerStateMock.mockImplementation(({ appState }) => ({
      ...serverStateValue,
      projectServers: appState.servers,
    }));
  });

  function writePendingMarker(organizationId: string | null) {
    localStorage.setItem(
      "mcp-hosted-oauth-pending",
      JSON.stringify({
        surface: "project",
        organizationId,
        projectId: "proj-1",
        serverId: "srv-1",
        serverName: "demo-server",
        serverUrl: "https://example.com/mcp",
        returnHash: "#servers",
        startedAt: Date.now(),
      })
    );
  }

  it("falls through to fallback when the marker org is no longer in validOrganizations (stale-org guard, #1)", async () => {
    // User was kicked out of org-stale during the OAuth round-trip.
    writePendingMarker("org-stale");

    const { result } = renderHook(() =>
      useAppState({
        currentUserId: "user-1",
        routeOrganizationId: undefined,
        hasOrganizations: true,
        isLoadingOrganizations: false,
        // org-stale is intentionally absent.
        validOrganizations: [{ _id: "org-current", myRole: "owner" }],
      })
    );

    await waitFor(() => {
      expect(useProjectStateMock).toHaveBeenCalled();
    });

    // Stale marker org id was rejected by the validOrganizations intersection;
    // resolution falls through to the fallback (first valid org).
    expect(result.current.activeOrganizationId).toBe("org-current");
  });

  it("prefers the marker org when it IS still in validOrganizations (race-fix happy path)", async () => {
    writePendingMarker("org-from-marker");

    const { result } = renderHook(() =>
      useAppState({
        currentUserId: "user-1",
        routeOrganizationId: undefined,
        hasOrganizations: true,
        isLoadingOrganizations: false,
        validOrganizations: [
          // Owner of two orgs — fallback would pick the first owned one
          // (org-other) without the marker preference.
          { _id: "org-other", myRole: "owner" },
          { _id: "org-from-marker", myRole: "owner" },
        ],
      })
    );

    await waitFor(() => {
      expect(useProjectStateMock).toHaveBeenCalled();
    });

    expect(result.current.activeOrganizationId).toBe("org-from-marker");
  });

  it("ignores the marker when the URL has no callback params (post-finalize / connection-failure path, #2)", async () => {
    // Simulate the post-callback state: URL has been cleaned by
    // finalizeHostedOAuth, even if the marker somehow survived.
    window.history.replaceState({}, "", "/");
    writePendingMarker("org-from-marker");

    const { result } = renderHook(() =>
      useAppState({
        currentUserId: "user-1",
        routeOrganizationId: undefined,
        hasOrganizations: true,
        isLoadingOrganizations: false,
        validOrganizations: [
          { _id: "org-other", myRole: "owner" },
          { _id: "org-from-marker", myRole: "owner" },
        ],
      })
    );

    await waitFor(() => {
      expect(useProjectStateMock).toHaveBeenCalled();
    });

    // Without ?code/?error in the URL, the marker is inert; resolution falls
    // back to the first owned org rather than restoring the marker's choice.
    expect(result.current.activeOrganizationId).toBe("org-other");
  });

  it("ignores the marker on the WorkOS sign-in callback path (/callback?code=…)", async () => {
    // Regression: WorkOS sign-in lands on /callback?code=… and used to
    // collide with MCP-OAuth detection, surfacing a stale marker (and the
    // "Finishing OAuth sign-in for X…" gate). MCP OAuth always uses
    // /oauth/callback, so the marker must not influence resolution here.
    window.history.replaceState({}, "", "/callback?code=workos-code");
    writePendingMarker("org-from-marker");

    const { result } = renderHook(() =>
      useAppState({
        currentUserId: "user-1",
        routeOrganizationId: undefined,
        hasOrganizations: true,
        isLoadingOrganizations: false,
        validOrganizations: [
          { _id: "org-other", myRole: "owner" },
          { _id: "org-from-marker", myRole: "owner" },
        ],
      })
    );

    await waitFor(() => {
      expect(useProjectStateMock).toHaveBeenCalled();
    });

    expect(result.current.activeOrganizationId).toBe("org-other");
  });
});
