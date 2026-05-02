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

  it("clears hosted OAuth pending state after browser back from consent", async () => {
    localStorage.setItem(
      "mcp-hosted-oauth-pending",
      JSON.stringify({
        surface: "project",
        serverName: "demo-server",
        serverUrl: "https://example.com/mcp",
        returnHash: "#servers",
        startedAt: Date.now(),
      }),
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
        routeOrganizationId: undefined,
        hasOrganizations: false,
        isLoadingOrganizations: false,
        validOrganizations: [],
      }),
    );

    await waitFor(() => {
      expect(useProjectStateMock).toHaveBeenCalled();
    });

    const pageShow = new Event("pageshow") as PageTransitionEvent;
    Object.defineProperty(pageShow, "persisted", { value: true });

    act(() => {
      window.dispatchEvent(pageShow);
    });

    await waitFor(() => {
      const lastProjectArgs = useProjectStateMock.mock.calls.at(-1)?.[0];
      expect(
        lastProjectArgs?.appState.servers["demo-server"]?.connectionStatus,
      ).toBe("failed");
    });
    expect(localStorage.getItem("mcp-hosted-oauth-pending")).toBeNull();
    expect(localStorage.getItem("mcp-oauth-pending")).toBeNull();
    expect(localStorage.getItem("mcp-oauth-return-hash")).toBeNull();
    expect(localStorage.getItem("mcp-quick-connect-pending")).toBeNull();
  });
});
