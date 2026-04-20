import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { toast } from "sonner";
import { useConvexAuth } from "convex/react";
import { useLogger } from "./use-logger";
import {
  initialAppState,
  type AppState,
  type ServerWithName,
} from "@/state/app-types";
import { appReducer } from "@/state/app-reducer";
import { loadAppState, saveAppState } from "@/state/storage";
import { useWorkspaceState } from "./use-workspace-state";
import { useServerState } from "./use-server-state";
import {
  clearLegacyActiveOrganizationStorage,
  readStoredActiveOrganizationId,
  writeStoredActiveOrganizationId,
} from "@/lib/active-organization-storage";
import { HOSTED_OAUTH_PENDING_STORAGE_KEY } from "@/lib/hosted-oauth-callback";

export type { ServerWithName } from "@/state/app-types";
export type { ServerUpdateResult } from "./use-server-state";

interface ActiveOrganizationSelection {
  organizationId?: string;
  userId: string | null;
}

function resolveFallbackOrganizationId(
  organizations: ReadonlyArray<{ _id: string; myRole?: string }>,
) {
  const firstOwnedOrganization = organizations.find(
    (organization) => organization.myRole === "owner",
  );

  return firstOwnedOrganization?._id ?? organizations[0]?._id;
}

function createDefaultWorkspace() {
  return {
    ...initialAppState.workspaces.default,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

// Resolves the server name for a pending OAuth callback by checking the
// hosted OAuth marker first (preferred), then the legacy localStorage key.
function resolvePendingOAuthServerName(): string | null {
  if (typeof window === "undefined") return null;
  if (!new URLSearchParams(window.location.search).has("code")) return null;

  try {
    const raw = localStorage.getItem(HOSTED_OAUTH_PENDING_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as {
        serverName?: unknown;
        surface?: unknown;
      } | null;
      if (parsed?.surface === "chatbox" || parsed?.surface === "shared") {
        return null;
      }
      if (
        parsed?.surface === "workspace" &&
        typeof parsed.serverName === "string" &&
        parsed.serverName
      ) {
        return parsed.serverName;
      }
    }
  } catch {
    // ignore
  }
  return localStorage.getItem("mcp-oauth-pending");
}

// Patches the loaded state so a pending OAuth server starts as "connecting"
// rather than "disconnected", preventing a flash on the first rendered frame.
function patchStateForPendingOAuth(
  state: AppState,
  serverName: string,
): AppState {
  const existing = state.servers[serverName];
  if (existing) {
    return {
      ...state,
      servers: {
        ...state.servers,
        [serverName]: { ...existing, connectionStatus: "connecting" },
      },
    };
  }
  // Server not yet in local state (e.g. hosted mode) — seed a minimal entry.
  const storedUrl = localStorage.getItem(`mcp-serverUrl-${serverName}`);
  if (!storedUrl) return state;
  try {
    new URL(storedUrl);
    return {
      ...state,
      servers: {
        ...state.servers,
        [serverName]: {
          name: serverName,
          config: { url: storedUrl } as ServerWithName["config"],
          lastConnectionTime: new Date(),
          connectionStatus: "connecting",
          retryCount: 0,
          enabled: true,
          useOAuth: true,
        } as ServerWithName,
      },
    };
  } catch {
    return state;
  }
}

export function buildDisconnectedRuntimeServers(
  servers: Record<string, ServerWithName> | undefined,
): Record<string, ServerWithName> {
  return Object.fromEntries(
    Object.entries(servers ?? {}).map(([serverName, server]) => [
      serverName,
      {
        ...server,
        connectionStatus: "disconnected",
      } satisfies ServerWithName,
    ]),
  );
}

export function useAppState({
  currentUserId,
  routeOrganizationId,
  hasOrganizations,
  isLoadingOrganizations,
  validOrganizations,
}: {
  currentUserId: string | null;
  routeOrganizationId?: string;
  hasOrganizations: boolean;
  isLoadingOrganizations: boolean;
  validOrganizations: Array<{ _id: string; myRole?: string }>;
}) {
  const logger = useLogger("Connections");
  const [appState, dispatch] = useReducer(appReducer, initialAppState);
  const [isLoading, setIsLoading] = useState(true);

  const { isAuthenticated, isLoading: isAuthLoading } = useConvexAuth();

  const [activeOrganizationSelection, setActiveOrganizationSelection] =
    useState<ActiveOrganizationSelection>({
      organizationId: undefined,
      userId: currentUserId,
    });
  const [
    hasHydratedStoredActiveOrganization,
    setHasHydratedStoredActiveOrganization,
  ] = useState(false);
  const storedActiveOrganizationId =
    activeOrganizationSelection.userId === currentUserId
      ? activeOrganizationSelection.organizationId
      : undefined;
  const isStoredActiveOrganizationValid =
    !!storedActiveOrganizationId &&
    validOrganizations.some(
      (organization) => organization._id === storedActiveOrganizationId,
    );
  const isRouteOrganizationValid =
    !!routeOrganizationId &&
    validOrganizations.some(
      (organization) => organization._id === routeOrganizationId,
    );
  const fallbackActiveOrganizationId =
    hasHydratedStoredActiveOrganization &&
    !routeOrganizationId &&
    !isLoadingOrganizations
      ? resolveFallbackOrganizationId(validOrganizations)
      : undefined;
  const activeOrganizationId = isStoredActiveOrganizationValid
    ? storedActiveOrganizationId
    : fallbackActiveOrganizationId;
  const setActiveOrganizationId = useCallback(
    (organizationId: string | undefined) => {
      setActiveOrganizationSelection({
        organizationId,
        userId: currentUserId,
      });
    },
    [currentUserId],
  );

  useEffect(() => {
    clearLegacyActiveOrganizationStorage();
    setHasHydratedStoredActiveOrganization(false);
    setActiveOrganizationSelection({
      organizationId: readStoredActiveOrganizationId(currentUserId),
      userId: currentUserId,
    });
    setHasHydratedStoredActiveOrganization(true);
  }, [currentUserId]);

  const isFirstScopedOrgRender = useRef(true);
  useEffect(() => {
    if (!hasHydratedStoredActiveOrganization) {
      return;
    }
    if (activeOrganizationSelection.userId !== currentUserId) {
      return;
    }

    clearLegacyActiveOrganizationStorage();
    if (isFirstScopedOrgRender.current) {
      isFirstScopedOrgRender.current = false;
      return;
    }

    writeStoredActiveOrganizationId(
      currentUserId,
      activeOrganizationSelection.organizationId,
    );
  }, [
    activeOrganizationSelection,
    currentUserId,
    hasHydratedStoredActiveOrganization,
  ]);

  useEffect(() => {
    if (!hasHydratedStoredActiveOrganization) {
      return;
    }
    if (activeOrganizationSelection.userId !== currentUserId) {
      return;
    }
    if (!routeOrganizationId || isLoadingOrganizations) {
      return;
    }
    if (!isRouteOrganizationValid) {
      return;
    }
    if (activeOrganizationSelection.organizationId === routeOrganizationId) {
      return;
    }

    setActiveOrganizationSelection({
      organizationId: routeOrganizationId,
      userId: currentUserId,
    });
  }, [
    activeOrganizationSelection.organizationId,
    activeOrganizationSelection.userId,
    currentUserId,
    hasHydratedStoredActiveOrganization,
    isLoadingOrganizations,
    isRouteOrganizationValid,
    routeOrganizationId,
  ]);

  useEffect(() => {
    if (!hasHydratedStoredActiveOrganization) {
      return;
    }
    if (activeOrganizationSelection.userId !== currentUserId) {
      return;
    }
    if (routeOrganizationId || isLoadingOrganizations) {
      return;
    }

    const nextOrganizationId = activeOrganizationId;
    if (activeOrganizationSelection.organizationId === nextOrganizationId) {
      return;
    }

    setActiveOrganizationSelection({
      organizationId: nextOrganizationId,
      userId: currentUserId,
    });
  }, [
    activeOrganizationId,
    activeOrganizationSelection.organizationId,
    activeOrganizationSelection.userId,
    currentUserId,
    hasHydratedStoredActiveOrganization,
    isLoadingOrganizations,
    routeOrganizationId,
  ]);

  useEffect(() => {
    try {
      const loaded = loadAppState();
      const pendingOAuthServerName = resolvePendingOAuthServerName();
      const hydratedState = pendingOAuthServerName
        ? patchStateForPendingOAuth(loaded, pendingOAuthServerName)
        : loaded;
      dispatch({ type: "HYDRATE_STATE", payload: hydratedState });
    } catch (error) {
      logger.error("Failed to load saved state", {
        error: error instanceof Error ? error.message : "Unknown error",
      });
    } finally {
      setIsLoading(false);
    }
  }, [logger]);

  useEffect(() => {
    if (!isLoading) saveAppState(appState);
  }, [appState, isLoading]);

  const workspaceState = useWorkspaceState({
    appState,
    dispatch,
    isAuthenticated,
    isAuthLoading,
    hasOrganizations,
    isLoadingOrganizations,
    validOrganizationIds: validOrganizations.map(
      (organization) => organization._id,
    ),
    activeOrganizationId,
    routeOrganizationId,
    logger,
  });

  const serverState = useServerState({
    appState,
    dispatch,
    isLoading,
    isAuthenticated,
    isAuthLoading,
    isLoadingWorkspaces: workspaceState.isLoadingWorkspaces,
    useLocalFallback: workspaceState.useLocalFallback,
    effectiveWorkspaces: workspaceState.effectiveWorkspaces,
    effectiveActiveWorkspaceId: workspaceState.effectiveActiveWorkspaceId,
    activeWorkspaceServersFlat: workspaceState.activeWorkspaceServersFlat,
    logger,
  });

  const {
    effectiveWorkspaces,
    setConvexActiveWorkspaceId,
    clearConvexActiveWorkspaceSelection,
    useLocalFallback,
    remoteWorkspaces,
    isLoadingRemoteWorkspaces,
    effectiveActiveWorkspaceId,
  } = workspaceState;
  const { handleDisconnect } = serverState;

  const handleSwitchWorkspace = useCallback(
    async (workspaceId: string) => {
      const newWorkspace = effectiveWorkspaces[workspaceId];
      if (!newWorkspace) {
        toast.error("Workspace not found");
        return;
      }

      logger.info("Switching to workspace", {
        workspaceId,
        name: newWorkspace.name,
      });

      const currentServers = Object.keys(appState.servers);
      for (const serverName of currentServers) {
        const server = appState.servers[serverName];
        if (server.connectionStatus === "connected") {
          logger.info("Disconnecting server before workspace switch", {
            serverName,
          });
          await handleDisconnect(serverName);
        }
      }

      if (isAuthenticated && !useLocalFallback) {
        setConvexActiveWorkspaceId(workspaceId);
      } else {
        dispatch({ type: "SWITCH_WORKSPACE", workspaceId });
      }
      toast.success(`Switched to workspace: ${newWorkspace.name}`);
    },
    [
      effectiveWorkspaces,
      appState.servers,
      handleDisconnect,
      logger,
      isAuthenticated,
      useLocalFallback,
      dispatch,
      setConvexActiveWorkspaceId,
    ],
  );

  const handleLeaveWorkspace = useCallback(
    async (workspaceId: string) => {
      const workspace = effectiveWorkspaces[workspaceId];
      if (!workspace) {
        toast.error("Workspace not found");
        return;
      }

      const otherWorkspaceIds = Object.keys(effectiveWorkspaces).filter(
        (id) => id !== workspaceId,
      );
      const defaultWorkspace = otherWorkspaceIds.find(
        (id) => effectiveWorkspaces[id].isDefault,
      );
      const targetWorkspaceId = defaultWorkspace || otherWorkspaceIds[0];

      if (!targetWorkspaceId) {
        toast.error("Cannot leave the only workspace");
        return;
      }

      const workspaceServers = Object.keys(workspace.servers || {});
      for (const serverName of workspaceServers) {
        const runtimeServer = appState.servers[serverName];
        if (runtimeServer?.connectionStatus === "connected") {
          await handleDisconnect(serverName);
        }
      }

      if (isAuthenticated && !useLocalFallback) {
        setConvexActiveWorkspaceId(targetWorkspaceId);
      } else {
        dispatch({ type: "SWITCH_WORKSPACE", workspaceId: targetWorkspaceId });
        dispatch({ type: "DELETE_WORKSPACE", workspaceId });
      }
    },
    [
      effectiveWorkspaces,
      appState.servers,
      handleDisconnect,
      isAuthenticated,
      useLocalFallback,
      dispatch,
      setConvexActiveWorkspaceId,
    ],
  );

  const clearLocalFallbackWorkspaceSelection = useCallback(
    (deletedOrganizationId: string, fallbackOrganizationId?: string) => {
      const remainingEntries = Object.entries(appState.workspaces).filter(
        ([, workspace]) => workspace.organizationId !== deletedOrganizationId,
      );
      const nextWorkspaces =
        remainingEntries.length > 0
          ? Object.fromEntries(remainingEntries)
          : { default: createDefaultWorkspace() };
      const preferredWorkspaceForFallbackOrg = fallbackOrganizationId
        ? Object.values(nextWorkspaces).find(
            (workspace) => workspace.organizationId === fallbackOrganizationId,
          )
        : undefined;
      const nextActiveWorkspace =
        preferredWorkspaceForFallbackOrg ??
        nextWorkspaces[appState.activeWorkspaceId] ??
        nextWorkspaces.default ??
        Object.values(nextWorkspaces)[0];
      const nextActiveWorkspaceId = nextActiveWorkspace?.id ?? "default";
      const nextServers = buildDisconnectedRuntimeServers(
        nextActiveWorkspace?.servers,
      );

      dispatch({
        type: "HYDRATE_STATE",
        payload: {
          ...appState,
          workspaces: nextWorkspaces,
          activeWorkspaceId: nextActiveWorkspaceId,
          servers: nextServers,
          selectedServer: "none",
          selectedMultipleServers: [],
        },
      });
    },
    [appState, dispatch],
  );

  const isCloudSyncActive =
    isAuthenticated && !useLocalFallback && remoteWorkspaces !== undefined;
  const selectedRuntimeServer =
    appState.selectedServer !== "none"
      ? appState.servers[appState.selectedServer]
      : undefined;
  const isSelectedServerSyncing =
    isCloudSyncActive &&
    !!selectedRuntimeServer &&
    !serverState.workspaceServers[appState.selectedServer] &&
    selectedRuntimeServer.connectionStatus !== "failed" &&
    selectedRuntimeServer.connectionStatus !== "disconnected";

  return {
    appState,
    isLoading,
    isLoadingRemoteWorkspaces,
    isCloudSyncActive,
    activeOrganizationId,
    setActiveOrganizationId,
    clearConvexActiveWorkspaceSelection,
    clearLocalFallbackWorkspaceSelection,

    workspaceServers: serverState.workspaceServers,
    connectedOrConnectingServerConfigs:
      serverState.connectedOrConnectingServerConfigs,
    selectedServerEntry: serverState.selectedServerEntry,
    selectedMCPConfig: serverState.selectedMCPConfig,
    // True when the currently selected server exists only in runtime state and
    // is still in a non-terminal state while cloud sync catches up. Once the
    // connection has failed or been disconnected, stop showing a loading UI
    // and let consumers fall back to the normal empty/error states.
    isSelectedServerSyncing,
    selectedMCPConfigs: serverState.selectedMCPConfigs,
    selectedMCPConfigsMap: serverState.selectedMCPConfigsMap,
    isMultiSelectMode: serverState.isMultiSelectMode,

    workspaces: effectiveWorkspaces,
    activeWorkspaceId: effectiveActiveWorkspaceId,
    activeWorkspace: serverState.activeWorkspace,

    handleConnect: serverState.handleConnect,
    handleDisconnect: serverState.handleDisconnect,
    handleReconnect: serverState.handleReconnect,
    handleUpdate: serverState.handleUpdate,
    handleRemoveServer: serverState.handleRemoveServer,
    setSelectedServer: serverState.setSelectedServer,
    setSelectedMCPConfigs: serverState.setSelectedMCPConfigs,
    toggleMultiSelectMode: serverState.toggleMultiSelectMode,
    toggleServerSelection: serverState.toggleServerSelection,
    getValidAccessToken: serverState.getValidAccessToken,
    setSelectedMultipleServersToAllServers:
      serverState.setSelectedMultipleServersToAllServers,
    saveServerConfigWithoutConnecting:
      serverState.saveServerConfigWithoutConnecting,
    handleConnectWithTokensFromOAuthFlow:
      serverState.handleConnectWithTokensFromOAuthFlow,
    handleRefreshTokensFromOAuthFlow:
      serverState.handleRefreshTokensFromOAuthFlow,

    handleSwitchWorkspace,
    handleCreateWorkspace: workspaceState.handleCreateWorkspace,
    handleUpdateWorkspace: workspaceState.handleUpdateWorkspace,
    handleUpdateClientConfig: workspaceState.handleUpdateClientConfig,
    handleDeleteWorkspace: workspaceState.handleDeleteWorkspace,
    handleLeaveWorkspace,
    handleDuplicateWorkspace: workspaceState.handleDuplicateWorkspace,
    handleSetDefaultWorkspace: workspaceState.handleSetDefaultWorkspace,
    handleWorkspaceShared: workspaceState.handleWorkspaceShared,
    handleExportWorkspace: workspaceState.handleExportWorkspace,
    handleImportWorkspace: workspaceState.handleImportWorkspace,
  };
}
