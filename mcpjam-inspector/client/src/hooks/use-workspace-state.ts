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

interface LoggerLike {
  info: (message: string, meta?: Record<string, unknown>) => void;
  warn: (message: string, meta?: Record<string, unknown>) => void;
  error: (message: string, meta?: Record<string, unknown>) => void;
}

export interface UseWorkspaceStateParams {
  appState: AppState;
  dispatch: Dispatch<AppAction>;
  isAuthenticated: boolean;
  isAuthLoading: boolean;
  logger: LoggerLike;
}

export function useWorkspaceState({
  appState,
  dispatch,
  isAuthenticated,
  isAuthLoading,
  logger,
}: UseWorkspaceStateParams) {
  const { workspaces: remoteWorkspaces, isLoading: isLoadingWorkspaces } =
    useWorkspaceQueries({ isAuthenticated });
  const {
    createWorkspace: convexCreateWorkspace,
    updateWorkspace: convexUpdateWorkspace,
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

  const hasMigratedRef = useRef(false);
  const [useLocalFallback, setUseLocalFallback] = useState(false);
  const convexTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const CONVEX_TIMEOUT_MS = 10000;

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
            servers: deserializedServers,
            createdAt: new Date(rw.createdAt),
            updatedAt: new Date(rw.updatedAt),
            sharedWorkspaceId: rw._id,
          } as Workspace,
        ];
      }),
    );
  }, [remoteWorkspaces, convexActiveWorkspaceId, activeWorkspaceServersFlat]);

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
    if (!isAuthenticated) {
      hasMigratedRef.current = false;
      return;
    }
    if (useLocalFallback) return;
    if (hasMigratedRef.current) return;
    if (remoteWorkspaces === undefined) return;

    hasMigratedRef.current = true;

    const localWorkspaces = Object.values(appState.workspaces).filter(
      (w) => !w.sharedWorkspaceId,
    );

    if (localWorkspaces.length === 0) return;
    if (remoteWorkspaces.length > 0) return;

    logger.info("Migrating local workspaces to Convex", {
      count: localWorkspaces.length,
    });

    const migrateWorkspace = async (workspace: Workspace) => {
      try {
        const serializedServers = serializeServersForSharing(workspace.servers);
        await convexCreateWorkspace({
          name: workspace.name,
          description: workspace.description,
          servers: serializedServers,
        });
        logger.info("Migrated workspace to Convex", { name: workspace.name });
      } catch (error) {
        logger.error("Failed to migrate workspace", {
          name: workspace.name,
          error: error instanceof Error ? error.message : "Unknown error",
        });
      }
    };

    Promise.all(localWorkspaces.map(migrateWorkspace)).then(() => {
      toast.success("Your workspaces have been synced to the cloud");
    });
  }, [
    isAuthenticated,
    useLocalFallback,
    remoteWorkspaces,
    appState.workspaces,
    convexCreateWorkspace,
    logger,
  ]);

  const handleCreateWorkspace = useCallback(
    async (name: string, switchTo: boolean = false) => {
      if (isAuthenticated) {
        try {
          const workspaceId = await convexCreateWorkspace({
            name,
            servers: {},
          });
          if (switchTo && workspaceId) {
            setConvexActiveWorkspaceId(workspaceId as string);
          }
          toast.success(`Workspace "${name}" created`);
          return workspaceId as string;
        } catch (error) {
          const errorMessage =
            error instanceof Error ? error.message : "Unknown error";
          toast.error(`Failed to create workspace: ${errorMessage}`);
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
    [isAuthenticated, convexCreateWorkspace, dispatch],
  );

  const handleUpdateWorkspace = useCallback(
    async (workspaceId: string, updates: Partial<Workspace>) => {
      if (isAuthenticated) {
        try {
          const updateData: any = { workspaceId };
          if (updates.name !== undefined) updateData.name = updates.name;
          if (updates.description !== undefined) {
            updateData.description = updates.description;
          }
          if (updates.servers !== undefined) {
            logger.warn(
              "Ignoring servers in handleUpdateWorkspace for authenticated user - use individual server operations",
            );
          }
          await convexUpdateWorkspace(updateData);
        } catch (error) {
          logger.error("Failed to update workspace", {
            error: error instanceof Error ? error.message : "Unknown error",
          });
        }
      } else {
        dispatch({ type: "UPDATE_WORKSPACE", workspaceId, updates });
      }
    },
    [isAuthenticated, convexUpdateWorkspace, logger, dispatch],
  );

  const handleDeleteWorkspace = useCallback(
    async (workspaceId: string) => {
      if (workspaceId === effectiveActiveWorkspaceId) {
        toast.error(
          "Cannot delete the active workspace. Switch to another workspace first.",
        );
        return;
      }

      if (isAuthenticated) {
        try {
          await convexDeleteWorkspace({ workspaceId });
        } catch (error) {
          let errorMessage = "Failed to delete workspace";
          if (error instanceof Error) {
            const match = error.message.match(/Uncaught Error: (.+?)(?:\n|$)/);
            errorMessage = match ? match[1] : error.message;
          }
          logger.error("Failed to delete workspace from Convex", {
            error: errorMessage,
          });
          toast.error(errorMessage);
          return;
        }
        toast.success("Workspace deleted");
      } else {
        dispatch({ type: "DELETE_WORKSPACE", workspaceId });
        toast.success("Workspace deleted");
      }
    },
    [
      effectiveActiveWorkspaceId,
      isAuthenticated,
      convexDeleteWorkspace,
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
            servers: serializedServers,
          });
          toast.success(`Workspace duplicated as "${newName}"`);
        } catch (error) {
          const errorMessage =
            error instanceof Error ? error.message : "Unknown error";
          toast.error(`Failed to duplicate workspace: ${errorMessage}`);
        }
      } else {
        dispatch({ type: "DUPLICATE_WORKSPACE", workspaceId, newName });
        toast.success(`Workspace duplicated as "${newName}"`);
      }
    },
    [effectiveWorkspaces, isAuthenticated, convexCreateWorkspace, dispatch],
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
            servers: serializedServers,
          });
          toast.success(`Workspace "${workspaceData.name}" imported`);
        } catch (error) {
          const errorMessage =
            error instanceof Error ? error.message : "Unknown error";
          toast.error(`Failed to import workspace: ${errorMessage}`);
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
    [isAuthenticated, convexCreateWorkspace, dispatch],
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
    handleDeleteWorkspace,
    handleDuplicateWorkspace,
    handleSetDefaultWorkspace,
    handleWorkspaceShared,
    handleExportWorkspace,
    handleImportWorkspace,
  };
}
