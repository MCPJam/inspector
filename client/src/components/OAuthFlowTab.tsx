import { useState, useCallback, useEffect, useMemo, useRef } from "react";
import { Button } from "@/components/ui/button";
import { AlertCircle, RefreshCw, Shield, Workflow } from "lucide-react";
import { EmptyState } from "./ui/empty-state";
import {
  AuthSettings,
  DEFAULT_AUTH_SETTINGS,
  StatusMessage,
} from "@/shared/types.js";
import { Card, CardContent } from "./ui/card";
import { getStoredTokens } from "../lib/mcp-oauth";
import { DebugMCPOAuthClientProvider } from "../lib/debug-oauth-provider";
import { ServerWithName } from "../hooks/use-app-state";
import {
  OAuthFlowState,
  EMPTY_OAUTH_FLOW_STATE,
} from "../lib/oauth-flow-types";
import { OAuthFlowProgress } from "./OAuthFlowProgress";
import { OAuthStateMachine } from "../lib/oauth-state-machine";
import { MCPServerConfig } from "@/sdk";

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

interface OAuthFlowTabProps {
  serverConfig?: MCPServerConfig;
  serverEntry?: ServerWithName;
  serverName?: string;
}

export const OAuthFlowTab = ({
  serverConfig,
  serverEntry,
  serverName,
}: OAuthFlowTabProps) => {
  const [authSettings, setAuthSettings] = useState<AuthSettings>(
    DEFAULT_AUTH_SETTINGS,
  );
  const [oauthFlowState, setOAuthFlowState] = useState<OAuthFlowState>(
    EMPTY_OAUTH_FLOW_STATE,
  );
  const [flowGuard, setFlowGuard] = useState<{
    canProceed: boolean;
    reason?: string;
  }>({ canProceed: false, reason: undefined });

  // Track if we've initialized the flow for the current server
  const initializedServerRef = useRef<string | null>(null);

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
    // Reset the flow state
    updateOAuthFlowState(EMPTY_OAUTH_FLOW_STATE);
    setFlowGuard({ canProceed: false, reason: undefined });
    initializedServerRef.current = null;

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

  const proceedToNextStep = useCallback(async () => {
    if (oauthStateMachine) {
      await oauthStateMachine.proceedToNextStep();
    }
  }, [oauthStateMachine]);

  // Initialize OAuth flow when component mounts or server changes
  useEffect(() => {
    // Only initialize if we haven't already for this server
    if (!serverName || initializedServerRef.current === serverName) {
      return;
    }

    // Reset and start the flow when switching to a new server
    resetOAuthFlow();
    initializedServerRef.current = serverName;

    // Start the flow automatically (use a slight delay to ensure state machine is ready)
    const timer = setTimeout(() => {
      if (oauthStateMachine) {
        oauthStateMachine.proceedToNextStep();
      }
    }, 100);

    return () => clearTimeout(timer);
  }, [serverName, resetOAuthFlow, oauthStateMachine]);

  // Check if server supports OAuth
  // Only HTTP servers support OAuth (STDIO servers use process-based auth)
  const isHttpServer = serverConfig && "url" in serverConfig;
  const supportsOAuth = isHttpServer;

  if (!serverConfig) {
    return (
      <EmptyState
        icon={Workflow}
        title="No Server Selected"
        description="Connect to an MCP server to visualize the OAuth authentication flow."
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
                <Workflow className="h-4 w-4 text-muted-foreground" />
                <h1 className="text-lg font-semibold text-foreground">
                  OAuth Flow Visualization
                </h1>
              </div>
              <p className="text-sm text-muted-foreground">
                Interactive sequence diagram of OAuth authentication process
              </p>
            </div>
          </div>

          {/* Content */}
          <div className="flex-1 overflow-auto px-6 py-6">
            <div className="space-y-6 max-w-2xl">
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
                      <Workflow className="h-6 w-6 text-muted-foreground" />
                    </div>
                    <div className="space-y-2">
                      <h3 className="text-lg font-medium">
                        No OAuth Flow Available
                      </h3>
                      <p className="text-sm text-muted-foreground max-w-md mx-auto">
                        {!isHttpServer
                          ? "STDIO servers don't support OAuth authentication. The flow visualization is only available for HTTP servers."
                          : "This server is not configured for OAuth authentication."}
                      </p>
                      {isHttpServer && (
                        <p className="text-xs text-muted-foreground max-w-md mx-auto mt-2">
                          If this server supports OAuth, you can reconnect it
                          with OAuth enabled from the Servers tab, or use the Auth tab to configure it.
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
    <div className="h-[calc(100vh-120px)] flex flex-col bg-background">
      {/* Header */}
      <div className="flex items-center justify-between px-6 py-4 border-b border-border bg-background">
        <div>
          <div className="flex items-center gap-2">
            <Workflow className="h-5 w-5" />
            <h3 className="text-lg font-medium">OAuth Authentication Flow</h3>
          </div>
          <p className="text-sm text-muted-foreground">
            {serverEntry?.name || "Unknown Server"} • {isHttpServer && (serverConfig as any).url.toString()}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            onClick={() => {
              void proceedToNextStep();
            }}
            disabled={
              oauthFlowState.isInitiatingAuth || !flowGuard.canProceed
            }
          >
            {oauthFlowState.isInitiatingAuth ? "Processing..." : "Continue"}
          </Button>
        </div>
      </div>

      {/* Status Messages */}
      {(!oauthFlowState.isInitiatingAuth &&
        !flowGuard.canProceed &&
        flowGuard.reason) ||
      authSettings.statusMessage ||
      authSettings.error ? (
        <div className="px-6 py-3 border-b border-border bg-background space-y-2">
          {!oauthFlowState.isInitiatingAuth &&
            !flowGuard.canProceed &&
            flowGuard.reason && (
              <p className="text-xs text-muted-foreground">
                {flowGuard.reason}
              </p>
            )}

          {authSettings.statusMessage && (
            <StatusMessageComponent message={authSettings.statusMessage} />
          )}

          {authSettings.error && !authSettings.statusMessage && (
            <div className="p-3 rounded-md border border-red-200 bg-red-50 text-red-700">
              <div className="flex items-center gap-2">
                <AlertCircle className="h-4 w-4" />
                <p className="text-sm">{authSettings.error}</p>
              </div>
            </div>
          )}
        </div>
      ) : null}

      {/* Flow Visualization - Takes up all remaining space */}
      <div className="flex-1 overflow-hidden">
        <OAuthFlowProgress
          flowState={oauthFlowState}
          updateFlowState={updateOAuthFlowState}
          onGuardStateChange={setFlowGuard}
        />
      </div>
    </div>
  );
};
