import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { EMPTY_OAUTH_FLOW_STATE_V2 } from "@/lib/oauth/state-machines/debug-oauth-2025-06-18";
import { createOAuthStateMachine } from "@/lib/oauth/state-machines/factory";
import { DebugMCPOAuthClientProvider } from "@/lib/oauth/debug-oauth-provider";
import type { OAuthTestProfile } from "@/lib/oauth/profile";
import type {
  OAuthFlowState,
  OAuthFlowStep,
} from "@/lib/oauth/state-machines/types";
import {
  buildHeaderMap,
  type OAuthFlowExperienceConfig,
  type OAuthTokensFromFlow,
} from "./oauthFlowShared";

interface UseOAuthFlowControllerOptions {
  profile: OAuthTestProfile;
  serverIdentifier: string;
  resetKey: string;
  experienceConfig?: OAuthFlowExperienceConfig;
}

export interface OAuthFlowControllerResult {
  oauthFlowState: OAuthFlowState;
  focusedStep: OAuthFlowStep | null;
  setFocusedStep: (step: OAuthFlowStep | null) => void;
  isAuthModalOpen: boolean;
  setIsAuthModalOpen: (open: boolean) => void;
  isRefreshTokensModalOpen: boolean;
  setIsRefreshTokensModalOpen: (open: boolean) => void;
  hasProfile: boolean;
  protocolVersion: OAuthTestProfile["protocolVersion"];
  registrationStrategy: OAuthTestProfile["registrationStrategy"];
  continueLabel: string;
  continueDisabled: boolean;
  clearInfoLogs: () => void;
  clearHttpHistory: () => void;
  handleAdvance: () => Promise<void>;
  resetOAuthFlow: (serverUrlOverride?: string) => void;
  extractTokensFromFlowState: () => OAuthTokensFromFlow;
}

const CALLBACK_CHANNEL_NAME = "oauth_callback_channel";
const EXCHANGE_DELAY_MS = 500;

const buildInitialFlowState = (serverUrl?: string): OAuthFlowState => ({
  ...EMPTY_OAUTH_FLOW_STATE_V2,
  serverUrl: serverUrl || undefined,
});

export function useOAuthFlowController({
  profile,
  serverIdentifier,
  resetKey,
  experienceConfig,
}: UseOAuthFlowControllerOptions): OAuthFlowControllerResult {
  const initialFocusedStep = experienceConfig?.initialFocusedStep ?? null;
  const [oauthFlowState, setOAuthFlowState] = useState<OAuthFlowState>(() =>
    buildInitialFlowState(profile.serverUrl),
  );
  const [focusedStep, setFocusedStep] =
    useState<OAuthFlowStep | null>(initialFocusedStep);
  const [isAuthModalOpen, setIsAuthModalOpen] = useState(false);
  const [isRefreshTokensModalOpen, setIsRefreshTokensModalOpen] =
    useState(false);

  const hasProfile = Boolean(profile.serverUrl.trim());
  const protocolVersion = profile.protocolVersion;
  const registrationStrategy = profile.registrationStrategy;

  const oauthFlowStateRef = useRef(oauthFlowState);
  const skipNextFocusResetRef = useRef(initialFocusedStep !== null);
  useEffect(() => {
    oauthFlowStateRef.current = oauthFlowState;
  }, [oauthFlowState]);

  useEffect(() => {
    if (skipNextFocusResetRef.current) {
      skipNextFocusResetRef.current = false;
      return;
    }
    setFocusedStep(null);
  }, [oauthFlowState.currentStep]);

  const updateOAuthFlowState = useCallback(
    (updates: Partial<OAuthFlowState>) => {
      setOAuthFlowState((prev) => ({ ...prev, ...updates }));
    },
    [],
  );

  const processedCodeRef = useRef<string | null>(null);
  const exchangeTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearPendingExchange = useCallback(() => {
    if (exchangeTimeoutRef.current) {
      clearTimeout(exchangeTimeoutRef.current);
      exchangeTimeoutRef.current = null;
    }
  }, []);

  const resetOAuthFlow = useCallback(
    (serverUrlOverride?: string) => {
      const nextServerUrl = serverUrlOverride ?? profile.serverUrl;
      setOAuthFlowState(buildInitialFlowState(nextServerUrl));
      setFocusedStep(initialFocusedStep);
      skipNextFocusResetRef.current = initialFocusedStep !== null;
      setIsAuthModalOpen(false);
      setIsRefreshTokensModalOpen(false);
      processedCodeRef.current = null;
      clearPendingExchange();
    },
    [clearPendingExchange, initialFocusedStep, profile.serverUrl],
  );

  useEffect(() => {
    return () => {
      clearPendingExchange();
    };
  }, [clearPendingExchange]);

  const previousResetKeyRef = useRef(resetKey);
  useEffect(() => {
    if (previousResetKeyRef.current !== resetKey) {
      previousResetKeyRef.current = resetKey;
      resetOAuthFlow(profile.serverUrl);
    }
  }, [profile.serverUrl, resetKey, resetOAuthFlow]);

  const clearInfoLogs = useCallback(() => {
    updateOAuthFlowState({ infoLogs: [] });
  }, [updateOAuthFlowState]);

  const clearHttpHistory = useCallback(() => {
    updateOAuthFlowState({ httpHistory: [] });
  }, [updateOAuthFlowState]);

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
    customHeaders,
    hasProfile,
    profile.scopes,
    profile.serverUrl,
    protocolVersion,
    registrationStrategy,
    serverIdentifier,
    updateOAuthFlowState,
  ]);

  const proceedToNextStep = useCallback(async () => {
    if (oauthStateMachine) {
      await oauthStateMachine.proceedToNextStep();
    }
  }, [oauthStateMachine]);

  const handleAdvance = useCallback(async () => {
    if (
      oauthFlowState.currentStep === "authorization_request" ||
      oauthFlowState.currentStep === "generate_pkce_parameters"
    ) {
      if (oauthFlowState.currentStep === "generate_pkce_parameters") {
        await proceedToNextStep();
      }
      setIsAuthModalOpen(true);
      return;
    }

    await proceedToNextStep();
  }, [oauthFlowState.currentStep, proceedToNextStep]);

  const continueLabel = !hasProfile
    ? "Configure Target"
    : oauthFlowState.currentStep === "complete"
      ? "Flow Complete"
      : oauthFlowState.isInitiatingAuth
        ? "Continue"
        : oauthFlowState.currentStep === "authorization_request" ||
            oauthFlowState.currentStep === "generate_pkce_parameters"
          ? "Authorize"
          : "Continue";

  const continueDisabled =
    !hasProfile ||
    !oauthStateMachine ||
    oauthFlowState.isInitiatingAuth ||
    oauthFlowState.currentStep === "complete";

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
      oauthFlowState.clientId,
      oauthFlowState.clientSecret,
      oauthFlowState.expiresIn,
      oauthFlowState.refreshToken,
      oauthFlowState.tokenType,
    ],
  );

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
      clearPendingExchange();
      setIsAuthModalOpen(false);

      updateOAuthFlowState({
        authorizationCode: code,
        error: undefined,
      });

      exchangeTimeoutRef.current = setTimeout(() => {
        oauthStateMachine?.proceedToNextStep();
        exchangeTimeoutRef.current = null;
      }, EXCHANGE_DELAY_MS);
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
      channel = new BroadcastChannel(CALLBACK_CHANNEL_NAME);
      channel.onmessage = (event) => {
        if (event.data?.type === "OAUTH_CALLBACK" && event.data?.code) {
          processOAuthCallback(event.data.code, event.data.state);
        }
      };
    } catch {
      // BroadcastChannel is optional; window messages remain the fallback.
    }

    window.addEventListener("message", handleMessage);
    return () => {
      window.removeEventListener("message", handleMessage);
      channel?.close();
    };
  }, [clearPendingExchange, oauthStateMachine, updateOAuthFlowState]);

  return {
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
    handleAdvance,
    resetOAuthFlow,
    extractTokensFromFlowState,
  };
}
