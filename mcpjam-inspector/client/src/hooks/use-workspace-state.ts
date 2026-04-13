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
  type BootstrapGuestSourceWorkspace,
  type RemoteWorkspace,
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
import {
  buildCarryForwardServerPayload,
} from "@/lib/persisted-server-payload";
import { useClientConfigStore } from "@/stores/client-config-store";
import { useOrganizationBillingStatus } from "./useOrganizationBilling";

const CLIENT_CONFIG_SYNC_ECHO_TIMEOUT_MS = 10000;
const GUEST_SERVER_CARRY_FORWARD_TIMEOUT_MS = 5000;

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

function buildGenerationKey(generation: number, key: string) {
  return `${generation}:${key}`;
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

function selectFallbackRemoteWorkspace(remoteWorkspaces: RemoteWorkspace[]) {
  const ownedFallbackWorkspace = remoteWorkspaces.reduce<RemoteWorkspace | null>(
    (newestWorkspace, workspace) => {
      if (!workspace.isOwnedFallbackCandidate) {
        return newestWorkspace;
      }
      if (!newestWorkspace) {
        return workspace;
      }
      return workspace.createdAt > newestWorkspace.createdAt
        ? workspace
        : newestWorkspace;
    },
    null,
  );

  return ownedFallbackWorkspace ?? remoteWorkspaces[0];
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
  const workspaceOrganizationId = routeOrganizationId ?? activeOrganizationId;
  const [convexActiveWorkspaceId, setConvexActiveWorkspaceId] = useState<
    string | null
  >(() => {
    if (typeof window !== "undefined") {
      return localStorage.getItem("convex-active-workspace-id");
    }
    return null;
  });
  const [useLocalFallback, setUseLocalFallback] = useState(false);

  // Guest server bootstrap: when a guest signs in, import their local servers
  // into Convex via a single mutation. Queries are paused until done so the
  // UI never shows a partially-imported workspace.
  const [isWorkspaceBootstrapLoading, setIsWorkspaceBootstrapLoading] =
    useState(false);
  const [hasCompletedBootstrapImport, setHasCompletedBootstrapImport] =
    useState(false);
  const operationContextKey =
    isAuthenticated && !useLocalFallback
      ? `auth:${workspaceOrganizationId ?? "fallback"}`
      : useLocalFallback
        ? "local-fallback"
        : "signed-out";
  const carryForwardLocalWorkspaces = useMemo(
    () =>
      Object.values(appState.workspaces).filter(
        (workspace) => Object.keys(workspace.servers).length > 0,
      ),
    [appState.workspaces],
  );
  const bootstrapGuestSourceWorkspaces =
    useMemo<BootstrapGuestSourceWorkspace[]>(
      () =>
        carryForwardLocalWorkspaces
          .map((workspace) => ({
            localWorkspaceId: workspace.id,
            servers: Object.entries(workspace.servers).map(
              ([serverName, server]) =>
                buildCarryForwardServerPayload(serverName, server),
            ),
          }))
          .filter((workspace) => workspace.servers.length > 0),
      [carryForwardLocalWorkspaces],
    );
  const hasCarryForwardCandidates = bootstrapGuestSourceWorkspaces.length > 0;
  // Hold off Convex queries until guest server carry-forward finishes, preventing
  // the UI from briefly showing an empty or partial workspace.
  const shouldPauseRemoteBootstrapQueries =
    isAuthenticated &&
    !useLocalFallback &&
    hasCarryForwardCandidates &&
    !hasCompletedBootstrapImport;
  const {
    allWorkspaces: allRemoteWorkspaces,
    workspaces: remoteWorkspaces,
    isLoading: isLoadingWorkspaces,
  } = useWorkspaceQueries({
    isAuthenticated,
    organizationId: workspaceOrganizationId,
    enabled: !shouldPauseRemoteBootstrapQueries,
  });
  const {
    createWorkspace: convexCreateWorkspace,
    bootstrapGuestServerImport: convexBootstrapGuestServerImport,
    ensureDefaultWorkspace: convexEnsureDefaultWorkspace,
    updateWorkspace: convexUpdateWorkspace,
    updateClientConfig: convexUpdateClientConfig,
    deleteWorkspace: convexDeleteWorkspace,
  } = useWorkspaceMutations();
  const billingStatus = useOrganizationBillingStatus(
    workspaceOrganizationId ?? null,
    { enabled: isAuthenticated },
  );

  const { servers: activeWorkspaceServersFlat, isLoading: isLoadingServers } =
    useWorkspaceServers({
      workspaceId: convexActiveWorkspaceId,
      isAuthenticated,
      enabled: !shouldPauseRemoteBootstrapQueries,
    });

  const operationGenerationRef = useRef(0);
  const operationContextKeyRef = useRef(operationContextKey);
  const migrationInFlightRef = useRef(new Set<string>());
  const bootstrapMutationInFlightGenerationRef = useRef<number | null>(null);
  const completedBootstrapGenerationRef = useRef<number | null>(null);
  const ensureDefaultInFlightRef = useRef(new Set<string>());
  const ensureDefaultCompletedRef = useRef(new Set<string>());
  const migrationErrorNotifiedRef = useRef(new Set<string>());
  const convexTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const workspaceBootstrapTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const workspaceBootstrapTimeoutGenerationRef = useRef<number | null>(null);
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

  const clearWorkspaceBootstrapTimeout = useCallback(() => {
    if (workspaceBootstrapTimeoutRef.current) {
      clearTimeout(workspaceBootstrapTimeoutRef.current);
      workspaceBootstrapTimeoutRef.current = null;
    }
    workspaceBootstrapTimeoutGenerationRef.current = null;
  }, []);

  const isCurrentOperationGeneration = useCallback((generation: number) => {
    return operationGenerationRef.current === generation;
  }, []);

  const canContinueBootstrapGeneration = useCallback((generation: number) => {
    return (
      operationGenerationRef.current === generation &&
      completedBootstrapGenerationRef.current !== generation
    );
  }, []);

  const resetOperationGeneration = useCallback(() => {
    operationGenerationRef.current += 1;
    migrationInFlightRef.current.clear();
    bootstrapMutationInFlightGenerationRef.current = null;
    completedBootstrapGenerationRef.current = null;
    migrationErrorNotifiedRef.current.clear();
    clearWorkspaceBootstrapTimeout();
    setHasCompletedBootstrapImport(false);
    setIsWorkspaceBootstrapLoading(false);
    return operationGenerationRef.current;
  }, [clearWorkspaceBootstrapTimeout]);

  const finishWorkspaceBootstrap = useCallback(
    (generation: number) => {
      if (!isCurrentOperationGeneration(generation)) {
        return;
      }

      completedBootstrapGenerationRef.current = generation;
      setHasCompletedBootstrapImport(true);
      clearWorkspaceBootstrapTimeout();
      if (bootstrapMutationInFlightGenerationRef.current === generation) {
        bootstrapMutationInFlightGenerationRef.current = null;
      }
      setIsWorkspaceBootstrapLoading(false);
    },
    [clearWorkspaceBootstrapTimeout, isCurrentOperationGeneration],
  );

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

  useEffect(() => {
    return () => {
      clearWorkspaceBootstrapTimeout();
    };
  }, [clearWorkspaceBootstrapTimeout]);

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
      if (remoteWorkspaces.length === 0) {
        return "none";
      }
      return selectFallbackRemoteWorkspace(remoteWorkspaces)._id;
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
  const canManageBillingForWorkspaceActions = workspaceOrganizationId
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
          setConvexActiveWorkspaceId(
            selectFallbackRemoteWorkspace(remoteWorkspaces)._id,
          );
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
    if (operationContextKeyRef.current !== operationContextKey) {
      operationContextKeyRef.current = operationContextKey;
      resetOperationGeneration();
    }
  }, [operationContextKey, resetOperationGeneration]);

  useEffect(() => {
    const currentGeneration = operationGenerationRef.current;
    const shouldRunBootstrapImport =
      isAuthenticated &&
      !isAuthLoading &&
      !useLocalFallback &&
      hasCarryForwardCandidates &&
      !hasCompletedBootstrapImport;

    if (!shouldRunBootstrapImport) {
      clearWorkspaceBootstrapTimeout();
      setIsWorkspaceBootstrapLoading(false);
      return;
    }

    setIsWorkspaceBootstrapLoading(true);
    if (workspaceBootstrapTimeoutGenerationRef.current !== currentGeneration) {
      clearWorkspaceBootstrapTimeout();
      workspaceBootstrapTimeoutGenerationRef.current = currentGeneration;
      workspaceBootstrapTimeoutRef.current = setTimeout(() => {
        if (!canContinueBootstrapGeneration(currentGeneration)) {
          return;
        }
        workspaceBootstrapTimeoutRef.current = null;
        workspaceBootstrapTimeoutGenerationRef.current = null;
        logger.warn("Guest server carry-forward timed out", {
          timeoutMs: GUEST_SERVER_CARRY_FORWARD_TIMEOUT_MS,
        });
        toast.warning(
          "Importing your servers took too long. Opened app without waiting.",
        );
        finishWorkspaceBootstrap(currentGeneration);
      }, GUEST_SERVER_CARRY_FORWARD_TIMEOUT_MS);
    }
  }, [
    canContinueBootstrapGeneration,
    clearWorkspaceBootstrapTimeout,
    finishWorkspaceBootstrap,
    hasCompletedBootstrapImport,
    hasCarryForwardCandidates,
    isAuthenticated,
    isAuthLoading,
    logger,
    useLocalFallback,
  ]);

  useEffect(() => {
    if (
      !isAuthenticated ||
      useLocalFallback ||
      hasCarryForwardCandidates ||
      allRemoteWorkspaces === undefined ||
      allRemoteWorkspaces.length > 0 ||
      migratableLocalWorkspaceCount === 0
    ) {
      migrationErrorNotifiedRef.current.clear();
    }
  }, [
    isAuthenticated,
    useLocalFallback,
    hasCarryForwardCandidates,
    allRemoteWorkspaces,
    migratableLocalWorkspaceCount,
  ]);

  useEffect(() => {
    if (!isAuthenticated) {
      return;
    }
    if (hasCarryForwardCandidates) return;
    const currentGeneration = operationGenerationRef.current;
    if (completedBootstrapGenerationRef.current === currentGeneration) return;
    if (isAuthLoading) return;
    if (useLocalFallback) return;
    if (allRemoteWorkspaces === undefined) return;
    if (allRemoteWorkspaces.length > 0) return;
    if (migratableLocalWorkspaceCount === 0) return;

    logger.info("Migrating local workspaces to Convex", {
      count: migratableLocalWorkspaceCount,
    });

    const migrateWorkspace = async (workspace: Workspace) => {
      if (!isCurrentOperationGeneration(currentGeneration)) {
        return;
      }
      const inFlightKey = buildGenerationKey(currentGeneration, workspace.id);
      if (migrationInFlightRef.current.has(inFlightKey)) {
        return;
      }

      migrationInFlightRef.current.add(inFlightKey);

      try {
        const workspaceId = await convexCreateWorkspace({
          name: workspace.name,
          description: workspace.description,
          clientConfig: workspace.clientConfig,
          servers: {},
          ...(workspaceOrganizationId
            ? { organizationId: workspaceOrganizationId }
            : {}),
        });
        if (!isCurrentOperationGeneration(currentGeneration)) {
          return;
        }

        dispatch({
          type: "UPDATE_WORKSPACE",
          workspaceId: workspace.id,
          updates: {
            sharedWorkspaceId: workspaceId as string,
            ...(workspaceOrganizationId
              ? { organizationId: workspaceOrganizationId }
              : {}),
          },
        });

        if (appState.activeWorkspaceId === workspace.id) {
          setConvexActiveWorkspaceId(workspaceId as string);
        }

        logger.info("Migrated workspace to Convex", { name: workspace.name });
      } catch (error) {
        migrationInFlightRef.current.delete(inFlightKey);
        if (!isCurrentOperationGeneration(currentGeneration)) {
          return;
        }
        const requestKey = buildGenerationKey(
          currentGeneration,
          workspaceOrganizationId ?? "fallback",
        );
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
        if (hasCarryForwardCandidates) {
          finishWorkspaceBootstrap(currentGeneration);
        }
      }
    };

    Promise.all(migratableLocalWorkspaces.map(migrateWorkspace));
  }, [
    isAuthenticated,
    isAuthLoading,
    useLocalFallback,
    hasCarryForwardCandidates,
    allRemoteWorkspaces,
    migratableLocalWorkspaces,
    migratableLocalWorkspaceCount,
    convexCreateWorkspace,
    dispatch,
    logger,
    workspaceOrganizationId,
    canManageBillingForWorkspaceActions,
    appState.activeWorkspaceId,
    finishWorkspaceBootstrap,
    isCurrentOperationGeneration,
  ]);

  useEffect(() => {
    if (!isAuthenticated) {
      return;
    }
    const currentGeneration = operationGenerationRef.current;
    if (isAuthLoading) return;
    if (useLocalFallback) return;
    if (!hasCarryForwardCandidates) return;
    if (hasCompletedBootstrapImport) return;
    if (bootstrapMutationInFlightGenerationRef.current === currentGeneration) {
      return;
    }

    bootstrapMutationInFlightGenerationRef.current = currentGeneration;

    void (async () => {
      try {
        const result = await convexBootstrapGuestServerImport({
          ...(workspaceOrganizationId
            ? { organizationId: workspaceOrganizationId }
            : {}),
          ...(convexActiveWorkspaceId
            ? { preferredWorkspaceId: convexActiveWorkspaceId }
            : {}),
          sourceWorkspaces: bootstrapGuestSourceWorkspaces,
        });

        if (!canContinueBootstrapGeneration(currentGeneration)) {
          return;
        }

        const targetOrganizationId =
          result.targetOrganizationId ?? workspaceOrganizationId;

        setConvexActiveWorkspaceId(result.targetWorkspaceId);
        localStorage.setItem(
          "convex-active-workspace-id",
          result.targetWorkspaceId,
        );

        for (const workspaceId of result.importedSourceWorkspaceIds) {
          dispatch({
            type: "UPDATE_WORKSPACE",
            workspaceId,
            updates: {
              sharedWorkspaceId: result.targetWorkspaceId,
              ...(targetOrganizationId
                ? { organizationId: targetOrganizationId }
                : {}),
            },
          });
        }

        if (result.failedServerNames.length > 0) {
          logger.error("Failed to carry forward some guest servers", {
            targetWorkspaceId: result.targetWorkspaceId,
            serverNames: result.failedServerNames,
          });
          toast.error(
            `Could not import some guest servers after sign-in: ${result.failedServerNames.join(", ")}`,
          );
        }

        if (result.timedOut) {
          logger.warn("Guest server carry-forward timed out in Convex", {
            targetWorkspaceId: result.targetWorkspaceId,
          });
          toast.warning(
            "Importing your servers took too long. Opened app without waiting.",
          );
        }

        logger.info("Carried forward guest workspace servers", {
          targetWorkspaceId: result.targetWorkspaceId,
          importedServerCount: result.importedServerNames.length,
          skippedExistingNameServerCount:
            result.skippedExistingNameServerNames.length,
          failedServerCount: result.failedServerNames.length,
          sourceWorkspaceCount: result.importedSourceWorkspaceIds.length,
          timedOut: result.timedOut,
        });
      } catch (error) {
        if (canContinueBootstrapGeneration(currentGeneration)) {
          logger.error("Failed to carry forward guest workspace servers", {
            error: error instanceof Error ? error.message : "Unknown error",
          });
          toast.error("Could not import guest servers after sign-in");
        }
      } finally {
        finishWorkspaceBootstrap(currentGeneration);
      }
    })();
  }, [
    canContinueBootstrapGeneration,
    isAuthenticated,
    isAuthLoading,
    useLocalFallback,
    hasCarryForwardCandidates,
    hasCompletedBootstrapImport,
    bootstrapGuestSourceWorkspaces,
    convexActiveWorkspaceId,
    convexBootstrapGuestServerImport,
    dispatch,
    finishWorkspaceBootstrap,
    workspaceOrganizationId,
    logger,
  ]);

  useEffect(() => {
    if (!isAuthenticated) {
      return;
    }
    if (hasCarryForwardCandidates) return;
    const currentGeneration = operationGenerationRef.current;
    if (completedBootstrapGenerationRef.current === currentGeneration) return;
    if (useLocalFallback) return;
    if (remoteWorkspaces === undefined) return;
    if (hasCurrentOrganizationWorkspaces) return;
    if (!hasAnyRemoteWorkspaces && migratableLocalWorkspaceCount > 0) return;

    const requestKey = workspaceOrganizationId ?? "fallback";
    if (ensureDefaultInFlightRef.current.has(requestKey)) {
      return;
    }
    if (ensureDefaultCompletedRef.current.has(requestKey)) {
      return;
    }

    ensureDefaultInFlightRef.current.add(requestKey);

    convexEnsureDefaultWorkspace(
      workspaceOrganizationId
        ? { organizationId: workspaceOrganizationId }
        : {},
    )
      .then(() => {
        ensureDefaultInFlightRef.current.delete(requestKey);
        ensureDefaultCompletedRef.current.add(requestKey);
      })
      .catch((error) => {
        ensureDefaultInFlightRef.current.delete(requestKey);
        if (!isCurrentOperationGeneration(currentGeneration)) {
          return;
        }
        logger.error("Failed to ensure default workspace", {
          organizationId: workspaceOrganizationId,
          error: error instanceof Error ? error.message : "Unknown error",
        });
        if (hasCarryForwardCandidates) {
          finishWorkspaceBootstrap(currentGeneration);
        }
      });
  }, [
    isAuthenticated,
    useLocalFallback,
    hasCarryForwardCandidates,
    remoteWorkspaces,
    hasCurrentOrganizationWorkspaces,
    hasAnyRemoteWorkspaces,
    migratableLocalWorkspaceCount,
    convexEnsureDefaultWorkspace,
    finishWorkspaceBootstrap,
    isCurrentOperationGeneration,
    workspaceOrganizationId,
    logger,
  ]);

  const handleCreateWorkspace = useCallback(
    async (name: string, switchTo: boolean = false) => {
      if (isAuthenticated) {
        try {
          const workspaceId = await convexCreateWorkspace({
            name,
            clientConfig: undefined,
            servers: {},
            ...(workspaceOrganizationId
              ? { organizationId: workspaceOrganizationId }
              : {}),
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
      workspaceOrganizationId,
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
        try {
          const serializedServers = serializeServersForSharing(
            sourceWorkspace.servers,
          );
          await convexCreateWorkspace({
            name: newName,
            description: sourceWorkspace.description,
            clientConfig: sourceWorkspace.clientConfig,
            servers: serializedServers,
            ...(workspaceOrganizationId
              ? { organizationId: workspaceOrganizationId }
              : {}),
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
      workspaceOrganizationId,
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
        try {
          const serializedServers = serializeServersForSharing(
            workspaceData.servers || {},
          );
          await convexCreateWorkspace({
            name: workspaceData.name,
            description: workspaceData.description,
            clientConfig: workspaceData.clientConfig,
            servers: serializedServers,
            ...(workspaceOrganizationId
              ? { organizationId: workspaceOrganizationId }
              : {}),
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
      workspaceOrganizationId,
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
    isWorkspaceBootstrapLoading,
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
