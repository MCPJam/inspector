import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { initialAppState } from "@/state/app-types";
import type { Organization } from "../useOrganizations";
import { useAppState } from "../use-app-state";

const {
  clearLegacyActiveOrganizationStorageMock,
  loadAppStateMock,
  logger,
  mockUseConvexAuth,
  readStoredActiveOrganizationIdMock,
  saveAppStateMock,
  useServerStateMock,
  useWorkspaceStateMock,
  writeStoredActiveOrganizationIdMock,
} = vi.hoisted(() => ({
  clearLegacyActiveOrganizationStorageMock: vi.fn(),
  loadAppStateMock: vi.fn(),
  logger: {
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  },
  mockUseConvexAuth: vi.fn(),
  readStoredActiveOrganizationIdMock: vi.fn(),
  saveAppStateMock: vi.fn(),
  useServerStateMock: vi.fn(),
  useWorkspaceStateMock: vi.fn(),
  writeStoredActiveOrganizationIdMock: vi.fn(),
}));

vi.mock("convex/react", () => ({
  useConvexAuth: (...args: unknown[]) => mockUseConvexAuth(...args),
}));

vi.mock("sonner", () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
  },
}));

vi.mock("../use-logger", () => ({
  useLogger: () => logger,
}));

vi.mock("../use-workspace-state", () => ({
  useWorkspaceState: (...args: unknown[]) => useWorkspaceStateMock(...args),
}));

vi.mock("../use-server-state", () => ({
  useServerState: (...args: unknown[]) => useServerStateMock(...args),
}));

vi.mock("@/state/storage", () => ({
  loadAppState: () => loadAppStateMock(),
  saveAppState: (...args: unknown[]) => saveAppStateMock(...args),
}));

vi.mock("@/lib/active-organization-storage", () => ({
  clearLegacyActiveOrganizationStorage: (...args: unknown[]) =>
    clearLegacyActiveOrganizationStorageMock(...args),
  readStoredActiveOrganizationId: (...args: unknown[]) =>
    readStoredActiveOrganizationIdMock(...args),
  writeStoredActiveOrganizationId: (...args: unknown[]) =>
    writeStoredActiveOrganizationIdMock(...args),
}));

function createOrganization(
  id: string,
  myRole?: Organization["myRole"],
): Organization {
  return {
    _id: id,
    name: id,
    createdBy: "user-1",
    createdAt: 1,
    updatedAt: 1,
    myRole,
  };
}

function createWorkspaceStateMock() {
  return {
    remoteWorkspaces: [],
    isLoadingWorkspaces: false,
    activeWorkspaceServersFlat: undefined,
    useLocalFallback: false,
    setConvexActiveWorkspaceId: vi.fn(),
    isLoadingRemoteWorkspaces: false,
    effectiveWorkspaces: {},
    effectiveActiveWorkspaceId: "none",
    handleCreateWorkspace: vi.fn(),
    handleUpdateWorkspace: vi.fn(),
    handleUpdateClientConfig: vi.fn(),
    handleDeleteWorkspace: vi.fn(),
    handleDuplicateWorkspace: vi.fn(),
    handleSetDefaultWorkspace: vi.fn(),
    handleWorkspaceShared: vi.fn(),
    handleExportWorkspace: vi.fn(),
    handleImportWorkspace: vi.fn(),
  };
}

function createServerStateMock() {
  return {
    workspaceServers: {},
    connectedOrConnectingServerConfigs: {},
    selectedServerEntry: undefined,
    selectedMCPConfig: null,
    selectedMCPConfigs: [],
    selectedMCPConfigsMap: new Map(),
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
  };
}

function renderUseAppState({
  currentUserId = "user-1",
  routeOrganizationId,
  sortedOrganizations = [],
  isLoadingOrganizations = false,
}: {
  currentUserId?: string | null;
  routeOrganizationId?: string;
  sortedOrganizations?: Organization[];
  isLoadingOrganizations?: boolean;
}) {
  return renderHook(() =>
    useAppState({
      currentUserId,
      routeOrganizationId,
      sortedOrganizations,
      isLoadingOrganizations,
    }),
  );
}

describe("useAppState organization fallback selection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseConvexAuth.mockReturnValue({
      isAuthenticated: true,
      isLoading: false,
    });
    loadAppStateMock.mockReturnValue(initialAppState);
    readStoredActiveOrganizationIdMock.mockReturnValue(undefined);
    useWorkspaceStateMock.mockImplementation(() => createWorkspaceStateMock());
    useServerStateMock.mockImplementation(() => createServerStateMock());
  });

  it("selects the first owned organization when there is no stored selection", async () => {
    const { result } = renderUseAppState({
      sortedOrganizations: [
        createOrganization("org-member", "member"),
        createOrganization("org-owner", "owner"),
      ],
    });

    await waitFor(() => {
      expect(result.current.activeOrganizationId).toBe("org-owner");
    });
    await waitFor(() => {
      expect(useWorkspaceStateMock).toHaveBeenLastCalledWith(
        expect.objectContaining({
          activeOrganizationId: "org-owner",
          routeOrganizationId: undefined,
        }),
      );
    });
    await waitFor(() => {
      expect(writeStoredActiveOrganizationIdMock).toHaveBeenCalledWith(
        "user-1",
        "org-owner",
      );
    });
  });

  it("selects the first organization when there is no owned organization", async () => {
    const { result } = renderUseAppState({
      sortedOrganizations: [
        createOrganization("org-first", "member"),
        createOrganization("org-second", "admin"),
      ],
    });

    await waitFor(() => {
      expect(result.current.activeOrganizationId).toBe("org-first");
    });
    await waitFor(() => {
      expect(writeStoredActiveOrganizationIdMock).toHaveBeenCalledWith(
        "user-1",
        "org-first",
      );
    });
  });

  it("keeps a valid stored active organization over fallback selection", async () => {
    readStoredActiveOrganizationIdMock.mockReturnValue("org-stored");

    const { result } = renderUseAppState({
      sortedOrganizations: [
        createOrganization("org-owner", "owner"),
        createOrganization("org-stored", "member"),
      ],
    });

    await waitFor(() => {
      expect(result.current.activeOrganizationId).toBe("org-stored");
    });
    await waitFor(() => {
      expect(useWorkspaceStateMock).toHaveBeenLastCalledWith(
        expect.objectContaining({
          activeOrganizationId: "org-stored",
        }),
      );
    });

    expect(writeStoredActiveOrganizationIdMock).not.toHaveBeenCalled();
  });

  it("falls back to the owned organization when the stored selection is stale", async () => {
    readStoredActiveOrganizationIdMock.mockReturnValue("org-stale");

    const { result } = renderUseAppState({
      sortedOrganizations: [
        createOrganization("org-member", "member"),
        createOrganization("org-owner", "owner"),
      ],
    });

    await waitFor(() => {
      expect(result.current.activeOrganizationId).toBe("org-owner");
    });
    await waitFor(() => {
      expect(writeStoredActiveOrganizationIdMock).toHaveBeenCalledWith(
        "user-1",
        "org-owner",
      );
    });
  });

  it("lets the route organization win over stored and fallback selection", async () => {
    readStoredActiveOrganizationIdMock.mockReturnValue("org-stored");

    const { result } = renderUseAppState({
      routeOrganizationId: "org-route",
      sortedOrganizations: [
        createOrganization("org-owner", "owner"),
        createOrganization("org-stored", "member"),
        createOrganization("org-route", "member"),
      ],
    });

    await waitFor(() => {
      expect(result.current.activeOrganizationId).toBe("org-route");
    });
    await waitFor(() => {
      expect(useWorkspaceStateMock).toHaveBeenLastCalledWith(
        expect.objectContaining({
          activeOrganizationId: "org-route",
          routeOrganizationId: "org-route",
        }),
      );
    });
    await waitFor(() => {
      expect(writeStoredActiveOrganizationIdMock).toHaveBeenCalledWith(
        "user-1",
        "org-route",
      );
    });
  });

  it("remains unselected when the authenticated user has no organizations", async () => {
    const { result } = renderUseAppState({
      sortedOrganizations: [],
    });

    await waitFor(() => {
      expect(result.current.activeOrganizationId).toBeUndefined();
    });
    await waitFor(() => {
      expect(useWorkspaceStateMock).toHaveBeenLastCalledWith(
        expect.objectContaining({
          activeOrganizationId: undefined,
          routeOrganizationId: undefined,
        }),
      );
    });

    expect(writeStoredActiveOrganizationIdMock).not.toHaveBeenCalled();
  });
});
