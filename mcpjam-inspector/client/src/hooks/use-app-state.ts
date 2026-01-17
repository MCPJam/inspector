import {
  useCallback,
  useEffect,
  useReducer,
  useRef,
  useState,
  useMemo,
} from "react";
import { toast } from "sonner";
import { useConvexAuth } from "convex/react";
import { useLogger } from "./use-logger";
import {
  initialAppState,
  type ServerWithName,
  type Workspace,
} from "@/state/app-types";
import { appReducer } from "@/state/app-reducer";
import { loadAppState, saveAppState } from "@/state/storage";
import { useWorkspaceQueries, useWorkspaceMutations } from "./useWorkspaces";
import {
  serializeServersForSharing,
  deserializeServersFromConvex,
} from "@/lib/workspace-serialization";
import {
  testConnection,
  deleteServer,
  listServers,
  reconnectServer,
  getInitializationInfo,
} from "@/state/mcp-api";
import {
  ensureAuthorizedForReconnect,
  type OAuthResult,
} from "@/state/oauth-orchestrator";
import type { ServerFormData } from "@/shared/types.js";
import { toMCPConfig } from "@/state/server-helpers";
import {
  handleOAuthCallback,
  getStoredTokens,
  clearOAuthData,
  initiateOAuth,
} from "@/lib/oauth/mcp-oauth";
import { MCPServerConfig } from "@/sdk";
import type { OAuthTestProfile } from "@/lib/oauth/profile";
export type { ServerWithName } from "@/state/app-types";

/**
 * Saves OAuth-related configuration to localStorage for reconnection purposes.
 * This persists server URL, scopes, headers, and client credentials.
 */
function saveOAuthConfigToLocalStorage(formData: ServerFormData): void {
  if (formData.type !== "http" || !formData.useOAuth || !formData.url) {
    return;
  }

  localStorage.setItem(`mcp-serverUrl-${formData.name}`, formData.url);

  const oauthConfig: Record<string, unknown> = {};
  if (formData.oauthScopes && formData.oauthScopes.length > 0) {
    oauthConfig.scopes = formData.oauthScopes;
  }
  if (formData.headers && Object.keys(formData.headers).length > 0) {
    oauthConfig.customHeaders = formData.headers;
  }
  if (Object.keys(oauthConfig).length > 0) {
    localStorage.setItem(
      `mcp-oauth-config-${formData.name}`,
      JSON.stringify(oauthConfig),
    );
  }

  if (formData.clientId || formData.clientSecret) {
    const clientInfo: Record<string, string> = {};
    if (formData.clientId) {
      clientInfo.client_id = formData.clientId;
    }
    if (formData.clientSecret) {
      clientInfo.client_secret = formData.clientSecret;
    }
    localStorage.setItem(
      `mcp-client-${formData.name}`,
      JSON.stringify(clientInfo),
    );
  }
}

export function useAppState() {
  const logger = useLogger("Connections");

  const [appState, dispatch] = useReducer(appReducer, initialAppState);
  const [isLoading, setIsLoading] = useState(true);
  // Guard to prevent duplicate OAuth callback processing
  const oauthCallbackHandledRef = useRef(false);
  // Operation guard to avoid races
  const opTokenRef = useRef<Map<string, number>>(new Map());
  const nextOpToken = (name: string) => {
    const current = opTokenRef.current.get(name) ?? 0;
    const next = current + 1;
    opTokenRef.current.set(name, next);
    return next;
  };
  const isStaleOp = (name: string, token: number) =>
    (opTokenRef.current.get(name) ?? 0) !== token;

  // Convex integration for workspaces
  const { isAuthenticated, isLoading: isAuthLoading } = useConvexAuth();
  const { workspaces: remoteWorkspaces, isLoading: isLoadingWorkspaces } =
    useWorkspaceQueries({ isAuthenticated });
  const {
    createWorkspace: convexCreateWorkspace,
    updateWorkspace: convexUpdateWorkspace,
    deleteWorkspace: convexDeleteWorkspace,
  } = useWorkspaceMutations();

  // Track if we've done the initial migration from local to Convex
  const hasMigratedRef = useRef(false);
  // Track active workspace ID separately for authenticated mode (Convex IDs)
  // Initialize from localStorage synchronously to avoid race conditions with OAuth callback
  const [convexActiveWorkspaceId, setConvexActiveWorkspaceId] = useState<
    string | null
  >(() => {
    if (typeof window !== "undefined") {
      return localStorage.getItem("convex-active-workspace-id");
    }
    return null;
  });
  // Debounce timer for Convex updates
  const syncTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  // Fallback to local storage if Convex takes too long or fails
  const [useLocalFallback, setUseLocalFallback] = useState(false);
  const convexTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const CONVEX_TIMEOUT_MS = 10000; // 10 seconds timeout

  // Load from storage once
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

  // Persist local state on change (only for unauthenticated mode or server runtime state)
  useEffect(() => {
    if (!isLoading) saveAppState(appState);
  }, [appState, isLoading]);

  // Convex timeout - fall back to local if Convex takes too long
  useEffect(() => {
    if (!isAuthenticated) {
      // Not authenticated, reset fallback state
      setUseLocalFallback(false);
      if (convexTimeoutRef.current) {
        clearTimeout(convexTimeoutRef.current);
        convexTimeoutRef.current = null;
      }
      return;
    }

    if (remoteWorkspaces !== undefined) {
      // Convex responded, clear timeout and reset fallback
      setUseLocalFallback(false);
      if (convexTimeoutRef.current) {
        clearTimeout(convexTimeoutRef.current);
        convexTimeoutRef.current = null;
      }
      return;
    }

    // Authenticated but still waiting for Convex - start timeout
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

  // Flag indicating we're waiting for Convex workspaces to load
  // Also true when auth is loading and user was previously authenticated
  const isLoadingRemoteWorkspaces =
    (isAuthenticated && !useLocalFallback && remoteWorkspaces === undefined) ||
    (isAuthLoading && !!convexActiveWorkspaceId);

  // Convert remote workspaces to local format
  const convexWorkspaces = useMemo((): Record<string, Workspace> => {
    if (!remoteWorkspaces) return {};
    return Object.fromEntries(
      remoteWorkspaces.map((rw) => {
        const deserializedServers = deserializeServersFromConvex(
          rw.servers || {},
        );
        return [
          rw._id,
          {
            id: rw._id,
            name: rw.name,
            description: rw.description,
            servers: deserializedServers,
            createdAt: new Date(rw.createdAt),
            updatedAt: new Date(rw.updatedAt),
            sharedWorkspaceId: rw._id, // Points to itself when in Convex
          } as Workspace,
        ];
      }),
    );
  }, [remoteWorkspaces]);

  // Derive effective workspaces based on auth state
  // When authenticated: use Convex as source of truth (unless fallback is active)
  // When not authenticated or fallback: use local state
  const effectiveWorkspaces = useMemo((): Record<string, Workspace> => {
    if (useLocalFallback) {
      // Convex connection failed, use local storage
      return appState.workspaces;
    }
    if (isAuthenticated && remoteWorkspaces !== undefined) {
      // If no workspaces in Convex yet, show empty (migration will create them)
      return convexWorkspaces;
    }
    if (isAuthenticated) {
      // Waiting for Convex - return empty, UI will show loading skeleton
      return {};
    }
    // If auth is still loading and user was previously authenticated (has convexActiveWorkspaceId),
    // return empty to avoid briefly showing local workspaces before Convex loads
    if (isAuthLoading && convexActiveWorkspaceId) {
      return {};
    }
    return appState.workspaces;
  }, [
    isAuthenticated,
    isAuthLoading,
    remoteWorkspaces,
    convexWorkspaces,
    convexActiveWorkspaceId,
    appState.workspaces,
    useLocalFallback,
  ]);

  // Derive effective active workspace ID
  const effectiveActiveWorkspaceId = useMemo(() => {
    if (useLocalFallback) {
      // Convex connection failed, use local storage
      return appState.activeWorkspaceId;
    }
    if (isAuthenticated && remoteWorkspaces !== undefined) {
      // Use convexActiveWorkspaceId if set and valid
      if (
        convexActiveWorkspaceId &&
        effectiveWorkspaces[convexActiveWorkspaceId]
      ) {
        return convexActiveWorkspaceId;
      }
      // Default to first workspace
      const firstId = Object.keys(effectiveWorkspaces)[0];
      return firstId || "none";
    }
    return appState.activeWorkspaceId;
  }, [
    isAuthenticated,
    remoteWorkspaces,
    convexActiveWorkspaceId,
    effectiveWorkspaces,
    appState.activeWorkspaceId,
    useLocalFallback,
  ]);

  // Set initial active workspace when Convex workspaces load
  // Also handles case where stored workspace ID no longer exists
  useEffect(() => {
    if (isAuthenticated && remoteWorkspaces && remoteWorkspaces.length > 0) {
      // If no workspace selected, or selected workspace doesn't exist, pick a valid one
      if (
        !convexActiveWorkspaceId ||
        !convexWorkspaces[convexActiveWorkspaceId]
      ) {
        // Try to restore last active workspace from localStorage
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

  // Persist active workspace ID to localStorage
  useEffect(() => {
    if (convexActiveWorkspaceId) {
      localStorage.setItem(
        "convex-active-workspace-id",
        convexActiveWorkspaceId,
      );
    }
  }, [convexActiveWorkspaceId]);

  // Migrate local workspaces to Convex on first login
  useEffect(() => {
    if (!isAuthenticated) {
      hasMigratedRef.current = false; // Reset when logged out
      return;
    }
    if (useLocalFallback) return; // Skip migration if Convex is unavailable
    if (hasMigratedRef.current) return;
    if (remoteWorkspaces === undefined) return; // Still loading

    hasMigratedRef.current = true;

    // Check if user has local workspaces that need migration
    const localWorkspaces = Object.values(appState.workspaces).filter(
      (w) => !w.sharedWorkspaceId, // Only migrate workspaces not already linked to Convex
    );

    if (localWorkspaces.length === 0) return;
    if (remoteWorkspaces.length > 0) return; // User already has Convex workspaces, don't migrate

    // Migrate local workspaces to Convex
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

    // Migrate all local workspaces
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

  // Get active workspace with server runtime state overlaid
  const activeWorkspace = useMemo(() => {
    const workspace = effectiveWorkspaces[effectiveActiveWorkspaceId];
    if (!workspace) {
      return undefined;
    }

    // Overlay server runtime state from appState.servers
    const serversWithRuntime: Record<string, ServerWithName> = {};
    for (const [name, server] of Object.entries(workspace.servers)) {
      const runtimeState = appState.servers[name];
      serversWithRuntime[name] = {
        ...server,
        connectionStatus: runtimeState?.connectionStatus || "disconnected",
        oauthTokens: runtimeState?.oauthTokens,
        initializationInfo: runtimeState?.initializationInfo,
        lastConnectionTime:
          runtimeState?.lastConnectionTime || server.lastConnectionTime,
        retryCount: runtimeState?.retryCount || 0,
      };
    }

    return { ...workspace, servers: serversWithRuntime };
  }, [effectiveWorkspaces, effectiveActiveWorkspaceId, appState.servers]);

  // Servers with runtime state for the active workspace
  const effectiveServers = useMemo(() => {
    return activeWorkspace?.servers || {};
  }, [activeWorkspace]);

  const validateForm = (formData: ServerFormData): string | null => {
    if (formData.type === "stdio") {
      if (!formData.command || formData.command.trim() === "") {
        return "Command is required for STDIO connections";
      }
      return null;
    }
    if (!formData.url || formData.url.trim() === "") {
      return "URL is required for HTTP connections";
    }
    try {
      new URL(formData.url);
    } catch (err) {
      return `Invalid URL format: ${formData.url} ${err}`;
    }
    return null;
  };

  const setSelectedMultipleServersToAllServers = useCallback(() => {
    const connectedNames = Object.entries(appState.servers)
      .filter(([, s]) => s.connectionStatus === "connected")
      .map(([name]) => name);
    dispatch({ type: "SET_MULTI_SELECTED", names: connectedNames });
  }, [appState.servers]);

  // Helper to sync server config to Convex workspace
  const syncServerToConvex = useCallback(
    async (serverName: string, serverEntry: ServerWithName) => {
      // Skip Convex sync if using local fallback or not authenticated
      if (useLocalFallback || !isAuthenticated || !effectiveActiveWorkspaceId)
        return;

      const currentWorkspace = effectiveWorkspaces[effectiveActiveWorkspaceId];
      if (!currentWorkspace) return;

      const updatedServers = {
        ...currentWorkspace.servers,
        [serverName]: serverEntry,
      };

      try {
        await convexUpdateWorkspace({
          workspaceId: effectiveActiveWorkspaceId,
          servers: serializeServersForSharing(updatedServers),
        });
      } catch (error) {
        logger.error("Failed to sync server to Convex", {
          serverName,
          error: error instanceof Error ? error.message : "Unknown error",
        });
      }
    },
    [
      useLocalFallback,
      isAuthenticated,
      effectiveActiveWorkspaceId,
      effectiveWorkspaces,
      convexUpdateWorkspace,
      logger,
    ],
  );

  // Helper to remove server from Convex workspace
  const removeServerFromConvex = useCallback(
    async (serverName: string) => {
      // Skip Convex sync if using local fallback or not authenticated
      if (useLocalFallback || !isAuthenticated || !effectiveActiveWorkspaceId)
        return;

      const currentWorkspace = effectiveWorkspaces[effectiveActiveWorkspaceId];
      if (!currentWorkspace) return;

      const { [serverName]: _, ...remainingServers } = currentWorkspace.servers;

      try {
        await convexUpdateWorkspace({
          workspaceId: effectiveActiveWorkspaceId,
          servers: serializeServersForSharing(remainingServers),
        });
      } catch (error) {
        logger.error("Failed to remove server from Convex", {
          serverName,
          error: error instanceof Error ? error.message : "Unknown error",
        });
      }
    },
    [
      useLocalFallback,
      isAuthenticated,
      effectiveActiveWorkspaceId,
      effectiveWorkspaces,
      convexUpdateWorkspace,
      logger,
    ],
  );

  // Helper to fetch and store initialization info
  const fetchAndStoreInitInfo = useCallback(async (serverName: string) => {
    try {
      const result = await getInitializationInfo(serverName);
      if (result.success && result.initInfo) {
        dispatch({
          type: "SET_INITIALIZATION_INFO",
          name: serverName,
          initInfo: result.initInfo,
        });
      }
    } catch (error) {
      // Silent fail - initialization info is optional
      console.debug("Failed to fetch initialization info", {
        serverName,
        error,
      });
    }
  }, []);

  // OAuth callback finish handler
  const handleOAuthCallbackComplete = useCallback(
    async (code: string) => {
      // Note: URL is already cleared by the useEffect before calling this function
      // to prevent duplicate processing from React re-renders

      try {
        const result = await handleOAuthCallback(code);

        // Clean up OAuth return hash from localStorage
        localStorage.removeItem("mcp-oauth-return-hash");

        if (result.success && result.serverConfig && result.serverName) {
          const serverName = result.serverName;

          // Move to connecting with fresh OAuth config
          dispatch({
            type: "CONNECT_REQUEST",
            name: serverName,
            config: result.serverConfig,
            select: true,
          });

          // Test the connection
          try {
            const connectionResult = await testConnection(
              result.serverConfig,
              serverName,
            );
            if (connectionResult.success) {
              dispatch({
                type: "CONNECT_SUCCESS",
                name: serverName,
                config: result.serverConfig,
                tokens: getStoredTokens(serverName),
              });
              logger.info("OAuth connection successful", { serverName });
              toast.success(
                `OAuth connection successful! Connected to ${serverName}.`,
              );
              fetchAndStoreInitInfo(serverName).catch((err) =>
                logger.warn("Failed to fetch init info", { serverName, err }),
              );
            } else {
              dispatch({
                type: "CONNECT_FAILURE",
                name: serverName,
                error:
                  connectionResult.error ||
                  "Connection test failed after OAuth",
              });
              logger.error("OAuth connection test failed", {
                serverName,
                error: connectionResult.error,
              });
              toast.error(
                `OAuth succeeded but connection test failed: ${connectionResult.error}`,
              );
            }
          } catch (connectionError) {
            const errorMessage =
              connectionError instanceof Error
                ? connectionError.message
                : "Unknown connection error";
            dispatch({
              type: "CONNECT_FAILURE",
              name: serverName,
              error: errorMessage,
            });
            logger.error("OAuth connection test error", {
              serverName,
              error: errorMessage,
            });
            toast.error(
              `OAuth succeeded but connection test failed: ${errorMessage}`,
            );
          }
        } else {
          throw new Error(result.error || "OAuth callback failed");
        }
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : "Unknown error";
        toast.error(`Error completing OAuth flow: ${errorMessage}`);
        logger.error("OAuth callback failed", { error: errorMessage });

        // Clean up OAuth state on failure
        localStorage.removeItem("mcp-oauth-return-hash");
        localStorage.removeItem("mcp-oauth-pending");
      }
    },
    [logger, fetchAndStoreInitInfo],
  );

  // Check for OAuth callback completion on mount
  useEffect(() => {
    // Skip OAuth callback handling if we're on the debug callback page
    // The debug callback page handles its own OAuth flow visualization
    if (window.location.pathname.startsWith("/oauth/callback/debug")) {
      return;
    }

    // Wait for local storage to load
    if (isLoading) return;

    // Wait for auth state to be determined before processing OAuth callback
    // This prevents processing while isAuthenticated is still false due to loading
    if (isAuthLoading) return;

    // If authenticated, also wait for Convex workspaces to load and workspace ID to be set
    // This ensures syncServerToConvex will work correctly
    // Skip this wait if useLocalFallback is true (Convex timed out)
    if (
      isAuthenticated &&
      !useLocalFallback &&
      (isLoadingWorkspaces || !effectiveActiveWorkspaceId)
    ) {
      return;
    }

    const urlParams = new URLSearchParams(window.location.search);
    const code = urlParams.get("code");
    const error = urlParams.get("error");
    if (code) {
      // Prevent duplicate processing (React StrictMode, dependency changes, etc.)
      if (oauthCallbackHandledRef.current) {
        return;
      }
      oauthCallbackHandledRef.current = true;

      // Clear URL immediately to prevent re-processing on re-renders
      const savedHash = localStorage.getItem("mcp-oauth-return-hash") || "";
      window.history.replaceState(
        {},
        document.title,
        window.location.pathname + savedHash,
      );

      handleOAuthCallbackComplete(code);
    } else if (error) {
      toast.error(`OAuth authorization failed: ${error}`);
      localStorage.removeItem("mcp-oauth-pending");
      window.history.replaceState({}, document.title, window.location.pathname);
    }
  }, [
    isLoading,
    isAuthLoading,
    isLoadingWorkspaces,
    isAuthenticated,
    effectiveActiveWorkspaceId,
    useLocalFallback,
    handleOAuthCallbackComplete,
  ]);

  const handleConnect = useCallback(
    async (formData: ServerFormData) => {
      const validationError = validateForm(formData);
      if (validationError) {
        toast.error(validationError);
        return;
      }

      const mcpConfig = toMCPConfig(formData);
      dispatch({
        type: "CONNECT_REQUEST",
        name: formData.name,
        config: mcpConfig,
        select: true,
      });
      const token = nextOpToken(formData.name);

      // Save server config BEFORE attempting connection
      // This ensures the config is persisted even if connection/OAuth fails
      const serverEntryForSave: ServerWithName = {
        name: formData.name,
        config: mcpConfig,
        lastConnectionTime: new Date(),
        connectionStatus: "connecting",
        retryCount: 0,
        enabled: true,
        useOAuth: formData.useOAuth ?? false,
      };
      // For authenticated users, sync to Convex
      syncServerToConvex(formData.name, serverEntryForSave).catch((err) =>
        logger.warn("Background sync to Convex failed (pre-connection)", {
          serverName: formData.name,
          err,
        }),
      );
      // For unauthenticated users, update local workspace
      if (!isAuthenticated) {
        const activeWorkspace = appState.workspaces[appState.activeWorkspaceId];
        if (activeWorkspace) {
          dispatch({
            type: "UPDATE_WORKSPACE",
            workspaceId: appState.activeWorkspaceId,
            updates: {
              servers: {
                ...activeWorkspace.servers,
                [formData.name]: serverEntryForSave,
              },
            },
          });
        }
      }

      saveOAuthConfigToLocalStorage(formData);

      try {
        if (formData.type === "http" && formData.useOAuth && formData.url) {
          // Check if we already have valid OAuth tokens for this server
          const existingTokens = getStoredTokens(formData.name);
          if (existingTokens?.access_token) {
            // We have existing tokens - connect using them instead of triggering new OAuth
            logger.info("Connecting with existing OAuth tokens", {
              serverName: formData.name,
            });
            const serverConfig = {
              url: new URL(formData.url),
              requestInit: {
                headers: {
                  Authorization: `Bearer ${existingTokens.access_token}`,
                  ...(formData.headers || {}),
                },
              },
            };
            const connectionResult = await testConnection(
              serverConfig as MCPServerConfig,
              formData.name,
            );
            if (isStaleOp(formData.name, token)) return;
            if (connectionResult.success) {
              dispatch({
                type: "CONNECT_SUCCESS",
                name: formData.name,
                config: serverConfig as MCPServerConfig,
                tokens: existingTokens,
              });
              toast.success(
                `Connected successfully with existing OAuth tokens!`,
              );
              fetchAndStoreInitInfo(formData.name).catch((err) =>
                logger.warn("Failed to fetch init info", {
                  serverName: formData.name,
                  err,
                }),
              );
              return;
            } else {
              // Tokens might be expired - fall through to trigger OAuth flow
              logger.warn("Existing tokens failed, will trigger OAuth flow", {
                serverName: formData.name,
                error: connectionResult.error,
              });
            }
          }

          // Mark oauth-flow status for UI while initiating
          dispatch({
            type: "UPSERT_SERVER",
            name: formData.name,
            server: {
              name: formData.name,
              config: mcpConfig,
              lastConnectionTime: new Date(),
              connectionStatus: "oauth-flow",
              retryCount: 0,
              enabled: true,
              useOAuth: true,
            } as ServerWithName,
          });

          const { initiateOAuth } = await import("@/lib/oauth/mcp-oauth");
          const oauthOptions: any = {
            serverName: formData.name,
            serverUrl: formData.url,
            clientId: formData.clientId,
            clientSecret: formData.clientSecret,
          };
          if (formData.oauthScopes && formData.oauthScopes.length > 0) {
            oauthOptions.scopes = formData.oauthScopes;
          }
          const oauthResult = await initiateOAuth(oauthOptions);
          if (oauthResult.success) {
            if (oauthResult.serverConfig) {
              const connectionResult = await testConnection(
                oauthResult.serverConfig,
                formData.name,
              );
              if (isStaleOp(formData.name, token)) return;
              if (connectionResult.success) {
                dispatch({
                  type: "CONNECT_SUCCESS",
                  name: formData.name,
                  config: oauthResult.serverConfig,
                  tokens: getStoredTokens(formData.name),
                });
                toast.success(`Connected successfully with OAuth!`);
                fetchAndStoreInitInfo(formData.name).catch((err) =>
                  logger.warn("Failed to fetch init info", {
                    serverName: formData.name,
                    err,
                  }),
                );
              } else {
                dispatch({
                  type: "CONNECT_FAILURE",
                  name: formData.name,
                  error:
                    connectionResult.error || "OAuth connection test failed",
                });
                toast.error(
                  `OAuth succeeded but connection failed: ${connectionResult.error}`,
                );
              }
            } else {
              toast.success(
                "OAuth flow initiated. You will be redirected to authorize access.",
              );
            }
            return;
          } else {
            if (isStaleOp(formData.name, token)) return;
            dispatch({
              type: "CONNECT_FAILURE",
              name: formData.name,
              error: oauthResult.error || "OAuth initialization failed",
            });
            toast.error(`OAuth initialization failed: ${oauthResult.error}`);
            return;
          }
        }

        // Non-OAuth connect - clear any lingering OAuth data
        // But NOT if there's a pending OAuth callback (would clear the code verifier)
        const hasPendingCallback = new URLSearchParams(
          window.location.search,
        ).has("code");
        if (!hasPendingCallback) {
          clearOAuthData(formData.name);
        }
        const result = await testConnection(mcpConfig, formData.name);
        if (isStaleOp(formData.name, token)) return;
        if (result.success) {
          dispatch({
            type: "CONNECT_SUCCESS",
            name: formData.name,
            config: mcpConfig,
          });
          logger.info("Connection successful", { serverName: formData.name });
          toast.success(`Connected successfully!`);
          fetchAndStoreInitInfo(formData.name).catch((err) =>
            logger.warn("Failed to fetch init info", {
              serverName: formData.name,
              err,
            }),
          );
        } else {
          dispatch({
            type: "CONNECT_FAILURE",
            name: formData.name,
            error: result.error || "Connection test failed",
          });
          logger.error("Connection failed", {
            serverName: formData.name,
            error: result.error,
          });
          toast.error(`Failed to connect to ${formData.name}`);
        }
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : "Unknown error";
        if (isStaleOp(formData.name, token)) return;
        dispatch({
          type: "CONNECT_FAILURE",
          name: formData.name,
          error: errorMessage,
        });
        logger.error("Connection failed", {
          serverName: formData.name,
          error: errorMessage,
        });
        toast.error(`Network error: ${errorMessage}`);
      }
    },
    [
      appState.servers,
      appState.workspaces,
      appState.activeWorkspaceId,
      isAuthenticated,
      logger,
      fetchAndStoreInitInfo,
      syncServerToConvex,
    ],
  );

  const saveServerConfigWithoutConnecting = useCallback(
    async (
      formData: ServerFormData,
      options?: { oauthProfile?: OAuthTestProfile },
    ) => {
      const validationError = validateForm(formData);
      if (validationError) {
        toast.error(validationError);
        return;
      }

      const serverName = formData.name.trim();
      if (!serverName) {
        toast.error("Server name is required");
        return;
      }

      const existingServer = appState.servers[serverName];
      const mcpConfig = toMCPConfig(formData);
      const nextOAuthProfile = formData.useOAuth
        ? (options?.oauthProfile ?? existingServer?.oauthFlowProfile)
        : undefined;

      const serverEntry: ServerWithName = {
        ...(existingServer ?? {}),
        name: serverName,
        config: mcpConfig,
        lastConnectionTime: existingServer?.lastConnectionTime ?? new Date(),
        connectionStatus: "disconnected",
        retryCount: existingServer?.retryCount ?? 0,
        enabled: existingServer?.enabled ?? false,
        oauthFlowProfile: nextOAuthProfile,
        useOAuth: formData.useOAuth ?? false,
      } as ServerWithName;

      // Clear OAuth data when switching away from OAuth
      // But NOT if there's a pending OAuth callback (would clear the code verifier)
      const hasPendingOAuthCallback = new URLSearchParams(
        window.location.search,
      ).has("code");
      if (!formData.useOAuth && !hasPendingOAuthCallback) {
        clearOAuthData(serverName);
      }

      dispatch({
        type: "UPSERT_SERVER",
        name: serverName,
        server: serverEntry,
      });

      saveOAuthConfigToLocalStorage(formData);

      // Sync to Convex or local workspace
      if (isAuthenticated && effectiveActiveWorkspaceId) {
        // When authenticated, sync server to Convex
        const currentWorkspace =
          effectiveWorkspaces[effectiveActiveWorkspaceId];
        if (currentWorkspace) {
          const updatedServers = {
            ...currentWorkspace.servers,
            [serverName]: serverEntry,
          };
          try {
            await convexUpdateWorkspace({
              workspaceId: effectiveActiveWorkspaceId,
              servers: serializeServersForSharing(updatedServers),
            });
          } catch (error) {
            logger.error("Failed to sync server to Convex", {
              error: error instanceof Error ? error.message : "Unknown error",
            });
          }
        }
      } else {
        const activeWorkspace = appState.workspaces[appState.activeWorkspaceId];
        if (activeWorkspace) {
          dispatch({
            type: "UPDATE_WORKSPACE",
            workspaceId: appState.activeWorkspaceId,
            updates: {
              servers: {
                ...activeWorkspace.servers,
                [serverName]: serverEntry,
              },
            },
          });
        }
      }

      logger.info("Saved server configuration without connecting", {
        serverName,
      });
      toast.success(`Saved configuration for ${serverName}`);
    },
    [
      appState.activeWorkspaceId,
      appState.servers,
      appState.workspaces,
      logger,
      isAuthenticated,
      effectiveActiveWorkspaceId,
      effectiveWorkspaces,
      convexUpdateWorkspace,
    ],
  );

  // Apply tokens from OAuth flow to a server and connect
  const applyTokensFromOAuthFlow = useCallback(
    async (
      serverName: string,
      tokens: {
        accessToken: string;
        refreshToken?: string;
        tokenType?: string;
        expiresIn?: number;
        clientId?: string;
        clientSecret?: string;
      },
      serverUrl: string,
    ): Promise<{ success: boolean; error?: string }> => {
      // 1. Store tokens in localStorage
      const tokenData = {
        access_token: tokens.accessToken,
        refresh_token: tokens.refreshToken,
        token_type: tokens.tokenType || "Bearer",
        expires_in: tokens.expiresIn,
      };
      localStorage.setItem(
        `mcp-tokens-${serverName}`,
        JSON.stringify(tokenData),
      );

      // 2. Store client info if available
      if (tokens.clientId) {
        localStorage.setItem(
          `mcp-client-${serverName}`,
          JSON.stringify({
            client_id: tokens.clientId,
            client_secret: tokens.clientSecret,
          }),
        );
      }

      // 3. Store server URL
      localStorage.setItem(`mcp-serverUrl-${serverName}`, serverUrl);

      // 4. Create server config with OAuth
      const serverConfig = {
        url: new URL(serverUrl),
        requestInit: {
          headers: { Authorization: `Bearer ${tokens.accessToken}` },
        },
        oauth: tokenData,
      };

      // 5. Mark as connecting
      dispatch({
        type: "CONNECT_REQUEST",
        name: serverName,
        config: serverConfig as MCPServerConfig,
        select: true,
      });

      const token = nextOpToken(serverName);

      // 6. Connect using reconnect (which disconnects first if needed)
      try {
        const result = await reconnectServer(
          serverName,
          serverConfig as MCPServerConfig,
        );
        if (isStaleOp(serverName, token)) {
          return { success: false, error: "Operation cancelled" };
        }
        if (result.success) {
          dispatch({
            type: "CONNECT_SUCCESS",
            name: serverName,
            config: serverConfig as MCPServerConfig,
            tokens: getStoredTokens(serverName),
          });
          await fetchAndStoreInitInfo(serverName);
          return { success: true };
        } else {
          dispatch({
            type: "CONNECT_FAILURE",
            name: serverName,
            error: result.error || "Connection failed",
          });
          return { success: false, error: result.error };
        }
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : "Unknown error";
        if (isStaleOp(serverName, token)) {
          return { success: false, error: "Operation cancelled" };
        }
        dispatch({
          type: "CONNECT_FAILURE",
          name: serverName,
          error: errorMessage,
        });
        return { success: false, error: errorMessage };
      }
    },
    [fetchAndStoreInitInfo, logger],
  );

  // Connect a server with tokens from OAuth flow (for new connections)
  const handleConnectWithTokensFromOAuthFlow = useCallback(
    async (
      serverName: string,
      tokens: {
        accessToken: string;
        refreshToken?: string;
        tokenType?: string;
        expiresIn?: number;
        clientId?: string;
        clientSecret?: string;
      },
      serverUrl: string,
    ) => {
      const result = await applyTokensFromOAuthFlow(
        serverName,
        tokens,
        serverUrl,
      );
      if (result.success) {
        toast.success(`Connected to ${serverName}!`);
      } else {
        toast.error(`Connection failed: ${result.error}`);
      }
    },
    [applyTokensFromOAuthFlow],
  );

  // Refresh tokens for an already connected server (replaces existing tokens)
  const handleRefreshTokensFromOAuthFlow = useCallback(
    async (
      serverName: string,
      tokens: {
        accessToken: string;
        refreshToken?: string;
        tokenType?: string;
        expiresIn?: number;
        clientId?: string;
        clientSecret?: string;
      },
      serverUrl: string,
    ) => {
      const result = await applyTokensFromOAuthFlow(
        serverName,
        tokens,
        serverUrl,
      );
      if (result.success) {
        toast.success(`Tokens refreshed for ${serverName}!`);
      } else {
        toast.error(`Token refresh failed: ${result.error}`);
      }
    },
    [applyTokensFromOAuthFlow],
  );

  // CLI config processing guard
  const cliConfigProcessedRef = useRef<boolean>(false);

  // Auto-connect to CLI-provided MCP server(s) on mount
  useEffect(() => {
    if (!isLoading && !cliConfigProcessedRef.current) {
      cliConfigProcessedRef.current = true;
      // Fetch CLI config from API (both dev and production)
      fetch("/api/mcp-cli-config")
        .then((response) => response.json())
        .then((data) => {
          const cliConfig = data.config;
          if (cliConfig) {
            // Handle initial tab navigation (if not already set via URL hash)
            if (cliConfig.initialTab && !window.location.hash) {
              window.location.hash = cliConfig.initialTab;
            }

            // Handle multiple servers from config file
            if (cliConfig.servers && Array.isArray(cliConfig.servers)) {
              const autoConnectServer = cliConfig.autoConnectServer;

              logger.info(
                "Processing CLI-provided MCP servers (from config file)",
                {
                  serverCount: cliConfig.servers.length,
                  autoConnectServer: autoConnectServer || "all",
                  cliConfig: cliConfig,
                },
              );

              // Add all servers to the UI, but only auto-connect to filtered ones
              cliConfig.servers.forEach((server: any) => {
                const serverName = server.name || "CLI Server";
                // Check if OAuth callback is in progress (prevents race condition redirect loop)
                const urlParams = new URLSearchParams(window.location.search);
                const oauthCallbackInProgress = urlParams.has("code");
                const formData: ServerFormData = {
                  name: serverName,
                  type: (server.type === "sse"
                    ? "http"
                    : server.type || "stdio") as "stdio" | "http",
                  command: server.command,
                  args: server.args || [],
                  url: server.url,
                  env: server.env || {},
                  headers: server.headers, // Include custom headers for HTTP
                  useOAuth: server.useOAuth ?? false, // Store the actual auth method from CLI config
                };

                // Always add/update server from CLI config
                const mcpConfig = toMCPConfig(formData);
                dispatch({
                  type: "UPSERT_SERVER",
                  name: formData.name,
                  server: {
                    name: formData.name,
                    config: mcpConfig,
                    lastConnectionTime: new Date(),
                    connectionStatus: "disconnected" as const,
                    retryCount: 0,
                    enabled: false, // Start disabled, will enable on successful connection
                  },
                });

                // Only auto-connect if matches filter (or no filter)
                // Skip auto-connect for OAuth servers when callback is in progress
                // (the callback handler will complete the connection)
                if (oauthCallbackInProgress && server.useOAuth) {
                  logger.info("Skipping auto-connect for OAuth server", {
                    serverName: server.name,
                    reason: "OAuth callback in progress",
                  });
                } else if (
                  !autoConnectServer ||
                  server.name === autoConnectServer
                ) {
                  logger.info("Auto-connecting to server", {
                    serverName: server.name,
                  });
                  handleConnect(formData);
                } else {
                  logger.info("Skipping auto-connect for server", {
                    serverName: server.name,
                    reason: "filtered out",
                  });
                }
              });
              return;
            }
            // Handle legacy single server mode
            if (cliConfig.command) {
              logger.info("Auto-connecting to CLI-provided MCP server", {
                cliConfig,
              });
              const formData: ServerFormData = {
                name: cliConfig.name || "CLI Server",
                type: "stdio" as const,
                command: cliConfig.command,
                args: cliConfig.args || [],
                env: cliConfig.env || {},
              };
              handleConnect(formData);
            }
          }
        })
        .catch((error) => {
          logger.debug("Could not fetch CLI config from API", { error });
        });
    }
  }, [isLoading, handleConnect, logger, appState.servers]);

  const getValidAccessToken = useCallback(
    async (serverName: string): Promise<string | null> => {
      const server = appState.servers[serverName];
      if (!server?.oauthTokens) return null;
      return server.oauthTokens.access_token || null;
    },
    [appState.servers],
  );

  const handleDisconnect = useCallback(async (serverName: string) => {
    logger.info("Disconnecting from server", { serverName });
    dispatch({ type: "DISCONNECT", name: serverName });
    try {
      const result = await deleteServer(serverName);
      if (!result.success) {
        dispatch({ type: "DISCONNECT", name: serverName, error: result.error });
      }
    } catch (error) {
      dispatch({
        type: "DISCONNECT",
        name: serverName,
        error: error instanceof Error ? error.message : "Unknown error",
      });
    }
  }, []);

  const handleRemoveServer = useCallback(
    async (serverName: string) => {
      logger.info("Removing server", { serverName });
      clearOAuthData(serverName);
      dispatch({ type: "REMOVE_SERVER", name: serverName });
      // Remove from Convex workspace if authenticated
      await removeServerFromConvex(serverName);
    },
    [logger, removeServerFromConvex],
  );

  const handleReconnect = useCallback(
    async (serverName: string, options?: { forceOAuthFlow?: boolean }) => {
      logger.info("Reconnecting to server", { serverName, options });
      // Use effectiveServers (workspace servers with runtime state) instead of appState.servers
      // This ensures servers synced from cloud workspaces are found even if they haven't been
      // connected in the current session yet
      const server = effectiveServers[serverName];
      if (!server) throw new Error(`Server ${serverName} not found`);

      dispatch({
        type: "RECONNECT_REQUEST",
        name: serverName,
        config: server.config,
      });
      const token = nextOpToken(serverName);

      // If forceOAuthFlow is true, clear all OAuth data and initiate a fresh OAuth flow
      if (options?.forceOAuthFlow) {
        clearOAuthData(serverName);
        await deleteServer(serverName);

        const serverUrl = (server.config as any)?.url?.toString?.();
        if (!serverUrl) {
          dispatch({
            type: "CONNECT_FAILURE",
            name: serverName,
            error: "No server URL found for OAuth flow",
          });
          return;
        }

        const oauthResult = await initiateOAuth({
          serverName,
          serverUrl,
        });

        if (oauthResult.success && !oauthResult.serverConfig) {
          // OAuth redirect in progress
          return;
        }
        if (!oauthResult.success) {
          if (isStaleOp(serverName, token)) return;
          dispatch({
            type: "CONNECT_FAILURE",
            name: serverName,
            error: oauthResult.error || "OAuth flow failed",
          });
          toast.error(`OAuth failed: ${serverName}`);
          return;
        }
        // OAuth completed successfully, continue with reconnect using the new config
        const result = await reconnectServer(
          serverName,
          oauthResult.serverConfig!,
        );
        if (isStaleOp(serverName, token)) return;
        if (result.success) {
          dispatch({
            type: "CONNECT_SUCCESS",
            name: serverName,
            config: oauthResult.serverConfig!,
            tokens: getStoredTokens(serverName),
          });
          logger.info("Reconnection with fresh OAuth successful", {
            serverName,
          });
          fetchAndStoreInitInfo(serverName).catch((err) =>
            logger.warn("Failed to fetch init info", { serverName, err }),
          );
          return { success: true } as const;
        } else {
          dispatch({
            type: "CONNECT_FAILURE",
            name: serverName,
            error: result.error || "Reconnection failed after OAuth",
          });
          return;
        }
      }

      try {
        const authResult: OAuthResult =
          await ensureAuthorizedForReconnect(server);
        if (authResult.kind === "redirect") return; // UI shows oauth-flow during redirect
        if (authResult.kind === "error") {
          if (isStaleOp(serverName, token)) return;
          dispatch({
            type: "CONNECT_FAILURE",
            name: serverName,
            error: authResult.error,
          });
          toast.error(`Failed to connect: ${serverName}`);
          return;
        }
        const result = await reconnectServer(
          serverName,
          authResult.serverConfig,
        );
        if (isStaleOp(serverName, token)) return;
        if (result.success) {
          dispatch({
            type: "CONNECT_SUCCESS",
            name: serverName,
            config: authResult.serverConfig,
            tokens: authResult.tokens,
          });
          logger.info("Reconnection successful", { serverName, result });
          fetchAndStoreInitInfo(serverName).catch((err) =>
            logger.warn("Failed to fetch init info", { serverName, err }),
          );
          return { success: true } as const;
        } else {
          dispatch({
            type: "CONNECT_FAILURE",
            name: serverName,
            error: result.error || "Reconnection failed",
          });
          logger.error("Reconnection failed", { serverName, result });
          const errorMessage =
            result.error || `Failed to reconnect: ${serverName}`;
          toast.error(errorMessage);
        }
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : "Unknown error";
        if (isStaleOp(serverName, token)) return;
        dispatch({
          type: "CONNECT_FAILURE",
          name: serverName,
          error: errorMessage,
        });
        logger.error("Reconnection failed", {
          serverName,
          error: errorMessage,
        });
        throw error;
      }
    },
    [effectiveServers, fetchAndStoreInitInfo, logger],
  );

  // Sync with centralized agent status on app startup only
  useEffect(() => {
    if (isLoading) return;
    const syncServerStatus = async () => {
      try {
        const result = await listServers();
        if (result?.success && result.servers) {
          dispatch({ type: "SYNC_AGENT_STATUS", servers: result.servers });
        }
      } catch (error) {
        logger.debug("Failed to sync server status on startup", {
          error: error instanceof Error ? error.message : "Unknown error",
        });
      }
    };
    syncServerStatus();
  }, [isLoading, logger]);

  const setSelectedServer = useCallback((serverName: string) => {
    dispatch({ type: "SELECT_SERVER", name: serverName });
  }, []);

  const setSelectedMCPConfigs = useCallback((serverNames: string[]) => {
    dispatch({ type: "SET_MULTI_SELECTED", names: serverNames });
  }, []);

  const toggleMultiSelectMode = useCallback((enabled: boolean) => {
    dispatch({ type: "SET_MULTI_MODE", enabled });
  }, []);

  const toggleServerSelection = useCallback(
    (serverName: string) => {
      const current = appState.selectedMultipleServers;
      const next = current.includes(serverName)
        ? current.filter((n) => n !== serverName)
        : [...current, serverName];
      dispatch({ type: "SET_MULTI_SELECTED", names: next });
    },
    [appState.selectedMultipleServers],
  );

  const handleUpdate = useCallback(
    async (
      originalServerName: string,
      formData: ServerFormData,
      skipAutoConnect?: boolean,
    ) => {
      const originalServer = appState.servers[originalServerName];

      // If skipAutoConnect is true, just update the config without reconnecting
      if (skipAutoConnect) {
        const mcpConfig = toMCPConfig(formData);
        dispatch({
          type: "CONNECT_SUCCESS",
          name: originalServerName,
          config: mcpConfig,
        });
        saveOAuthConfigToLocalStorage(formData);
        toast.success("Server configuration updated");
        return;
      }

      const hadOAuthTokens = originalServer?.oauthTokens != null;
      const shouldPreserveOAuth =
        hadOAuthTokens &&
        formData.useOAuth &&
        formData.name === originalServerName &&
        formData.type === "http" &&
        formData.url === (originalServer?.config as any).url?.toString();

      if (shouldPreserveOAuth && originalServer) {
        const mcpConfig = toMCPConfig(formData);
        dispatch({
          type: "CONNECT_REQUEST",
          name: originalServerName,
          config: mcpConfig,
        });
        saveOAuthConfigToLocalStorage(formData);
        try {
          const result = await testConnection(
            originalServer.config,
            originalServerName,
          );
          if (result.success) {
            dispatch({
              type: "CONNECT_SUCCESS",
              name: originalServerName,
              config: mcpConfig,
            });
            // Fetch initialization info after successful update
            await fetchAndStoreInitInfo(originalServerName);
            toast.success("Server configuration updated successfully!");
            return;
          } else {
            console.warn(
              "OAuth connection test failed, falling back to full reconnect",
            );
          }
        } catch (error) {
          console.warn(
            "OAuth connection test error, falling back to full reconnect",
            error,
          );
        }
      }

      // Clear OAuth tokens if switching from OAuth to no authentication
      if (hadOAuthTokens && !formData.useOAuth) {
        clearOAuthData(originalServerName);
      }

      saveOAuthConfigToLocalStorage(formData);

      await handleDisconnect(originalServerName);
      await handleConnect(formData);
      if (
        appState.selectedServer === originalServerName &&
        formData.name !== originalServerName
      ) {
        setSelectedServer(formData.name);
      }
    },
    [
      appState.servers,
      appState.selectedServer,
      handleDisconnect,
      handleConnect,
    ],
  );

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

      // Disconnect all currently connected servers before switching
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

      // Switch the workspace
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
    ],
  );

  const handleCreateWorkspace = useCallback(
    async (name: string, switchTo: boolean = false) => {
      if (isAuthenticated) {
        // Create in Convex
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
      } else {
        // Create locally
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
      }
    },
    [isAuthenticated, convexCreateWorkspace],
  );

  const handleUpdateWorkspace = useCallback(
    async (workspaceId: string, updates: Partial<Workspace>) => {
      if (isAuthenticated) {
        // Update in Convex
        try {
          const updateData: any = { workspaceId };
          if (updates.name !== undefined) updateData.name = updates.name;
          if (updates.description !== undefined)
            updateData.description = updates.description;
          if (updates.servers !== undefined) {
            updateData.servers = serializeServersForSharing(updates.servers);
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
    [isAuthenticated, convexUpdateWorkspace, logger],
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
        // Delete from Convex
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
    ],
  );

  // Leave a shared workspace (removes from local state without deleting from Convex)
  // The backend removeMember call should be made before calling this
  const handleLeaveWorkspace = useCallback(
    async (workspaceId: string) => {
      const workspace = effectiveWorkspaces[workspaceId];
      if (!workspace) {
        toast.error("Workspace not found");
        return;
      }

      // Find another workspace to switch to
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

      // Disconnect all servers before leaving
      const workspaceServers = Object.keys(workspace.servers || {});
      for (const serverName of workspaceServers) {
        const runtimeServer = appState.servers[serverName];
        if (runtimeServer?.connectionStatus === "connected") {
          await handleDisconnect(serverName);
        }
      }

      // Switch to another workspace
      if (isAuthenticated) {
        setConvexActiveWorkspaceId(targetWorkspaceId);
      } else {
        dispatch({ type: "SWITCH_WORKSPACE", workspaceId: targetWorkspaceId });
        // Then delete the workspace from local state (don't touch Convex - removeMember already handled it)
        dispatch({ type: "DELETE_WORKSPACE", workspaceId });
      }
    },
    [effectiveWorkspaces, appState.servers, handleDisconnect, isAuthenticated],
  );

  const handleDuplicateWorkspace = useCallback(
    async (workspaceId: string, newName: string) => {
      const sourceWorkspace = effectiveWorkspaces[workspaceId];
      if (!sourceWorkspace) {
        toast.error("Workspace not found");
        return;
      }

      if (isAuthenticated) {
        // Duplicate in Convex
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
    [effectiveWorkspaces, isAuthenticated, convexCreateWorkspace],
  );

  const handleSetDefaultWorkspace = useCallback((workspaceId: string) => {
    dispatch({ type: "SET_DEFAULT_WORKSPACE", workspaceId });
    toast.success("Default workspace updated");
  }, []);

  // Handler for when a workspace is shared/linked to Convex for the first time
  const handleWorkspaceShared = useCallback(
    (convexWorkspaceId: string) => {
      if (isAuthenticated) {
        // For authenticated users, switch to the new Convex workspace directly
        // This bypasses the existence check in handleSwitchWorkspace since
        // the workspace was just created and may not be in effectiveWorkspaces yet
        setConvexActiveWorkspaceId(convexWorkspaceId);
        logger.info("Switched to newly shared workspace", {
          convexWorkspaceId,
        });
      } else {
        // For non-authenticated users, update local workspace with the sharedWorkspaceId
        dispatch({
          type: "UPDATE_WORKSPACE",
          workspaceId: appState.activeWorkspaceId,
          updates: { sharedWorkspaceId: convexWorkspaceId },
        });
      }
    },
    [isAuthenticated, appState.activeWorkspaceId, logger],
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
        // Import to Convex
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
        // Generate new ID to avoid conflicts
        const importedWorkspace: Workspace = {
          ...workspaceData,
          id: `workspace_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
          createdAt: new Date(),
          updatedAt: new Date(),
          isDefault: false, // Never import as default
        };
        dispatch({ type: "IMPORT_WORKSPACE", workspace: importedWorkspace });
        toast.success(`Workspace "${importedWorkspace.name}" imported`);
      }
    },
    [isAuthenticated, convexCreateWorkspace],
  );

  return {
    // State
    appState,
    isLoading,
    isLoadingRemoteWorkspaces,
    // Cloud sync status - true when authenticated and Convex is working
    isCloudSyncActive:
      isAuthenticated && !useLocalFallback && remoteWorkspaces !== undefined,

    // Computed values - use effective servers (from active workspace with runtime state)
    // All servers from the active workspace (for display in ServersTab)
    workspaceServers: effectiveServers,
    // Only connected servers (for features requiring active connections)
    connectedServerConfigs: Object.fromEntries(
      Object.entries(effectiveServers).filter(
        ([, server]) => server.connectionStatus === "connected",
      ),
    ),
    selectedServerEntry: effectiveServers[appState.selectedServer],
    selectedMCPConfig: effectiveServers[appState.selectedServer]?.config,
    selectedMCPConfigs: appState.selectedMultipleServers
      .map((name) => effectiveServers[name])
      .filter(Boolean),
    selectedMCPConfigsMap: appState.selectedMultipleServers.reduce(
      (acc, name) => {
        if (effectiveServers[name]) {
          acc[name] = effectiveServers[name].config;
        }
        return acc;
      },
      {} as Record<string, MCPServerConfig>,
    ),
    isMultiSelectMode: appState.isMultiSelectMode,

    // Workspace-related - use effective workspaces (Convex when authenticated, local otherwise)
    workspaces: effectiveWorkspaces,
    activeWorkspaceId: effectiveActiveWorkspaceId,
    activeWorkspace,

    // Actions
    handleConnect,
    handleDisconnect,
    handleReconnect,
    handleUpdate,
    handleRemoveServer,
    setSelectedServer,
    setSelectedMCPConfigs,
    toggleMultiSelectMode,
    toggleServerSelection,
    getValidAccessToken,
    setSelectedMultipleServersToAllServers,
    saveServerConfigWithoutConnecting,
    handleConnectWithTokensFromOAuthFlow,
    handleRefreshTokensFromOAuthFlow,

    // Workspace actions
    handleSwitchWorkspace,
    handleCreateWorkspace,
    handleUpdateWorkspace,
    handleDeleteWorkspace,
    handleLeaveWorkspace,
    handleDuplicateWorkspace,
    handleSetDefaultWorkspace,
    handleWorkspaceShared,
    handleExportWorkspace,
    handleImportWorkspace,
  };
}
