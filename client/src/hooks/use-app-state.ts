import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { toast } from "sonner";
import { useLogger } from "./use-logger";
import {
  initialAppState,
  type ServerWithName,
  type Workspace,
} from "@/state/app-types";
import { appReducer } from "@/state/app-reducer";
import { loadAppState, saveAppState } from "@/state/storage";
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
} from "@/lib/mcp-oauth";
import { MCPServerConfig } from "@/sdk";
import type { OAuthTestProfile } from "@/lib/oauth/profile";
export type { ServerWithName } from "@/state/app-types";

export function useAppState() {
  const logger = useLogger("Connections");

  const [appState, dispatch] = useReducer(appReducer, initialAppState);
  const [isLoading, setIsLoading] = useState(true);
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

  // Persist on change
  useEffect(() => {
    if (!isLoading) saveAppState(appState);
  }, [appState, isLoading]);

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

  // OAuth callback finish handler
  const handleOAuthCallbackComplete = useCallback(
    async (code: string) => {
      window.history.replaceState({}, document.title, window.location.pathname);
      try {
        const result = await handleOAuthCallback(code);
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
              // Fetch initialization info after successful connection
              await fetchAndStoreInitInfo(serverName);
              logger.info("OAuth connection successful", { serverName });
              toast.success(
                `OAuth connection successful! Connected to ${serverName}.`,
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
      }
    },
    [logger],
  );

  // Check for OAuth callback completion on mount
  useEffect(() => {
    // Skip OAuth callback handling if we're on the debug callback page
    // The debug callback page handles its own OAuth flow visualization
    if (window.location.pathname.startsWith("/oauth/callback/debug")) {
      return;
    }

    if (!isLoading) {
      const urlParams = new URLSearchParams(window.location.search);
      const code = urlParams.get("code");
      const error = urlParams.get("error");
      if (code) {
        handleOAuthCallbackComplete(code);
      } else if (error) {
        toast.error(`OAuth authorization failed: ${error}`);
        localStorage.removeItem("mcp-oauth-pending");
        window.history.replaceState(
          {},
          document.title,
          window.location.pathname,
        );
      }
    }
  }, [isLoading, handleOAuthCallbackComplete]);

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

      try {
        if (formData.type === "http" && formData.useOAuth && formData.url) {
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
            } as ServerWithName,
          });

          const { initiateOAuth } = await import("@/lib/mcp-oauth");
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
                // Fetch initialization info after successful connection
                await fetchAndStoreInitInfo(formData.name);
                toast.success(`Connected successfully with OAuth!`);
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

        // Non-OAuth connect
        const result = await testConnection(mcpConfig, formData.name);
        if (isStaleOp(formData.name, token)) return;
        if (result.success) {
          dispatch({
            type: "CONNECT_SUCCESS",
            name: formData.name,
            config: mcpConfig,
          });
          // Fetch initialization info after successful connection
          await fetchAndStoreInitInfo(formData.name);
          logger.info("Connection successful", { serverName: formData.name });
          toast.success(`Connected successfully!`);
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
    [appState.servers, logger, fetchAndStoreInitInfo],
  );

  const saveServerConfigWithoutConnecting = useCallback(
    (
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
      } as ServerWithName;

      dispatch({
        type: "UPSERT_SERVER",
        name: serverName,
        server: serverEntry,
      });

      if (formData.type === "http") {
        if (formData.useOAuth && formData.url) {
          localStorage.setItem(`mcp-serverUrl-${serverName}`, formData.url);

          const oauthConfig: Record<string, any> = {};
          if (formData.oauthScopes && formData.oauthScopes.length > 0) {
            oauthConfig.scopes = formData.oauthScopes;
          }
          if (formData.headers && Object.keys(formData.headers).length > 0) {
            oauthConfig.customHeaders = formData.headers;
          }
          if (Object.keys(oauthConfig).length > 0) {
            localStorage.setItem(
              `mcp-oauth-config-${serverName}`,
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
              `mcp-client-${serverName}`,
              JSON.stringify(clientInfo),
            );
          }
        } else {
          localStorage.removeItem(`mcp-serverUrl-${serverName}`);
          localStorage.removeItem(`mcp-oauth-config-${serverName}`);
          localStorage.removeItem(`mcp-client-${serverName}`);
        }
      }

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

      logger.info("Saved server configuration without connecting", {
        serverName,
      });
      toast.success(`Saved configuration for ${serverName}`);
    },
    [appState.activeWorkspaceId, appState.servers, appState.workspaces, logger],
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
    [fetchAndStoreInitInfo],
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
      const result = await applyTokensFromOAuthFlow(serverName, tokens, serverUrl);
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
      const result = await applyTokensFromOAuthFlow(serverName, tokens, serverUrl);
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
                const formData: ServerFormData = {
                  name: server.name || "CLI Server",
                  type: (server.type === "sse"
                    ? "http"
                    : server.type || "stdio") as "stdio" | "http",
                  command: server.command,
                  args: server.args || [],
                  url: server.url,
                  env: server.env || {},
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
                if (!autoConnectServer || server.name === autoConnectServer) {
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

  const handleRemoveServer = useCallback(async (serverName: string) => {
    logger.info("Removing server", { serverName });
    clearOAuthData(serverName);
    dispatch({ type: "REMOVE_SERVER", name: serverName });
  }, []);

  const handleReconnect = useCallback(
    async (serverName: string) => {
      logger.info("Reconnecting to server", { serverName });
      const server = appState.servers[serverName];
      if (!server) throw new Error(`Server ${serverName} not found`);

      dispatch({ type: "RECONNECT_REQUEST", name: serverName });
      const token = nextOpToken(serverName);
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
          // Fetch initialization info after successful reconnection
          await fetchAndStoreInitInfo(serverName);
          logger.info("Reconnection successful", { serverName, result });
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
    [appState.servers, fetchAndStoreInitInfo],
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
      const newWorkspace = appState.workspaces[workspaceId];
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
      dispatch({ type: "SWITCH_WORKSPACE", workspaceId });
      toast.success(`Switched to workspace: ${newWorkspace.name}`);
    },
    [appState.workspaces, appState.servers, handleDisconnect, logger],
  );

  const handleCreateWorkspace = useCallback(
    (name: string, switchTo: boolean = false) => {
      const newWorkspace: Workspace = {
        id: `workspace_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
        name,
        servers: {},
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      dispatch({ type: "CREATE_WORKSPACE", workspace: newWorkspace });

      // Switch to the new workspace if requested
      if (switchTo) {
        dispatch({ type: "SWITCH_WORKSPACE", workspaceId: newWorkspace.id });
      }

      toast.success(`Workspace "${name}" created`);
      return newWorkspace.id;
    },
    [],
  );

  const handleUpdateWorkspace = useCallback(
    (workspaceId: string, updates: Partial<Workspace>) => {
      dispatch({ type: "UPDATE_WORKSPACE", workspaceId, updates });
    },
    [],
  );

  const handleDeleteWorkspace = useCallback(
    (workspaceId: string) => {
      if (workspaceId === appState.activeWorkspaceId) {
        toast.error(
          "Cannot delete the active workspace. Switch to another workspace first.",
        );
        return;
      }
      dispatch({ type: "DELETE_WORKSPACE", workspaceId });
      toast.success("Workspace deleted");
    },
    [appState.activeWorkspaceId],
  );

  const handleDuplicateWorkspace = useCallback(
    (workspaceId: string, newName: string) => {
      dispatch({ type: "DUPLICATE_WORKSPACE", workspaceId, newName });
      toast.success(`Workspace duplicated as "${newName}"`);
    },
    [],
  );

  const handleSetDefaultWorkspace = useCallback((workspaceId: string) => {
    dispatch({ type: "SET_DEFAULT_WORKSPACE", workspaceId });
    toast.success("Default workspace updated");
  }, []);

  const handleExportWorkspace = useCallback(
    (workspaceId: string) => {
      const workspace = appState.workspaces[workspaceId];
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
    [appState.workspaces],
  );

  const handleImportWorkspace = useCallback((workspaceData: Workspace) => {
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
  }, []);

  return {
    // State
    appState,
    isLoading,

    // Computed values
    connectedServerConfigs: appState.servers,
    selectedServerEntry: appState.servers[appState.selectedServer],
    selectedMCPConfig: appState.servers[appState.selectedServer]?.config,
    selectedMCPConfigs: appState.selectedMultipleServers
      .map((name) => appState.servers[name])
      .filter(Boolean),
    selectedMCPConfigsMap: appState.selectedMultipleServers.reduce(
      (acc, name) => {
        if (appState.servers[name]) {
          acc[name] = appState.servers[name].config;
        }
        return acc;
      },
      {} as Record<string, MCPServerConfig>,
    ),
    isMultiSelectMode: appState.isMultiSelectMode,

    // Workspace-related
    workspaces: appState.workspaces,
    activeWorkspaceId: appState.activeWorkspaceId,
    activeWorkspace: appState.workspaces[appState.activeWorkspaceId],

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
    handleDuplicateWorkspace,
    handleSetDefaultWorkspace,
    handleExportWorkspace,
    handleImportWorkspace,
  };
}
