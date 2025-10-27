import { useState, useCallback, useEffect, useMemo, useRef } from "react";
import { Button } from "@/components/ui/button";
import { AlertCircle, RefreshCw, Shield, Workflow, ChevronDown, ChevronRight, ArrowDownToLine, ArrowUpFromLine, ExternalLink, CheckCircle2 } from "lucide-react";
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
  OauthFlowStateJune2025,
  EMPTY_OAUTH_FLOW_STATE_V2,
  createDebugOAuthStateMachine,
} from "../lib/debug-oauth-state-machine";
import { DebugMCPOAuthClientProvider } from "../lib/debug-oauth-provider";
import { OAuthSequenceDiagram } from "./OAuthSequenceDiagram";
import { MCPServerConfig } from "@/sdk";
import JsonView from "react18-json-view";
import "react18-json-view/src/style.css";
import "react18-json-view/src/dark.css";

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
  const [oauthFlowState, setOAuthFlowState] = useState<OauthFlowStateJune2025>(
    EMPTY_OAUTH_FLOW_STATE_V2,
  );

  // Track if we've initialized the flow for the current server
  const initializedServerRef = useRef<string | null>(null);

  // Track which HTTP blocks are expanded
  const [expandedBlocks, setExpandedBlocks] = useState<Set<string>>(new Set());

  // Use ref to always have access to the latest state
  const oauthFlowStateRef = useRef(oauthFlowState);
  useEffect(() => {
    oauthFlowStateRef.current = oauthFlowState;
  }, [oauthFlowState]);

  const toggleExpanded = (id: string) => {
    setExpandedBlocks((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const updateAuthSettings = useCallback((updates: Partial<AuthSettings>) => {
    setAuthSettings((prev) => ({ ...prev, ...updates }));
  }, []);

  const updateOAuthFlowState = useCallback(
    (updates: Partial<OauthFlowStateJune2025>) => {
      setOAuthFlowState((prev) => ({ ...prev, ...updates }));
    },
    [],
  );

  const resetOAuthFlow = useCallback(() => {
    console.log("[OAuth Flow] 🔄 Resetting OAuth flow state");
    // Reset the flow state - clear everything
    updateOAuthFlowState({
      ...EMPTY_OAUTH_FLOW_STATE_V2,
      lastRequest: undefined,
      lastResponse: undefined,
      authorizationCode: undefined,
      authorizationUrl: undefined,
      accessToken: undefined,
      refreshToken: undefined,
      codeVerifier: undefined,
      codeChallenge: undefined,
      error: undefined,
    });
    initializedServerRef.current = null;
    setExpandedBlocks(new Set());
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

    // Create provider to get redirect URL
    const provider = new DebugMCPOAuthClientProvider(authSettings.serverUrl);

    return createDebugOAuthStateMachine({
      state: oauthFlowStateRef.current,
      getState: () => oauthFlowStateRef.current,
      updateState: updateOAuthFlowState,
      serverUrl: authSettings.serverUrl,
      serverName,
      redirectUrl: provider.redirectUrl,
    });
  }, [
    serverConfig,
    serverName,
    authSettings.serverUrl,
    updateOAuthFlowState,
  ]);

  const proceedToNextStep = useCallback(async () => {
    if (oauthStateMachine) {
      await oauthStateMachine.proceedToNextStep();
    }
  }, [oauthStateMachine]);

  // Listen for OAuth callback messages from the popup window
  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      console.log("[OAuth Flow] 📨 Message received:", {
        origin: event.origin,
        type: event.data?.type,
        hasCode: !!event.data?.code,
      });

      // Verify origin matches our app
      if (event.origin !== window.location.origin) {
        console.warn("[OAuth Flow] ⚠️ Origin mismatch, ignoring");
        return;
      }

      // Check if this is an OAuth callback message
      if (event.data?.type === "OAUTH_CALLBACK" && event.data?.code) {
        console.log("[OAuth Flow] ✅ Authorization code received:", event.data.code);

        // Update state with the authorization code
        updateOAuthFlowState({
          authorizationCode: event.data.code,
          error: undefined,
        });

        console.log("[OAuth Flow] 🔄 State updated, proceeding to next step in 500ms");

        // Automatically proceed to the next step after a brief delay
        setTimeout(() => {
          if (oauthStateMachine) {
            oauthStateMachine.proceedToNextStep();
          }
        }, 500);
      }
    };

    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, [oauthStateMachine, updateOAuthFlowState]);

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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverName, resetOAuthFlow]);

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
              console.log("[OAuth Flow] 🔄 Reset button clicked - clearing all state");
              if (oauthStateMachine) {
                oauthStateMachine.resetFlow();
              }
              // Also reset the initialized server ref to allow restarting
              initializedServerRef.current = null;
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
        <div className="w-96 border-l border-border bg-muted/30 p-4 overflow-auto">
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

            {/* Authorization URL - Show when ready */}
            {oauthFlowState.currentStep === "authorization_request" && oauthFlowState.authorizationUrl && (
              <div className="rounded-lg border-2 border-blue-500/50 bg-blue-50 dark:bg-blue-950/20 p-4 animate-pulse">
                <h3 className="text-sm font-semibold mb-3 text-blue-700 dark:text-blue-300">
                  🔐 Authorization Required
                </h3>
                <div className="space-y-3">
                  <p className="text-xs text-blue-600 dark:text-blue-400 font-medium">
                    Step 1: Click the button below to authorize in your browser
                  </p>
                  <Button
                    onClick={async () => {
                      window.open(oauthFlowState.authorizationUrl!, "_blank", "noopener,noreferrer");

                      // Automatically move to the next step (waiting for code)
                      setTimeout(() => {
                        proceedToNextStep();
                      }, 500);
                    }}
                    className="w-full"
                    size="sm"
                  >
                    <ExternalLink className="h-4 w-4 mr-2" />
                    Open Authorization URL
                  </Button>
                  <p className="text-xs text-blue-600 dark:text-blue-400">
                    Step 2: After authorizing, the code will be automatically captured and the flow will continue
                  </p>
                  <div className="text-[10px] font-mono bg-muted p-2 rounded break-all text-muted-foreground">
                    {oauthFlowState.authorizationUrl}
                  </div>
                </div>
              </div>
            )}

            {/* Authorization Code Input - Show when waiting for code */}
            {oauthFlowState.currentStep === "received_authorization_code" && (
              <div className="rounded-lg border-2 border-green-500/50 bg-green-50 dark:bg-green-950/20 p-4">
                <h3 className="text-sm font-semibold mb-3 text-green-700 dark:text-green-300">
                  ⏳ Waiting for Authorization Code
                </h3>
                <div className="space-y-3">
                  {!oauthFlowState.authorizationCode ? (
                    <>
                      <div className="flex items-center gap-2 text-xs text-green-600 dark:text-green-400">
                        <div className="h-2 w-2 bg-green-500 rounded-full animate-pulse" />
                        <span>Waiting for authorization code from callback...</span>
                      </div>
                      <p className="text-xs text-muted-foreground">
                        If the code wasn't captured automatically, paste it manually below:
                      </p>
                      <input
                        type="text"
                        value={oauthFlowState.authorizationCode || ""}
                        onChange={(e) => {
                          updateOAuthFlowState({ authorizationCode: e.target.value, error: undefined });
                        }}
                        placeholder="Paste authorization code here"
                        className="w-full px-3 py-2 text-sm border border-input rounded-md bg-background focus:outline-none focus:ring-2 focus:ring-ring"
                      />
                    </>
                  ) : (
                    <>
                      <div className="flex items-center gap-2 text-xs text-green-600 dark:text-green-400 font-medium">
                        <CheckCircle2 className="h-4 w-4" />
                        <span>Authorization code received!</span>
                      </div>
                      <div>
                        <div className="text-xs font-semibold mb-1 text-green-700 dark:text-green-300">Code to exchange:</div>
                        <div className="text-xs font-mono bg-muted p-2 rounded break-all border border-green-500/30">
                          {oauthFlowState.authorizationCode}
                        </div>
                      </div>
                      <p className="text-xs text-muted-foreground">
                        Click "Next Step" to exchange the code for an access token
                      </p>
                    </>
                  )}
                  {oauthFlowState.error && (
                    <div className="mt-3 p-2 rounded-md border border-red-200 bg-red-50 dark:bg-red-950/50 text-red-700 dark:text-red-400">
                      <p className="text-xs">{oauthFlowState.error}</p>
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* Error Display for other steps */}
            {oauthFlowState.error && oauthFlowState.currentStep !== "received_authorization_code" && (
              <div className="rounded-lg border border-red-200 bg-red-50 dark:bg-red-950/50 p-4">
                <h3 className="text-sm font-semibold text-red-700 dark:text-red-400 mb-2">Error</h3>
                <p className="text-xs text-red-600 dark:text-red-500">{oauthFlowState.error}</p>
              </div>
            )}

            {/* HTTP History - Show all request/response pairs */}
            {oauthFlowState.httpHistory && oauthFlowState.httpHistory.length > 0 && (
              <div className="space-y-3">
                <h3 className="text-sm font-semibold px-1">HTTP History</h3>
                {(() => {
                  // Flatten entries into individual messages and reverse
                  const messages: Array<{
                    type: "request" | "response";
                    data: any;
                    id: string;
                  }> = [];

                  oauthFlowState.httpHistory.forEach((entry, entryIndex) => {
                    if (entry.request) {
                      messages.push({
                        type: "request",
                        data: entry.request,
                        id: `request-${entryIndex}`,
                      });
                    }
                    if (entry.response) {
                      messages.push({
                        type: "response",
                        data: entry.response,
                        id: `response-${entryIndex}`,
                      });
                    }
                  });

                  return messages.reverse().map((message) => {
                    const isExpanded = expandedBlocks.has(message.id);

                    if (message.type === "request") {
                      const request = message.data;
                      return (
                        <div key={message.id} className="group border rounded-lg shadow-sm hover:shadow-md transition-all duration-200 overflow-hidden bg-card">
                          <div
                            className="px-3 py-2 flex items-center gap-2 cursor-pointer hover:bg-muted/50 transition-colors"
                            onClick={() => toggleExpanded(message.id)}
                          >
                            <div className="flex-shrink-0">
                              {isExpanded ? (
                                <ChevronDown className="h-3 w-3 text-muted-foreground transition-transform" />
                              ) : (
                                <ChevronRight className="h-3 w-3 text-muted-foreground transition-transform" />
                              )}
                            </div>
                            <div className="flex items-center gap-2 flex-1 min-w-0">
                              <span
                                className="flex items-center justify-center px-1 py-0.5 rounded bg-green-500/10 text-green-600 dark:text-green-400"
                                title="Outgoing"
                              >
                                <ArrowUpFromLine className="h-3 w-3" />
                              </span>
                              <span className="text-xs font-mono text-foreground truncate">
                                {request.method} {request.url}
                              </span>
                            </div>
                          </div>
                          {isExpanded && (
                            <div className="border-t bg-muted/20">
                              <div className="p-3">
                                <div className="max-h-[40vh] overflow-auto rounded-sm bg-background/60 p-2">
                                  <JsonView
                                    src={{
                                      method: request.method,
                                      url: request.url,
                                      headers: request.headers,
                                    }}
                                    dark={true}
                                    theme="atom"
                                    enableClipboard={true}
                                    displaySize={false}
                                    collapseStringsAfterLength={100}
                                    style={{
                                      fontSize: "11px",
                                      fontFamily: "ui-monospace, SFMono-Regular, 'SF Mono', monospace",
                                      backgroundColor: "transparent",
                                      padding: "0",
                                      borderRadius: "0",
                                      border: "none",
                                    }}
                                  />
                                </div>
                              </div>
                            </div>
                          )}
                        </div>
                      );
                    } else {
                      const response = message.data;
                      return (
                        <div key={message.id} className="group border rounded-lg shadow-sm hover:shadow-md transition-all duration-200 overflow-hidden bg-card">
                          <div
                            className="px-3 py-2 flex items-center gap-2 cursor-pointer hover:bg-muted/50 transition-colors"
                            onClick={() => toggleExpanded(message.id)}
                          >
                            <div className="flex-shrink-0">
                              {isExpanded ? (
                                <ChevronDown className="h-3 w-3 text-muted-foreground transition-transform" />
                              ) : (
                                <ChevronRight className="h-3 w-3 text-muted-foreground transition-transform" />
                              )}
                            </div>
                            <div className="flex items-center gap-2 flex-1 min-w-0">
                              <span
                                className="flex items-center justify-center px-1 py-0.5 rounded bg-blue-500/10 text-blue-600 dark:text-blue-400"
                                title="Incoming"
                              >
                                <ArrowDownToLine className="h-3 w-3" />
                              </span>
                              <span className={`text-xs px-1.5 py-0.5 rounded font-mono flex-shrink-0 ${
                                response.status >= 200 && response.status < 300
                                  ? "bg-green-500/10 text-green-600 dark:text-green-400"
                                  : "bg-red-500/10 text-red-600 dark:text-red-400"
                              }`}>
                                {response.status}
                              </span>
                              <span className="text-xs font-mono text-foreground truncate">
                                {response.statusText}
                              </span>
                            </div>
                          </div>
                          {isExpanded && (
                            <div className="border-t bg-muted/20">
                              <div className="p-3">
                                <div className="max-h-[40vh] overflow-auto rounded-sm bg-background/60 p-2">
                                  <JsonView
                                    src={{
                                      status: response.status,
                                      statusText: response.statusText,
                                      headers: response.headers,
                                      body: response.body,
                                    }}
                                    dark={true}
                                    theme="atom"
                                    enableClipboard={true}
                                    displaySize={false}
                                    collapseStringsAfterLength={100}
                                    style={{
                                      fontSize: "11px",
                                      fontFamily: "ui-monospace, SFMono-Regular, 'SF Mono', monospace",
                                      backgroundColor: "transparent",
                                      padding: "0",
                                      borderRadius: "0",
                                      border: "none",
                                    }}
                                  />
                                </div>
                              </div>
                            </div>
                          )}
                        </div>
                      );
                    }
                  });
                })()}
              </div>
            )}

          </div>
        </div>
      </div>
    </div>
  );
};
