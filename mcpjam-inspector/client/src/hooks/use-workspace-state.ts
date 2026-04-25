import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
} from "react";
import { toast } from "sonner";
import type { AppAction, AppState, Workspace } from "@/state/app-types";
import {
  useWorkspaceMutations,
  useWorkspaceQueries,
  useWorkspaceServers,
} from "./useWorkspaces";
import {
  deserializeServersFromConvex,
  serializeServersForSharing,
} from "@/lib/workspace-serialization";
import {
  composeWorkspaceClientConfig,
  pickWorkspaceConnectionConfig,
  pickWorkspaceHostContext,
  stableStringifyJson,
  type WorkspaceClientConfig,
  type WorkspaceConnectionConfigDraft,
  type WorkspaceHostContextDraft,
} from "@/lib/client-config";
import { getBillingErrorMessage } from "@/lib/billing-entitlements";
import { useClientConfigStore } from "@/stores/client-config-store";
import { useHostContextStore } from "@/stores/host-context-store";
import { useOrganizationBillingStatus } from "./useOrganizationBilling";

const CLIENT_CONFIG_SYNC_ECHO_TIMEOUT_MS = 10000;

function stringifyWorkspaceClientConfig(
  clientConfig: WorkspaceClientConfig | undefined,
) {
  return stableStringifyJson(clientConfig ?? null);
}

function buildLocalWorkspaceId() {
  return `workspace_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

interface PendingClientConfigSync {
  workspaceId: string;
  expectedSerializedConfig: string;
  resolve: () => void;
  reject: (error: Error) => void;
  timeoutId: ReturnType<typeof setTimeout>;
}

interface ClientConfigSaveController<T> {
  beginSave: (input: {
    workspaceId: string;
    savedConfig: T | undefined;
    awaitRemoteEcho: boolean;
  }) => void;
  markSaved: (savedConfig: T | undefined) => void;
  failSave: () => void;
}

interface LoggerLike {
  info: (message: string, meta?: Record<string, unknown>) => void;
  warn: (message: string, meta?: Record<string, unknown>) => void;
  error: (message: string, meta?: Record<string, unknown>) => void;
}

function isSyntheticDefaultWorkspace(workspace: Workspace) {
  return (
    workspace.id === "default" &&
    workspace.isDefault === true &&
    workspace.sharedWorkspaceId === undefined &&
    workspace.organizationId === undefined &&
    workspace.name === "Default" &&
    workspace.description === "Default workspace" &&
    Object.keys(workspace.servers).length === 0
  );
}

export interface UseWorkspaceStateParams {
  appState: AppState;
  dispatch: Dispatch<AppAction>;
  isAuthenticated: boolean;
  isAuthLoading: boolean;
  hasOrganizations: boolean;
  isLoadingOrganizations: boolean;
  validOrganizationIds: string[];
  activeOrganizationId?: string;
  routeOrganizationId?: string;
  logger: LoggerLike;
}

export function useWorkspaceState({
  appState,
  dispatch,
  isAuthenticated,
  isAuthLoading,
  hasOrganizations,
  isLoadingOrganizations,
  validOrganizationIds,
  activeOrganizationId,
  routeOrganizationId,
  logger,
}: UseWorkspaceStateParams) {
  const workspaceOrganizationId = routeOrganizationId ?? activeOrganizationId;
  const hasResolvedWorkspaceOrganizationSelection =
    !isLoadingOrganizations && workspaceOrganizationId !== undefined;
  const shouldScopeLocalFallbackByOrganization =
    isAuthenticated &&
    hasResolvedWorkspaceOrganizationSelection &&
    workspaceOrganizationId !== undefined;
  const billingOrganizationId = routeOrganizationId
    ? routeOrganizationId
    : !isLoadingOrganizations &&
        activeOrganizationId &&
        validOrganizationIds.includes(activeOrganizationId)
      ? activeOrganizationId
      : undefined;
  const {
    allWorkspaces: allRemoteWorkspaces,
    workspaces: remoteWorkspaces,
    isLoading: isLoadingWorkspaces,
  } = useWorkspaceQueries({
    isAuthenticated,
    organizationId: workspaceOrganizationId,
  });
  const {
    createWorkspace: convexCreateWorkspace,
    ensureDefaultWorkspace: convexEnsureDefaultWorkspace,
    updateWorkspace: convexUpdateWorkspace,
    updateClientConfig: convexUpdateClientConfig,
    deleteWorkspace: convexDeleteWorkspace,
  } = useWorkspaceMutations();
  const billingStatus = useOrganizationBillingStatus(
    billingOrganizationId ?? null,
    { enabled: isAuthenticated },
  );

  const [convexActiveWorkspaceId, setConvexActiveWorkspaceId] = useState<
    string | null
  >(() => {
    if (typeof window !== "undefined") {
      return localStorage.getItem("convex-active-workspace-id");
    }
    return null;
  });

  const migrationInFlightRef = useRef(new Set<string>());
  const ensureDefaultInFlightRef = useRef(new Set<string>());
  const ensureDefaultCompletedRef = useRef(new Set<string>());
  const migrationErrorNotifiedRef = useRef(new Set<string>());
  const [useLocalFallback, setUseLocalFallback] = useState(false);
  const convexTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const pendingClientConfigSyncRef = useRef<PendingClientConfigSync | null>(
    null,
  );
  const CONVEX_TIMEOUT_MS = 10000;
  const shouldTreatRemoteWorkspacesAsEmpty =
    isAuthenticated &&
    !isLoadingOrganizations &&
    !hasOrganizations &&
    !routeOrganizationId &&
    !activeOrganizationId;

  const clearConvexActiveWorkspaceSelection = useCallback(() => {
    setConvexActiveWorkspaceId(null);
    if (typeof window !== "undefined") {
      localStorage.removeItem("convex-active-workspace-id");
    }
  }, []);

  const { servers: activeWorkspaceServersFlat, isLoading: isLoadingServers } =
    useWorkspaceServers({
      workspaceId: shouldTreatRemoteWorkspacesAsEmpty
        ? null
        : convexActiveWorkspaceId,
      isAuthenticated,
    });

  const clearPendingClientConfigSync = useCallback((error?: Error) => {
    const pending = pendingClientConfigSyncRef.current;
    if (!pending) {
      return;
    }

    clearTimeout(pending.timeoutId);
    pendingClientConfigSyncRef.current = null;

    if (error) {
      pending.reject(error);
    }
  }, []);

  useEffect(() => {
    if (!isAuthenticated) {
      setUseLocalFallback(false);
      if (convexTimeoutRef.current) {
        clearTimeout(convexTimeoutRef.current);
        convexTimeoutRef.current = null;
      }
      return;
    }

    if (shouldTreatRemoteWorkspacesAsEmpty) {
      setUseLocalFallback(false);
      if (convexTimeoutRef.current) {
        clearTimeout(convexTimeoutRef.current);
        convexTimeoutRef.current = null;
      }
      return;
    }

    if (remoteWorkspaces !== undefined) {
      setUseLocalFallback(false);
      if (convexTimeoutRef.current) {
        clearTimeout(convexTimeoutRef.current);
        convexTimeoutRef.current = null;
      }
      return;
    }

    if (!convexTimeoutRef.current && !useLocalFallback) {
      convexTimeoutRef.current = setTimeout(() => {
        logger.warn(
          "Convex connection timed out, falling back to local storage",
        );
        toast.warning("Cloud sync unavailable - using local data", {
          description: "Your changes will be saved locally",
        });
        setUseLocalFallback(true);
        convexTimeoutRef.current = null;
      }, CONVEX_TIMEOUT_MS);
    }

    return () => {
      if (convexTimeoutRef.current) {
        clearTimeout(convexTimeoutRef.current);
        convexTimeoutRef.current = null;
      }
    };
  }, [
    isAuthenticated,
    remoteWorkspaces,
    shouldTreatRemoteWorkspacesAsEmpty,
    useLocalFallback,
    logger,
  ]);

  useEffect(() => {
    if (
      isAuthenticated &&
      !useLocalFallback &&
      !shouldTreatRemoteWorkspacesAsEmpty
    ) {
      return;
    }

    clearPendingClientConfigSync(
      new Error("Workspace client config sync was interrupted."),
    );
  }, [
    clearPendingClientConfigSync,
    isAuthenticated,
    shouldTreatRemoteWorkspacesAsEmpty,
    useLocalFallback,
  ]);

  useEffect(() => {
    return () => {
      clearPendingClientConfigSync(
        new Error("Workspace client config sync was interrupted."),
      );
    };
  }, [clearPendingClientConfigSync]);

  useEffect(() => {
    if (!shouldTreatRemoteWorkspacesAsEmpty || !convexActiveWorkspaceId) {
      return;
    }

    clearConvexActiveWorkspaceSelection();
  }, [
    shouldTreatRemoteWorkspacesAsEmpty,
    convexActiveWorkspaceId,
    clearConvexActiveWorkspaceSelection,
  ]);

  const isLoadingRemoteWorkspaces =
    (!shouldTreatRemoteWorkspacesAsEmpty &&
      isAuthenticated &&
      !useLocalFallback &&
      (remoteWorkspaces === undefined || isLoadingServers)) ||
    (isAuthLoading && !!convexActiveWorkspaceId);

  const convexWorkspaces = useMemo((): Record<string, Workspace> => {
    if (!remoteWorkspaces) return {};
    return Object.fromEntries(
      remoteWorkspaces.map((rw) => {
        let deserializedServers: Workspace["servers"] = {};

        if (
          rw._id === convexActiveWorkspaceId &&
          activeWorkspaceServersFlat !== undefined
        ) {
          deserializedServers = deserializeServersFromConvex(
            activeWorkspaceServersFlat,
          );
        } else if (rw.servers) {
          deserializedServers = deserializeServersFromConvex(rw.servers);
        }

        return [
          rw._id,
          {
            id: rw._id,
            name: rw.name,
            description: rw.description,
            icon: rw.icon,
            clientConfig: rw.clientConfig,
            servers: deserializedServers,
            createdAt: new Date(rw.createdAt),
            updatedAt: new Date(rw.updatedAt),
            canDeleteWorkspace: rw.canDeleteWorkspace,
            sharedWorkspaceId: rw._id,
            organizationId: rw.organizationId,
            visibility: rw.visibility,
          } as Workspace,
        ];
      }),
    );
  }, [remoteWorkspaces, convexActiveWorkspaceId, activeWorkspaceServersFlat]);

  useEffect(() => {
    const pending = pendingClientConfigSyncRef.current;
    if (!pending) {
      return;
    }

    const syncedClientConfig =
      convexWorkspaces[pending.workspaceId]?.clientConfig ?? undefined;
    if (
      stringifyWorkspaceClientConfig(syncedClientConfig) !==
      pending.expectedSerializedConfig
    ) {
      return;
    }

    clearTimeout(pending.timeoutId);
    pendingClientConfigSyncRef.current = null;
    pending.resolve();
  }, [convexWorkspaces]);

  const scopedLocalWorkspaces = useMemo((): Record<string, Workspace> => {
    if (!shouldScopeLocalFallbackByOrganization) {
      return appState.workspaces;
    }

    return Object.fromEntries(
      Object.entries(appState.workspaces).filter(
        ([, workspace]) => workspace.organizationId === workspaceOrganizationId,
      ),
    );
  }, [appState.workspaces, shouldScopeLocalFallbackByOrganization, workspaceOrganizationId]);

  const localFallbackWorkspaces = useMemo((): Record<string, Workspace> => {
    if (!useLocalFallback) {
      return appState.workspaces;
    }

    return scopedLocalWorkspaces;
  }, [useLocalFallback, appState.workspaces, scopedLocalWorkspaces]);

  const authenticatedMergedWorkspaces = useMemo((): Record<string, Workspace> => {
    const workspacesWithoutRemoteMatch = Object.fromEntries(
      Object.entries(scopedLocalWorkspaces).filter(([localWorkspaceId, workspace]) => {
        if (convexWorkspaces[localWorkspaceId]) {
          return false;
        }

        if (
          workspace.sharedWorkspaceId &&
          convexWorkspaces[workspace.sharedWorkspaceId]
        ) {
          return false;
        }

        return true;
      }),
    );

    return {
      ...convexWorkspaces,
      ...workspacesWithoutRemoteMatch,
    };
  }, [convexWorkspaces, scopedLocalWorkspaces]);

  const activeScopedLocalWorkspace = useMemo(
    () => scopedLocalWorkspaces[appState.activeWorkspaceId],
    [scopedLocalWorkspaces, appState.activeWorkspaceId],
  );

  const activeScopedRemoteWorkspaceId =
    activeScopedLocalWorkspace?.sharedWorkspaceId ?? null;

  const shouldKeepLocalActiveWorkspace = Boolean(
    activeScopedLocalWorkspace &&
      (!activeScopedRemoteWorkspaceId ||
        !convexWorkspaces[activeScopedRemoteWorkspaceId]),
  );

  const effectiveWorkspaces = useMemo((): Record<string, Workspace> => {
    if (shouldTreatRemoteWorkspacesAsEmpty) {
      return {};
    }
    if (useLocalFallback) {
      return localFallbackWorkspaces;
    }
    if (isAuthenticated && remoteWorkspaces !== undefined) {
      return authenticatedMergedWorkspaces;
    }
    if (isAuthenticated) {
      return {};
    }
    if (isAuthLoading && convexActiveWorkspaceId) {
      return {};
    }
    return appState.workspaces;
  }, [
    useLocalFallback,
    localFallbackWorkspaces,
    isAuthenticated,
    remoteWorkspaces,
    authenticatedMergedWorkspaces,
    isAuthLoading,
    convexActiveWorkspaceId,
    shouldTreatRemoteWorkspacesAsEmpty,
  ]);

  const effectiveActiveWorkspaceId = useMemo(() => {
    if (shouldTreatRemoteWorkspacesAsEmpty) {
      return "none";
    }
    if (useLocalFallback) {
      if (localFallbackWorkspaces[appState.activeWorkspaceId]) {
        return appState.activeWorkspaceId;
      }
      const defaultWorkspaceId = Object.entries(localFallbackWorkspaces).find(
        ([, workspace]) => workspace.isDefault,
      )?.[0];
      return (
        defaultWorkspaceId ?? Object.keys(localFallbackWorkspaces)[0] ?? "none"
      );
    }
    if (isAuthenticated && remoteWorkspaces !== undefined) {
      if (
        shouldKeepLocalActiveWorkspace &&
        effectiveWorkspaces[appState.activeWorkspaceId]
      ) {
        return appState.activeWorkspaceId;
      }

      if (
        activeScopedRemoteWorkspaceId &&
        effectiveWorkspaces[activeScopedRemoteWorkspaceId]
      ) {
        return activeScopedRemoteWorkspaceId;
      }

      if (
        convexActiveWorkspaceId &&
        effectiveWorkspaces[convexActiveWorkspaceId]
      ) {
        return convexActiveWorkspaceId;
      }
      const firstId = Object.keys(effectiveWorkspaces)[0];
      return firstId || "none";
    }
    return appState.activeWorkspaceId;
  }, [
    useLocalFallback,
    appState.activeWorkspaceId,
    localFallbackWorkspaces,
    scopedLocalWorkspaces,
    isAuthenticated,
    remoteWorkspaces,
    convexActiveWorkspaceId,
    effectiveWorkspaces,
    activeScopedRemoteWorkspaceId,
    shouldKeepLocalActiveWorkspace,
    shouldTreatRemoteWorkspacesAsEmpty,
  ]);

  const migratableLocalWorkspaces = useMemo(
    () =>
      Object.values(appState.workspaces).filter(
        (workspace) =>
          !workspace.sharedWorkspaceId &&
          (!shouldScopeLocalFallbackByOrganization ||
            workspace.organizationId === workspaceOrganizationId) &&
          !isSyntheticDefaultWorkspace(workspace),
      ),
    [
      appState.workspaces,
      shouldScopeLocalFallbackByOrganization,
      workspaceOrganizationId,
    ],
  );
  const migratableLocalWorkspaceCount = migratableLocalWorkspaces.length;
  const hasAnyRemoteWorkspaces = (allRemoteWorkspaces?.length ?? 0) > 0;
  const hasCurrentOrganizationWorkspaces = (remoteWorkspaces?.length ?? 0) > 0;
  const canManageBillingForWorkspaceActions = workspaceOrganizationId
    ? (billingStatus?.canManageBilling ?? false)
    : true;

  useEffect(() => {
    if (shouldTreatRemoteWorkspacesAsEmpty) {
      return;
    }

    if (isAuthenticated && remoteWorkspaces && remoteWorkspaces.length > 0) {
      if (shouldKeepLocalActiveWorkspace) {
        if (convexActiveWorkspaceId) {
          clearConvexActiveWorkspaceSelection();
        }
        return;
      }

      if (
        !convexActiveWorkspaceId ||
        !convexWorkspaces[convexActiveWorkspaceId]
      ) {
        if (
          activeScopedRemoteWorkspaceId &&
          convexWorkspaces[activeScopedRemoteWorkspaceId]
        ) {
          setConvexActiveWorkspaceId(activeScopedRemoteWorkspaceId);
          return;
        }

        const savedActiveId = localStorage.getItem("convex-active-workspace-id");
        if (savedActiveId && convexWorkspaces[savedActiveId]) {
          setConvexActiveWorkspaceId(savedActiveId);
          return;
        }

        setConvexActiveWorkspaceId(remoteWorkspaces[0]._id);
      }
    }
  }, [
    isAuthenticated,
    remoteWorkspaces,
    convexActiveWorkspaceId,
    convexWorkspaces,
    activeScopedRemoteWorkspaceId,
    shouldKeepLocalActiveWorkspace,
    clearConvexActiveWorkspaceSelection,
    shouldTreatRemoteWorkspacesAsEmpty,
  ]);

  useEffect(() => {
    if (convexActiveWorkspaceId) {
      localStorage.setItem(
        "convex-active-workspace-id",
        convexActiveWorkspaceId,
      );
    } else {
      localStorage.removeItem("convex-active-workspace-id");
    }
  }, [convexActiveWorkspaceId]);

  useEffect(() => {
    if (!isAuthenticated || useLocalFallback) {
      migrationInFlightRef.current.clear();
      ensureDefaultInFlightRef.current.clear();
      // Intentionally NOT clearing ensureDefaultCompletedRef here — it must
      // survive transient auth-state flickers so that a workspace that was
      // already successfully created isn't re-created when the Convex
      // subscription briefly returns an empty result during reconnection.
      migrationErrorNotifiedRef.current.clear();
    }
  }, [isAuthenticated, useLocalFallback]);

  useEffect(() => {
    if (
      !isAuthenticated ||
      useLocalFallback ||
      allRemoteWorkspaces === undefined ||
      allRemoteWorkspaces.length > 0 ||
      migratableLocalWorkspaceCount === 0
    ) {
      migrationErrorNotifiedRef.current.clear();
    }
  }, [
    isAuthenticated,
    useLocalFallback,
    allRemoteWorkspaces,
    migratableLocalWorkspaceCount,
  ]);

  useEffect(() => {
    if (!isAuthenticated) {
      return;
    }
    if (shouldTreatRemoteWorkspacesAsEmpty) return;
    if (useLocalFallback) return;
    if (!hasResolvedWorkspaceOrganizationSelection) return;
    if (allRemoteWorkspaces === undefined) return;
    if (allRemoteWorkspaces.length > 0) return;
    if (migratableLocalWorkspaceCount === 0) return;

    const organizationId = workspaceOrganizationId;
    if (organizationId === undefined) return;

    logger.info("Migrating local workspaces to Convex", {
      count: migratableLocalWorkspaceCount,
    });

    const migrateWorkspace = async (workspace: Workspace) => {
      if (migrationInFlightRef.current.has(workspace.id)) {
        return;
      }

      migrationInFlightRef.current.add(workspace.id);

      try {
        const serializedServers = serializeServersForSharing(workspace.servers);
        const workspaceId = await convexCreateWorkspace({
          name: workspace.name,
          description: workspace.description,
          clientConfig: workspace.clientConfig,
          servers: serializedServers,
          organizationId,
        });
        dispatch({
          type: "UPDATE_WORKSPACE",
          workspaceId: workspace.id,
          updates: {
            sharedWorkspaceId: workspaceId as string,
            organizationId,
          },
        });
        logger.info("Migrated workspace to Convex", { name: workspace.name });
      } catch (error) {
        migrationInFlightRef.current.delete(workspace.id);
        const requestKey = organizationId;
        if (!migrationErrorNotifiedRef.current.has(requestKey)) {
          migrationErrorNotifiedRef.current.add(requestKey);
          toast.error(
            getBillingErrorMessage(
              error,
              "Some local workspaces could not be migrated",
              canManageBillingForWorkspaceActions,
            ),
          );
        }
        logger.error("Failed to migrate workspace", {
          name: workspace.name,
          error: error instanceof Error ? error.message : "Unknown error",
        });
      }
    };

    Promise.all(migratableLocalWorkspaces.map(migrateWorkspace));
  }, [
    isAuthenticated,
    useLocalFallback,
    allRemoteWorkspaces,
    migratableLocalWorkspaces,
    migratableLocalWorkspaceCount,
    convexCreateWorkspace,
    dispatch,
    logger,
    workspaceOrganizationId,
    hasResolvedWorkspaceOrganizationSelection,
    canManageBillingForWorkspaceActions,
    shouldTreatRemoteWorkspacesAsEmpty,
  ]);

  useEffect(() => {
    if (!isAuthenticated) {
      return;
    }
    if (shouldTreatRemoteWorkspacesAsEmpty) return;
    if (useLocalFallback) return;
    if (!hasResolvedWorkspaceOrganizationSelection) return;
    if (remoteWorkspaces === undefined) return;
    if (hasCurrentOrganizationWorkspaces) return;
    if (!hasAnyRemoteWorkspaces && migratableLocalWorkspaceCount > 0) return;

    const organizationId = workspaceOrganizationId;
    if (organizationId === undefined) return;

    const requestKey = organizationId;
    if (ensureDefaultInFlightRef.current.has(requestKey)) {
      return;
    }
    if (ensureDefaultCompletedRef.current.has(requestKey)) {
      return;
    }

    ensureDefaultInFlightRef.current.add(requestKey);

    convexEnsureDefaultWorkspace({ organizationId })
      .then((workspaceId) => {
        ensureDefaultCompletedRef.current.add(requestKey);
      })
      .catch((error) => {
        ensureDefaultInFlightRef.current.delete(requestKey);
        logger.error("Failed to ensure default workspace", {
          organizationId,
          error: error instanceof Error ? error.message : "Unknown error",
        });
      });
  }, [
    isAuthenticated,
    useLocalFallback,
    remoteWorkspaces,
    hasCurrentOrganizationWorkspaces,
    hasAnyRemoteWorkspaces,
    migratableLocalWorkspaceCount,
    convexEnsureDefaultWorkspace,
    workspaceOrganizationId,
    hasResolvedWorkspaceOrganizationSelection,
    logger,
    shouldTreatRemoteWorkspacesAsEmpty,
  ]);

  const handleCreateWorkspace = useCallback(
    async (name: string, switchTo: boolean = false) => {
      if (isAuthenticated && !useLocalFallback) {
        const organizationId = workspaceOrganizationId;
        if (
          shouldTreatRemoteWorkspacesAsEmpty ||
          !hasResolvedWorkspaceOrganizationSelection ||
          organizationId === undefined
        ) {
          toast.error("Create or join an organization to create workspaces.");
          return "";
        }
        try {
          const workspaceId = await convexCreateWorkspace({
            name,
            clientConfig: undefined,
            servers: {},
            organizationId,
          });
          if (switchTo && workspaceId) {
            setConvexActiveWorkspaceId(workspaceId as string);
          }
          toast.success(`Workspace "${name}" created`);
          return workspaceId as string;
        } catch (error) {
          toast.error(
            getBillingErrorMessage(
              error,
              "Failed to create workspace",
              canManageBillingForWorkspaceActions,
            ),
          );
          return "";
        }
      }

      if (
        isAuthenticated &&
        (!hasResolvedWorkspaceOrganizationSelection ||
          workspaceOrganizationId === undefined)
      ) {
        toast.error("Create or join an organization to create workspaces.");
        return "";
      }

      const newWorkspace: Workspace = {
        id: buildLocalWorkspaceId(),
        name,
        servers: {},
        createdAt: new Date(),
        updatedAt: new Date(),
        organizationId: isAuthenticated ? workspaceOrganizationId : undefined,
      };
      dispatch({ type: "CREATE_WORKSPACE", workspace: newWorkspace });

      if (switchTo) {
        dispatch({ type: "SWITCH_WORKSPACE", workspaceId: newWorkspace.id });
      }

      toast.success(`Workspace "${name}" created`);
      return newWorkspace.id;
    },
    [
      isAuthenticated,
      useLocalFallback,
      shouldTreatRemoteWorkspacesAsEmpty,
      convexCreateWorkspace,
      dispatch,
      workspaceOrganizationId,
      hasResolvedWorkspaceOrganizationSelection,
      canManageBillingForWorkspaceActions,
    ],
  );

  const handleUpdateWorkspace = useCallback(
    async (workspaceId: string, updates: Partial<Workspace>): Promise<void> => {
      if (isAuthenticated && !useLocalFallback) {
        try {
          const updateData: any = { workspaceId };
          if (updates.name !== undefined) updateData.name = updates.name;
          if (updates.description !== undefined) {
            updateData.description = updates.description;
          }
          if (updates.icon !== undefined) updateData.icon = updates.icon;
          if (updates.visibility !== undefined) {
            updateData.visibility = updates.visibility;
          }
          if (updates.servers !== undefined) {
            logger.warn(
              "Ignoring servers in handleUpdateWorkspace for authenticated user - use individual server operations",
            );
          }
          await convexUpdateWorkspace(updateData);
        } catch (error) {
          const errorMessage =
            error instanceof Error ? error.message : "Unknown error";
          logger.error("Failed to update workspace", {
            error: errorMessage,
          });
          toast.error(errorMessage);
          throw error instanceof Error ? error : new Error(errorMessage);
        }
      } else {
        dispatch({ type: "UPDATE_WORKSPACE", workspaceId, updates });
      }
    },
    [
      isAuthenticated,
      useLocalFallback,
      convexUpdateWorkspace,
      logger,
      dispatch,
    ],
  );

  const persistWorkspaceClientConfig = useCallback(
    async <T,>({
      workspaceId,
      clientConfig,
      savedSlice,
      controller,
    }: {
      workspaceId: string;
      clientConfig: WorkspaceClientConfig | undefined;
      savedSlice: T | undefined;
      controller: ClientConfigSaveController<T>;
    }): Promise<void> => {
      const awaitRemoteEcho = isAuthenticated && !useLocalFallback;

      controller.beginSave({
        workspaceId,
        savedConfig: savedSlice,
        awaitRemoteEcho,
      });

      if (awaitRemoteEcho) {
        const remoteEchoPromise = new Promise<void>((resolve, reject) => {
          clearPendingClientConfigSync();

          const timeoutId = setTimeout(() => {
            pendingClientConfigSyncRef.current = null;
            reject(
              new Error(
                "Timed out waiting for workspace client config to sync.",
              ),
            );
          }, CLIENT_CONFIG_SYNC_ECHO_TIMEOUT_MS);

          pendingClientConfigSyncRef.current = {
            workspaceId,
            expectedSerializedConfig:
              stringifyWorkspaceClientConfig(clientConfig),
            resolve,
            reject,
            timeoutId,
          };
        });

        try {
          await convexUpdateClientConfig({
            workspaceId,
            clientConfig,
          });
          await remoteEchoPromise;
        } catch (error) {
          clearPendingClientConfigSync();
          controller.failSave();
          const errorMessage =
            error instanceof Error ? error.message : "Unknown error";
          logger.error("Failed to update workspace client config", {
            error: errorMessage,
            workspaceId,
          });
          toast.error(errorMessage);
          throw error instanceof Error ? error : new Error(errorMessage);
        }
        return;
      }

      dispatch({
        type: "UPDATE_WORKSPACE",
        workspaceId,
        updates: { clientConfig },
      });
      controller.markSaved(savedSlice);
    },
    [
      isAuthenticated,
      useLocalFallback,
      clearPendingClientConfigSync,
      convexUpdateClientConfig,
      logger,
      dispatch,
    ],
  );

  const resolvePersistedConnectionConfig = useCallback(
    (workspaceId: string): WorkspaceConnectionConfigDraft => {
      const clientConfigStore = useClientConfigStore.getState();
      const workspaceClientConfig = effectiveWorkspaces[workspaceId]?.clientConfig;

      return (
        clientConfigStore.savedConfig ??
        clientConfigStore.defaultConfig ??
        pickWorkspaceConnectionConfig(workspaceClientConfig)
      );
    },
    [effectiveWorkspaces],
  );

  const resolvePersistedHostContext = useCallback(
    (workspaceId: string): WorkspaceHostContextDraft => {
      const hostContextStore = useHostContextStore.getState();
      const workspaceClientConfig = effectiveWorkspaces[workspaceId]?.clientConfig;

      return (
        hostContextStore.savedHostContext ??
        hostContextStore.defaultHostContext ??
        pickWorkspaceHostContext(workspaceClientConfig)
      );
    },
    [effectiveWorkspaces],
  );

  const handleUpdateClientConfig = useCallback(
    async (
      workspaceId: string,
      connectionConfig: WorkspaceConnectionConfigDraft | undefined,
    ): Promise<void> => {
      const clientConfigStore = useClientConfigStore.getState();
      const workspaceClientConfig = effectiveWorkspaces[workspaceId]?.clientConfig;
      const connectionConfigToPersist =
        connectionConfig ??
        clientConfigStore.draftConfig ??
        resolvePersistedConnectionConfig(workspaceId);
      const clientConfig = composeWorkspaceClientConfig({
        connectionConfig: connectionConfigToPersist,
        hostContext: resolvePersistedHostContext(workspaceId),
        fallback: workspaceClientConfig ?? null,
      });

      await persistWorkspaceClientConfig({
        workspaceId,
        clientConfig,
        savedSlice: connectionConfigToPersist,
        controller: clientConfigStore,
      });
    },
    [
      effectiveWorkspaces,
      persistWorkspaceClientConfig,
      resolvePersistedConnectionConfig,
      resolvePersistedHostContext,
    ],
  );

  const handleUpdateHostContext = useCallback(
    async (
      workspaceId: string,
      hostContext: WorkspaceHostContextDraft | undefined,
    ): Promise<void> => {
      const hostContextStore = useHostContextStore.getState();
      const workspaceClientConfig = effectiveWorkspaces[workspaceId]?.clientConfig;
      const hostContextToPersist =
        hostContext ??
        hostContextStore.draftHostContext ??
        resolvePersistedHostContext(workspaceId);
      const clientConfig = composeWorkspaceClientConfig({
        connectionConfig: resolvePersistedConnectionConfig(workspaceId),
        hostContext: hostContextToPersist,
        fallback: workspaceClientConfig ?? null,
      });

      await persistWorkspaceClientConfig({
        workspaceId,
        clientConfig,
        savedSlice: hostContextToPersist,
        controller: {
          beginSave: ({ workspaceId, savedConfig, awaitRemoteEcho }) =>
            hostContextStore.beginSave({
              workspaceId,
              savedHostContext: savedConfig,
              awaitRemoteEcho,
            }),
          markSaved: (savedConfig) => hostContextStore.markSaved(savedConfig),
          failSave: () => hostContextStore.failSave(),
        },
      });
    },
    [
      effectiveWorkspaces,
      persistWorkspaceClientConfig,
      resolvePersistedConnectionConfig,
      resolvePersistedHostContext,
    ],
  );

  const handleDeleteWorkspace = useCallback(
    async (workspaceId: string): Promise<boolean> => {
      // If deleting the active workspace, switch to another first
      if (workspaceId === effectiveActiveWorkspaceId) {
        const otherWorkspaceIds = Object.keys(effectiveWorkspaces).filter(
          (id) => id !== workspaceId,
        );
        const defaultWorkspace = otherWorkspaceIds.find(
          (id) => effectiveWorkspaces[id].isDefault,
        );
        const targetWorkspaceId = defaultWorkspace || otherWorkspaceIds[0];

        if (!targetWorkspaceId) {
          toast.error("Cannot delete the only workspace");
          return false;
        }

        if (isAuthenticated && !useLocalFallback) {
          setConvexActiveWorkspaceId(targetWorkspaceId);
        } else {
          dispatch({
            type: "SWITCH_WORKSPACE",
            workspaceId: targetWorkspaceId,
          });
        }
      }

      if (isAuthenticated && !useLocalFallback) {
        try {
          await convexDeleteWorkspace({ workspaceId });
        } catch (error) {
          let errorMessage = "Failed to delete workspace";
          if (
            error &&
            typeof error === "object" &&
            "data" in error &&
            typeof (error as { data: unknown }).data === "string"
          ) {
            errorMessage = (error as { data: string }).data;
          } else if (error instanceof Error) {
            const match = error.message.match(/Uncaught Error: (.+?)(?:\n|$)/);
            errorMessage = match ? match[1] : error.message;
          }
          logger.error("Failed to delete workspace from Convex", {
            error: errorMessage,
          });
          toast.error(errorMessage);
          return false;
        }
        toast.success("Workspace deleted");
      } else {
        dispatch({ type: "DELETE_WORKSPACE", workspaceId });
        toast.success("Workspace deleted");
      }
      return true;
    },
    [
      effectiveActiveWorkspaceId,
      effectiveWorkspaces,
      isAuthenticated,
      useLocalFallback,
      convexDeleteWorkspace,
      setConvexActiveWorkspaceId,
      logger,
      dispatch,
    ],
  );

  const handleDuplicateWorkspace = useCallback(
    async (workspaceId: string, newName: string) => {
      const sourceWorkspace = effectiveWorkspaces[workspaceId];
      if (!sourceWorkspace) {
        toast.error("Workspace not found");
        return;
      }

      if (isAuthenticated && !useLocalFallback) {
        const organizationId = workspaceOrganizationId;
        if (
          shouldTreatRemoteWorkspacesAsEmpty ||
          !hasResolvedWorkspaceOrganizationSelection ||
          organizationId === undefined
        ) {
          toast.error("Create or join an organization to create workspaces.");
          return;
        }
        try {
          const serializedServers = serializeServersForSharing(
            sourceWorkspace.servers,
          );
          await convexCreateWorkspace({
            name: newName,
            description: sourceWorkspace.description,
            clientConfig: sourceWorkspace.clientConfig,
            servers: serializedServers,
            organizationId,
          });
          toast.success(`Workspace duplicated as "${newName}"`);
        } catch (error) {
          toast.error(
            getBillingErrorMessage(
              error,
              "Failed to duplicate workspace",
              canManageBillingForWorkspaceActions,
            ),
          );
        }
      } else {
        if (
          isAuthenticated &&
          (!hasResolvedWorkspaceOrganizationSelection ||
            workspaceOrganizationId === undefined)
        ) {
          toast.error("Create or join an organization to create workspaces.");
          return;
        }

        const duplicatedWorkspace: Workspace = {
          ...sourceWorkspace,
          id: buildLocalWorkspaceId(),
          name: newName,
          createdAt: new Date(),
          updatedAt: new Date(),
          isDefault: false,
          organizationId: isAuthenticated
            ? workspaceOrganizationId
            : sourceWorkspace.organizationId,
        };
        dispatch({ type: "CREATE_WORKSPACE", workspace: duplicatedWorkspace });
        toast.success(`Workspace duplicated as "${newName}"`);
      }
    },
    [
      effectiveWorkspaces,
      isAuthenticated,
      useLocalFallback,
      shouldTreatRemoteWorkspacesAsEmpty,
      convexCreateWorkspace,
      dispatch,
      workspaceOrganizationId,
      hasResolvedWorkspaceOrganizationSelection,
      canManageBillingForWorkspaceActions,
    ],
  );

  const handleSetDefaultWorkspace = useCallback(
    (workspaceId: string) => {
      dispatch({ type: "SET_DEFAULT_WORKSPACE", workspaceId });
      toast.success("Default workspace updated");
    },
    [dispatch],
  );

  const handleWorkspaceShared = useCallback(
    (convexWorkspaceId: string, sourceWorkspaceId?: string) => {
      const resolvedSourceWorkspaceId =
        sourceWorkspaceId ?? appState.activeWorkspaceId;
      const shouldKeepActiveWorkspace =
        resolvedSourceWorkspaceId === appState.activeWorkspaceId;

      if (isAuthenticated) {
        if (appState.workspaces[resolvedSourceWorkspaceId]) {
          dispatch({
            type: "UPDATE_WORKSPACE",
            workspaceId: resolvedSourceWorkspaceId,
            updates: { sharedWorkspaceId: convexWorkspaceId },
          });
        }

        if (shouldKeepActiveWorkspace) {
          setConvexActiveWorkspaceId(convexWorkspaceId);
        }

        logger.info("Workspace shared", {
          convexWorkspaceId,
          sourceWorkspaceId,
          switchedActiveWorkspace: shouldKeepActiveWorkspace,
        });
      } else {
        dispatch({
          type: "UPDATE_WORKSPACE",
          workspaceId: resolvedSourceWorkspaceId,
          updates: { sharedWorkspaceId: convexWorkspaceId },
        });
      }
    },
    [
      isAuthenticated,
      logger,
      dispatch,
      appState.activeWorkspaceId,
      appState.workspaces,
    ],
  );

  const handleExportWorkspace = useCallback(
    (workspaceId: string) => {
      const workspace = effectiveWorkspaces[workspaceId];
      if (!workspace) {
        toast.error("Workspace not found");
        return;
      }

      const dataStr = JSON.stringify(workspace, null, 2);
      const dataBlob = new Blob([dataStr], { type: "application/json" });
      const url = URL.createObjectURL(dataBlob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `${workspace.name.replace(/\s+/g, "_")}_workspace.json`;
      link.click();
      URL.revokeObjectURL(url);
      toast.success("Workspace exported");
    },
    [effectiveWorkspaces],
  );

  const handleImportWorkspace = useCallback(
    async (workspaceData: Workspace) => {
      if (isAuthenticated && !useLocalFallback) {
        const organizationId = workspaceOrganizationId;
        if (
          shouldTreatRemoteWorkspacesAsEmpty ||
          !hasResolvedWorkspaceOrganizationSelection ||
          organizationId === undefined
        ) {
          toast.error("Create or join an organization to create workspaces.");
          return;
        }
        try {
          const serializedServers = serializeServersForSharing(
            workspaceData.servers || {},
          );
          await convexCreateWorkspace({
            name: workspaceData.name,
            description: workspaceData.description,
            clientConfig: workspaceData.clientConfig,
            servers: serializedServers,
            organizationId,
          });
          toast.success(`Workspace "${workspaceData.name}" imported`);
        } catch (error) {
          toast.error(
            getBillingErrorMessage(
              error,
              "Failed to import workspace",
              canManageBillingForWorkspaceActions,
            ),
          );
        }
      } else {
        if (
          isAuthenticated &&
          (!hasResolvedWorkspaceOrganizationSelection ||
            workspaceOrganizationId === undefined)
        ) {
          toast.error("Create or join an organization to create workspaces.");
          return;
        }
        const importedWorkspace: Workspace = {
          ...workspaceData,
          id: buildLocalWorkspaceId(),
          createdAt: new Date(),
          updatedAt: new Date(),
          isDefault: false,
          organizationId: isAuthenticated
            ? workspaceOrganizationId
            : workspaceData.organizationId,
        };
        dispatch({ type: "IMPORT_WORKSPACE", workspace: importedWorkspace });
        toast.success(`Workspace "${importedWorkspace.name}" imported`);
      }
    },
    [
      isAuthenticated,
      useLocalFallback,
      shouldTreatRemoteWorkspacesAsEmpty,
      convexCreateWorkspace,
      dispatch,
      workspaceOrganizationId,
      hasResolvedWorkspaceOrganizationSelection,
      canManageBillingForWorkspaceActions,
    ],
  );

  return {
    remoteWorkspaces,
    isLoadingWorkspaces,
    activeWorkspaceServersFlat,
    useLocalFallback,
    setConvexActiveWorkspaceId,
    clearConvexActiveWorkspaceSelection,
    isLoadingRemoteWorkspaces,
    effectiveWorkspaces,
    effectiveActiveWorkspaceId,
    handleCreateWorkspace,
    handleUpdateWorkspace,
    handleUpdateClientConfig,
    handleUpdateHostContext,
    handleDeleteWorkspace,
    handleDuplicateWorkspace,
    handleSetDefaultWorkspace,
    handleWorkspaceShared,
    handleExportWorkspace,
    handleImportWorkspace,
  };
}
