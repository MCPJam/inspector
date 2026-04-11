import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { toast } from "sonner";
import { useConvexAuth } from "convex/react";
import { useLogger } from "./use-logger";
import { initialAppState } from "@/state/app-types";
import { appReducer } from "@/state/app-reducer";
import { loadAppState, saveAppState } from "@/state/storage";
import { useWorkspaceState } from "./use-workspace-state";
import { useServerState } from "./use-server-state";
import {
  clearLegacyActiveOrganizationStorage,
  readStoredActiveOrganizationId,
  writeStoredActiveOrganizationId,
} from "@/lib/active-organization-storage";

export type { ServerWithName } from "@/state/app-types";
export type { ServerUpdateResult } from "./use-server-state";

interface ActiveOrganizationSelection {
  organizationId?: string;
  userId: string | null;
}

export function useAppState({
  currentUserId,
  routeOrganizationId,
  hasOrganizations,
  isLoadingOrganizations,
}: {
  currentUserId: string | null;
  routeOrganizationId?: string;
  hasOrganizations: boolean;
  isLoadingOrganizations: boolean;
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
  const activeOrganizationId =
    activeOrganizationSelection.userId === currentUserId
      ? activeOrganizationSelection.organizationId
      : undefined;
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
    setActiveOrganizationSelection({
      organizationId: readStoredActiveOrganizationId(currentUserId),
      userId: currentUserId,
    });
  }, [currentUserId]);

  const isFirstScopedOrgRender = useRef(true);
  useEffect(() => {
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
  }, [activeOrganizationSelection, currentUserId]);

  useEffect(() => {
    try {
      const loaded = loadAppState();
      dispatch({ type: "HYDRATE_STATE", payload: loaded });
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

      if (isAuthenticated) {
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

      if (isAuthenticated) {
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
      dispatch,
      setConvexActiveWorkspaceId,
    ],
  );

  const isCloudSyncActive =
    isAuthenticated && !useLocalFallback && remoteWorkspaces !== undefined;

  return {
    appState,
    isLoading,
    isLoadingRemoteWorkspaces,
    isCloudSyncActive,
    activeOrganizationId,
    setActiveOrganizationId,
    clearConvexActiveWorkspaceSelection,

    workspaceServers: serverState.workspaceServers,
    connectedOrConnectingServerConfigs:
      serverState.connectedOrConnectingServerConfigs,
    selectedServerEntry: serverState.selectedServerEntry,
    selectedMCPConfig: serverState.selectedMCPConfig,
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
