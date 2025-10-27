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
import { ServerWithName } from "../hooks/use-app-state";
import {
  OauthFlowStateNovember2025,
  EMPTY_OAUTH_FLOW_STATE_V2,
  createDebugOAuthStateMachine,
} from "../lib/debug-oauth-state-machine";
import { OAuthSequenceDiagram } from "./OAuthSequenceDiagram";
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
  const [oauthFlowState, setOAuthFlowState] = useState<OauthFlowStateNovember2025>(
    EMPTY_OAUTH_FLOW_STATE_V2,
  );

  // Track if we've initialized the flow for the current server
  const initializedServerRef = useRef<string | null>(null);

  const updateAuthSettings = useCallback((updates: Partial<AuthSettings>) => {
    setAuthSettings((prev) => ({ ...prev, ...updates }));
  }, []);

  const updateOAuthFlowState = useCallback(
    (updates: Partial<OauthFlowStateNovember2025>) => {
      setOAuthFlowState((prev) => ({ ...prev, ...updates }));
    },
    [],
  );

  const resetOAuthFlow = useCallback(() => {
    // Reset the flow state
    updateOAuthFlowState(EMPTY_OAUTH_FLOW_STATE_V2);
    initializedServerRef.current = null;
  }, [updateOAuthFlowState]);

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

  // Initialize Debug OAuth state machine
  const oauthStateMachine = useMemo(() => {
    if (!serverConfig || !serverName || !authSettings.serverUrl) return null;

    return createDebugOAuthStateMachine({
      state: oauthFlowState,
      updateState: updateOAuthFlowState,
      serverUrl: authSettings.serverUrl,
      serverName,
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
            disabled={oauthFlowState.isInitiatingAuth}
          >
            {oauthFlowState.isInitiatingAuth ? "Processing..." : "Next Step"}
          </Button>
          <Button
            variant="outline"
            onClick={() => {
              oauthStateMachine?.resetFlow();
            }}
            disabled={oauthFlowState.isInitiatingAuth}
          >
            Reset
          </Button>
        </div>
      </div>

      {/* Status Messages */}
      {authSettings.statusMessage || authSettings.error ? (
        <div className="px-6 py-3 border-b border-border bg-background space-y-2">
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
      <div className="flex-1 overflow-hidden flex">
        {/* ReactFlow Sequence Diagram */}
        <div className="flex-1">
          <OAuthSequenceDiagram flowState={oauthFlowState} />
        </div>

        {/* Side Panel with Details */}
        <div className="w-80 border-l border-border bg-muted/30 p-4 overflow-auto">
          <div className="space-y-4">
            {/* Current Step Info */}
            <div className="rounded-lg border border-border bg-card p-4">
              <h3 className="text-sm font-semibold mb-3">Current Step</h3>
              <div className="space-y-2">
                <div className="font-mono text-xs bg-primary/10 px-2 py-1 rounded">
                  {oauthFlowState.currentStep}
                </div>
                <div className={`text-xs px-2 py-1 rounded ${
                  oauthFlowState.isInitiatingAuth
                    ? "bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300"
                    : "bg-green-100 text-green-700 dark:bg-green-950 dark:text-green-300"
                }`}>
                  {oauthFlowState.isInitiatingAuth ? "Processing..." : "Ready"}
                </div>
              </div>
            </div>

            {/* Step Details */}
            <div className="rounded-lg border border-border bg-card p-4">
              <h3 className="text-sm font-semibold mb-3">Details</h3>
              <div className="space-y-3 text-xs">
                {oauthFlowState.currentStep === "idle" && (
                  <div className="text-muted-foreground">
                    Ready to begin OAuth flow. Click "Next Step" to send an unauthenticated request.
                  </div>
                )}

                {oauthFlowState.currentStep === "sent_unauthenticated_request" && (
                  <div className="space-y-2">
                    <div className="text-muted-foreground">
                      Sent unauthenticated request to the server.
                    </div>
                    {oauthFlowState.serverUrl && (
                      <div className="bg-muted p-2 rounded font-mono text-xs">
                        <div className="text-muted-foreground mb-1">Server:</div>
                        <div className="break-all">{oauthFlowState.serverUrl}</div>
                      </div>
                    )}
                  </div>
                )}

                {oauthFlowState.currentStep === "received_401_www_authenticate" && (
                  <div className="space-y-2">
                    <div className="text-muted-foreground">
                      Received 401 response with WWW-Authenticate header.
                    </div>
                    {oauthFlowState.wwwAuthenticateHeader && (
                      <div className="bg-muted p-2 rounded font-mono text-xs space-y-2">
                        <div>
                          <div className="text-muted-foreground mb-1">WWW-Authenticate:</div>
                          <div className="break-all">{oauthFlowState.wwwAuthenticateHeader}</div>
                        </div>
                      </div>
                    )}
                    {oauthFlowState.authorizationServer && (
                      <div className="bg-muted p-2 rounded font-mono text-xs">
                        <div className="text-muted-foreground mb-1">Auth Server:</div>
                        <div className="break-all">{oauthFlowState.authorizationServer}</div>
                      </div>
                    )}
                  </div>
                )}

                {oauthFlowState.error && (
                  <div className="bg-red-50 dark:bg-red-950/50 border border-red-200 dark:border-red-800 p-2 rounded">
                    <div className="text-xs font-medium text-red-700 dark:text-red-400">
                      Error: {oauthFlowState.error}
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
