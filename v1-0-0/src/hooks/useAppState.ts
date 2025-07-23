import { useState, useEffect, useCallback } from "react";
import { toast } from "sonner";
import { createOAuthFlow, OAuthFlowManager } from "@/lib/oauth-flow";
import {
  MastraMCPServerDefinition,
  StdioServerDefinition,
  HttpServerDefinition,
} from "@/lib/types";

export interface ServerWithName {
  name: string;
  config: MastraMCPServerDefinition;
  oauthFlow?: OAuthFlowManager;
  oauthState?: {
    serverUrl: string;
    clientName: string;
    clientId?: string;
    scopes: string[];
    state: string;
    codeVerifier: string;
    codeChallenge: string;
    accessToken?: string;
    refreshToken?: string;
    expiresAt?: number;
  };
  lastConnectionTime: Date;
  connectionStatus: "connected" | "connecting" | "failed" | "disconnected";
  retryCount: number;
  lastError?: string;
}

export interface AppState {
  servers: Record<string, ServerWithName>;
  selectedServer: string;
  selectedMultipleServers: string[]; // Array of selected server names for multi-select mode
  isMultiSelectMode: boolean; // Flag to enable/disable multi-select mode
  oauthFlows: Record<string, OAuthFlowManager>;
  pendingOAuthCallbacks: Record<
    string,
    {
      serverUrl: string;
      clientName: string;
      clientId?: string;
      scopes: string[];
      state: string;
      codeVerifier: string;
      codeChallenge: string;
    }
  >;
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
}

const STORAGE_KEY = "mcp-inspector-state";

export function useAppState() {
  const [appState, setAppState] = useState<AppState>({
    servers: {},
    selectedServer: "none",
    selectedMultipleServers: [],
    isMultiSelectMode: false,
    oauthFlows: {},
    pendingOAuthCallbacks: {},
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
              },
            ],
          ),
        );
        setAppState({
          servers: updatedServers,
          selectedServer: parsed.selectedServer || "none",
          selectedMultipleServers: parsed.selectedMultipleServers || [],
          isMultiSelectMode: parsed.isMultiSelectMode || false,
          oauthFlows: parsed.oauthFlows || {},
          pendingOAuthCallbacks: parsed.pendingOAuthCallbacks || {},
        });
      } catch (error) {
        console.error("Failed to parse saved state:", error);
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
      selectedMultipleServers: Object.keys(appState.servers),
    }));
  }, [appState.servers]);

  // Check for OAuth callback completion on mount
  useEffect(() => {
    if (!isLoading) {
      const urlParams = new URLSearchParams(window.location.search);
      const code = urlParams.get("code");
      const state = urlParams.get("state");
      const error = urlParams.get("error");

      if (code && state && appState.pendingOAuthCallbacks?.[state]) {
        handleOAuthCallback(code, state, appState.pendingOAuthCallbacks[state]);
      } else if (error) {
        alert(`OAuth authorization failed: ${error}`);
      }
    }
  }, [isLoading, appState.pendingOAuthCallbacks]);

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
          toast.error(`Invalid URL format: ${formData.url}`);
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
          },
        },
        selectedServer: formData.name,
      }));

      try {
        // Handle OAuth flow for HTTP servers
        if (formData.type === "http" && formData.useOAuth && formData.url) {
          const oauthFlow = createOAuthFlow(formData.url, {
            client_name: `MCP Inspector - ${formData.name}`,
            requested_scopes: formData.oauthScopes || ["mcp:*"],
            redirect_uri: `${window.location.origin}/oauth/callback`,
          });

          const oauthResult = await oauthFlow.initiate();

          if (oauthResult.success && oauthResult.authorization_url) {
            // Store only serializable OAuth state data
            const oauthState = oauthFlow.getState();
            const pkceParams = oauthState.pkce_params;

            if (pkceParams && oauthState.authorization_request?.state) {
              const stateParam = oauthState.authorization_request.state;
              const clientId: string | undefined =
                oauthState.client_registration?.client_id;

              setAppState((prev) => {
                const newState = {
                  ...prev,
                  pendingOAuthCallbacks: {
                    ...prev.pendingOAuthCallbacks,
                    [stateParam]: {
                      serverUrl: formData.url!,
                      clientName: `MCP Inspector - ${formData.name}`,
                      clientId,
                      scopes: formData.oauthScopes || ["mcp:*"],
                      state: stateParam,
                      codeVerifier: pkceParams.code_verifier,
                      codeChallenge: pkceParams.code_challenge,
                    },
                  },
                };

                // Force save to localStorage immediately
                localStorage.setItem(STORAGE_KEY, JSON.stringify(newState));

                return newState;
              });

              // Wait a bit for the state to be saved, then redirect
              setTimeout(() => {
                toast.success(
                  "OAuth flow initiated. You will be redirected to authorize access.",
                );
                window.location.href = oauthResult.authorization_url!;
              }, 100);

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
                  lastError: oauthResult.error?.error || "Unknown error",
                },
              },
            }));
            toast.error(
              `OAuth initialization failed: ${oauthResult.error?.error || "Unknown error"}`,
            );
            return;
          }
        }

        // For non-OAuth connections, test connection using the stateless endpoint
        const response = await fetch("/api/mcp/test-connection", {
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

        toast.error(`Network error: ${errorMessage}`);
      }
    },
    [convertFormToMCPConfig],
  );

  const handleOAuthCallback = useCallback(
    async (
      code: string,
      state: string,
      oauthData: {
        serverUrl: string;
        clientName: string;
        clientId?: string;
        scopes: string[];
        state: string;
        codeVerifier: string;
        codeChallenge: string;
      },
    ) => {
      try {
        // Create a new OAuth flow manager for discovery
        const oauthFlow = createOAuthFlow(oauthData.serverUrl, {
          client_name: oauthData.clientName,
          requested_scopes: oauthData.scopes,
          redirect_uri: `${window.location.origin}/oauth/callback`,
        });

        // Perform discovery to get the token endpoint
        const discoveryResult = await oauthFlow.initiate();
        if (!discoveryResult.success) {
          throw new Error(
            `Discovery failed: ${discoveryResult.error?.error_description}`,
          );
        }

        // Get the discovered endpoints
        const oauthState = oauthFlow.getState();
        const tokenEndpoint =
          oauthState.authorization_server_metadata?.token_endpoint;

        // Use the stored client ID from the original OAuth flow
        const clientId = oauthData.clientId;

        if (!tokenEndpoint) {
          throw new Error("Token endpoint not available after discovery");
        }

        if (!clientId) {
          throw new Error(
            "Client ID not available. OAuth flow may have failed during registration.",
          );
        }

        // Manually exchange the authorization code for tokens
        const tokenResponse = await fetch(tokenEndpoint, {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            Accept: "application/json",
            "User-Agent": "MCP-Inspector/1.0",
          },
          body: new URLSearchParams({
            grant_type: "authorization_code",
            code: code,
            redirect_uri: `${window.location.origin}/oauth/callback`,
            client_id: clientId,
            code_verifier: oauthData.codeVerifier,
          }).toString(),
        });

        if (!tokenResponse.ok) {
          const errorData = await tokenResponse.json().catch(() => ({}));
          throw new Error(
            `Token exchange failed: ${errorData.error_description || `HTTP ${tokenResponse.status}`}`,
          );
        }

        const tokens = await tokenResponse.json();

        // Create the MCP config with OAuth tokens
        const mcpConfig: HttpServerDefinition = {
          url: new URL(oauthData.serverUrl),
          requestInit: {
            headers: {
              Authorization: `Bearer ${tokens.access_token}`,
            },
          },
        };

        // Extract server name from client name
        const serverName = oauthData.clientName.replace("MCP Inspector - ", "");

        // Add server to state with OAuth tokens
        setAppState((prev) => {
          const newPendingCallbacks = { ...prev.pendingOAuthCallbacks };
          delete newPendingCallbacks[state];

          return {
            ...prev,
            servers: {
              ...prev.servers,
              [serverName]: {
                name: serverName,
                config: mcpConfig,
                oauthState: {
                  ...oauthData,
                  accessToken: tokens.access_token,
                  refreshToken: tokens.refresh_token,
                  expiresAt: tokens.expires_in
                    ? Date.now() + tokens.expires_in * 1000
                    : undefined,
                },
                lastConnectionTime: new Date(),
                connectionStatus: "connected" as const,
                retryCount: 0,
              },
            },
            selectedServer: serverName,
            pendingOAuthCallbacks: newPendingCallbacks,
          };
        });

        // Clean up URL parameters
        window.history.replaceState(
          {},
          document.title,
          window.location.pathname,
        );

        toast.success(
          `OAuth connection successful! Connected to ${serverName}.`,
        );
      } catch (error) {
        toast.error(
          `Error completing OAuth flow: ${error instanceof Error ? error.message : "Unknown error"}`,
        );
      }
    },
    [],
  );

  const isTokenExpired = useCallback(
    (expiresAt?: number, bufferMinutes: number = 5): boolean => {
      if (!expiresAt) return false;
      return Date.now() + bufferMinutes * 60 * 1000 >= expiresAt;
    },
    [],
  );

  const refreshOAuthToken = useCallback(
    async (serverName: string) => {
      const server = appState.servers[serverName];
      if (!server?.oauthState?.refreshToken) {
        throw new Error("No refresh token available");
      }

      try {
        // Create a new OAuth flow manager for discovery
        const oauthFlow = createOAuthFlow(server.oauthState.serverUrl, {
          client_name: server.oauthState.clientName,
          requested_scopes: server.oauthState.scopes,
          redirect_uri: `${window.location.origin}/oauth/callback`,
        });

        // Perform discovery to get the token endpoint
        const discoveryResult = await oauthFlow.initiate();
        if (!discoveryResult.success) {
          throw new Error(
            `Discovery failed: ${discoveryResult.error?.error_description}`,
          );
        }

        const oauthState = oauthFlow.getState();
        const tokenEndpoint =
          oauthState.authorization_server_metadata?.token_endpoint;

        // Use the stored client ID from the original OAuth flow
        const clientId = server.oauthState.clientId;

        if (!tokenEndpoint) {
          throw new Error("Token endpoint not available after discovery");
        }

        if (!clientId) {
          throw new Error("Client ID not available for token refresh");
        }

        // Refresh the token
        const tokenResponse = await fetch(tokenEndpoint, {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            Accept: "application/json",
            "User-Agent": "MCP-Inspector/1.0",
          },
          body: new URLSearchParams({
            grant_type: "refresh_token",
            refresh_token: server.oauthState.refreshToken,
            client_id: clientId,
          }).toString(),
        });

        if (!tokenResponse.ok) {
          const errorData = await tokenResponse.json().catch(() => ({}));
          throw new Error(
            `Token refresh failed: ${errorData.error_description || `HTTP ${tokenResponse.status}`}`,
          );
        }

        const tokens = await tokenResponse.json();

        // Update the server config with new tokens
        const updatedConfig: HttpServerDefinition = {
          url: new URL(server.oauthState.serverUrl),
          requestInit: {
            headers: {
              Authorization: `Bearer ${tokens.access_token}`,
            },
          },
        };

        setAppState((prev) => ({
          ...prev,
          servers: {
            ...prev.servers,
            [serverName]: {
              ...server,
              config: updatedConfig,
              oauthState: {
                ...server.oauthState!,
                accessToken: tokens.access_token,
                refreshToken:
                  tokens.refresh_token || server.oauthState!.refreshToken,
                expiresAt: tokens.expires_in
                  ? Date.now() + tokens.expires_in * 1000
                  : undefined,
              },
            },
          },
        }));

        return tokens.access_token;
      } catch (error) {
        toast.error(
          `Failed to refresh token: ${error instanceof Error ? error.message : "Unknown error"}`,
        );
      }
    },
    [appState.servers],
  );

  const getValidAccessToken = useCallback(
    async (serverName: string): Promise<string | null> => {
      const server = appState.servers[serverName];
      if (!server?.oauthState?.accessToken) {
        return null;
      }

      // Check if token is expired or about to expire
      if (isTokenExpired(server.oauthState.expiresAt)) {
        try {
          return await refreshOAuthToken(serverName);
        } catch (error) {
          console.error(`Failed to refresh token for ${serverName}:`, error);
          return null;
        }
      }

      return server.oauthState.accessToken;
    },
    [appState.servers, isTokenExpired, refreshOAuthToken],
  );

  const handleDisconnect = useCallback(async (serverName: string) => {
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
          },
        },
      }));

      try {
        // Check if OAuth token needs refresh
        if (
          server.oauthState?.accessToken &&
          isTokenExpired(server.oauthState.expiresAt)
        ) {
          try {
            await refreshOAuthToken(serverName);
          } catch (error) {
            console.error(`Failed to refresh token for ${serverName}:`, error);
            // Continue with reconnection attempt even if token refresh fails
          }
        }

        // Get the current server config (may have been updated with new tokens)
        const currentServer = appState.servers[serverName];

        // Test connection using the stateless endpoint
        const response = await fetch("/api/mcp/test-connection", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            serverConfig: currentServer.config,
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

        throw error;
      }
    },
    [appState.servers, isTokenExpired, refreshOAuthToken],
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
    setSelectedServer,
    setSelectedMCPConfigs,
    toggleMultiSelectMode,
    toggleServerSelection,
    refreshOAuthToken,
    getValidAccessToken,
    isTokenExpired,
    setSelectedMultipleServersToAllServers,
  };
}
