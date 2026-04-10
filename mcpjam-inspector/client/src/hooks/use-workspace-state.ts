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
  filterWorkspacesForOrganization,
  useWorkspaceMutations,
  useWorkspaceQueries,
  useWorkspaceServers,
} from "./useWorkspaces";
import {
  deserializeServersFromConvex,
  serializeServersForSharing,
} from "@/lib/workspace-serialization";
import {
  stableStringifyJson,
  type WorkspaceClientConfig,
} from "@/lib/client-config";
import { getBillingErrorMessage } from "@/lib/billing-entitlements";
import { useClientConfigStore } from "@/stores/client-config-store";
import { useOrganizationBillingStatus } from "./useOrganizationBilling";

const CLIENT_CONFIG_SYNC_ECHO_TIMEOUT_MS = 10000;

function stringifyWorkspaceClientConfig(
  clientConfig: WorkspaceClientConfig | undefined,
) {
  return stableStringifyJson(clientConfig ?? null);
}

interface PendingClientConfigSync {
  workspaceId: string;
  expectedSerializedConfig: string;
  resolve: () => void;
  reject: (error: Error) => void;
  timeoutId: ReturnType<typeof setTimeout>;
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
  activeOrganizationId?: string;
  routeOrganizationId?: string;
  logger: LoggerLike;
}

export function useWorkspaceState({
  appState,
  dispatch,
  isAuthenticated,
  isAuthLoading,
  activeOrganizationId,
  routeOrganizationId,
  logger,
}: UseWorkspaceStateParams) {
  const selectedOrganizationId = routeOrganizationId ?? activeOrganizationId;
  const { workspaces: allRemoteWorkspaces, isLoading: isLoadingWorkspaces } =
    useWorkspaceQueries({
      isAuthenticated,
    });
  const {
    createWorkspace: convexCreateWorkspace,
    ensureDefaultWorkspace: convexEnsureDefaultWorkspace,
    updateWorkspace: convexUpdateWorkspace,
    updateClientConfig: convexUpdateClientConfig,
    deleteWorkspace: convexDeleteWorkspace,
  } = useWorkspaceMutations();

  const [convexActiveWorkspaceId, setConvexActiveWorkspaceId] = useState<
    string | null
  >(() => {
    if (typeof window !== "undefined") {
      return localStorage.getItem("convex-active-workspace-id");
    }
    return null;
  });

  const { servers: activeWorkspaceServersFlat, isLoading: isLoadingServers } =
    useWorkspaceServers({
      workspaceId: convexActiveWorkspaceId,
      isAuthenticated,
    });

  const effectiveWorkspaceOrganizationId = useMemo(() => {
    if (selectedOrganizationId) {
      return selectedOrganizationId;
    }
    if (!allRemoteWorkspaces) {
      return undefined;
    }

    const activeRemoteWorkspace =
      convexActiveWorkspaceId != null
        ? allRemoteWorkspaces.find(
            (workspace) => workspace._id === convexActiveWorkspaceId,
          )
        : undefined;
    if (activeRemoteWorkspace?.organizationId) {
      return activeRemoteWorkspace.organizationId;
    }

    const mostRecentlyUpdatedWorkspace = [...allRemoteWorkspaces].sort(
      (a, b) => b.updatedAt - a.updatedAt,
    )[0];
    return mostRecentlyUpdatedWorkspace?.organizationId;
  }, [selectedOrganizationId, allRemoteWorkspaces, convexActiveWorkspaceId]);

  const remoteWorkspaces = useMemo(() => {
    if (allRemoteWorkspaces === undefined) {
      return undefined;
    }
    if (!effectiveWorkspaceOrganizationId) {
      return [];
    }

    return (
      filterWorkspacesForOrganization(
        allRemoteWorkspaces,
        effectiveWorkspaceOrganizationId,
      ) ?? []
    );
  }, [allRemoteWorkspaces, effectiveWorkspaceOrganizationId]);

  const billingStatus = useOrganizationBillingStatus(
    effectiveWorkspaceOrganizationId ?? null,
    { enabled: isAuthenticated },
  );

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
  }, [isAuthenticated, remoteWorkspaces, useLocalFallback, logger]);

  useEffect(() => {
    if (isAuthenticated && !useLocalFallback) {
      return;
    }

    clearPendingClientConfigSync(
      new Error("Workspace client config sync was interrupted."),
    );
  }, [clearPendingClientConfigSync, isAuthenticated, useLocalFallback]);

  useEffect(() => {
    return () => {
      clearPendingClientConfigSync(
        new Error("Workspace client config sync was interrupted."),
      );
    };
  }, [clearPendingClientConfigSync]);

  const isLoadingRemoteWorkspaces =
    (isAuthenticated &&
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

  const effectiveWorkspaces = useMemo((): Record<string, Workspace> => {
    if (useLocalFallback) {
      return appState.workspaces;
    }
    if (isAuthenticated && remoteWorkspaces !== undefined) {
      return convexWorkspaces;
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
    appState.workspaces,
    isAuthenticated,
    remoteWorkspaces,
    convexWorkspaces,
    isAuthLoading,
    convexActiveWorkspaceId,
  ]);

  const effectiveActiveWorkspaceId = useMemo(() => {
    if (useLocalFallback) {
      return appState.activeWorkspaceId;
    }
    if (isAuthenticated && remoteWorkspaces !== undefined) {
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
    isAuthenticated,
    remoteWorkspaces,
    convexActiveWorkspaceId,
    effectiveWorkspaces,
  ]);

  const migratableLocalWorkspaces = useMemo(
    () =>
      Object.values(appState.workspaces).filter(
        (workspace) =>
          !workspace.sharedWorkspaceId &&
          !isSyntheticDefaultWorkspace(workspace),
      ),
    [appState.workspaces],
  );
  const migratableLocalWorkspaceCount = migratableLocalWorkspaces.length;
  const hasAnyRemoteWorkspaces = (allRemoteWorkspaces?.length ?? 0) > 0;
  const hasCurrentOrganizationWorkspaces = (remoteWorkspaces?.length ?? 0) > 0;
  const canManageBillingForWorkspaceActions = effectiveWorkspaceOrganizationId
    ? (billingStatus?.canManageBilling ?? false)
    : true;

  useEffect(() => {
    if (isAuthenticated && remoteWorkspaces && remoteWorkspaces.length > 0) {
      if (
        !convexActiveWorkspaceId ||
        !convexWorkspaces[convexActiveWorkspaceId]
      ) {
        const savedActiveId = localStorage.getItem(
          "convex-active-workspace-id",
        );
        if (savedActiveId && convexWorkspaces[savedActiveId]) {
          setConvexActiveWorkspaceId(savedActiveId);
        } else {
          setConvexActiveWorkspaceId(remoteWorkspaces[0]._id);
        }
      }
    }
  }, [
    isAuthenticated,
    remoteWorkspaces,
    convexActiveWorkspaceId,
    convexWorkspaces,
  ]);

  useEffect(() => {
    if (convexActiveWorkspaceId) {
      localStorage.setItem(
        "convex-active-workspace-id",
        convexActiveWorkspaceId,
      );
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
    if (useLocalFallback) return;
    if (!effectiveWorkspaceOrganizationId) return;
    if (allRemoteWorkspaces === undefined) return;
    if (allRemoteWorkspaces.length > 0) return;
    if (migratableLocalWorkspaceCount === 0) return;

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
          organizationId: effectiveWorkspaceOrganizationId,
        });
        dispatch({
          type: "UPDATE_WORKSPACE",
          workspaceId: workspace.id,
          updates: {
            sharedWorkspaceId: workspaceId as string,
            organizationId: effectiveWorkspaceOrganizationId,
          },
        });
        logger.info("Migrated workspace to Convex", { name: workspace.name });
      } catch (error) {
        migrationInFlightRef.current.delete(workspace.id);
        const requestKey = effectiveWorkspaceOrganizationId;
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
    effectiveWorkspaceOrganizationId,
    canManageBillingForWorkspaceActions,
  ]);

  useEffect(() => {
    if (!isAuthenticated) {
      return;
    }
    if (useLocalFallback) return;
    if (!effectiveWorkspaceOrganizationId) return;
    if (remoteWorkspaces === undefined) return;
    if (hasCurrentOrganizationWorkspaces) return;
    if (!hasAnyRemoteWorkspaces && migratableLocalWorkspaceCount > 0) return;

    const requestKey = effectiveWorkspaceOrganizationId;
    if (ensureDefaultInFlightRef.current.has(requestKey)) {
      return;
    }
    if (ensureDefaultCompletedRef.current.has(requestKey)) {
      return;
    }

    ensureDefaultInFlightRef.current.add(requestKey);

    convexEnsureDefaultWorkspace({
      organizationId: effectiveWorkspaceOrganizationId,
    })
      .then((workspaceId) => {
        ensureDefaultCompletedRef.current.add(requestKey);
      })
      .catch((error) => {
        ensureDefaultInFlightRef.current.delete(requestKey);
        logger.error("Failed to ensure default workspace", {
          organizationId: effectiveWorkspaceOrganizationId,
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
    effectiveWorkspaceOrganizationId,
    logger,
  ]);

  const handleCreateWorkspace = useCallback(
    async (name: string, switchTo: boolean = false) => {
      if (isAuthenticated) {
        if (!effectiveWorkspaceOrganizationId) {
          toast.error("Select an organization to create workspaces.");
          return "";
        }

        try {
          const workspaceId = await convexCreateWorkspace({
            name,
            clientConfig: undefined,
            servers: {},
            organizationId: effectiveWorkspaceOrganizationId,
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

      const newWorkspace: Workspace = {
        id: `workspace_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
        name,
        servers: {},
        createdAt: new Date(),
        updatedAt: new Date(),
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
      convexCreateWorkspace,
      dispatch,
      effectiveWorkspaceOrganizationId,
      canManageBillingForWorkspaceActions,
    ],
  );

  const handleUpdateWorkspace = useCallback(
    async (workspaceId: string, updates: Partial<Workspace>): Promise<void> => {
      if (isAuthenticated) {
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
    [isAuthenticated, convexUpdateWorkspace, logger, dispatch],
  );

  const handleUpdateClientConfig = useCallback(
    async (
      workspaceId: string,
      clientConfig: WorkspaceClientConfig | undefined,
    ): Promise<void> => {
      const clientConfigStore = useClientConfigStore.getState();
      const awaitRemoteEcho = isAuthenticated && !useLocalFallback;

      clientConfigStore.beginSave({
        workspaceId,
        savedConfig: clientConfig,
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
          clientConfigStore.failSave();
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
      clientConfigStore.markSaved(clientConfig);
    },
    [
      isAuthenticated,
      useLocalFallback,
      convexUpdateClientConfig,
      clearPendingClientConfigSync,
      logger,
      dispatch,
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

        if (isAuthenticated) {
          setConvexActiveWorkspaceId(targetWorkspaceId);
        } else {
          dispatch({
            type: "SWITCH_WORKSPACE",
            workspaceId: targetWorkspaceId,
          });
        }
      }

      if (isAuthenticated) {
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

      if (isAuthenticated) {
        if (!effectiveWorkspaceOrganizationId) {
          toast.error("Select an organization to manage workspaces.");
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
            organizationId: effectiveWorkspaceOrganizationId,
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
        dispatch({ type: "DUPLICATE_WORKSPACE", workspaceId, newName });
        toast.success(`Workspace duplicated as "${newName}"`);
      }
    },
    [
      effectiveWorkspaces,
      isAuthenticated,
      convexCreateWorkspace,
      dispatch,
      effectiveWorkspaceOrganizationId,
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
    (convexWorkspaceId: string) => {
      if (isAuthenticated) {
        setConvexActiveWorkspaceId(convexWorkspaceId);
        logger.info("Switched to newly shared workspace", {
          convexWorkspaceId,
        });
      } else {
        dispatch({
          type: "UPDATE_WORKSPACE",
          workspaceId: appState.activeWorkspaceId,
          updates: { sharedWorkspaceId: convexWorkspaceId },
        });
      }
    },
    [isAuthenticated, logger, dispatch, appState.activeWorkspaceId],
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
      if (isAuthenticated) {
        if (!effectiveWorkspaceOrganizationId) {
          toast.error("Select an organization to manage workspaces.");
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
            organizationId: effectiveWorkspaceOrganizationId,
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
        const importedWorkspace: Workspace = {
          ...workspaceData,
          id: `workspace_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
          createdAt: new Date(),
          updatedAt: new Date(),
          isDefault: false,
        };
        dispatch({ type: "IMPORT_WORKSPACE", workspace: importedWorkspace });
        toast.success(`Workspace "${importedWorkspace.name}" imported`);
      }
    },
    [
      isAuthenticated,
      convexCreateWorkspace,
      dispatch,
      effectiveWorkspaceOrganizationId,
      canManageBillingForWorkspaceActions,
    ],
  );

  return {
    remoteWorkspaces,
    isLoadingWorkspaces,
    activeWorkspaceServersFlat,
    useLocalFallback,
    setConvexActiveWorkspaceId,
    isLoadingRemoteWorkspaces,
    effectiveWorkspaces,
    effectiveActiveWorkspaceId,
    handleCreateWorkspace,
    handleUpdateWorkspace,
    handleUpdateClientConfig,
    handleDeleteWorkspace,
    handleDuplicateWorkspace,
    handleSetDefaultWorkspace,
    handleWorkspaceShared,
    handleExportWorkspace,
    handleImportWorkspace,
  };
}
