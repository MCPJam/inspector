import { useCallback, useEffect, useMemo, useRef, type Dispatch } from "react";
import { toast } from "sonner";
import type { HttpServerConfig, MCPServerConfig } from "@mcpjam/sdk";
import type {
  AppAction,
  AppState,
  ServerWithName,
  Workspace,
} from "@/state/app-types";
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
import type { OAuthTestProfile } from "@/lib/oauth/profile";
import { authFetch } from "@/lib/session-token";
import { useServerMutations, type RemoteServer } from "./useWorkspaces";

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

interface LoggerLike {
  info: (message: string, meta?: Record<string, unknown>) => void;
  warn: (message: string, meta?: Record<string, unknown>) => void;
  error: (message: string, meta?: Record<string, unknown>) => void;
  debug: (message: string, meta?: Record<string, unknown>) => void;
}

interface UseServerStateParams {
  appState: AppState;
  dispatch: Dispatch<AppAction>;
  isLoading: boolean;
  isAuthenticated: boolean;
  isAuthLoading: boolean;
  isLoadingWorkspaces: boolean;
  useLocalFallback: boolean;
  effectiveWorkspaces: Record<string, Workspace>;
  effectiveActiveWorkspaceId: string;
  activeWorkspaceServersFlat: RemoteServer[] | undefined;
  logger: LoggerLike;
}

export function useServerState({
  appState,
  dispatch,
  isLoading,
  isAuthenticated,
  isAuthLoading,
  isLoadingWorkspaces,
  useLocalFallback,
  effectiveWorkspaces,
  effectiveActiveWorkspaceId,
  activeWorkspaceServersFlat,
  logger,
}: UseServerStateParams) {
  const {
    createServer: convexCreateServer,
    updateServer: convexUpdateServer,
    deleteServer: convexDeleteServer,
  } = useServerMutations();

  const oauthCallbackHandledRef = useRef(false);
  const opTokenRef = useRef<Map<string, number>>(new Map());
  const nextOpToken = (name: string) => {
    const current = opTokenRef.current.get(name) ?? 0;
    const next = current + 1;
    opTokenRef.current.set(name, next);
    return next;
  };
  const isStaleOp = (name: string, token: number) =>
    (opTokenRef.current.get(name) ?? 0) !== token;

  const activeWorkspace = useMemo(() => {
    const workspace = effectiveWorkspaces[effectiveActiveWorkspaceId];
    if (!workspace) {
      return undefined;
    }

    const serversWithRuntime: Record<string, ServerWithName> = {};
    for (const [name, server] of Object.entries(workspace.servers)) {
      const runtimeState = appState.servers[name];

      let envFromStorage: Record<string, string> | undefined;
      try {
        const stored = localStorage.getItem(`mcp-env-${name}`);
        if (stored) envFromStorage = JSON.parse(stored);
      } catch {
        // Ignore parse errors
      }

      let configWithEnv: MCPServerConfig = server.config;
      if (
        envFromStorage &&
        "command" in server.config &&
        typeof server.config.command === "string"
      ) {
        configWithEnv = { ...server.config, env: envFromStorage };
      }

      serversWithRuntime[name] = {
        ...server,
        config: configWithEnv,
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
  }, [appState.servers, dispatch]);

  const syncServerToConvex = useCallback(
    async (serverName: string, serverEntry: ServerWithName) => {
      if (useLocalFallback || !isAuthenticated || !effectiveActiveWorkspaceId) {
        return;
      }

      const existingServer = activeWorkspaceServersFlat?.find(
        (s) => s.name === serverName,
      );

      const config = serverEntry.config as any;
      const transportType = config?.command ? "stdio" : "http";
      const url =
        config?.url instanceof URL ? config.url.href : config?.url || undefined;
      const headers = config?.requestInit?.headers || undefined;

      const payload = {
        name: serverName,
        enabled: serverEntry.enabled ?? false,
        transportType,
        command: config?.command,
        args: config?.args,
        url,
        headers,
        timeout: config?.timeout,
        useOAuth: serverEntry.useOAuth,
        oauthScopes: serverEntry.oauthFlowProfile?.scopes
          ? serverEntry.oauthFlowProfile.scopes.split(",").filter(Boolean)
          : undefined,
        clientId: serverEntry.oauthFlowProfile?.clientId,
      } as const;

      try {
        if (existingServer) {
          await convexUpdateServer({
            serverId: existingServer._id,
            ...payload,
          });
          return;
        }

        await convexCreateServer({
          workspaceId: effectiveActiveWorkspaceId,
          ...payload,
        });
      } catch (primaryError) {
        // Best-effort fallback for stale query snapshots:
        // if update failed, try create; if create failed, try update when possible.
        try {
          if (existingServer) {
            await convexCreateServer({
              workspaceId: effectiveActiveWorkspaceId,
              ...payload,
            });
            return;
          }
          const retryExisting = activeWorkspaceServersFlat?.find(
            (s) => s.name === serverName,
          );
          if (retryExisting) {
            await convexUpdateServer({
              serverId: retryExisting._id,
              ...payload,
            });
            return;
          }
        } catch (fallbackError) {
          logger.error("Failed to sync server to Convex", {
            serverName,
            primaryError:
              primaryError instanceof Error
                ? primaryError.message
                : "Unknown error",
            fallbackError:
              fallbackError instanceof Error
                ? fallbackError.message
                : "Unknown error",
          });
          return;
        }

        logger.error("Failed to sync server to Convex", {
          serverName,
          error:
            primaryError instanceof Error
              ? primaryError.message
              : "Unknown error",
        });
      }
    },
    [
      useLocalFallback,
      isAuthenticated,
      effectiveActiveWorkspaceId,
      activeWorkspaceServersFlat,
      convexUpdateServer,
      convexCreateServer,
      logger,
    ],
  );

  const removeServerFromConvex = useCallback(
    async (serverName: string) => {
      if (useLocalFallback || !isAuthenticated || !effectiveActiveWorkspaceId) {
        return;
      }

      const existingServer = activeWorkspaceServersFlat?.find(
        (s) => s.name === serverName,
      );

      if (!existingServer) {
        logger.warn("Server not found in Convex for deletion", { serverName });
        return;
      }

      try {
        await convexDeleteServer({
          serverId: existingServer._id,
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
      activeWorkspaceServersFlat,
      convexDeleteServer,
      logger,
    ],
  );

  const fetchAndStoreInitInfo = useCallback(
    async (serverName: string) => {
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
        console.debug("Failed to fetch initialization info", {
          serverName,
          error,
        });
      }
    },
    [dispatch],
  );

  const handleOAuthCallbackComplete = useCallback(
    async (code: string) => {
      try {
        const result = await handleOAuthCallback(code);

        localStorage.removeItem("mcp-oauth-return-hash");

        if (result.success && result.serverConfig && result.serverName) {
          const serverName = result.serverName;

          dispatch({
            type: "CONNECT_REQUEST",
            name: serverName,
            config: result.serverConfig,
            select: true,
          });

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

        localStorage.removeItem("mcp-oauth-return-hash");
        localStorage.removeItem("mcp-oauth-pending");
      }
    },
    [dispatch, logger, fetchAndStoreInitInfo],
  );

  useEffect(() => {
    if (window.location.pathname.startsWith("/oauth/callback/debug")) {
      return;
    }

    if (isLoading) return;
    if (isAuthLoading) return;

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
      if (oauthCallbackHandledRef.current) {
        return;
      }
      oauthCallbackHandledRef.current = true;

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
    isAuthenticated,
    useLocalFallback,
    isLoadingWorkspaces,
    effectiveActiveWorkspaceId,
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

      const serverEntryForSave: ServerWithName = {
        name: formData.name,
        config: mcpConfig,
        lastConnectionTime: new Date(),
        connectionStatus: "connecting",
        retryCount: 0,
        enabled: true,
        useOAuth: formData.useOAuth ?? false,
      };
      syncServerToConvex(formData.name, serverEntryForSave).catch((err) =>
        logger.warn("Background sync to Convex failed (pre-connection)", {
          serverName: formData.name,
          err,
        }),
      );
      if (!isAuthenticated) {
        const workspace = appState.workspaces[appState.activeWorkspaceId];
        if (workspace) {
          dispatch({
            type: "UPDATE_WORKSPACE",
            workspaceId: appState.activeWorkspaceId,
            updates: {
              servers: {
                ...workspace.servers,
                [formData.name]: serverEntryForSave,
              },
            },
          });
        }
      }

      saveOAuthConfigToLocalStorage(formData);

      try {
        if (formData.type === "http" && formData.useOAuth && formData.url) {
          const existingTokens = getStoredTokens(formData.name);
          if (existingTokens?.access_token) {
            logger.info("Connecting with existing OAuth tokens", {
              serverName: formData.name,
            });
            const serverConfig = {
              url: formData.url,
              requestInit: {
                headers: {
                  Authorization: `Bearer ${existingTokens.access_token}`,
                  ...(formData.headers || {}),
                },
              },
            } satisfies HttpServerConfig;
            const connectionResult = await testConnection(
              serverConfig,
              formData.name,
            );
            if (isStaleOp(formData.name, token)) return;
            if (connectionResult.success) {
              dispatch({
                type: "CONNECT_SUCCESS",
                name: formData.name,
                config: serverConfig,
                tokens: existingTokens,
              });
              toast.success(
                "Connected successfully with existing OAuth tokens!",
              );
              fetchAndStoreInitInfo(formData.name).catch((err) =>
                logger.warn("Failed to fetch init info", {
                  serverName: formData.name,
                  err,
                }),
              );
              return;
            }
            logger.warn("Existing tokens failed, will trigger OAuth flow", {
              serverName: formData.name,
              error: connectionResult.error,
            });
          }

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
                toast.success("Connected successfully with OAuth!");
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
          }

          if (isStaleOp(formData.name, token)) return;
          dispatch({
            type: "CONNECT_FAILURE",
            name: formData.name,
            error: oauthResult.error || "OAuth initialization failed",
          });
          toast.error(`OAuth initialization failed: ${oauthResult.error}`);
          return;
        }

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
          const env = (mcpConfig as any).env;
          if (env && Object.keys(env).length > 0) {
            localStorage.setItem(
              `mcp-env-${formData.name}`,
              JSON.stringify(env),
            );
          }
          logger.info("Connection successful", { serverName: formData.name });
          toast.success("Connected successfully!");
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
      dispatch,
      isAuthenticated,
      appState.workspaces,
      appState.activeWorkspaceId,
      syncServerToConvex,
      logger,
      fetchAndStoreInitInfo,
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

      if (isAuthenticated && effectiveActiveWorkspaceId) {
        try {
          await syncServerToConvex(serverName, serverEntry);
        } catch (error) {
          logger.error("Failed to sync server to Convex", {
            error: error instanceof Error ? error.message : "Unknown error",
          });
        }
      } else {
        const workspace = appState.workspaces[appState.activeWorkspaceId];
        if (workspace) {
          dispatch({
            type: "UPDATE_WORKSPACE",
            workspaceId: appState.activeWorkspaceId,
            updates: {
              servers: {
                ...workspace.servers,
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
      dispatch,
      isAuthenticated,
      effectiveActiveWorkspaceId,
      syncServerToConvex,
    ],
  );

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

      if (tokens.clientId) {
        localStorage.setItem(
          `mcp-client-${serverName}`,
          JSON.stringify({
            client_id: tokens.clientId,
            client_secret: tokens.clientSecret,
          }),
        );
      }

      localStorage.setItem(`mcp-serverUrl-${serverName}`, serverUrl);

      const serverConfig = {
        url: serverUrl,
        requestInit: {
          headers: { Authorization: `Bearer ${tokens.accessToken}` },
        },
      } satisfies HttpServerConfig;

      dispatch({
        type: "CONNECT_REQUEST",
        name: serverName,
        config: serverConfig,
        select: true,
      });

      const token = nextOpToken(serverName);

      try {
        const result = await reconnectServer(serverName, serverConfig);
        if (isStaleOp(serverName, token)) {
          return { success: false, error: "Operation cancelled" };
        }
        if (result.success) {
          dispatch({
            type: "CONNECT_SUCCESS",
            name: serverName,
            config: serverConfig,
            tokens: getStoredTokens(serverName),
          });
          await fetchAndStoreInitInfo(serverName);
          return { success: true };
        }
        dispatch({
          type: "CONNECT_FAILURE",
          name: serverName,
          error: result.error || "Connection failed",
        });
        return { success: false, error: result.error };
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
    [dispatch, fetchAndStoreInitInfo],
  );

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

  const cliConfigProcessedRef = useRef<boolean>(false);

  useEffect(() => {
    if (!isLoading && !cliConfigProcessedRef.current) {
      cliConfigProcessedRef.current = true;
      authFetch("/api/mcp-cli-config")
        .then((response) => response.json())
        .then((data) => {
          const cliConfig = data.config;
          if (cliConfig) {
            if (cliConfig.initialTab && !window.location.hash) {
              window.location.hash = cliConfig.initialTab;
            }

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

              cliConfig.servers.forEach((server: any) => {
                const serverName = server.name || "CLI Server";
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
                  headers: server.headers,
                  useOAuth: server.useOAuth ?? false,
                };

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
                    enabled: false,
                  },
                });

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
  }, [isLoading, handleConnect, logger, dispatch]);

  const getValidAccessToken = useCallback(
    async (serverName: string): Promise<string | null> => {
      const server = appState.servers[serverName];
      if (!server?.oauthTokens) return null;
      return server.oauthTokens.access_token || null;
    },
    [appState.servers],
  );

  const handleDisconnect = useCallback(
    async (serverName: string) => {
      logger.info("Disconnecting from server", { serverName });
      dispatch({ type: "DISCONNECT", name: serverName });
      try {
        const result = await deleteServer(serverName);
        if (!result.success) {
          dispatch({
            type: "DISCONNECT",
            name: serverName,
            error: result.error,
          });
        }
      } catch (error) {
        dispatch({
          type: "DISCONNECT",
          name: serverName,
          error: error instanceof Error ? error.message : "Unknown error",
        });
      }
    },
    [dispatch, logger],
  );

  const cleanupServerLocalArtifacts = useCallback((serverName: string) => {
    clearOAuthData(serverName);
    localStorage.removeItem(`mcp-env-${serverName}`);
  }, []);

  const removeServerFromStateAndCloud = useCallback(
    async (serverName: string) => {
      cleanupServerLocalArtifacts(serverName);
      dispatch({ type: "REMOVE_SERVER", name: serverName });
      await removeServerFromConvex(serverName);
    },
    [cleanupServerLocalArtifacts, dispatch, removeServerFromConvex],
  );

  const handleRemoveServer = useCallback(
    async (serverName: string) => {
      logger.info("Removing server", { serverName });
      await handleDisconnect(serverName);
      await removeServerFromStateAndCloud(serverName);
    },
    [logger, handleDisconnect, removeServerFromStateAndCloud],
  );

  const handleReconnect = useCallback(
    async (serverName: string, options?: { forceOAuthFlow?: boolean }) => {
      logger.info("Reconnecting to server", { serverName, options });
      const server = effectiveServers[serverName];
      if (!server) throw new Error(`Server ${serverName} not found`);

      dispatch({
        type: "RECONNECT_REQUEST",
        name: serverName,
        config: server.config,
      });
      const token = nextOpToken(serverName);

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
        }
        dispatch({
          type: "CONNECT_FAILURE",
          name: serverName,
          error: result.error || "Reconnection failed after OAuth",
        });
        return;
      }

      try {
        const authResult: OAuthResult =
          await ensureAuthorizedForReconnect(server);
        if (authResult.kind === "redirect") return;
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
        }
        dispatch({
          type: "CONNECT_FAILURE",
          name: serverName,
          error: result.error || "Reconnection failed",
        });
        logger.error("Reconnection failed", { serverName, result });
        const errorMessage =
          result.error || `Failed to reconnect: ${serverName}`;
        toast.error(errorMessage);
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
    [effectiveServers, fetchAndStoreInitInfo, logger, dispatch],
  );

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
  }, [isLoading, logger, dispatch]);

  const setSelectedServer = useCallback(
    (serverName: string) => {
      dispatch({ type: "SELECT_SERVER", name: serverName });
    },
    [dispatch],
  );

  const setSelectedMCPConfigs = useCallback(
    (serverNames: string[]) => {
      dispatch({ type: "SET_MULTI_SELECTED", names: serverNames });
    },
    [dispatch],
  );

  const toggleMultiSelectMode = useCallback(
    (enabled: boolean) => {
      dispatch({ type: "SET_MULTI_MODE", enabled });
    },
    [dispatch],
  );

  const toggleServerSelection = useCallback(
    (serverName: string) => {
      const current = appState.selectedMultipleServers;
      const next = current.includes(serverName)
        ? current.filter((n) => n !== serverName)
        : [...current, serverName];
      dispatch({ type: "SET_MULTI_SELECTED", names: next });
    },
    [appState.selectedMultipleServers, dispatch],
  );

  const handleUpdate = useCallback(
    async (
      originalServerName: string,
      formData: ServerFormData,
      skipAutoConnect?: boolean,
    ) => {
      const nextServerName = formData.name.trim();
      if (!nextServerName) {
        toast.error("Server name is required");
        return;
      }
      const isRename = nextServerName !== originalServerName;
      const activeWorkspaceServers =
        effectiveWorkspaces[effectiveActiveWorkspaceId]?.servers ?? {};
      if (isRename && activeWorkspaceServers[nextServerName]) {
        toast.error(
          `A server named "${nextServerName}" already exists. Choose a different name.`,
        );
        return;
      }
      const originalServer =
        appState.servers[originalServerName] ??
        effectiveServers[originalServerName];

      if (skipAutoConnect) {
        const mcpConfig = toMCPConfig(formData);
        if (isRename) {
          await handleDisconnect(originalServerName);
          await removeServerFromStateAndCloud(originalServerName);
        }

        const updatedServer: ServerWithName = {
          ...(originalServer ?? {}),
          name: nextServerName,
          config: mcpConfig,
          lastConnectionTime: originalServer?.lastConnectionTime ?? new Date(),
          connectionStatus: originalServer?.connectionStatus ?? "disconnected",
          retryCount: originalServer?.retryCount ?? 0,
          enabled: originalServer?.enabled ?? false,
          oauthTokens: originalServer?.oauthTokens,
          oauthFlowProfile: originalServer?.oauthFlowProfile,
          initializationInfo: originalServer?.initializationInfo,
          useOAuth: formData.useOAuth ?? false,
        } as ServerWithName;

        if (!formData.useOAuth) {
          clearOAuthData(nextServerName);
        }
        dispatch({
          type: "UPSERT_SERVER",
          name: nextServerName,
          server: updatedServer,
        });

        if (!isAuthenticated) {
          const workspace = appState.workspaces[appState.activeWorkspaceId];
          if (workspace) {
            const nextServers = { ...workspace.servers };
            if (isRename) {
              delete nextServers[originalServerName];
            }
            nextServers[nextServerName] = updatedServer;
            dispatch({
              type: "UPDATE_WORKSPACE",
              workspaceId: appState.activeWorkspaceId,
              updates: { servers: nextServers },
            });
          }
        } else {
          await syncServerToConvex(nextServerName, updatedServer);
        }

        saveOAuthConfigToLocalStorage(formData);
        if (appState.selectedServer === originalServerName && isRename) {
          setSelectedServer(nextServerName);
        }
        toast.success("Server configuration updated");
        return;
      }

      const hadOAuthTokens = originalServer?.oauthTokens != null;
      const shouldPreserveOAuth =
        hadOAuthTokens &&
        formData.useOAuth &&
        nextServerName === originalServerName &&
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
            await fetchAndStoreInitInfo(originalServerName);
            toast.success("Server configuration updated successfully!");
            return;
          }
          console.warn(
            "OAuth connection test failed, falling back to full reconnect",
          );
        } catch (error) {
          console.warn(
            "OAuth connection test error, falling back to full reconnect",
            error,
          );
        }
      }

      if (hadOAuthTokens && !formData.useOAuth) {
        clearOAuthData(originalServerName);
      }

      saveOAuthConfigToLocalStorage(formData);

      if (isRename) {
        await handleDisconnect(originalServerName);
        await removeServerFromStateAndCloud(originalServerName);
      } else {
        await handleDisconnect(originalServerName);
      }
      await handleConnect(formData);
      if (
        appState.selectedServer === originalServerName &&
        nextServerName !== originalServerName
      ) {
        setSelectedServer(nextServerName);
      }
    },
    [
      appState.servers,
      appState.activeWorkspaceId,
      appState.workspaces,
      appState.selectedServer,
      dispatch,
      effectiveWorkspaces,
      effectiveActiveWorkspaceId,
      effectiveServers,
      fetchAndStoreInitInfo,
      handleDisconnect,
      handleConnect,
      isAuthenticated,
      removeServerFromStateAndCloud,
      setSelectedServer,
      syncServerToConvex,
    ],
  );

  return {
    activeWorkspace,
    effectiveServers,
    workspaceServers: effectiveServers,
    connectedOrConnectingServerConfigs: Object.fromEntries(
      Object.entries(effectiveServers).filter(
        ([, server]) =>
          server.connectionStatus === "connected" ||
          server.connectionStatus === "connecting",
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
  };
}
