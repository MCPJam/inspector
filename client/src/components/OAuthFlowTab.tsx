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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./ui/select";
import { getStoredTokens } from "../lib/mcp-oauth";
import { ServerWithName } from "../hooks/use-app-state";
import {
  OauthFlowStateJune2025,
  EMPTY_OAUTH_FLOW_STATE_V2,
  OAuthProtocolVersion,
} from "../lib/debug-oauth-state-machine";
import {
  createOAuthStateMachine,
  getDefaultRegistrationStrategy,
  getSupportedRegistrationStrategies,
} from "../lib/oauth/state-machines/factory";
import { DebugMCPOAuthClientProvider } from "../lib/debug-oauth-provider";
import { OAuthSequenceDiagram } from "./OAuthSequenceDiagram";
import { OAuthAuthorizationModal } from "./OAuthAuthorizationModal";
import { ProtocolVersionBadge } from "./oauth/ProtocolVersionSelector";
import { ServerModal } from "./connection/ServerModal";
import { ServerFormData } from "@/shared/types";
import { MCPServerConfig } from "@/sdk";
import JsonView from "react18-json-view";
import "react18-json-view/src/style.css";
import "react18-json-view/src/dark.css";
import { HTTPHistoryEntry } from "./HTTPHistoryEntry";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "./ui/resizable";

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
  onUpdate?: (originalServerName: string, formData: ServerFormData) => void;
}

export const OAuthFlowTab = ({
  serverConfig,
  serverEntry,
  serverName,
  onUpdate,
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

  // Track if server edit modal is open
  const [isEditingServer, setIsEditingServer] = useState(false);

  // Track custom scopes input
  const [customScopes, setCustomScopes] = useState("");

  // Track protocol version (load from localStorage or default to latest)
  const [protocolVersion, setProtocolVersion] = useState<OAuthProtocolVersion>(
    () => {
      try {
        const saved = localStorage.getItem("mcp-oauth-flow-preferences");
        if (saved) {
          const parsed = JSON.parse(saved);
          return parsed.protocolVersion || "2025-11-25";
        }
      } catch (e) {
        console.error("Failed to load OAuth flow preferences:", e);
      }
      return "2025-11-25";
    },
  );

  // Track client registration strategy (load from localStorage or default)
  const [registrationStrategy, setRegistrationStrategy] = useState<string>(
    () => {
      try {
        const saved = localStorage.getItem("mcp-oauth-flow-preferences");
        if (saved) {
          const parsed = JSON.parse(saved);
          // If we have a saved strategy, validate it's supported for the protocol
          if (parsed.registrationStrategy && parsed.protocolVersion) {
            const supportedStrategies = getSupportedRegistrationStrategies(
              parsed.protocolVersion,
            );
            if (supportedStrategies.includes(parsed.registrationStrategy)) {
              return parsed.registrationStrategy;
            }
          }
        }
      } catch (e) {
        console.error("Failed to load OAuth flow preferences:", e);
      }
      return getDefaultRegistrationStrategy("2025-11-25");
    },
  );

  // Use ref to always have access to the latest state
  const oauthFlowStateRef = useRef(oauthFlowState);
  useEffect(() => {
    oauthFlowStateRef.current = oauthFlowState;
  }, [oauthFlowState]);

  // Save protocol version and registration strategy to localStorage whenever they change
  useEffect(() => {
    try {
      const preferences = {
        protocolVersion,
        registrationStrategy,
      };
      localStorage.setItem(
        "mcp-oauth-flow-preferences",
        JSON.stringify(preferences),
      );
    } catch (e) {
      console.error("Failed to save OAuth flow preferences:", e);
    }
  }, [protocolVersion, registrationStrategy]);

  const toggleExpanded = (id: string) => {
    setExpandedBlocks((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const clearInfoLogs = () => {
    // Clear all info logs from state
    updateOAuthFlowState({ infoLogs: [] });
    setDeletedInfoLogs(new Set()); // Also clear the deleted set
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

      // Load OAuth scopes from server config or stored tokens
      // Priority: stored tokens > server config
      let scopes = "";

      // Try to get scopes from stored tokens (space-separated string)
      if (existingTokens?.scope) {
        scopes = existingTokens.scope;
      }
      // Fall back to server config (array of strings)
      else if (
        (serverConfig as any).oauthScopes &&
        Array.isArray((serverConfig as any).oauthScopes)
      ) {
        scopes = (serverConfig as any).oauthScopes.join(" ");
      }
      // Try localStorage OAuth config as last resort
      else {
        try {
          const storedOAuthConfig = localStorage.getItem(
            `mcp-oauth-config-${serverName}`,
          );
          if (storedOAuthConfig) {
            const parsed = JSON.parse(storedOAuthConfig);
            if (parsed.scopes && Array.isArray(parsed.scopes)) {
              scopes = parsed.scopes.join(" ");
            }
          }
        } catch (e) {
          console.error("Failed to load OAuth scopes from localStorage:", e);
        }
      }

      // Set custom scopes if we found any
      if (scopes && customScopes !== scopes) {
        setCustomScopes(scopes);
      }
    } else {
      updateAuthSettings(DEFAULT_AUTH_SETTINGS);
    }
  }, [serverConfig, serverName, updateAuthSettings, customScopes]);

  // Initialize Debug OAuth state machine with protocol version support
  const oauthStateMachine = useMemo(() => {
    if (!serverConfig || !serverName || !authSettings.serverUrl) return null;

    // Create provider to get redirect URL
    const provider = new DebugMCPOAuthClientProvider(authSettings.serverUrl);

    // Extract custom headers from server config (if HTTP server)
    let customHeaders: Record<string, string> | undefined;
    if ("url" in serverConfig && serverConfig.requestInit?.headers) {
      const headers = serverConfig.requestInit.headers as Record<
        string,
        string
      >;
      // Filter out Authorization header - OAuth flow will add its own
      customHeaders = Object.fromEntries(
        Object.entries(headers).filter(
          ([key]) => key.toLowerCase() !== "authorization",
        ),
      );
    }

    return createOAuthStateMachine({
      protocolVersion,
      state: oauthFlowStateRef.current,
      getState: () => oauthFlowStateRef.current,
      updateState: updateOAuthFlowState,
      serverUrl: authSettings.serverUrl,
      serverName,
      redirectUrl: provider.redirectUrl,
      customScopes: customScopes.trim() || undefined,
      customHeaders,
      registrationStrategy,
    });
  }, [
    protocolVersion,
    serverConfig,
    serverName,
    authSettings.serverUrl,
    updateOAuthFlowState,
    customScopes,
    registrationStrategy,
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
              <h3 className="text-lg font-medium">OAuth Flow</h3>
              <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400">
                BETA
              </span>
            </div>
            <p className="text-sm text-muted-foreground">
              {serverEntry?.name || "Unknown Server"} •{" "}
              {isHttpServer && (serverConfig as any).url.toString()}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <div className="flex items-center gap-2 border-r border-border pr-4">
              <label
                htmlFor="protocol-version"
                className="text-xs text-muted-foreground whitespace-nowrap"
              >
                Protocol:
              </label>
              <Select
                value={protocolVersion}
                onValueChange={(value: OAuthProtocolVersion) => {
                  setProtocolVersion(value);
                  // Reset registration strategy to default for new protocol
                  setRegistrationStrategy(
                    getDefaultRegistrationStrategy(value),
                  );
                }}
                disabled={oauthFlowState.isInitiatingAuth}
              >
                <SelectTrigger
                  id="protocol-version"
                  className="w-[140px] h-9 text-xs"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="2025-06-18" className="text-xs">
                    2025-06-18 (Latest)
                  </SelectItem>
                  <SelectItem value="2025-11-25" className="text-xs">
                    2025-11-25 (Draft)
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="flex items-center gap-2 border-r border-border pr-4">
              <label
                htmlFor="registration-strategy"
                className="text-xs text-muted-foreground whitespace-nowrap"
              >
                Registration:
              </label>
              <Select
                value={registrationStrategy}
                onValueChange={(value: string) =>
                  setRegistrationStrategy(value)
                }
                disabled={oauthFlowState.isInitiatingAuth}
              >
                <SelectTrigger
                  id="registration-strategy"
                  className="w-[180px] h-9 text-xs"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {getSupportedRegistrationStrategies(protocolVersion).map(
                    (strategy) => (
                      <SelectItem
                        key={strategy}
                        value={strategy}
                        className="text-xs"
                      >
                        {strategy === "cimd"
                          ? "CIMD (URL-based)"
                          : strategy === "dcr"
                            ? "Dynamic (DCR)"
                            : "Pre-registered"}
                      </SelectItem>
                    ),
                  )}
                </SelectContent>
              </Select>
            </div>
            {serverEntry && (
              <Button
                variant="outline"
                onClick={() => setIsEditingServer(true)}
                disabled={oauthFlowState.isInitiatingAuth}
              >
                Edit Config
              </Button>
            )}
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
      <div className="flex-1 overflow-hidden">
        <ResizablePanelGroup direction="horizontal" className="h-full">
          {/* ReactFlow Sequence Diagram */}
          <ResizablePanel defaultSize={70} minSize={30}>
            <OAuthSequenceDiagram
              flowState={oauthFlowState}
              registrationStrategy={registrationStrategy}
              protocolVersion={protocolVersion}
            />
          </ResizablePanel>

          <ResizableHandle withHandle />

          {/* Side Panel with Details - Combined Info and HTTP History */}
          <ResizablePanel defaultSize={30} minSize={20} maxSize={50}>
            <div className="h-full border-l border-border flex flex-col">
              <div className="h-full bg-muted/30 overflow-auto">
                {/* Header */}
                <div className="sticky top-0 z-10 bg-muted/30 backdrop-blur-sm border-b border-border px-4 py-3 flex items-center justify-between">
                  <h3 className="text-sm font-semibold">Console Output</h3>
                  <button
                    onClick={() => {
                      clearInfoLogs();
                      clearHttpHistory();
                    }}
                    className="p-1 hover:bg-muted rounded transition-colors"
                    title="Clear all logs"
                  >
                    <Trash2 className="h-4 w-4 text-muted-foreground hover:text-destructive transition-colors" />
                  </button>
                </div>

                {/* Console Output - Merged chronologically */}
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

                  {/* Merged Console Output - Chronologically sorted */}
                  {(() => {
                    const infoLogs = oauthFlowState.infoLogs || [];
                    const httpHistory = oauthFlowState.httpHistory || [];

                    // Create unified array with type markers
                    type ConsoleEntry =
                      | {
                          type: "info";
                          timestamp: number;
                          data: (typeof infoLogs)[0];
                        }
                      | {
                          type: "http";
                          timestamp: number;
                          data: (typeof httpHistory)[0];
                          index: number;
                        };

                    const allEntries: ConsoleEntry[] = [
                      ...infoLogs
                        .filter((log) => !deletedInfoLogs.has(log.id))
                        .map((log) => ({
                          type: "info" as const,
                          timestamp: log.timestamp,
                          data: log,
                        })),
                      ...httpHistory.map((entry, index) => ({
                        type: "http" as const,
                        timestamp: entry.timestamp,
                        data: entry,
                        index,
                      })),
                    ];

                    // Sort by timestamp (newest first)
                    allEntries.sort((a, b) => b.timestamp - a.timestamp);

                    return allEntries.map((entry, idx) => {
                      if (entry.type === "info") {
                        const log = entry.data;
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
                      } else {
                        // HTTP entry
                        const httpEntry = entry.data;
                        return (
                          <HTTPHistoryEntry
                            key={`http-${entry.index}-${entry.timestamp}`}
                            method={httpEntry.request.method}
                            url={httpEntry.request.url}
                            status={httpEntry.response?.status}
                            statusText={httpEntry.response?.statusText}
                            duration={httpEntry.duration}
                            requestHeaders={httpEntry.request.headers}
                            requestBody={httpEntry.request.body}
                            responseHeaders={httpEntry.response?.headers}
                            responseBody={httpEntry.response?.body}
                          />
                        );
                      }
                    });
                  })()}

                  {/* Empty state */}
                  {(!oauthFlowState.infoLogs ||
                    oauthFlowState.infoLogs.length === 0) &&
                    (!oauthFlowState.httpHistory ||
                      oauthFlowState.httpHistory.length === 0) &&
                    !oauthFlowState.error && (
                      <div className="text-center py-8 text-muted-foreground text-sm">
                        No console output yet
                      </div>
                    )}
                </div>
              </div>
            </div>
          </ResizablePanel>
        </ResizablePanelGroup>
      </div>

      {/* OAuth Authorization Modal */}
      {oauthFlowState.authorizationUrl && (
        <OAuthAuthorizationModal
          open={isAuthModalOpen}
          onOpenChange={setIsAuthModalOpen}
          authorizationUrl={oauthFlowState.authorizationUrl}
        />
      )}

      {/* Edit Server Modal */}
      {serverEntry && onUpdate && (
        <ServerModal
          mode="edit"
          isOpen={isEditingServer}
          onClose={() => setIsEditingServer(false)}
          onSubmit={(formData, originalName) =>
            onUpdate(originalName!, formData)
          }
          server={serverEntry}
        />
      )}
    </div>
  );
};
