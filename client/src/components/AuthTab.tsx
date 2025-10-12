import { useState, useCallback, useEffect, useMemo } from "react";
import { Button } from "@/components/ui/button";
import { AlertCircle, RefreshCw, Shield } from "lucide-react";
import { EmptyState } from "./ui/empty-state";
import {
  AuthSettings,
  DEFAULT_AUTH_SETTINGS,
  StatusMessage,
} from "@/shared/types.js";
import { Card, CardContent } from "./ui/card";
import {
  initiateOAuth,
  refreshOAuthTokens,
  getStoredTokens,
  clearOAuthData,
  MCPOAuthOptions,
} from "../lib/mcp-oauth";
import { DebugMCPOAuthClientProvider } from "../lib/debug-oauth-provider";
import { ServerWithName } from "../hooks/use-app-state";
import {
  OAuthFlowState,
  EMPTY_OAUTH_FLOW_STATE,
} from "../lib/oauth-flow-types";
import { OAuthFlowProgress } from "./OAuthFlowProgress";
import { OAuthStateMachine } from "../lib/oauth-state-machine";
import { MCPServerConfig } from "@/shared/mcp-client-manager";

interface StatusMessageProps {
  message: StatusMessage;
}

const StatusMessageComponent = ({ message }: StatusMessageProps) => {
  let bgColor: string;
  let textColor: string;
  let borderColor: string;

  switch (message.type) {
    case "error":
      bgColor = "bg-red-50 dark:bg-red-950/50";
      textColor = "text-red-700 dark:text-red-400";
      borderColor = "border-red-200 dark:border-red-800";
      break;
    case "success":
      bgColor = "bg-green-50 dark:bg-green-950/50";
      textColor = "text-green-700 dark:text-green-400";
      borderColor = "border-green-200 dark:border-green-800";
      break;
    case "info":
    default:
      bgColor = "bg-blue-50 dark:bg-blue-950/50";
      textColor = "text-blue-700 dark:text-blue-400";
      borderColor = "border-blue-200 dark:border-blue-800";
      break;
  }

  return (
    <div
      className={`p-3 rounded-md border ${bgColor} ${borderColor} ${textColor} mb-4`}
    >
      <div className="flex items-center gap-2">
        <AlertCircle className="h-4 w-4" />
        <p className="text-sm">{message.message}</p>
      </div>
    </div>
  );
};

interface AuthTabProps {
  serverConfig?: MCPServerConfig;
  serverEntry?: ServerWithName;
  serverName?: string;
}

export const AuthTab = ({
  serverConfig,
  serverEntry,
  serverName,
}: AuthTabProps) => {
  const [authSettings, setAuthSettings] = useState<AuthSettings>(
    DEFAULT_AUTH_SETTINGS,
  );
  const [oauthFlowState, setOAuthFlowState] = useState<OAuthFlowState>(
    EMPTY_OAUTH_FLOW_STATE,
  );
  const [showGuidedFlow, setShowGuidedFlow] = useState(false);

  const updateAuthSettings = useCallback((updates: Partial<AuthSettings>) => {
    setAuthSettings((prev) => ({ ...prev, ...updates }));
  }, []);

  const updateOAuthFlowState = useCallback(
    (updates: Partial<OAuthFlowState>) => {
      setOAuthFlowState((prev) => ({ ...prev, ...updates }));
    },
    [],
  );

  const resetOAuthFlow = useCallback(() => {
    // Reset the guided flow state
    setShowGuidedFlow(false);
    updateOAuthFlowState(EMPTY_OAUTH_FLOW_STATE);

    // Clear any debug OAuth artifacts to avoid stale client info/scope
    if (authSettings.serverUrl) {
      try {
        const provider = new DebugMCPOAuthClientProvider(
          authSettings.serverUrl,
        );
        provider.clear();
      } catch (e) {
        console.warn("Failed to clear debug OAuth provider state:", e);
      }
    }
  }, [authSettings.serverUrl, updateOAuthFlowState]);

  // Update auth settings when server config changes
  useEffect(() => {
    if (serverConfig && serverConfig.url && serverName) {
      const serverUrl = serverConfig.url.toString();

      // Check for existing tokens using the real OAuth system
      const existingTokens = getStoredTokens(serverName);

      updateAuthSettings({
        serverUrl,
        tokens: existingTokens,
        error: null,
        statusMessage: null,
      });
    } else {
      updateAuthSettings(DEFAULT_AUTH_SETTINGS);
    }
  }, [serverConfig, serverName, updateAuthSettings]);

  // Reset OAuth flow when component mounts or server changes
  useEffect(() => {
    // Reset the guided flow state when switching tabs or servers
    resetOAuthFlow();
  }, [serverName, resetOAuthFlow]);

  const handleQuickRefresh = useCallback(async () => {
    if (!serverConfig || !authSettings.serverUrl || !serverName) {
      updateAuthSettings({
        statusMessage: {
          type: "error",
          message: "Please select a server before refreshing tokens",
        },
      });
      return;
    }

    updateAuthSettings({
      isAuthenticating: true,
      error: null,
      statusMessage: null,
    });

    try {
      let result;

      if (authSettings.tokens) {
        // If tokens exist, try to refresh them
        result = await refreshOAuthTokens(serverName);
      } else {
        // If no tokens exist, initiate new OAuth flow
        const oauthOptions: MCPOAuthOptions = {
          serverName: serverName,
          serverUrl: authSettings.serverUrl,
        };
        result = await initiateOAuth(oauthOptions);
      }

      if (result.success) {
        // Check for updated tokens
        const updatedTokens = getStoredTokens(serverName);

        updateAuthSettings({
          tokens: updatedTokens,
          isAuthenticating: false,
          statusMessage: {
            type: "success",
            message: authSettings.tokens
              ? "Tokens refreshed successfully!"
              : result.serverConfig
                ? "OAuth authentication completed!"
                : "OAuth flow initiated. You will be redirected to authorize access.",
          },
        });

        // If redirect is needed, the browser will redirect automatically
        // Clear success message after 3 seconds
        setTimeout(() => {
          updateAuthSettings({ statusMessage: null });
        }, 3000);
      } else {
        updateAuthSettings({
          isAuthenticating: false,
          error: result.error || "OAuth operation failed",
          statusMessage: {
            type: "error",
            message: `Failed: ${result.error || "OAuth operation failed"}`,
          },
        });
      }
    } catch (error) {
      updateAuthSettings({
        isAuthenticating: false,
        error: error instanceof Error ? error.message : String(error),
        statusMessage: {
          type: "error",
          message: `Failed: ${error instanceof Error ? error.message : String(error)}`,
        },
      });
    }
  }, [
    serverConfig,
    authSettings.serverUrl,
    authSettings.tokens,
    serverName,
    updateAuthSettings,
  ]);

  const handleNewOAuth = useCallback(async () => {
    if (!serverConfig || !authSettings.serverUrl || !serverName) {
      updateAuthSettings({
        statusMessage: {
          type: "error",
          message: "Please select a server before starting OAuth",
        },
      });
      return;
    }

    updateAuthSettings({
      isAuthenticating: true,
      error: null,
      statusMessage: null,
    });

    try {
      // Clear existing tokens first to force a fresh OAuth flow
      clearOAuthData(serverName);

      // Always initiate new OAuth flow (fresh start)
      const oauthOptions: MCPOAuthOptions = {
        serverName: serverName,
        serverUrl: authSettings.serverUrl,
      };
      const result = await initiateOAuth(oauthOptions);

      if (result.success) {
        // Check for updated tokens
        const updatedTokens = getStoredTokens(serverName);

        updateAuthSettings({
          tokens: updatedTokens,
          isAuthenticating: false,
          statusMessage: {
            type: "success",
            message: result.serverConfig
              ? "OAuth authentication completed!"
              : "OAuth flow initiated. You will be redirected to authorize access.",
          },
        });

        // Clear success message after 3 seconds
        setTimeout(() => {
          updateAuthSettings({ statusMessage: null });
        }, 3000);
      } else {
        updateAuthSettings({
          isAuthenticating: false,
          error: result.error || "OAuth authentication failed",
          statusMessage: {
            type: "error",
            message: `Failed: ${result.error || "OAuth authentication failed"}`,
          },
        });
      }
    } catch (error) {
      updateAuthSettings({
        isAuthenticating: false,
        error: error instanceof Error ? error.message : String(error),
        statusMessage: {
          type: "error",
          message: `Failed: ${error instanceof Error ? error.message : String(error)}`,
        },
      });
    }
  }, [serverConfig, authSettings.serverUrl, serverName, updateAuthSettings]);

  // Initialize OAuth state machine
  const oauthStateMachine = useMemo(() => {
    if (!serverConfig || !serverName || !authSettings.serverUrl) return null;

    const provider = new DebugMCPOAuthClientProvider(authSettings.serverUrl);
    return new OAuthStateMachine({
      state: oauthFlowState,
      serverUrl: authSettings.serverUrl,
      serverName,
      provider,
      updateState: updateOAuthFlowState,
    });
  }, [
    serverConfig,
    serverName,
    authSettings.serverUrl,
    oauthFlowState,
    updateOAuthFlowState,
  ]);

  const startGuidedFlow = useCallback(() => {
    // First reset any existing flow state
    resetOAuthFlow();

    // Then start the new guided flow
    setShowGuidedFlow(true);
    updateOAuthFlowState(EMPTY_OAUTH_FLOW_STATE);
    if (oauthStateMachine) {
      oauthStateMachine.proceedToNextStep();
    }
  }, [
    oauthStateMachine,
    updateOAuthFlowState,
    authSettings.serverUrl,
    serverName,
    serverConfig,
    resetOAuthFlow,
  ]);

  const proceedToNextStep = useCallback(async () => {
    if (oauthStateMachine) {
      await oauthStateMachine.proceedToNextStep();
    }
  }, [oauthStateMachine]);

  const exitGuidedFlow = useCallback(() => {
    setShowGuidedFlow(false);
    updateOAuthFlowState(EMPTY_OAUTH_FLOW_STATE);
    // Refresh tokens after guided flow completion
    if (serverName) {
      const updatedTokens = getStoredTokens(serverName);
      updateAuthSettings({ tokens: updatedTokens });
    }
  }, [serverName, updateAuthSettings, updateOAuthFlowState]);

  const handleClearTokens = useCallback(() => {
    if (serverConfig && authSettings.serverUrl && serverName) {
      // Use the real OAuth system to clear tokens
      clearOAuthData(serverName);

      updateAuthSettings({
        tokens: null,
        error: null,
        statusMessage: {
          type: "success",
          message: "OAuth tokens cleared successfully",
        },
      });

      // Clear success message after 3 seconds
      setTimeout(() => {
        updateAuthSettings({ statusMessage: null });
      }, 3000);
    }
  }, [serverConfig, authSettings.serverUrl, serverName, updateAuthSettings]);

  // Check if server supports OAuth
  // Only HTTP servers support OAuth (STDIO servers use process-based auth)
  const isHttpServer = serverConfig && "url" in serverConfig;
  const supportsOAuth = isHttpServer;

  // Check if OAuth is currently configured/in-use
  const hasOAuthConfigured =
    serverName &&
    (serverEntry?.oauthTokens ||
      getStoredTokens(serverName) ||
      serverEntry?.connectionStatus === "oauth-flow");

  const contributionBanner = (
    <div className="rounded-md border border-dashed border-primary/30 bg-primary/10 px-3 py-2 text-xs text-primary space-y-1">
      <div>
        <span className="font-medium">Help us improve this feature!</span>{" "}
        We&apos;re looking for contributors to polish up this feature.
      </div>
      <a
        href="https://discord.com/invite/JEnDtz8X6z"
        target="_blank"
        rel="noreferrer"
        className="inline-flex items-center gap-1 text-xs font-medium text-primary underline hover:text-primary/80"
      >
        Join our Discord
      </a>
    </div>
  );

  if (!serverConfig) {
    return (
      <EmptyState
        icon={Shield}
        title="No Server Selected"
        description="Connect to an MCP server to manage authentication and OAuth settings."
      />
    );
  }

  if (!supportsOAuth) {
    return (
      <div className="h-[calc(100vh-120px)] flex flex-col">
        <div className="h-full flex flex-col bg-background">
          {/* Header */}
          <div className="flex items-center justify-between px-6 py-5 border-b border-border bg-background">
            <div className="space-y-2">
              <div className="flex items-center gap-3">
                <RefreshCw className="h-4 w-4 text-muted-foreground" />
                <h1 className="text-lg font-semibold text-foreground">
                  Authentication
                </h1>
              </div>
              <p className="text-sm text-muted-foreground">
                Manage OAuth authentication for the selected server
              </p>
            </div>
          </div>

          {/* Content */}
          <div className="flex-1 overflow-auto px-6 py-6">
            <div className="space-y-6 max-w-2xl">
              {contributionBanner}
              {/* Server Info */}
              <div className="rounded-md border p-4 space-y-2">
                <h3 className="text-sm font-medium">Selected Server</h3>
                <div className="text-xs text-muted-foreground">
                  <div>Name: {serverEntry?.name || "Unknown"}</div>
                  {isHttpServer && (
                    <div>URL: {(serverConfig as any).url.toString()}</div>
                  )}
                  {!isHttpServer && (
                    <div>Command: {(serverConfig as any).command}</div>
                  )}
                  <div>
                    Type: {isHttpServer ? "HTTP Server" : "STDIO Server"}
                  </div>
                </div>
              </div>

              {/* No OAuth Support Message */}
              <Card>
                <CardContent className="pt-6">
                  <div className="text-center space-y-4">
                    <div className="mx-auto w-12 h-12 bg-muted rounded-full flex items-center justify-center">
                      <RefreshCw className="h-6 w-6 text-muted-foreground" />
                    </div>
                    <div className="space-y-2">
                      <h3 className="text-lg font-medium">
                        {!isHttpServer
                          ? "No OAuth Support"
                          : "No Authentication Required"}
                      </h3>
                      <p className="text-sm text-muted-foreground max-w-md mx-auto">
                        {!isHttpServer
                          ? "STDIO servers don't support OAuth authentication."
                          : `The HTTP server "${serverEntry?.name || "Unknown"}" is connected without OAuth authentication.`}
                      </p>
                      {isHttpServer && (
                        <p className="text-xs text-muted-foreground max-w-md mx-auto mt-2">
                          If this server supports OAuth, you can reconnect it
                          with OAuth enabled from the Servers tab.
                        </p>
                      )}
                    </div>
                  </div>
                </CardContent>
              </Card>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="h-[calc(100vh-120px)] flex flex-col">
      <div className="h-full flex flex-col bg-background">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-5 border-b border-border bg-background">
          <div className="space-y-2">
            <div className="flex items-center gap-3">
              <RefreshCw className="h-4 w-4 text-muted-foreground" />
              <h1 className="text-lg font-semibold text-foreground">
                Authentication
              </h1>
            </div>
            <p className="text-sm text-muted-foreground">
              Manage OAuth authentication for the selected server
            </p>
          </div>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-auto px-6 py-6">
          <div className="space-y-6 max-w-2xl">
            {contributionBanner}
            {/* Server Info */}
            <div className="rounded-md border p-4 space-y-2">
              <h3 className="text-sm font-medium">Selected Server</h3>
              <div className="text-xs text-muted-foreground">
                <div>Name: {serverEntry?.name || "Unknown"}</div>
                {isHttpServer && (
                  <div>URL: {(serverConfig as any).url.toString()}</div>
                )}
                <div>Type: HTTP Server</div>
              </div>
            </div>

            {/* OAuth Authentication */}
            <div className="rounded-md border p-6 space-y-6">
              <div className="flex items-center gap-2">
                <RefreshCw className="h-5 w-5" />
                <h3 className="text-lg font-medium">OAuth Authentication</h3>
              </div>
              <p className="text-sm text-muted-foreground mb-2">
                {hasOAuthConfigured
                  ? "Manage OAuth authentication for this server."
                  : "This server supports OAuth authentication. Use Quick OAuth to authenticate and get tokens."}
              </p>

              {authSettings.statusMessage && (
                <StatusMessageComponent message={authSettings.statusMessage} />
              )}

              {authSettings.error && !authSettings.statusMessage && (
                <div className="p-3 rounded-md border border-red-200 bg-red-50 text-red-700 mb-4">
                  <div className="flex items-center gap-2">
                    <AlertCircle className="h-4 w-4" />
                    <p className="text-sm">{authSettings.error}</p>
                  </div>
                </div>
              )}

              <div className="space-y-4">
                {authSettings.tokens && (
                  <div className="space-y-2">
                    <p className="text-sm font-medium">Current Tokens:</p>
                    <div className="bg-muted p-3 rounded-md space-y-2">
                      <div>
                        <p className="text-xs font-medium text-muted-foreground">
                          Access Token:
                        </p>
                        <div className="text-xs font-mono overflow-x-auto">
                          {authSettings.tokens.access_token.substring(0, 40)}...
                        </div>
                      </div>
                      {authSettings.tokens.refresh_token && (
                        <div>
                          <p className="text-xs font-medium text-muted-foreground">
                            Refresh Token:
                          </p>
                          <div className="text-xs font-mono overflow-x-auto">
                            {authSettings.tokens.refresh_token.substring(0, 40)}
                            ...
                          </div>
                        </div>
                      )}
                      <div className="flex gap-4 text-xs text-muted-foreground">
                        <span>Type: {authSettings.tokens.token_type}</span>
                        {authSettings.tokens.expires_in && (
                          <span>
                            Expires in: {authSettings.tokens.expires_in}s
                          </span>
                        )}
                        {authSettings.tokens.scope && (
                          <span>Scope: {authSettings.tokens.scope}</span>
                        )}
                      </div>
                    </div>
                  </div>
                )}

                <div className="flex gap-4">
                  <Button
                    onClick={
                      authSettings.tokens ? handleQuickRefresh : handleNewOAuth
                    }
                    disabled={authSettings.isAuthenticating || !serverConfig}
                    className="flex items-center gap-2"
                    variant={authSettings.tokens ? "outline" : "default"}
                  >
                    {authSettings.isAuthenticating ? (
                      <>
                        <RefreshCw className="h-4 w-4 animate-spin" />
                        {authSettings.tokens
                          ? "Refreshing..."
                          : "Authenticating..."}
                      </>
                    ) : (
                      <>
                        <RefreshCw className="h-4 w-4" />
                        {authSettings.tokens ? "Quick Refresh" : "Quick OAuth"}
                      </>
                    )}
                  </Button>

                  {authSettings.tokens && (
                    <Button
                      onClick={handleNewOAuth}
                      disabled={authSettings.isAuthenticating || !serverConfig}
                      className="flex items-center gap-2"
                      variant="default"
                    >
                      {authSettings.isAuthenticating ? (
                        <>
                          <RefreshCw className="h-4 w-4 animate-spin" />
                          Authenticating...
                        </>
                      ) : (
                        <>
                          <RefreshCw className="h-4 w-4" />
                          Quick OAuth
                        </>
                      )}
                    </Button>
                  )}

                  <Button
                    variant="outline"
                    onClick={handleClearTokens}
                    disabled={!serverConfig || !authSettings.tokens}
                  >
                    Clear Tokens
                  </Button>

                  <Button
                    variant="secondary"
                    onClick={startGuidedFlow}
                    disabled={authSettings.isAuthenticating || !serverConfig}
                  >
                    Guided OAuth Flow
                  </Button>
                </div>

                <p className="text-xs text-muted-foreground">
                  {!serverConfig
                    ? "Select a server to manage its OAuth authentication."
                    : authSettings.tokens
                      ? "Use Quick Refresh to renew existing tokens, or Quick OAuth to start a fresh authentication flow."
                      : "Use Quick OAuth to authenticate with the server and get tokens."}
                </p>
              </div>

              {/* OAuth Flow Progress */}
              {showGuidedFlow && authSettings.serverUrl && (
                <OAuthFlowProgress
                  serverUrl={authSettings.serverUrl}
                  flowState={oauthFlowState}
                  updateFlowState={updateOAuthFlowState}
                  proceedToNextStep={proceedToNextStep}
                />
              )}

              {/* Exit Guided Flow Button */}
              {showGuidedFlow && (
                <div className="mt-4">
                  <Button variant="outline" onClick={exitGuidedFlow}>
                    Exit Guided Flow
                  </Button>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
