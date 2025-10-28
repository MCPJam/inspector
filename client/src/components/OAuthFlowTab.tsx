import { useState, useCallback, useEffect, useMemo, useRef } from "react";
import { Button } from "@/components/ui/button";
import {
  AlertCircle,
  RefreshCw,
  Shield,
  Workflow,
  ChevronDown,
  ChevronRight,
  ArrowDownToLine,
  ArrowUpFromLine,
  ExternalLink,
  CheckCircle2,
  Trash2,
} from "lucide-react";
import { EmptyState } from "./ui/empty-state";
import {
  AuthSettings,
  DEFAULT_AUTH_SETTINGS,
  StatusMessage,
} from "@/shared/types.js";
import { Card, CardContent } from "./ui/card";
import { Alert, AlertDescription, AlertTitle } from "./ui/alert";
import { Input } from "./ui/input";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "./ui/resizable";
import { getStoredTokens } from "../lib/mcp-oauth";
import { ServerWithName } from "../hooks/use-app-state";
import {
  OauthFlowStateJune2025,
  EMPTY_OAUTH_FLOW_STATE_V2,
  createDebugOAuthStateMachine,
} from "../lib/debug-oauth-state-machine";
import { DebugMCPOAuthClientProvider } from "../lib/debug-oauth-provider";
import { OAuthSequenceDiagram } from "./OAuthSequenceDiagram";
import { OAuthAuthorizationModal } from "./OAuthAuthorizationModal";
import {
  OAuthAdvancedConfigModal,
  CustomHeader,
} from "./OAuthAdvancedConfigModal";
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

  // Track if user manually reset (don't auto-restart in this case)
  const manualResetRef = useRef(false);

  // Track which HTTP blocks are expanded
  const [expandedBlocks, setExpandedBlocks] = useState<Set<string>>(new Set());

  // Track which info logs have been deleted
  const [deletedInfoLogs, setDeletedInfoLogs] = useState<Set<string>>(
    new Set(),
  );

  // Track if authorization modal is open
  const [isAuthModalOpen, setIsAuthModalOpen] = useState(false);

  // Track if advanced config modal is open
  const [isAdvancedConfigOpen, setIsAdvancedConfigOpen] = useState(false);

  // Track custom scopes input
  const [customScopes, setCustomScopes] = useState("");

  // Track custom headers
  const [customHeaders, setCustomHeaders] = useState<CustomHeader[]>([]);

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

  const clearInfoLogs = () => {
    // Clear all info logs by marking all as deleted
    const allInfoLogIds = new Set<string>([
      "www-authenticate",
      "authorization-servers",
      "as-metadata",
      "dcr",
      "pkce-generation",
      "auth-url",
      "auth-code",
      "oauth-tokens",
      "token",
    ]);
    setDeletedInfoLogs(allInfoLogIds);
  };

  const clearHttpHistory = () => {
    updateOAuthFlowState({ httpHistory: [] });
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
    processedCodeRef.current = null; // Clear processed code tracker
    if (exchangeTimeoutRef.current) {
      clearTimeout(exchangeTimeoutRef.current); // Clear any pending exchange
      exchangeTimeoutRef.current = null;
    }
    setExpandedBlocks(new Set());
    setDeletedInfoLogs(new Set());
    setCustomScopes(""); // Clear custom scopes
    // Headers will remain from server config (not cleared on reset)
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

      // Pre-populate custom headers from server config (if any)
      if ("url" in serverConfig) {
        if (serverConfig.requestInit?.headers) {
          const headers = serverConfig.requestInit.headers as Record<
            string,
            string
          >;
          const headerEntries = Object.entries(headers)
            .filter(([key]) => key.toLowerCase() !== "authorization") // Exclude auth header
            .map(([key, value]) => ({ key, value }));
          setCustomHeaders(headerEntries);
        } else {
          // No headers configured for this server
          setCustomHeaders([]);
        }
      }
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
      customScopes: customScopes.trim() || undefined,
      customHeaders:
        customHeaders.length > 0
          ? Object.fromEntries(customHeaders.map((h) => [h.key, h.value]))
          : undefined,
    });
  }, [
    serverConfig,
    serverName,
    authSettings.serverUrl,
    updateOAuthFlowState,
    customScopes,
    customHeaders,
  ]);

  const proceedToNextStep = useCallback(async () => {
    if (oauthStateMachine) {
      // Clear manual reset flag when user manually starts the flow
      if (oauthFlowState.currentStep === "idle") {
        manualResetRef.current = false;
      }
      await oauthStateMachine.proceedToNextStep();
    }
  }, [oauthStateMachine, oauthFlowState.currentStep]);

  // Track if we've already processed a code for this flow (prevent duplicates)
  const processedCodeRef = useRef<string | null>(null);
  const exchangeTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  // Listen for OAuth callback messages from the popup window
  useEffect(() => {
    // Helper function to process OAuth callback (shared by both methods)
    const processOAuthCallback = (code: string, state: string | undefined) => {
      // Check if we've already processed this exact code (prevent duplicate exchanges)
      if (processedCodeRef.current === code) {
        return;
      }

      // Validate state parameter to prevent accepting stale authorization codes
      const expectedState = oauthFlowStateRef.current.state;

      // Only accept the code if we're at the right step AND state matches
      const currentStep = oauthFlowStateRef.current.currentStep;
      const isWaitingForCode =
        currentStep === "received_authorization_code" ||
        currentStep === "authorization_request";

      if (!isWaitingForCode) {
        return;
      }

      if (!expectedState) {
        updateOAuthFlowState({
          error:
            "Flow was reset. Please start a new authorization by clicking 'Next Step'.",
        });
        return;
      }

      if (state !== expectedState) {
        updateOAuthFlowState({
          error:
            "Invalid state parameter - this authorization code is from a previous flow. Please try again.",
        });
        return;
      }

      // Mark this code as processed to prevent duplicate exchanges
      processedCodeRef.current = code;

      // Clear any pending exchange timeout
      if (exchangeTimeoutRef.current) {
        clearTimeout(exchangeTimeoutRef.current);
      }

      // Update state with the authorization code
      updateOAuthFlowState({
        authorizationCode: code,
        error: undefined,
      });

      // Automatically proceed to the next step after a brief delay (store timeout ref)
      exchangeTimeoutRef.current = setTimeout(() => {
        if (oauthStateMachine) {
          oauthStateMachine.proceedToNextStep();
        }
        exchangeTimeoutRef.current = null;
      }, 500);
    };

    // Method 1: Listen via window.postMessage (standard approach)
    const handleMessage = (event: MessageEvent) => {
      // Verify origin matches our app
      if (event.origin !== window.location.origin) {
        return;
      }

      // Check if this is an OAuth callback message
      if (event.data?.type === "OAUTH_CALLBACK" && event.data?.code) {
        processOAuthCallback(event.data.code, event.data.state);
      }
    };

    // Method 2: Listen via BroadcastChannel (fallback for COOP-protected OAuth servers)
    let channel: BroadcastChannel | null = null;
    try {
      channel = new BroadcastChannel("oauth_callback_channel");
      channel.onmessage = (event) => {
        if (event.data?.type === "OAUTH_CALLBACK" && event.data?.code) {
          processOAuthCallback(event.data.code, event.data.state);
        }
      };
    } catch (error) {
      // BroadcastChannel not supported in this browser
    }

    window.addEventListener("message", handleMessage);
    return () => {
      window.removeEventListener("message", handleMessage);
      channel?.close();
    };
  }, [oauthStateMachine, updateOAuthFlowState]);

  // Initialize OAuth flow when component mounts or server changes
  useEffect(() => {
    // Only initialize if we haven't already for this server
    if (!serverName || initializedServerRef.current === serverName) {
      return;
    }

    // Reset the initialized ref to allow reinitialization
    initializedServerRef.current = null;

    // Clear custom scopes when switching servers
    // (headers will be auto-populated from new server config)
    setCustomScopes("");

    // Reset using the state machine if available
    if (oauthStateMachine) {
      oauthStateMachine.resetFlow();
    } else {
      resetOAuthFlow();
    }

    // Mark this server as initialized
    initializedServerRef.current = serverName;

    // Only auto-start if this is NOT a manual reset
    if (!manualResetRef.current) {
      // Start the flow automatically (use a longer delay to ensure state machine is ready with new settings)
      const timer = setTimeout(() => {
        if (oauthStateMachine) {
          oauthStateMachine.proceedToNextStep();
        }
      }, 200);

      return () => clearTimeout(timer);
    } else {
      // Clear the manual reset flag for next time
      manualResetRef.current = false;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverName, oauthStateMachine]);

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
                          with OAuth enabled from the Servers tab, or use the
                          Auth tab to configure it.
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
      <div className="px-6 py-4 border-b border-border bg-background">
        <div className="flex items-center justify-between">
          <div>
            <div className="flex items-center gap-2">
              <Workflow className="h-5 w-5" />
              <h3 className="text-lg font-medium">OAuth Authentication Flow</h3>
            </div>
            <p className="text-sm text-muted-foreground">
              {serverEntry?.name || "Unknown Server"} •{" "}
              {isHttpServer && (serverConfig as any).url.toString()}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <p className="text-xs text-muted-foreground pr-4">
              Protocol Revision: 2025-06-18
            </p>
            <Button
              variant="outline"
              onClick={() => setIsAdvancedConfigOpen(true)}
              disabled={oauthFlowState.isInitiatingAuth}
            >
              Advanced
            </Button>
            <Button
              variant="outline"
              onClick={() => {
                // Mark this as a manual reset (don't auto-restart)
                manualResetRef.current = true;

                if (oauthStateMachine) {
                  oauthStateMachine.resetFlow();
                }

                // Reset the initialized server ref to allow manual restart
                initializedServerRef.current = null;

                // Clear processed code tracker and any pending exchanges
                processedCodeRef.current = null;
                if (exchangeTimeoutRef.current) {
                  clearTimeout(exchangeTimeoutRef.current);
                  exchangeTimeoutRef.current = null;
                }
              }}
              disabled={oauthFlowState.isInitiatingAuth}
            >
              Reset
            </Button>
            <Button
              onClick={() => {
                // If we're at authorization step, open the popup
                if (oauthFlowState.currentStep === "authorization_request") {
                  setIsAuthModalOpen(true);
                } else {
                  // Otherwise proceed to next step
                  void proceedToNextStep();
                }
              }}
              disabled={
                oauthFlowState.isInitiatingAuth ||
                oauthFlowState.currentStep === "complete"
              }
              className={`min-w-[180px] ${oauthFlowState.currentStep === "complete" ? "bg-green-600 hover:bg-green-600" : ""}`}
            >
              {oauthFlowState.currentStep === "complete" ? (
                <>
                  <CheckCircle2 className="mr-2 h-4 w-4" />
                  Flow Complete
                </>
              ) : oauthFlowState.isInitiatingAuth ? (
                "Processing..."
              ) : oauthFlowState.currentStep === "authorization_request" ? (
                "Ready to authorize"
              ) : (
                "Next Step"
              )}
            </Button>
          </div>
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
      <div className="flex-1 overflow-hidden flex flex-row">
        {/* ReactFlow Sequence Diagram */}
        <div className="flex-1">
          <OAuthSequenceDiagram flowState={oauthFlowState} />
        </div>

        {/* Side Panel with Details - Split into two resizable sections */}
        <div className="w-96 border-l border-border flex flex-col">
          <ResizablePanelGroup direction="vertical" className="flex-1">
            {/* Top Panel - Info */}
            <ResizablePanel defaultSize={40} minSize={20} maxSize={80}>
              <div className="h-full bg-muted/30 overflow-auto">
                <div className="sticky top-0 z-10 bg-muted/30 backdrop-blur-sm border-b border-border px-4 py-3 flex items-center justify-between">
                  <h3 className="text-sm font-semibold">Info</h3>
                  <button
                    onClick={clearInfoLogs}
                    className="p-1 hover:bg-muted rounded transition-colors"
                    title="Clear all logs"
                  >
                    <Trash2 className="h-4 w-4 text-muted-foreground hover:text-destructive transition-colors" />
                  </button>
                </div>
                <div className="p-4 space-y-3">
                  {/* Error Display */}
                  {oauthFlowState.error && (
                    <Alert variant="destructive" className="py-2">
                      <AlertCircle className="h-4 w-4" />
                      <AlertDescription className="text-xs">
                        {oauthFlowState.error}
                      </AlertDescription>
                    </Alert>
                  )}

                  {/* OAuth Flow Info Logs */}
                  {(() => {
                    // Get logs from state
                    const infoLogs = oauthFlowState.infoLogs || [];

                    return infoLogs
                      .slice()
                      .reverse()
                      .filter((log) => !deletedInfoLogs.has(log.id))
                      .map((log) => {
                        const isExpanded = expandedBlocks.has(log.id);
                        return (
                          <div
                            key={log.id}
                            className="group border rounded-lg shadow-sm hover:shadow-md transition-all duration-200 overflow-hidden bg-card"
                          >
                            <div
                              className="px-3 py-2 flex items-center gap-2 cursor-pointer hover:bg-muted/50 transition-colors"
                              onClick={() => toggleExpanded(log.id)}
                            >
                              <div className="flex-shrink-0">
                                {isExpanded ? (
                                  <ChevronDown className="h-3 w-3 text-muted-foreground transition-transform" />
                                ) : (
                                  <ChevronRight className="h-3 w-3 text-muted-foreground transition-transform" />
                                )}
                              </div>
                              <span className="text-xs font-medium text-foreground">
                                {log.label}
                              </span>
                            </div>
                            {isExpanded && (
                              <div className="border-t bg-muted/20">
                                <div className="p-3">
                                  <div className="max-h-[40vh] overflow-auto rounded-sm bg-background/60 p-2">
                                    <JsonView
                                      src={log.data}
                                      dark={true}
                                      theme="atom"
                                      enableClipboard={true}
                                      displaySize={false}
                                      collapsed={false}
                                      style={{
                                        fontSize: "11px",
                                        fontFamily:
                                          "ui-monospace, SFMono-Regular, 'SF Mono', monospace",
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
                      });
                  })()}

                  {/* Empty state when no logs */}
                  {!oauthFlowState.codeChallenge && (
                    <div className="text-center py-8 text-muted-foreground text-sm">
                      No flow information yet
                    </div>
                  )}
                </div>
              </div>
            </ResizablePanel>

            <ResizableHandle withHandle />

            {/* Bottom Panel - HTTP History */}
            <ResizablePanel defaultSize={60} minSize={20}>
              <div className="h-full bg-muted/30 overflow-auto">
                <div className="sticky top-0 z-10 bg-muted/30 backdrop-blur-sm border-b border-border px-4 py-3 flex items-center justify-between">
                  <h3 className="text-sm font-semibold">HTTP History</h3>
                  <button
                    onClick={clearHttpHistory}
                    className="p-1 hover:bg-muted rounded transition-colors"
                    title="Clear all history"
                  >
                    <Trash2 className="h-4 w-4 text-muted-foreground hover:text-destructive transition-colors" />
                  </button>
                </div>
                <div className="p-4 space-y-3">
                  {oauthFlowState.httpHistory &&
                  oauthFlowState.httpHistory.length > 0 ? (
                    (() => {
                      // Flatten entries into individual messages and reverse
                      const messages: Array<{
                        type: "request" | "response";
                        data: any;
                        id: string;
                      }> = [];

                      oauthFlowState.httpHistory.forEach(
                        (entry, entryIndex) => {
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
                        },
                      );

                      return messages.reverse().map((message) => {
                        const isExpanded = expandedBlocks.has(message.id);

                        if (message.type === "request") {
                          const request = message.data;
                          return (
                            <div
                              key={message.id}
                              className="group border rounded-lg shadow-sm hover:shadow-md transition-all duration-200 overflow-hidden bg-card"
                            >
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
                                          fontFamily:
                                            "ui-monospace, SFMono-Regular, 'SF Mono', monospace",
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
                            <div
                              key={message.id}
                              className="group border rounded-lg shadow-sm hover:shadow-md transition-all duration-200 overflow-hidden bg-card"
                            >
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
                                  <span
                                    className={`text-xs px-1.5 py-0.5 rounded font-mono flex-shrink-0 ${
                                      response.status >= 200 &&
                                      response.status < 300
                                        ? "bg-green-500/10 text-green-600 dark:text-green-400"
                                        : "bg-red-500/10 text-red-600 dark:text-red-400"
                                    }`}
                                  >
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
                                          fontFamily:
                                            "ui-monospace, SFMono-Regular, 'SF Mono', monospace",
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
                    })()
                  ) : (
                    <div className="text-center py-8 text-muted-foreground text-sm">
                      No HTTP requests yet
                    </div>
                  )}
                </div>
              </div>
            </ResizablePanel>
          </ResizablePanelGroup>
        </div>
      </div>

      {/* OAuth Authorization Modal */}
      {oauthFlowState.authorizationUrl && (
        <OAuthAuthorizationModal
          open={isAuthModalOpen}
          onOpenChange={setIsAuthModalOpen}
          authorizationUrl={oauthFlowState.authorizationUrl}
        />
      )}

      {/* Advanced Config Modal */}
      <OAuthAdvancedConfigModal
        open={isAdvancedConfigOpen}
        onOpenChange={setIsAdvancedConfigOpen}
        customScopes={customScopes}
        onCustomScopesChange={setCustomScopes}
        customHeaders={customHeaders}
        onCustomHeadersChange={setCustomHeaders}
      />
    </div>
  );
};
