import { useState, useEffect, useCallback } from "react";
import { toast } from "sonner";
import {
  initiateOAuth,
  handleOAuthCallback,
  getStoredTokens,
  clearOAuthData,
  refreshOAuthTokens,
  MCPOAuthOptions,
} from "@/lib/mcp-oauth";
import {
  MastraMCPServerDefinition,
  StdioServerDefinition,
  HttpServerDefinition,
  OauthTokens,
} from "@/shared/types.js";
import { useLogger } from "./use-logger";

export interface ServerWithName {
  name: string;
  config: MastraMCPServerDefinition;
  oauthTokens?: OauthTokens;
  lastConnectionTime: Date;
  connectionStatus:
    | "connected"
    | "connecting"
    | "failed"
    | "disconnected"
    | "oauth-flow";
  retryCount: number;
  lastError?: string;
  enabled?: boolean;
}

export interface AppState {
  servers: Record<string, ServerWithName>;
  selectedServer: string;
  selectedMultipleServers: string[]; // Array of selected server names for multi-select mode
  isMultiSelectMode: boolean; // Flag to enable/disable multi-select mode
}

export interface ServerFormData {
  name: string;
  type: "stdio" | "http";
  command?: string;
  args?: string[];
  url?: string;
  headers?: Record<string, string>;
  env?: Record<string, string>;
  useOAuth?: boolean;
  oauthScopes?: string[];
  clientId?: string;
  clientSecret?: string;
}

const STORAGE_KEY = "mcp-inspector-state";

export function useAppState() {
  const logger = useLogger("Connections");

  const [appState, setAppState] = useState<AppState>({
    servers: {},
    selectedServer: "none",
    selectedMultipleServers: [],
    isMultiSelectMode: false,
  });

  const [isLoading, setIsLoading] = useState(true);
  const [reconnectionTimeouts, setReconnectionTimeouts] = useState<
    Record<string, NodeJS.Timeout>
  >({});

  // Load state from localStorage on mount
  useEffect(() => {
    const savedState = localStorage.getItem(STORAGE_KEY);
    if (savedState) {
      try {
        const parsed = JSON.parse(savedState);
        // Ensure all loaded servers have the new fields with defaults
        const updatedServers = Object.fromEntries(
          Object.entries(parsed.servers || {}).map(
            ([name, server]: [string, any]) => [
              name,
              {
                ...server,
                connectionStatus: server.connectionStatus || "disconnected",
                retryCount: server.retryCount || 0,
                lastConnectionTime: server.lastConnectionTime
                  ? new Date(server.lastConnectionTime)
                  : new Date(),
                enabled: server.enabled !== false,
              },
            ],
          ),
        );
        setAppState({
          servers: updatedServers,
          selectedServer: parsed.selectedServer || "none",
          selectedMultipleServers: parsed.selectedMultipleServers || [],
          isMultiSelectMode: parsed.isMultiSelectMode || false,
        });
      } catch (error) {
        logger.error("Failed to parse saved state", {
          error: error instanceof Error ? error.message : "Unknown error",
        });
      }
    }
    setIsLoading(false);
  }, []);

  // Save state to localStorage whenever it changes
  useEffect(() => {
    if (!isLoading) {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(appState));
    }
  }, [appState, isLoading]);

  const setSelectedMultipleServersToAllServers = useCallback(() => {
    setAppState((prev) => ({
      ...prev,
      selectedMultipleServers: Object.entries(appState.servers)
        .filter(([, s]) => s.enabled !== false)
        .map(([name]) => name),
    }));
  }, [appState.servers]);

  // Check for OAuth callback completion on mount
  useEffect(() => {
    if (!isLoading) {
      const urlParams = new URLSearchParams(window.location.search);
      const code = urlParams.get("code");
      const error = urlParams.get("error");

      if (code) {
        handleOAuthCallbackComplete(code);
      } else if (error) {
        // Show the error toast (do not suppress), then clean up the URL
        toast.error(`OAuth authorization failed: ${error}`);
        localStorage.removeItem("mcp-oauth-pending");
        window.history.replaceState(
          {},
          document.title,
          window.location.pathname,
        );
      }
    }
  }, [isLoading]);

  const convertFormToMCPConfig = useCallback(
    (formData: ServerFormData): MastraMCPServerDefinition => {
      if (formData.type === "stdio") {
        return {
          command: formData.command!,
          args: formData.args,
          env: formData.env,
        } as StdioServerDefinition;
      } else {
        return {
          url: new URL(formData.url!),
          requestInit: { headers: formData.headers || {} },
        } as HttpServerDefinition;
      }
    },
    [],
  );

  const handleConnect = useCallback(
    async (formData: ServerFormData) => {
      // Validate form data first

      if (formData.type === "stdio") {
        if (!formData.command || formData.command.trim() === "") {
          toast.error("Command is required for STDIO connections");
          return;
        }
      } else {
        if (!formData.url || formData.url.trim() === "") {
          toast.error("URL is required for HTTP connections");
          return;
        }

        try {
          new URL(formData.url);
        } catch (urlError) {
          toast.error(`Invalid URL format: ${formData.url} ${urlError}`);
          return;
        }
      }

      // Convert form data to MCP config
      const mcpConfig = convertFormToMCPConfig(formData);

      // Immediately create server with 'connecting' state for responsive UI
      setAppState((prev) => ({
        ...prev,
        servers: {
          ...prev.servers,
          [formData.name]: {
            name: formData.name,
            config: mcpConfig,
            lastConnectionTime: new Date(),
            connectionStatus: "connecting" as const,
            retryCount: 0,
            enabled: true,
          },
        },
        selectedServer: formData.name,
      }));

      try {
        // Handle OAuth flow for HTTP servers
        if (formData.type === "http" && formData.useOAuth && formData.url) {
          // Mark as OAuth flow in progress
          setAppState((prev) => ({
            ...prev,
            servers: {
              ...prev.servers,
              [formData.name]: {
                ...prev.servers[formData.name],
                connectionStatus: "oauth-flow" as const,
              },
            },
          }));

          const oauthOptions: MCPOAuthOptions = {
            serverName: formData.name,
            serverUrl: formData.url,
            clientId: formData.clientId,
            clientSecret: formData.clientSecret,
          } as MCPOAuthOptions;
          // Only pass scopes if the user explicitly provided them
          if (formData.oauthScopes && formData.oauthScopes.length > 0) {
            oauthOptions.scopes = formData.oauthScopes;
          }

          const oauthResult = await initiateOAuth(oauthOptions);

          if (oauthResult.success) {
            if (oauthResult.serverConfig) {
              // Already authorized, test connection immediately
              try {
                const response = await fetch("/api/mcp/connect", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({
                    serverConfig: oauthResult.serverConfig,
                  }),
                });

                const connectionResult = await response.json();

                if (connectionResult.success) {
                  setAppState((prev) => ({
                    ...prev,
                    servers: {
                      ...prev.servers,
                      [formData.name]: {
                        ...prev.servers[formData.name],
                        config: oauthResult.serverConfig!,
                        connectionStatus: "connected" as const,
                        oauthTokens: getStoredTokens(formData.name),
                        lastError: undefined,
                      },
                    },
                  }));
                  toast.success(`Connected successfully with OAuth!`);
                } else {
                  setAppState((prev) => ({
                    ...prev,
                    servers: {
                      ...prev.servers,
                      [formData.name]: {
                        ...prev.servers[formData.name],
                        connectionStatus: "failed" as const,
                        lastError:
                          connectionResult.error ||
                          "OAuth connection test failed",
                      },
                    },
                  }));
                  toast.error(
                    `OAuth succeeded but connection failed: ${connectionResult.error}`,
                  );
                }
              } catch (error) {
                const errorMessage =
                  error instanceof Error ? error.message : "Unknown error";
                setAppState((prev) => ({
                  ...prev,
                  servers: {
                    ...prev.servers,
                    [formData.name]: {
                      ...prev.servers[formData.name],
                      connectionStatus: "failed" as const,
                      lastError: errorMessage,
                    },
                  },
                }));
                toast.error(
                  `OAuth succeeded but connection test threw error: ${errorMessage}`,
                );
              }
              return;
            } else {
              // Redirect needed - keep oauth-flow status
              toast.success(
                "OAuth flow initiated. You will be redirected to authorize access.",
              );
              return;
            }
          } else {
            setAppState((prev) => ({
              ...prev,
              servers: {
                ...prev.servers,
                [formData.name]: {
                  ...prev.servers[formData.name],
                  connectionStatus: "failed" as const,
                  retryCount: 0,
                  lastError: oauthResult.error || "OAuth initialization failed",
                },
              },
            }));
            toast.error(`OAuth initialization failed: ${oauthResult.error}`);
            return;
          }
        }

        // For non-OAuth connections, test connection using the stateless endpoint
        const response = await fetch("/api/mcp/connect", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            serverConfig: mcpConfig,
          }),
        });

        const result = await response.json();

        if (result.success) {
          // Update existing server to connected state
          setAppState((prev) => ({
            ...prev,
            servers: {
              ...prev.servers,
              [formData.name]: {
                ...prev.servers[formData.name],
                connectionStatus: "connected" as const,
                lastConnectionTime: new Date(),
                retryCount: 0,
                lastError: undefined,
              },
            },
          }));
          logger.info("Connection successful", {
            serverName: formData.name,
          });
          toast.success(`Connected successfully!`);
        } else {
          // Update existing server to failed state
          setAppState((prev) => ({
            ...prev,
            servers: {
              ...prev.servers,
              [formData.name]: {
                ...prev.servers[formData.name],
                connectionStatus: "failed" as const,
                retryCount: 0,
                lastError: result.error,
              },
            },
          }));
          logger.error("Connection failed", {
            serverName: formData.name,
            error: result.error,
          });
          toast.error(`Failed to connect to ${formData.name}`);
        }
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : "Unknown error";

        // Update existing server to failed state
        setAppState((prev) => ({
          ...prev,
          servers: {
            ...prev.servers,
            [formData.name]: {
              ...prev.servers[formData.name],
              connectionStatus: "failed" as const,
              retryCount: 0,
              lastError: errorMessage,
            },
          },
        }));
        logger.error("Connection failed", {
          serverName: formData.name,
          error: errorMessage,
        });

        toast.error(`Network error: ${errorMessage}`);
      }
    },
    [convertFormToMCPConfig],
  );

  // Auto-connect to CLI-provided MCP server on mount
  useEffect(() => {
    if (!isLoading) {
      // First try window config (production mode)
      const windowCliConfig = (window as any).MCP_CLI_CONFIG;
      if (windowCliConfig && windowCliConfig.command) {
        logger.info(
          "Auto-connecting to CLI-provided MCP server (from window)",
          { cliConfig: windowCliConfig },
        );

        const formData: ServerFormData = {
          name: windowCliConfig.name || "CLI Server",
          type: "stdio" as const,
          command: windowCliConfig.command,
          args: windowCliConfig.args || [],
        };

        handleConnect(formData);
        return;
      }

      // If no window config, try API config (development mode)
      fetch("/api/mcp-cli-config")
        .then((response) => response.json())
        .then((data) => {
          const cliConfig = data.config;
          if (cliConfig && cliConfig.command) {
            logger.info(
              "Auto-connecting to CLI-provided MCP server (from API)",
              { cliConfig },
            );

            const formData: ServerFormData = {
              name: cliConfig.name || "CLI Server",
              type: "stdio" as const,
              command: cliConfig.command,
              args: cliConfig.args || [],
            };

            handleConnect(formData);
          }
        })
        .catch((error) => {
          // Ignore errors - just means no CLI config available
          logger.debug("No CLI config available", { error });
        });
    }
  }, [isLoading, handleConnect, logger]);

  const handleOAuthCallbackComplete = useCallback(
    async (code: string) => {
      // Clean up URL parameters immediately
      window.history.replaceState({}, document.title, window.location.pathname);

      try {
        const result = await handleOAuthCallback(code);

        if (result.success && result.serverConfig && result.serverName) {
          const serverName = result.serverName;

          // Check if server exists and is in oauth-flow state
          const existingServer = appState.servers[serverName];
          if (
            !existingServer ||
            existingServer.connectionStatus !== "oauth-flow"
          ) {
            // Create new server entry if it doesn't exist or wasn't in oauth flow
            setAppState((prev) => ({
              ...prev,
              servers: {
                ...prev.servers,
                [serverName]: {
                  name: serverName,
                  config: result.serverConfig!,
                  oauthTokens: getStoredTokens(serverName),
                  lastConnectionTime: new Date(),
                  connectionStatus: "connecting" as const,
                  retryCount: 0,
                },
              },
              selectedServer: serverName,
            }));
          } else {
            // Update existing server to connecting with OAuth config
            setAppState((prev) => ({
              ...prev,
              servers: {
                ...prev.servers,
                [serverName]: {
                  ...prev.servers[serverName],
                  config: result.serverConfig!,
                  oauthTokens: getStoredTokens(serverName),
                  connectionStatus: "connecting" as const,
                  lastError: undefined,
                },
              },
              selectedServer: serverName,
            }));
          }

          // Test the connection
          try {
            const response = await fetch("/api/mcp/connect", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                serverConfig: result.serverConfig,
              }),
            });

            const connectionResult = await response.json();

            if (connectionResult.success) {
              setAppState((prev) => ({
                ...prev,
                servers: {
                  ...prev.servers,
                  [serverName]: {
                    ...prev.servers[serverName],
                    connectionStatus: "connected" as const,
                    lastConnectionTime: new Date(),
                    lastError: undefined,
                  },
                },
              }));

              logger.info("OAuth connection successful", { serverName });
              toast.success(
                `OAuth connection successful! Connected to ${serverName}.`,
              );
            } else {
              setAppState((prev) => ({
                ...prev,
                servers: {
                  ...prev.servers,
                  [serverName]: {
                    ...prev.servers[serverName],
                    connectionStatus: "failed" as const,
                    lastError:
                      connectionResult.error ||
                      "Connection test failed after OAuth",
                  },
                },
              }));

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

            setAppState((prev) => ({
              ...prev,
              servers: {
                ...prev.servers,
                [serverName]: {
                  ...prev.servers[serverName],
                  connectionStatus: "failed" as const,
                  lastError: errorMessage,
                },
              },
            }));

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
    [appState.servers, logger],
  );

  const getValidAccessToken = useCallback(
    async (serverName: string): Promise<string | null> => {
      const server = appState.servers[serverName];
      if (!server?.oauthTokens) {
        return null;
      }

      // The SDK handles token refresh automatically
      return server.oauthTokens.access_token || null;
    },
    [appState.servers],
  );

  const handleDisconnect = useCallback(async (serverName: string) => {
    logger.info("Disconnecting from server", { serverName });
    // Mark server as disabled and disconnected, but keep config
    setAppState((prev: AppState) => ({
      ...prev,
      servers: {
        ...prev.servers,
        [serverName]: prev.servers[serverName]
          ? {
              ...prev.servers[serverName],
              connectionStatus: "disconnected" as const,
              enabled: false,
            }
          : prev.servers[serverName],
      },
      selectedServer:
        prev.selectedServer === serverName ? "none" : prev.selectedServer,
      selectedMultipleServers: prev.selectedMultipleServers.filter(
        (name) => name !== serverName,
      ),
    }));
  }, []);

  // Permanently remove a server: clear OAuth data and delete from state
  const handleRemoveServer = useCallback(async (serverName: string) => {
    logger.info("Removing server", { serverName });

    // Clear OAuth data
    clearOAuthData(serverName);

    // Remove server from state (no API call needed for stateless architecture)
    setAppState((prev: AppState) => {
      const newServers = { ...prev.servers };
      delete newServers[serverName];

      return {
        ...prev,
        servers: newServers,
        selectedServer:
          prev.selectedServer === serverName ? "none" : prev.selectedServer,
        selectedMultipleServers: prev.selectedMultipleServers.filter(
          (name) => name !== serverName,
        ),
      };
    });
  }, []);

  const handleReconnect = useCallback(
    async (serverName: string) => {
      logger.info("Reconnecting to server", { serverName });

      const server = appState.servers[serverName];
      if (!server) {
        throw new Error(`Server ${serverName} not found`);
      }

      // Update status to connecting
      setAppState((prev) => ({
        ...prev,
        servers: {
          ...prev.servers,
          [serverName]: {
            ...server,
            connectionStatus: "connecting" as const,
            enabled: true,
          },
        },
      }));

      try {
        let serverConfig = server.config;

        // If server has OAuth tokens, try to refresh them
        if (server.oauthTokens) {
          logger.info("Attempting to refresh OAuth tokens", { serverName });
          const refreshResult = await refreshOAuthTokens(serverName);

          if (refreshResult.success && refreshResult.serverConfig) {
            logger.info("OAuth tokens refreshed successfully", { serverName });
            serverConfig = refreshResult.serverConfig;

            // Update server state with refreshed config and tokens
            setAppState((prev) => ({
              ...prev,
              servers: {
                ...prev.servers,
                [serverName]: {
                  ...prev.servers[serverName],
                  config: refreshResult.serverConfig!,
                  oauthTokens: getStoredTokens(serverName),
                },
              },
            }));
          } else {
            logger.warn(
              "OAuth token refresh failed, attempting with existing tokens",
              {
                serverName,
                error: refreshResult.error,
              },
            );
          }
        }

        // Test connection using the stateless endpoint
        const response = await fetch("/api/mcp/connect", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            serverConfig,
          }),
        });

        const result = await response.json();

        if (result.success) {
          // Update status to connected and reset retry count
          setAppState((prev) => ({
            ...prev,
            servers: {
              ...prev.servers,
              [serverName]: {
                ...prev.servers[serverName],
                connectionStatus: "connected" as const,
                lastConnectionTime: new Date(),
                retryCount: 0,
                lastError: undefined,
              },
            },
          }));
          logger.info("Reconnection successful", {
            serverName,
            result,
          });
          return { success: true };
        } else {
          // Update status to failed and increment retry count
          setAppState((prev) => ({
            ...prev,
            servers: {
              ...prev.servers,
              [serverName]: {
                ...prev.servers[serverName],
                connectionStatus: "failed" as const,
                retryCount: prev.servers[serverName].retryCount + 1,
                lastError: result.error || "Connection test failed",
              },
            },
          }));
          logger.error("Reconnection failed", {
            serverName,
            result,
          });
          toast.error(`Failed to connect: ${serverName}`);
        }
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : "Unknown error";

        // Update status to failed and increment retry count
        setAppState((prev) => ({
          ...prev,
          servers: {
            ...prev.servers,
            [serverName]: {
              ...prev.servers[serverName],
              connectionStatus: "failed" as const,
              retryCount: prev.servers[serverName].retryCount + 1,
              lastError: errorMessage,
            },
          },
        }));
        logger.error("Reconnection failed", {
          serverName,
          error: errorMessage,
        });
        throw error;
      }
    },
    [appState.servers],
  );

  // Effect to handle cleanup of reconnection timeouts (automatic retries disabled)
  useEffect(() => {
    // Cleanup timeouts for servers that are no longer failed or have been removed
    Object.keys(reconnectionTimeouts).forEach((serverName) => {
      const server = appState.servers[serverName];
      if (!server || server.connectionStatus !== "failed") {
        clearTimeout(reconnectionTimeouts[serverName]);
        setReconnectionTimeouts((prev) => {
          const newTimeouts = { ...prev };
          delete newTimeouts[serverName];
          return newTimeouts;
        });
      }
    });
  }, [appState.servers, reconnectionTimeouts]);

  // Cleanup timeouts on unmount
  useEffect(() => {
    return () => {
      Object.values(reconnectionTimeouts).forEach(clearTimeout);
    };
  }, [reconnectionTimeouts]);

  const setSelectedServer = useCallback((serverName: string) => {
    setAppState((prev) => ({
      ...prev,
      selectedServer: serverName,
    }));
  }, []);

  const setSelectedMCPConfigs = useCallback((serverNames: string[]) => {
    setAppState((prev) => ({
      ...prev,
      selectedMCPConfigs: serverNames,
    }));
  }, []);

  const toggleMultiSelectMode = useCallback((enabled: boolean) => {
    setAppState((prev) => ({
      ...prev,
      isMultiSelectMode: enabled,
      // Reset selections when switching modes
      selectedMultipleServers: enabled ? [] : prev.selectedMultipleServers,
    }));
  }, []);

  const toggleServerSelection = useCallback((serverName: string) => {
    setAppState((prev) => {
      const currentSelected = prev.selectedMultipleServers;
      const isSelected = currentSelected.includes(serverName);

      return {
        ...prev,
        selectedMultipleServers: isSelected
          ? currentSelected.filter((name) => name !== serverName)
          : [...currentSelected, serverName],
      };
    });
  }, []);

  const handleUpdate = useCallback(
    async (originalServerName: string, formData: ServerFormData) => {
      const originalServer = appState.servers[originalServerName];
      const hadOAuthTokens = originalServer?.oauthTokens != null;

      // For OAuth servers, preserve the tokens if the server name and URL haven't changed
      // and the user is still using OAuth authentication
      const shouldPreserveOAuth =
        hadOAuthTokens &&
        formData.useOAuth &&
        formData.name === originalServerName &&
        formData.type === "http" &&
        formData.url === originalServer.config.url?.toString();

      if (shouldPreserveOAuth) {
        // Update server config without disconnecting to preserve OAuth tokens
        const mcpConfig = convertFormToMCPConfig(formData);

        // Update the server configuration in place
        setAppState((prev) => ({
          ...prev,
          servers: {
            ...prev.servers,
            [originalServerName]: {
              ...prev.servers[originalServerName],
              config: mcpConfig,
              connectionStatus: "connecting" as const,
            },
          },
        }));

        // Test connection with existing OAuth tokens
        try {
          const response = await fetch("/api/mcp/connect", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              serverConfig: originalServer.config, // Use original config with OAuth tokens
            }),
          });

          const result = await response.json();

          if (result.success) {
            setAppState((prev) => ({
              ...prev,
              servers: {
                ...prev.servers,
                [originalServerName]: {
                  ...prev.servers[originalServerName],
                  config: mcpConfig, // Now update to new config
                  connectionStatus: "connected" as const,
                  lastConnectionTime: new Date(),
                  retryCount: 0,
                  lastError: undefined,
                },
              },
            }));
            toast.success("Server configuration updated successfully!");
            return;
          } else {
            // Connection failed, fall back to full reconnect
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

      // Full disconnect and reconnect for non-OAuth or when preservation fails
      // First, disconnect the original server
      await handleDisconnect(originalServerName);

      // Then connect with the new configuration
      await handleConnect(formData);

      // If the server name changed, update selected server
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
      convertFormToMCPConfig,
      handleDisconnect,
      handleConnect,
      setSelectedServer,
    ],
  );

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
      {} as Record<string, MastraMCPServerDefinition>,
    ),
    isMultiSelectMode: appState.isMultiSelectMode,

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
  };
}
