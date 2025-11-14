import { useState, useCallback, useEffect, useMemo, useRef } from "react";
import { Button } from "@/components/ui/button";
import { CheckCircle2 } from "lucide-react";
import { EMPTY_OAUTH_FLOW_STATE_V2 } from "@/lib/oauth/state-machines/debug-oauth-2025-06-18";
import {
  OAuthFlowState,
  type OAuthFlowStep,
} from "@/lib/oauth/state-machines/types";
import {
  createOAuthStateMachine,
  getDefaultRegistrationStrategy,
  getSupportedRegistrationStrategies,
} from "@/lib/oauth/state-machines/factory";
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
import {
  EMPTY_OAUTH_TEST_PROFILE,
  type OAuthTestProfile,
  type OAuthRegistrationStrategy,
} from "./oauth/types";
import { OAuthFlowLogger } from "./oauth/OAuthFlowLogger";

const PROFILE_STORAGE_KEY = "mcp-oauth-flow-profile";
const CLIENT_STORAGE_PREFIX = "mcp-client-";

const loadStoredProfile = (): OAuthTestProfile => {
  if (typeof window === "undefined") {
    return EMPTY_OAUTH_TEST_PROFILE;
  }

  try {
    const stored = localStorage.getItem(PROFILE_STORAGE_KEY);
    if (!stored) {
      return EMPTY_OAUTH_TEST_PROFILE;
    }
    const parsed = JSON.parse(stored);
    const protocolVersion = ["2025-03-26", "2025-06-18", "2025-11-25"].includes(
      parsed.protocolVersion,
    )
      ? parsed.protocolVersion
      : "2025-11-25";

    const supported = getSupportedRegistrationStrategies(protocolVersion);
    const registrationStrategy: OAuthRegistrationStrategy = supported.includes(
      parsed.registrationStrategy,
    )
      ? parsed.registrationStrategy
      : (getDefaultRegistrationStrategy(
          protocolVersion,
        ) as OAuthRegistrationStrategy);

    return {
      ...EMPTY_OAUTH_TEST_PROFILE,
      ...parsed,
      customHeaders: Array.isArray(parsed.customHeaders)
        ? parsed.customHeaders.map((header: any) => ({
            key: header.key || "",
            value: header.value || "",
          }))
        : [],
      protocolVersion,
      registrationStrategy,
    };
  } catch (error) {
    console.error("Failed to load stored OAuth profile", error);
    return EMPTY_OAUTH_TEST_PROFILE;
  }
};

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

export const OAuthFlowTab = () => {
  const initialProfile = useMemo(() => loadStoredProfile(), []);
  const [profile, setProfile] = useState<OAuthTestProfile>(initialProfile);
  const [isProfileModalOpen, setIsProfileModalOpen] = useState(true);
  const [oauthFlowState, setOAuthFlowState] = useState<OAuthFlowState>(
    EMPTY_OAUTH_FLOW_STATE_V2,
  );
  const [focusedStep, setFocusedStep] = useState<OAuthFlowStep | null>(null);
  const [isAuthModalOpen, setIsAuthModalOpen] = useState(false);

  const hasProfile = Boolean(profile.serverUrl.trim());
  const serverIdentifier = useMemo(
    () => deriveServerIdentifier(profile),
    [profile.serverUrl],
  );

  useEffect(() => {
    try {
      localStorage.setItem(PROFILE_STORAGE_KEY, JSON.stringify(profile));
    } catch (error) {
      console.error("Failed to persist OAuth profile", error);
    }
  }, [profile]);

  const credentialKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (typeof window === "undefined") return;

    if (!hasProfile) {
      if (credentialKeyRef.current) {
        localStorage.removeItem(
          `${CLIENT_STORAGE_PREFIX}${credentialKeyRef.current}`,
        );
        credentialKeyRef.current = null;
      }
      return;
    }

    const storageKey = `${CLIENT_STORAGE_PREFIX}${serverIdentifier}`;

    if (
      credentialKeyRef.current &&
      credentialKeyRef.current !== serverIdentifier
    ) {
      localStorage.removeItem(
        `${CLIENT_STORAGE_PREFIX}${credentialKeyRef.current}`,
      );
    }

    credentialKeyRef.current = serverIdentifier;

    const trimmedClientId = profile.clientId.trim();
    if (!trimmedClientId) {
      localStorage.removeItem(storageKey);
      return;
    }

    const payload: Record<string, string> = {
      client_id: trimmedClientId,
    };

    const trimmedSecret = profile.clientSecret.trim();
    if (trimmedSecret) {
      payload.client_secret = trimmedSecret;
    }

    try {
      localStorage.setItem(storageKey, JSON.stringify(payload));
    } catch (error) {
      console.error("Failed to persist OAuth client credentials", error);
    }
  }, [hasProfile, profile.clientId, profile.clientSecret, serverIdentifier]);

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
                onContinue: continueDisabled ? undefined : handleAdvance,
                continueLabel,
                continueDisabled,
                resetDisabled: !hasProfile || oauthFlowState.isInitiatingAuth,
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
        profile={profile}
        onSave={(nextProfile) => {
          setProfile(nextProfile);
          resetOAuthFlow(nextProfile.serverUrl);
        }}
      />
    </div>
  );
};
