import { useState, useCallback, useEffect, useMemo, useRef } from "react";
import { Button } from "@/components/ui/button";
import { AlertCircle, Workflow, CheckCircle2 } from "lucide-react";
import { EmptyState } from "@/components/ui/empty-state";
import {
  AuthSettings,
  DEFAULT_AUTH_SETTINGS,
  StatusMessage,
} from "@/shared/types.js";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { getStoredTokens } from "@/lib/mcp-oauth";
import { ServerWithName } from "@/hooks/use-app-state";
import { EMPTY_OAUTH_FLOW_STATE_V2 } from "@/lib/oauth/state-machines/debug-oauth-2025-06-18";
import {
  OAuthFlowState,
  OAuthProtocolVersion,
  RegistrationStrategy2025_11_25,
  RegistrationStrategy2025_06_18,
  type OAuthFlowStep,
} from "@/lib/oauth/state-machines/types";
import {
  createOAuthStateMachine,
  getDefaultRegistrationStrategy,
  getSupportedRegistrationStrategies,
} from "@/lib/oauth/state-machines/factory";
import { DebugMCPOAuthClientProvider } from "@/lib/debug-oauth-provider";
import { OAuthSequenceDiagram } from "@/components/oauth/OAuthSequenceDiagram";
import { OAuthFlowLogger } from "@/components/oauth/OAuthFlowLogger";
import { OAuthAuthorizationModal } from "@/components/oauth/OAuthAuthorizationModal";
import { ServerFormData } from "@/shared/types";
import { MCPServerConfig } from "@/sdk";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "./ui/resizable";
import { EditServerModal } from "./connection/EditServerModal";
import posthog from "posthog-js";
import { detectEnvironment, detectPlatform } from "@/logs/PosthogUtils";

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
  onUpdate?: (
    originalServerName: string,
    formData: ServerFormData,
    skipAutoConnect?: boolean,
  ) => void;
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
  const [oauthFlowState, setOAuthFlowState] = useState<OAuthFlowState>(
    EMPTY_OAUTH_FLOW_STATE_V2,
  );
  const [focusedStep, setFocusedStep] = useState<OAuthFlowStep | null>(null);

  // Track if we've initialized the flow for the current server
  const initializedServerRef = useRef<string | null>(null);

  // Track if user manually reset (don't auto-restart in this case)
  const manualResetRef = useRef(false);

  // Track if authorization modal is open
  const [isAuthModalOpen, setIsAuthModalOpen] = useState(false);

  // Track if server edit modal is open
  const [isEditingServer, setIsEditingServer] = useState(false);

  // Track custom scopes input
  const [customScopes, setCustomScopes] = useState("");

  const [serverUrlInput, setServerUrlInput] = useState(() => {
    if (serverConfig && "url" in serverConfig) {
      return (serverConfig as any).url.toString();
    }
    return "";
  });

  const isHttpServer = Boolean(serverConfig && "url" in serverConfig);

  const previousServerIdentityRef = useRef<string | null>(null);
  const lastConfigUrlRef = useRef<string | null>(null);
  useEffect(() => {
    const identity = serverName ?? serverEntry?.name ?? null;
    const configUrl =
      serverConfig && "url" in serverConfig
        ? (serverConfig as any).url.toString()
        : null;

    const identityChanged = identity !== previousServerIdentityRef.current;

    if (identityChanged) {
      previousServerIdentityRef.current = identity;
      lastConfigUrlRef.current = configUrl;
      setServerUrlInput(configUrl ?? "");
      return;
    }

    if (configUrl !== lastConfigUrlRef.current) {
      const previousConfigUrl = lastConfigUrlRef.current;
      lastConfigUrlRef.current = configUrl;
      if (
        !previousConfigUrl ||
        serverUrlInput.trim() === (previousConfigUrl ?? "")
      ) {
        setServerUrlInput(configUrl ?? "");
      }
    }

    if (!serverConfig && serverUrlInput !== "") {
      lastConfigUrlRef.current = null;
      setServerUrlInput("");
    }
  }, [serverConfig, serverEntry, serverName, serverUrlInput]);

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
  const [registrationStrategy, setRegistrationStrategy] = useState<
    RegistrationStrategy2025_06_18 | RegistrationStrategy2025_11_25
  >(() => {
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
  });

  // Use ref to always have access to the latest state
  const oauthFlowStateRef = useRef(oauthFlowState);
  useEffect(() => {
    oauthFlowStateRef.current = oauthFlowState;
  }, [oauthFlowState]);

  useEffect(() => {
    setFocusedStep(null);
  }, [oauthFlowState.currentStep]);

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

  const clearInfoLogs = () => {
    // Clear all info logs from state
    updateOAuthFlowState({ infoLogs: [] });
  };

  const clearHttpHistory = () => {
    updateOAuthFlowState({ httpHistory: [] });
  };

  const updateAuthSettings = useCallback((updates: Partial<AuthSettings>) => {
    setAuthSettings((prev) => ({ ...prev, ...updates }));
  }, []);

  const handleServerUrlChange = useCallback(
    (value: string) => {
      setServerUrlInput(value);
      updateAuthSettings({ serverUrl: value });
    },
    [updateAuthSettings],
  );

  const updateOAuthFlowState = useCallback(
    (updates: Partial<OAuthFlowState>) => {
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
    // Don't clear custom scopes - they should persist from server config
    // Headers and scopes will remain from server config (not cleared on reset)
  }, [updateOAuthFlowState]);

  // Update auth settings when server config changes or server URL is overridden
  useEffect(() => {
    if (serverConfig && serverName && isHttpServer) {
      const configUrl = (serverConfig as any).url.toString();
      const effectiveUrl = serverUrlInput.trim() || configUrl;

      // Check for existing tokens using the real OAuth system
      const existingTokens = getStoredTokens(serverName);

      updateAuthSettings({
        serverUrl: effectiveUrl,
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
  }, [
    serverConfig,
    serverName,
    updateAuthSettings,
    customScopes,
    isHttpServer,
    serverUrlInput,
  ]);

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
  const supportsOAuth = isHttpServer;

  useEffect(() => {
    posthog.capture("oauth_flow_tab_viewed", {
      location: "oauth_flow_tab",
      platform: detectPlatform(),
      environment: detectEnvironment(),
    });
  }, []);

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
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-end gap-3">
            <div className="flex-1 min-w-[220px] space-y-2">
              <label
                htmlFor="oauth-flow-server-url"
                className="text-xs uppercase tracking-wide text-muted-foreground"
              >
                Server URL
              </label>
              <Input
                id="oauth-flow-server-url"
                value={serverUrlInput}
                onChange={(event) => handleServerUrlChange(event.target.value)}
                placeholder="https://example.com"
                className="h-9"
                spellCheck={false}
                autoComplete="off"
              />
            </div>
            <div className="flex flex-wrap items-end gap-3">
              <div className="min-w-[150px] space-y-1">
                <label
                  htmlFor="protocol-version"
                  className="text-xs uppercase tracking-wide text-muted-foreground"
                >
                  Protocol
                </label>
                <Select
                  value={protocolVersion}
                  onValueChange={(value: OAuthProtocolVersion) => {
                    setProtocolVersion(value);
                    // Reset registration strategy to default for new protocol
                    setRegistrationStrategy(
                      getDefaultRegistrationStrategy(value) as
                        | RegistrationStrategy2025_06_18
                        | RegistrationStrategy2025_11_25,
                    );
                  }}
                  disabled={oauthFlowState.isInitiatingAuth}
                >
                  <SelectTrigger
                    id="protocol-version"
                    className="h-9 w-full text-xs"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="2025-03-26" className="text-xs">
                      2025-03-26
                    </SelectItem>
                    <SelectItem value="2025-06-18" className="text-xs">
                      2025-06-18 (Latest)
                    </SelectItem>
                    <SelectItem value="2025-11-25" className="text-xs">
                      2025-11-25 (Draft)
                    </SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="min-w-[180px] space-y-1">
                <label
                  htmlFor="registration-strategy"
                  className="text-xs uppercase tracking-wide text-muted-foreground"
                >
                  Registration
                </label>
                <Select
                  value={registrationStrategy}
                  onValueChange={(value: string) =>
                    setRegistrationStrategy(
                      value as
                        | RegistrationStrategy2025_06_18
                        | RegistrationStrategy2025_11_25,
                    )
                  }
                  disabled={oauthFlowState.isInitiatingAuth}
                >
                  <SelectTrigger
                    id="registration-strategy"
                    className="h-9 w-full text-xs"
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
            </div>
            <div className="flex items-end gap-2">
              {serverEntry && onUpdate && (
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
                onClick={async () => {
                  // If we're about to do authorization or already at it, handle the modal
                  posthog.capture("oauth_flow_tab_next_step_button_clicked", {
                    location: "oauth_flow_tab",
                    platform: detectPlatform(),
                    environment: detectEnvironment(),
                    currentStep: oauthFlowState.currentStep,
                    protocolVersion: protocolVersion,
                    registrationStrategy: registrationStrategy,
                  });
                  if (
                    oauthFlowState.currentStep === "authorization_request" ||
                    oauthFlowState.currentStep === "generate_pkce_parameters"
                  ) {
                    // First proceed to authorization_request if needed
                    if (
                      oauthFlowState.currentStep === "generate_pkce_parameters"
                    ) {
                      await proceedToNextStep();
                    }
                    // Then open modal
                    setIsAuthModalOpen(true);
                  } else {
                    // Otherwise proceed to next step
                    await proceedToNextStep();
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
                ) : oauthFlowState.currentStep === "authorization_request" ||
                  oauthFlowState.currentStep === "generate_pkce_parameters" ? (
                  "Ready to authorize"
                ) : (
                  "Next Step"
                )}
              </Button>
            </div>
          </div>
          <p className="text-xs text-muted-foreground">
            Set the target URL, pick your protocol version, and confirm the
            registration strategy before continuing.
          </p>
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
          <ResizablePanel defaultSize={50} minSize={30}>
            <OAuthSequenceDiagram
              flowState={oauthFlowState}
              registrationStrategy={registrationStrategy}
              protocolVersion={protocolVersion}
              focusedStep={focusedStep}
            />
          </ResizablePanel>

          <ResizableHandle withHandle />

          {/* Side Panel with Details - Combined Info and HTTP History */}
          <ResizablePanel defaultSize={50} minSize={20} maxSize={50}>
            <OAuthFlowLogger
              oauthFlowState={oauthFlowState}
              onClearLogs={clearInfoLogs}
              onClearHttpHistory={clearHttpHistory}
              activeStep={focusedStep ?? oauthFlowState.currentStep}
              onFocusStep={setFocusedStep}
            />
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
        <EditServerModal
          isOpen={isEditingServer}
          onClose={() => setIsEditingServer(false)}
          onSubmit={(formData, originalName, skipAutoConnect) => {
            onUpdate(originalName, formData, skipAutoConnect);
            // Reset OAuth flow to regenerate authorization URL with new config
            resetOAuthFlow();
          }}
          server={serverEntry}
          skipAutoConnect={true}
        />
      )}
    </div>
  );
};
