import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { initialAppState } from "@/state/app-types";
import { useAppState } from "../use-app-state";

const {
  loadAppStateMock,
  saveAppStateMock,
  useWorkspaceStateMock,
  useServerStateMock,
  workspaceStateValue,
  serverStateValue,
} = vi.hoisted(() => ({
  loadAppStateMock: vi.fn(),
  saveAppStateMock: vi.fn(),
  useWorkspaceStateMock: vi.fn(),
  useServerStateMock: vi.fn(),
  workspaceStateValue: {
    effectiveWorkspaces: {},
    setConvexActiveWorkspaceId: vi.fn(),
    clearConvexActiveWorkspaceSelection: vi.fn(),
    useLocalFallback: false,
    remoteWorkspaces: [],
    isLoadingRemoteWorkspaces: false,
    effectiveActiveWorkspaceId: "none",
    isLoadingWorkspaces: false,
    activeWorkspaceServersFlat: undefined,
    handleCreateWorkspace: vi.fn(),
    handleUpdateWorkspace: vi.fn(),
    handleUpdateClientConfig: vi.fn(),
    handleDeleteWorkspace: vi.fn(),
    handleDuplicateWorkspace: vi.fn(),
    handleSetDefaultWorkspace: vi.fn(),
    handleWorkspaceShared: vi.fn(),
    handleExportWorkspace: vi.fn(),
    handleImportWorkspace: vi.fn(),
  },
  serverStateValue: {
    workspaceServers: {},
    connectedOrConnectingServerConfigs: {},
    selectedServerEntry: undefined,
    selectedMCPConfig: undefined,
    selectedMCPConfigs: [],
    selectedMCPConfigsMap: {},
    isMultiSelectMode: false,
    activeWorkspace: undefined,
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

vi.mock("../use-workspace-state", () => ({
  useWorkspaceState: (...args: unknown[]) => useWorkspaceStateMock(...args),
}));

vi.mock("../use-server-state", () => ({
  useServerState: (...args: unknown[]) => useServerStateMock(...args),
}));

describe("useAppState active organization recovery", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    loadAppStateMock.mockReturnValue(initialAppState);
    useWorkspaceStateMock.mockReturnValue(workspaceStateValue);
    useServerStateMock.mockReturnValue(serverStateValue);
  });

  it("recovers a stale stored org to the first owned organization", async () => {
    localStorage.setItem("active-organization-id:user-1", "org-stale");

    const { result } = renderHook(() =>
      useAppState({
        currentUserId: "user-1",
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

    expect(useWorkspaceStateMock).toHaveBeenLastCalledWith(
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
        routeOrganizationId: undefined,
        hasOrganizations: true,
        isLoadingOrganizations: false,
        validOrganizations: [
          { _id: "org-owned", myRole: "owner" },
          { _id: "org-stored", myRole: "member" },
        ],
      }),
    );

    expect(useWorkspaceStateMock).toHaveBeenCalled();
    expect(useWorkspaceStateMock.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        activeOrganizationId: undefined,
      }),
    );

    await waitFor(() => {
      expect(result.current.activeOrganizationId).toBe("org-stored");
    });
  });

  it("clears a stale stored org when no valid organizations remain", async () => {
    localStorage.setItem("active-organization-id:user-1", "org-stale");

    const { result } = renderHook(() =>
      useAppState({
        currentUserId: "user-1",
        routeOrganizationId: undefined,
        hasOrganizations: false,
        isLoadingOrganizations: false,
        validOrganizations: [],
      }),
    );

    await waitFor(() => {
      expect(result.current.activeOrganizationId).toBeUndefined();
    });

    expect(useWorkspaceStateMock).toHaveBeenLastCalledWith(
      expect.objectContaining({
        activeOrganizationId: undefined,
        validOrganizationIds: [],
      }),
    );
    expect(localStorage.getItem("active-organization-id:user-1")).toBeNull();
  });
});
