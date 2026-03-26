import { useState, useCallback, useEffect, useMemo } from "react";
import posthog from "posthog-js";
import { detectEnvironment, detectPlatform } from "@/lib/PosthogUtils";
import { OAuthFlowExperience } from "@/components/oauth/OAuthFlowExperience";
import { OAuthProfileModal } from "@/components/oauth/OAuthProfileModal";
import { useOAuthFlowController } from "@/components/oauth/useOAuthFlowController";
import {
  deriveServerIdentifier,
  describeRegistrationStrategy,
  type OAuthTokensFromFlow,
} from "@/components/oauth/oauthFlowShared";
import type { OAuthTestProfile } from "@/lib/oauth/profile";
import type { ServerFormData } from "@/shared/types.js";
import type { ServerWithName } from "@/hooks/use-app-state";
import { deriveOAuthProfileFromServer } from "@/components/oauth/utils";

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

  const serverIdentifier = useMemo(
    () => (activeServer ? activeServer.name : deriveServerIdentifier(profile)),
    [activeServer, profile],
  );

  const {
    oauthFlowState,
    focusedStep,
    setFocusedStep,
    isAuthModalOpen,
    setIsAuthModalOpen,
    isRefreshTokensModalOpen,
    setIsRefreshTokensModalOpen,
    hasProfile,
    protocolVersion,
    registrationStrategy,
    continueLabel,
    continueDisabled,
    clearInfoLogs,
    clearHttpHistory,
    handleAdvance: advanceOAuthFlow,
    resetOAuthFlow,
    extractTokensFromFlowState,
  } = useOAuthFlowController({
    profile,
    serverIdentifier,
    resetKey: selectedServerName,
    experienceConfig: {
      targetMode: "server-backed",
    },
  });

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

    await advanceOAuthFlow();
  }, [
    advanceOAuthFlow,
    hasProfile,
    oauthFlowState.currentStep,
    profile.serverUrl,
    protocolVersion,
    registrationStrategy,
  ]);

  const isServerConnected = activeServer?.connectionStatus === "connected";
  const canApplyTokens =
    oauthFlowState.currentStep === "complete" &&
    oauthFlowState.accessToken &&
    activeServer;

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
    extractTokensFromFlowState,
    onConnectWithTokens,
    profile.serverUrl,
  ]);

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
    extractTokensFromFlowState,
    onRefreshTokens,
    profile.serverUrl,
    setIsRefreshTokensModalOpen,
  ]);

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
    <>
      <OAuthFlowExperience
        flowState={oauthFlowState}
        focusedStep={focusedStep}
        onFocusStep={setFocusedStep}
        hasProfile={hasProfile}
        protocolVersion={protocolVersion}
        registrationStrategy={registrationStrategy}
        summary={{
          label: hasProfile ? serverIdentifier : "No target configured",
          description: headerDescription,
          protocol: hasProfile ? protocolVersion : undefined,
          registration: hasProfile
            ? describeRegistrationStrategy(registrationStrategy)
            : undefined,
          step: oauthFlowState.currentStep,
          serverUrl: hasProfile ? profile.serverUrl : undefined,
          scopes: hasProfile && profile.scopes.trim()
            ? profile.scopes.trim()
            : undefined,
          clientId: hasProfile && profile.clientId.trim()
            ? profile.clientId.trim()
            : undefined,
          customHeadersCount: hasProfile
            ? profile.customHeaders.filter((header) => header.key.trim()).length
            : undefined,
        }}
        config={{
          targetMode: "server-backed",
        }}
        onClearLogs={clearInfoLogs}
        onClearHttpHistory={clearHttpHistory}
        onConfigureTarget={() => setIsProfileModalOpen(true)}
        onReset={hasProfile ? () => resetOAuthFlow() : undefined}
        onContinue={
          canApplyTokens || continueDisabled ? undefined : handleAdvance
        }
        continueLabel={continueLabel}
        continueDisabled={Boolean(canApplyTokens || continueDisabled)}
        onApplyTokens={
          canApplyTokens && !isServerConnected ? handleConnectServer : undefined
        }
        onRefreshTokens={
          canApplyTokens && isServerConnected
            ? () => setIsRefreshTokensModalOpen(true)
            : undefined
        }
        isApplyingTokens={isApplyingTokens}
        authModal={{
          open: isAuthModalOpen,
          onOpenChange: setIsAuthModalOpen,
          authorizationUrl: oauthFlowState.authorizationUrl,
        }}
        refreshModal={
          activeServer
            ? {
                open: isRefreshTokensModalOpen,
                onOpenChange: setIsRefreshTokensModalOpen,
                serverName: activeServer.name,
                onConfirm: handleRefreshTokensConfirm,
                isLoading: isApplyingTokens,
              }
            : undefined
        }
      />

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
    </>
  );
};
