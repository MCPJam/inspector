import { useState, useCallback, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { AlertCircle, RefreshCw } from "lucide-react";
import { AuthSettings, DEFAULT_AUTH_SETTINGS, StatusMessage } from "../lib/auth-types";
import { SimpleOAuthClient } from "../lib/auth-client";
import { MastraMCPServerDefinition } from "../lib/types";
import { Card, CardContent } from "./ui/card";

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
    <div className={`p-3 rounded-md border ${bgColor} ${borderColor} ${textColor} mb-4`}>
      <div className="flex items-center gap-2">
        <AlertCircle className="h-4 w-4" />
        <p className="text-sm">{message.message}</p>
      </div>
    </div>
  );
};

interface AuthTabProps {
  serverConfig?: MastraMCPServerDefinition;
}

export const AuthTab = ({ serverConfig }: AuthTabProps) => {
  const [authSettings, setAuthSettings] = useState<AuthSettings>(DEFAULT_AUTH_SETTINGS);

  const updateAuthSettings = useCallback((updates: Partial<AuthSettings>) => {
    setAuthSettings((prev) => ({ ...prev, ...updates }));
  }, []);

  // Update auth settings when server config changes
  useEffect(() => {
    if (serverConfig && serverConfig.url) {
      const serverUrl = serverConfig.url.toString();
      // For now, we'll check localStorage for tokens based on server URL
      // In a full implementation, this would be integrated with the server's OAuth tokens
      const client = new SimpleOAuthClient(serverUrl);
      const existingTokens = client.getStoredTokens();
      
      updateAuthSettings({
        serverUrl,
        tokens: existingTokens,
        error: null,
        statusMessage: null,
      });
    } else {
      updateAuthSettings(DEFAULT_AUTH_SETTINGS);
    }
  }, [serverConfig, updateAuthSettings]);

  const handleQuickRefresh = useCallback(async () => {
    if (!serverConfig || !authSettings.serverUrl) {
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
      statusMessage: null 
    });

    try {
      const client = new SimpleOAuthClient(authSettings.serverUrl);
      
      // If no tokens exist, initiate OAuth, otherwise refresh
      const tokens = authSettings.tokens 
        ? await client.quickRefresh()
        : await client.initiateOAuth();

      updateAuthSettings({
        tokens,
        isAuthenticating: false,
        statusMessage: {
          type: "success",
          message: authSettings.tokens 
            ? "Tokens refreshed successfully!" 
            : "OAuth authentication completed!",
        },
      });

      // Clear success message after 3 seconds
      setTimeout(() => {
        updateAuthSettings({ statusMessage: null });
      }, 3000);
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
  }, [serverConfig, authSettings.serverUrl, authSettings.tokens, updateAuthSettings]);

  const handleClearTokens = useCallback(() => {
    if (serverConfig && authSettings.serverUrl) {
      const client = new SimpleOAuthClient(authSettings.serverUrl);
      client.clearTokens();
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
  }, [serverConfig, authSettings.serverUrl, updateAuthSettings]);

  if (!serverConfig) {
    return (
      <Card>
        <CardContent className="pt-6">
          <p className="text-center text-muted-foreground font-medium">
            Please select a server to manage authentication
          </p>
        </CardContent>
      </Card>
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
              <h1 className="text-lg font-semibold text-foreground">Authentication</h1>
            </div>
            <p className="text-sm text-muted-foreground">
              Manage OAuth authentication for the selected server
            </p>
          </div>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-auto px-6 py-6">
          <div className="space-y-6 max-w-2xl">

            {/* Server Info */}
            {serverConfig.url && (
              <div className="rounded-md border p-4 space-y-2">
                <h3 className="text-sm font-medium">Selected Server</h3>
                <div className="text-xs text-muted-foreground">
                  <div>URL: {serverConfig.url.toString()}</div>
                  <div>Type: HTTP Server</div>
                </div>
              </div>
            )}

            {/* OAuth Authentication */}
            <div className="rounded-md border p-6 space-y-6">
              <div className="flex items-center gap-2">
                <RefreshCw className="h-5 w-5" />
                <h3 className="text-lg font-medium">OAuth Authentication</h3>
              </div>
              <p className="text-sm text-muted-foreground mb-2">
                Use OAuth to securely authenticate with the MCP server.
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
                        <p className="text-xs font-medium text-muted-foreground">Access Token:</p>
                        <div className="text-xs font-mono overflow-x-auto">
                          {authSettings.tokens.access_token.substring(0, 40)}...
                        </div>
                      </div>
                      {authSettings.tokens.refresh_token && (
                        <div>
                          <p className="text-xs font-medium text-muted-foreground">Refresh Token:</p>
                          <div className="text-xs font-mono overflow-x-auto">
                            {authSettings.tokens.refresh_token.substring(0, 40)}...
                          </div>
                        </div>
                      )}
                      <div className="flex gap-4 text-xs text-muted-foreground">
                        <span>Type: {authSettings.tokens.token_type}</span>
                        {authSettings.tokens.expires_in && (
                          <span>Expires in: {authSettings.tokens.expires_in}s</span>
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
                    onClick={handleQuickRefresh}
                    disabled={authSettings.isAuthenticating || !serverConfig}
                    className="flex items-center gap-2"
                  >
                    {authSettings.isAuthenticating ? (
                      <>
                        <RefreshCw className="h-4 w-4 animate-spin" />
                        {authSettings.tokens ? "Refreshing..." : "Authenticating..."}
                      </>
                    ) : (
                      <>
                        <RefreshCw className="h-4 w-4" />
                        {authSettings.tokens ? "Quick Refresh" : "Quick OAuth"}
                      </>
                    )}
                  </Button>

                  <Button 
                    variant="outline" 
                    onClick={handleClearTokens} 
                    disabled={!serverConfig || !authSettings.tokens}
                  >
                    Clear Tokens
                  </Button>
                </div>

                <p className="text-xs text-muted-foreground">
                  {!serverConfig
                    ? "Select a server to manage its OAuth authentication."
                    : authSettings.tokens
                      ? "Use Quick Refresh to renew your authentication tokens."
                      : "Use Quick OAuth to authenticate with the server and get tokens."}
                </p>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
