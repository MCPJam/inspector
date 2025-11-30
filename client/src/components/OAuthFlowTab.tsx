import { useState, useCallback, useEffect, useMemo, useRef } from "react";
import { EMPTY_OAUTH_FLOW_STATE_V2 } from "@/lib/oauth/state-machines/debug-oauth-2025-06-18";
import {
  OAuthFlowState,
  type OAuthFlowStep,
} from "@/lib/oauth/state-machines/types";
import { createOAuthStateMachine } from "@/lib/oauth/state-machines/factory";
import { DebugMCPOAuthClientProvider } from "@/lib/debug-oauth-provider";
import { OAuthSequenceDiagram } from "@/components/oauth/OAuthSequenceDiagram";
import { OAuthAuthorizationModal } from "@/components/oauth/OAuthAuthorizationModal";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "./ui/resizable";
import posthog from "posthog-js";
import { detectEnvironment, detectPlatform } from "@/logs/PosthogUtils";
import { OAuthProfileModal } from "./oauth/OAuthProfileModal";
import { type OAuthTestProfile } from "@/lib/oauth/profile";
import { OAuthFlowLogger } from "./oauth/OAuthFlowLogger";
import type { ServerFormData } from "@/shared/types.js";
import type { ServerWithName } from "@/hooks/use-app-state";
import { deriveOAuthProfileFromServer } from "./oauth/utils";
import { RefreshTokensConfirmModal } from "./oauth/RefreshTokensConfirmModal";

export interface OAuthTokensFromFlow {
  accessToken: string;
  refreshToken?: string;
  tokenType?: string;
  expiresIn?: number;
  clientId?: string;
  clientSecret?: string;
}

const deriveServerIdentifier = (profile: OAuthTestProfile): string => {
  const trimmedUrl = profile.serverUrl.trim();
  if (!trimmedUrl) {
    return "oauth-flow-target";
  }

  try {
    const url = new URL(trimmedUrl);
    return url.host;
  } catch {
    return trimmedUrl;
  }
};

const buildHeaderMap = (
  headers: Array<{ key: string; value: string }>,
): Record<string, string> | undefined => {
  const entries = headers
    .map((header) => ({
      key: header.key.trim(),
      value: header.value.trim(),
    }))
    .filter((header) => header.key.length > 0);

  if (!entries.length) {
    return undefined;
  }

  return Object.fromEntries(entries.map(({ key, value }) => [key, value]));
};

const describeRegistrationStrategy = (strategy: string): string => {
  if (strategy === "cimd") return "CIMD (URL-based)";
  if (strategy === "dcr") return "Dynamic (DCR)";
  return "Pre-registered";
};

const isHttpServer = (server?: ServerWithName) =>
  Boolean(server && "url" in server.config);

interface OAuthFlowTabProps {
  serverConfigs: Record<string, ServerWithName>;
  selectedServerName: string;
  onSelectServer: (serverName: string) => void;
  onSaveServerConfig?: (
    formData: ServerFormData,
    options?: { oauthProfile?: OAuthTestProfile },
  ) => void;
  onConnectWithTokens?: (
    serverName: string,
    tokens: OAuthTokensFromFlow,
    serverUrl: string,
  ) => Promise<void>;
  onRefreshTokens?: (
    serverName: string,
    tokens: OAuthTokensFromFlow,
    serverUrl: string,
  ) => Promise<void>;
}

export const OAuthFlowTab = ({
  serverConfigs,
  selectedServerName,
  onSelectServer,
  onSaveServerConfig,
  onConnectWithTokens,
  onRefreshTokens,
}: OAuthFlowTabProps) => {
  const [isProfileModalOpen, setIsProfileModalOpen] = useState(false);
  const [pendingServerSelection, setPendingServerSelection] = useState<
    string | null
  >(null);
  const [oauthFlowState, setOAuthFlowState] = useState<OAuthFlowState>(
    EMPTY_OAUTH_FLOW_STATE_V2,
  );
  const [focusedStep, setFocusedStep] = useState<OAuthFlowStep | null>(null);
  const [isAuthModalOpen, setIsAuthModalOpen] = useState(false);
  const [isRefreshTokensModalOpen, setIsRefreshTokensModalOpen] =
    useState(false);
  const [isApplyingTokens, setIsApplyingTokens] = useState(false);

  const httpServers = useMemo(
    () => Object.values(serverConfigs).filter((server) => isHttpServer(server)),
    [serverConfigs],
  );

  const selectedServer =
    selectedServerName !== "none"
      ? serverConfigs[selectedServerName]
      : undefined;
  const activeServer = isHttpServer(selectedServer)
    ? selectedServer
    : undefined;

  useEffect(() => {
    if (!isHttpServer(selectedServer) && httpServers.length > 0) {
      onSelectServer(httpServers[0].name);
    }
  }, [selectedServer, httpServers, onSelectServer]);

  useEffect(() => {
    if (
      pendingServerSelection &&
      serverConfigs[pendingServerSelection] &&
      isHttpServer(serverConfigs[pendingServerSelection])
    ) {
      onSelectServer(pendingServerSelection);
      setPendingServerSelection(null);
    }
  }, [pendingServerSelection, serverConfigs, onSelectServer]);

  useEffect(() => {
    if (httpServers.length === 0) {
      setIsProfileModalOpen(true);
    }
  }, [httpServers.length]);

  const profile = useMemo(
    () => deriveOAuthProfileFromServer(activeServer),
    [activeServer],
  );

  const hasProfile = Boolean(activeServer && profile.serverUrl.trim());
  const serverIdentifier = useMemo(
    () => (activeServer ? activeServer.name : deriveServerIdentifier(profile)),
    [activeServer, profile.serverUrl],
  );

  const protocolVersion = profile.protocolVersion;
  const registrationStrategy = profile.registrationStrategy;

  const oauthFlowStateRef = useRef(oauthFlowState);
  useEffect(() => {
    oauthFlowStateRef.current = oauthFlowState;
  }, [oauthFlowState]);

  useEffect(() => {
    setFocusedStep(null);
  }, [oauthFlowState.currentStep]);

  const updateOAuthFlowState = useCallback(
    (updates: Partial<OAuthFlowState>) => {
      setOAuthFlowState((prev) => ({ ...prev, ...updates }));
    },
    [],
  );

  const processedCodeRef = useRef<string | null>(null);
  const exchangeTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  // Reset OAuth flow state when switching servers
  const prevServerNameRef = useRef(selectedServerName);
  useEffect(() => {
    if (prevServerNameRef.current !== selectedServerName) {
      prevServerNameRef.current = selectedServerName;
      setOAuthFlowState({
        ...EMPTY_OAUTH_FLOW_STATE_V2,
        serverUrl: profile.serverUrl || undefined,
      });
      processedCodeRef.current = null;
      if (exchangeTimeoutRef.current) {
        clearTimeout(exchangeTimeoutRef.current);
        exchangeTimeoutRef.current = null;
      }
    }
  }, [selectedServerName, profile.serverUrl]);

  const resetOAuthFlow = useCallback(
    (serverUrlOverride?: string) => {
      const nextServerUrl = serverUrlOverride ?? profile.serverUrl;
      setOAuthFlowState({
        ...EMPTY_OAUTH_FLOW_STATE_V2,
        serverUrl: nextServerUrl || undefined,
      });
      processedCodeRef.current = null;
      if (exchangeTimeoutRef.current) {
        clearTimeout(exchangeTimeoutRef.current);
        exchangeTimeoutRef.current = null;
      }
    },
    [profile.serverUrl],
  );

  const clearInfoLogs = () => {
    updateOAuthFlowState({ infoLogs: [] });
  };

  const clearHttpHistory = () => {
    updateOAuthFlowState({ httpHistory: [] });
  };

  const customHeaders = useMemo(
    () => buildHeaderMap(profile.customHeaders),
    [profile.customHeaders],
  );

  const oauthStateMachine = useMemo(() => {
    if (!hasProfile) return null;

    const provider = new DebugMCPOAuthClientProvider(profile.serverUrl);

    return createOAuthStateMachine({
      protocolVersion,
      state: oauthFlowStateRef.current,
      getState: () => oauthFlowStateRef.current,
      updateState: updateOAuthFlowState,
      serverUrl: profile.serverUrl,
      serverName: serverIdentifier,
      redirectUrl: provider.redirectUrl,
      customScopes: profile.scopes.trim() || undefined,
      customHeaders,
      registrationStrategy,
    });
  }, [
    hasProfile,
    protocolVersion,
    profile.serverUrl,
    profile.scopes,
    serverIdentifier,
    customHeaders,
    registrationStrategy,
    updateOAuthFlowState,
  ]);

  const proceedToNextStep = useCallback(async () => {
    if (oauthStateMachine) {
      await oauthStateMachine.proceedToNextStep();
    }
  }, [oauthStateMachine]);

  const handleAdvance = useCallback(async () => {
    posthog.capture("oauth_flow_tab_next_step_button_clicked", {
      location: "oauth_flow_tab",
      platform: detectPlatform(),
      environment: detectEnvironment(),
      currentStep: oauthFlowState.currentStep,
      protocolVersion,
      registrationStrategy,
      hasProfile,
      targetUrlConfigured: Boolean(profile.serverUrl),
    });

    if (
      oauthFlowState.currentStep === "authorization_request" ||
      oauthFlowState.currentStep === "generate_pkce_parameters"
    ) {
      if (oauthFlowState.currentStep === "generate_pkce_parameters") {
        await proceedToNextStep();
      }
      setIsAuthModalOpen(true);
    } else {
      await proceedToNextStep();
    }
  }, [
    hasProfile,
    oauthFlowState.currentStep,
    proceedToNextStep,
    profile.serverUrl,
    protocolVersion,
    registrationStrategy,
  ]);

  const continueLabel = !hasProfile
    ? "Configure Target"
    : oauthFlowState.currentStep === "complete"
      ? "Flow Complete"
      : oauthFlowState.isInitiatingAuth
        ? "Processing..."
        : oauthFlowState.currentStep === "authorization_request" ||
            oauthFlowState.currentStep === "generate_pkce_parameters"
          ? "Authorize"
          : "Continue";
  const continueDisabled =
    !hasProfile ||
    !oauthStateMachine ||
    oauthFlowState.isInitiatingAuth ||
    oauthFlowState.currentStep === "complete";

  // Determine if we can apply tokens (flow complete with access token)
  const isServerConnected = activeServer?.connectionStatus === "connected";
  const canApplyTokens =
    oauthFlowState.currentStep === "complete" &&
    oauthFlowState.accessToken &&
    activeServer;

  // Extract tokens from flow state
  const extractTokensFromFlowState = useCallback(
    (): OAuthTokensFromFlow => ({
      accessToken: oauthFlowState.accessToken!,
      refreshToken: oauthFlowState.refreshToken,
      tokenType: oauthFlowState.tokenType,
      expiresIn: oauthFlowState.expiresIn,
      clientId: oauthFlowState.clientId,
      clientSecret: oauthFlowState.clientSecret,
    }),
    [
      oauthFlowState.accessToken,
      oauthFlowState.refreshToken,
      oauthFlowState.tokenType,
      oauthFlowState.expiresIn,
      oauthFlowState.clientId,
      oauthFlowState.clientSecret,
    ],
  );

  // Handler for connecting server with new tokens
  const handleConnectServer = useCallback(async () => {
    if (!activeServer || !onConnectWithTokens) return;
    setIsApplyingTokens(true);
    try {
      await onConnectWithTokens(
        activeServer.name,
        extractTokensFromFlowState(),
        profile.serverUrl,
      );
    } finally {
      setIsApplyingTokens(false);
    }
  }, [
    activeServer,
    onConnectWithTokens,
    extractTokensFromFlowState,
    profile.serverUrl,
  ]);

  // Handler for refreshing tokens (called after modal confirmation)
  const handleRefreshTokensConfirm = useCallback(async () => {
    if (!activeServer || !onRefreshTokens) return;
    setIsApplyingTokens(true);
    try {
      await onRefreshTokens(
        activeServer.name,
        extractTokensFromFlowState(),
        profile.serverUrl,
      );
      setIsRefreshTokensModalOpen(false);
    } finally {
      setIsApplyingTokens(false);
    }
  }, [
    activeServer,
    onRefreshTokens,
    extractTokensFromFlowState,
    profile.serverUrl,
  ]);

  useEffect(() => {
    const processOAuthCallback = (code: string, state: string | undefined) => {
      if (processedCodeRef.current === code) {
        return;
      }

      const expectedState = oauthFlowStateRef.current.state;
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

      processedCodeRef.current = code;

      if (exchangeTimeoutRef.current) {
        clearTimeout(exchangeTimeoutRef.current);
      }

      updateOAuthFlowState({
        authorizationCode: code,
        error: undefined,
      });

      exchangeTimeoutRef.current = setTimeout(() => {
        oauthStateMachine?.proceedToNextStep();
        exchangeTimeoutRef.current = null;
      }, 500);
    };

    const handleMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) {
        return;
      }

      if (event.data?.type === "OAUTH_CALLBACK" && event.data?.code) {
        processOAuthCallback(event.data.code, event.data.state);
      }
    };

    let channel: BroadcastChannel | null = null;
    try {
      channel = new BroadcastChannel("oauth_callback_channel");
      channel.onmessage = (event) => {
        if (event.data?.type === "OAUTH_CALLBACK" && event.data?.code) {
          processOAuthCallback(event.data.code, event.data.state);
        }
      };
    } catch (error) {
      // BroadcastChannel not supported; fallback to window message only
    }

    window.addEventListener("message", handleMessage);
    return () => {
      window.removeEventListener("message", handleMessage);
      channel?.close();
    };
  }, [oauthStateMachine, updateOAuthFlowState]);

  useEffect(() => {
    posthog.capture("oauth_flow_tab_viewed", {
      location: "oauth_flow_tab",
      platform: detectPlatform(),
      environment: detectEnvironment(),
    });
  }, []);

  const headerDescription = hasProfile
    ? profile.serverUrl
    : "Paste an MCP base URL to start debugging the OAuth flow.";

  return (
    <div className="h-[calc(100vh-120px)] flex flex-col bg-background">
      <div className="flex-1 overflow-hidden">
        <ResizablePanelGroup direction="horizontal" className="h-full">
          <ResizablePanel defaultSize={50} minSize={30}>
            <OAuthSequenceDiagram
              flowState={oauthFlowState}
              registrationStrategy={registrationStrategy}
              protocolVersion={protocolVersion}
              focusedStep={focusedStep}
            />
          </ResizablePanel>

          <ResizableHandle withHandle />

          <ResizablePanel defaultSize={50} minSize={20} maxSize={50}>
            <OAuthFlowLogger
              oauthFlowState={oauthFlowState}
              onClearLogs={clearInfoLogs}
              onClearHttpHistory={clearHttpHistory}
              activeStep={focusedStep ?? oauthFlowState.currentStep}
              onFocusStep={setFocusedStep}
              summary={{
                label: hasProfile ? serverIdentifier : "No target configured",
                description: headerDescription,
                protocol: hasProfile ? protocolVersion : undefined,
                registration: hasProfile
                  ? describeRegistrationStrategy(registrationStrategy)
                  : undefined,
                step: oauthFlowState.currentStep,
              }}
              actions={{
                onConfigure: () => setIsProfileModalOpen(true),
                onReset: hasProfile ? () => resetOAuthFlow() : undefined,
                // Hide Continue button when showing Connect/Refresh buttons
                onContinue:
                  canApplyTokens || continueDisabled
                    ? undefined
                    : handleAdvance,
                continueLabel,
                continueDisabled: canApplyTokens || continueDisabled,
                resetDisabled: !hasProfile || oauthFlowState.isInitiatingAuth,
                onConnectServer:
                  canApplyTokens && !isServerConnected
                    ? handleConnectServer
                    : undefined,
                onRefreshTokens:
                  canApplyTokens && isServerConnected
                    ? () => setIsRefreshTokensModalOpen(true)
                    : undefined,
                isApplyingTokens,
              }}
            />
          </ResizablePanel>
        </ResizablePanelGroup>
      </div>

      {oauthFlowState.authorizationUrl && (
        <OAuthAuthorizationModal
          open={isAuthModalOpen}
          onOpenChange={setIsAuthModalOpen}
          authorizationUrl={oauthFlowState.authorizationUrl}
        />
      )}

      <OAuthProfileModal
        open={isProfileModalOpen}
        onOpenChange={setIsProfileModalOpen}
        server={activeServer}
        existingServerNames={Object.keys(serverConfigs)}
        onSave={({ formData, profile: savedProfile }) => {
          onSaveServerConfig?.(formData, { oauthProfile: savedProfile });
          setPendingServerSelection(formData.name);
          resetOAuthFlow(formData.url);
        }}
      />

      {activeServer && (
        <RefreshTokensConfirmModal
          open={isRefreshTokensModalOpen}
          onOpenChange={setIsRefreshTokensModalOpen}
          serverName={activeServer.name}
          onConfirm={handleRefreshTokensConfirm}
          isLoading={isApplyingTokens}
        />
      )}
    </div>
  );
};
