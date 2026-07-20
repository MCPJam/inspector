import { useState, useCallback, useEffect, useMemo, useRef } from "react";
import {
  EMPTY_OAUTH_FLOW_STATE,
  buildOAuthSequenceActions,
  getSupportedRegistrationStrategies,
  type OAuthFlowState,
  type OAuthFlowStep,
} from "@mcpjam/sdk/browser";
import { createInspectorOAuthStateMachine } from "@/lib/oauth/debug-state-machine-adapter";
import { OAuthSequenceDiagram } from "@/components/oauth/OAuthSequenceDiagram";
import { OAuthAuthorizationModal } from "@/components/oauth/OAuthAuthorizationModal";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "./ui/resizable";
import { track } from "@/lib/analytics";
import {
  OAuthProfileModal,
  type OAuthProfileAgentSeed,
} from "./oauth/OAuthProfileModal";
import {
  normalizeOAuthRegistrationStrategy,
  type OAuthTestProfile,
} from "@/lib/oauth/profile";
import { OAuthFlowLogger } from "./oauth/OAuthFlowLogger";
import type { ServerFormData } from "@/shared/types.js";
import type { ServerWithName } from "@/hooks/use-app-state";
import { deriveOAuthProfileFromServer } from "./oauth/utils";
import { RefreshTokensConfirmModal } from "./oauth/RefreshTokensConfirmModal";
import { useSurfaceAgentBridge } from "@/lib/webmcp/use-surface-agent-bridge";
import {
  buildOAuthFlowSnapshot,
  toSafeSequenceSteps,
} from "@/lib/webmcp/oauth-flow-snapshot";
import { extractOauthErrorCode } from "@/lib/webmcp/oauth-error-code";
import { planAuthConfigModal } from "@/lib/webmcp/auth-config-command";
import { createInspectorCommandClientError } from "@/lib/inspector-command-handlers";
import type {
  InspectorCommand,
  OpenOauthServerConfigInspectorCommand,
} from "@/shared/inspector-command.js";

export interface OAuthTokensFromFlow {
  accessToken: string;
  refreshToken?: string;
  tokenType?: string;
  expiresIn?: number;
  clientId?: string;
  clientSecret?: string;
  // AS URL discovered during the debugger flow. Forwarded to the hosted
  // backend so it can refresh without re-discovering against a resource it
  // can't reach itself (e.g. localhost).
  authorizationServerUrl?: string;
}

declare global {
  interface Window {
    __oauthDebuggerE2EFlowState?: {
      authorizationUrl?: string;
      currentStep: OAuthFlowStep;
      state?: string;
    };
  }
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

/**
 * Honest post-step result for the advanceOauthFlow command. Never echoes the
 * raw error string — only presence and an allowlisted OAuth error code.
 */
const buildAdvanceResult = (
  previousStep: OAuthFlowStep,
  state: OAuthFlowState,
) => {
  const oauthErrorCode = extractOauthErrorCode(state.error, state.lastResponse);
  return {
    status: "advanced" as const,
    previousStep,
    currentStep: state.currentStep,
    ok: !state.error,
    ...(oauthErrorCode ? { oauthErrorCode } : {}),
    ...(state.lastResponse ? { httpStatus: state.lastResponse.status } : {}),
  };
};

interface OAuthFlowTabProps {
  serverConfigs: Record<string, ServerWithName>;
  selectedServerName: string;
  hasHeaderServers?: boolean;
  areServersHydrated?: boolean;
  onSelectServer: (serverName: string) => void;
  // Resolves false when the save failed (the hook toasts the reason), so
  // callers can keep the modal open instead of treating every call as saved.
  onSaveServerConfig?: (
    formData: ServerFormData,
    options?: { oauthProfile?: OAuthTestProfile; originalServerName?: string },
  ) => void | boolean | Promise<void | boolean>;
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
  /**
   * Bumped by the shell when the header "Add Server" button is clicked while
   * this tab is active, so the Configure-OAuth-Target modal opens instead of
   * the generic Add Server modal. Each new value (not the initial one) opens it.
   */
  openProfileModalSignal?: number;
}

export const OAuthFlowTab = ({
  serverConfigs,
  selectedServerName,
  hasHeaderServers = false,
  areServersHydrated = true,
  onSelectServer,
  onSaveServerConfig,
  onConnectWithTokens,
  onRefreshTokens,
  openProfileModalSignal,
}: OAuthFlowTabProps) => {
  const [isProfileModalOpen, setIsProfileModalOpen] = useState(false);
  // "edit" opens the modal prefilled with the selected server; "add" opens it
  // blank so a new target can be saved without touching the current one.
  const [profileModalMode, setProfileModalMode] = useState<"edit" | "add">(
    "edit",
  );
  // Prefill set by the openOauthServerConfig agent command. Human-opened
  // modals clear it first so a stale agent seed never bleeds into them; it is
  // also cleared whenever the modal closes.
  const [agentSeed, setAgentSeed] = useState<OAuthProfileAgentSeed | null>(
    null,
  );
  const openProfileModal = useCallback((mode: "edit" | "add") => {
    setAgentSeed(null);
    setProfileModalMode(mode);
    setIsProfileModalOpen(true);
  }, []);
  const handleProfileModalOpenChange = useCallback((open: boolean) => {
    setIsProfileModalOpen(open);
    if (!open) setAgentSeed(null);
  }, []);

  // Open the modal when the shell bumps the signal (header "Add Server"). Skip
  // the initial value so it doesn't pop open on mount.
  const prevOpenSignalRef = useRef(openProfileModalSignal);
  useEffect(() => {
    if (openProfileModalSignal === prevOpenSignalRef.current) return;
    prevOpenSignalRef.current = openProfileModalSignal;
    // The header button reads "Add Server" — open blank, not prefilled with
    // the current selection.
    openProfileModal("add");
  }, [openProfileModalSignal, openProfileModal]);
  const [pendingServerSelection, setPendingServerSelection] = useState<
    string | null
  >(null);
  const [oauthFlowState, setOAuthFlowState] = useState<OAuthFlowState>(
    EMPTY_OAUTH_FLOW_STATE,
  );
  const [focusedStep, setFocusedStep] = useState<OAuthFlowStep | null>(null);
  const [isAuthModalOpen, setIsAuthModalOpen] = useState(false);
  const [isRefreshTokensModalOpen, setIsRefreshTokensModalOpen] =
    useState(false);
  const [isApplyingTokens, setIsApplyingTokens] = useState(false);

  const httpServerCount = useMemo(
    () =>
      Object.values(serverConfigs).filter((server) => isHttpServer(server))
        .length,
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
    // On a hard reload, the project server query resolves after this tab first
    // mounts. Do not mistake that loading gap for an empty project. If an
    // eligible server then appears in the header, also close any dialog opened
    // by the earlier empty state.
    if (!areServersHydrated) return;
    if (hasHeaderServers) {
      // Don't force-close a modal the agent just opened with a pending
      // prefill (servers can hydrate right after the command ran).
      if (!agentSeed) setIsProfileModalOpen(false);
      return;
    }
    if (httpServerCount === 0) {
      setIsProfileModalOpen(true);
    }
  }, [areServersHydrated, hasHeaderServers, httpServerCount, agentSeed]);

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

  // Synced SYNCHRONOUSLY by every writer below (not only via this effect):
  // the state machine's getState, the agent advance handler, and the surface
  // snapshot all read the ref right after an awaited step, where an
  // effect-only sync would still be one commit stale. Mirrors XAAFlowTab's
  // applyFlowState/updateFlowState. The effect stays as belt-and-braces.
  const oauthFlowStateRef = useRef(oauthFlowState);
  useEffect(() => {
    oauthFlowStateRef.current = oauthFlowState;
  }, [oauthFlowState]);

  const applyOAuthFlowState = useCallback((next: OAuthFlowState) => {
    oauthFlowStateRef.current = next;
    setOAuthFlowState(next);
  }, []);

  useEffect(() => {
    if (
      !import.meta.env.DEV ||
      !window.location.pathname.startsWith("/__e2e/oauth-debugger")
    ) {
      return;
    }

    window.__oauthDebuggerE2EFlowState = {
      authorizationUrl: oauthFlowState.authorizationUrl,
      currentStep: oauthFlowState.currentStep,
      state: oauthFlowState.state,
    };
  }, [
    oauthFlowState.authorizationUrl,
    oauthFlowState.currentStep,
    oauthFlowState.state,
  ]);

  useEffect(() => {
    setFocusedStep(null);
  }, [oauthFlowState.currentStep]);

  const updateOAuthFlowState = useCallback(
    (updates: Partial<OAuthFlowState>) => {
      oauthFlowStateRef.current = { ...oauthFlowStateRef.current, ...updates };
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
      applyOAuthFlowState({
        ...EMPTY_OAUTH_FLOW_STATE,
        serverUrl: profile.serverUrl || undefined,
      });
      processedCodeRef.current = null;
      if (exchangeTimeoutRef.current) {
        clearTimeout(exchangeTimeoutRef.current);
        exchangeTimeoutRef.current = null;
      }
    }
  }, [selectedServerName, profile.serverUrl, applyOAuthFlowState]);

  const resetOAuthFlow = useCallback(
    (serverUrlOverride?: string) => {
      const nextServerUrl = serverUrlOverride ?? profile.serverUrl;
      applyOAuthFlowState({
        ...EMPTY_OAUTH_FLOW_STATE,
        serverUrl: nextServerUrl || undefined,
      });
      processedCodeRef.current = null;
      if (exchangeTimeoutRef.current) {
        clearTimeout(exchangeTimeoutRef.current);
        exchangeTimeoutRef.current = null;
      }
    },
    [profile.serverUrl, applyOAuthFlowState],
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

    return createInspectorOAuthStateMachine({
      protocolVersion,
      state: oauthFlowStateRef.current,
      getState: () => oauthFlowStateRef.current,
      updateState: updateOAuthFlowState,
      serverUrl: profile.serverUrl,
      serverName: serverIdentifier,
      customScopes: profile.scopes.trim() || undefined,
      customHeaders,
      registrationStrategy,
      preregisteredClientId: profile.clientId.trim() || undefined,
      preregisteredClientSecret: profile.clientSecret.trim() || undefined,
      hasClientSecret: Boolean(activeServer?.hasClientSecret),
    });
  }, [
    hasProfile,
    protocolVersion,
    profile.serverUrl,
    profile.scopes,
    profile.clientId,
    profile.clientSecret,
    serverIdentifier,
    customHeaders,
    registrationStrategy,
    activeServer?.hasClientSecret,
    updateOAuthFlowState,
  ]);

  const proceedToNextStep = useCallback(async () => {
    if (oauthStateMachine) {
      await oauthStateMachine.proceedToNextStep();
    }
  }, [oauthStateMachine]);

  const handleAdvance = useCallback(async () => {
    track("oauth_flow_tab_next_step_button_clicked", {
      location: "oauth_flow_tab",
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

  // Determine if we can apply tokens (flow complete with access token)
  const isServerConnected = activeServer?.connectionStatus === "connected";
  const canApplyTokens =
    oauthFlowState.currentStep === "complete" &&
    oauthFlowState.accessToken &&
    activeServer;

  // Memoized: the modal's reseed-on-open effect depends on this array (via
  // generateDefaultName), so a fresh Object.keys() per render re-seeds the
  // open modal on any parent re-render and wipes typed values.
  const existingServerNames = useMemo(
    () => Object.keys(serverConfigs),
    [serverConfigs],
  );

  useSurfaceAgentBridge({
    surfaceId: "oauth-flow",
    handlers: {
      openOauthServerConfig: (command: InspectorCommand) => {
        const { payload } = command as OpenOauthServerConfigInspectorCommand;
        const requestedName = payload.serverName?.trim() || undefined;
        const requestedUrl = payload.serverUrl?.trim() || undefined;
        let registrationStrategy;
        if (payload.registrationMode !== undefined) {
          registrationStrategy = normalizeOAuthRegistrationStrategy(
            payload.registrationMode,
          );
          if (!registrationStrategy) {
            throw createInspectorCommandClientError(
              "invalid_request",
              `Unknown registration mode "${String(payload.registrationMode)}" — use preregistered, dcr, or cimd.`,
            );
          }
        }
        const plan = planAuthConfigModal({
          requestedServerName: requestedName,
          selectedServerName: activeServer?.name ?? null,
          existingServerNames,
        });
        if ("reject" in plan) {
          throw createInspectorCommandClientError("invalid_request", plan.reject);
        }
        // Editing the selected server: a seeded registration mode must be one
        // its configured protocol version supports (e.g. 2025-03-26 has no
        // CIMD) — reject naming the supported set instead of letting the form
        // show an impossible value.
        if (plan.mode === "edit" && registrationStrategy && hasProfile) {
          const supported = getSupportedRegistrationStrategies(protocolVersion);
          if (!supported.includes(registrationStrategy)) {
            throw createInspectorCommandClientError(
              "invalid_request",
              `Registration mode "${registrationStrategy}" is not supported by protocol ${protocolVersion}. Supported: ${supported.join(", ")}.`,
            );
          }
        }
        setAgentSeed({
          ...(requestedName ? { serverName: requestedName } : {}),
          ...(requestedUrl ? { serverUrl: requestedUrl } : {}),
          ...(registrationStrategy ? { registrationStrategy } : {}),
        });
        setProfileModalMode(plan.mode);
        setIsProfileModalOpen(true);
        return {
          status: "form_opened",
          mode: plan.mode,
          note: "The Configure-Server modal is open for the user to review, complete (credentials are typed by the human), and save.",
        };
      },
      advanceOauthFlow: async () => {
        if (!hasProfile || !oauthStateMachine) {
          throw createInspectorCommandClientError(
            "invalid_request",
            "No OAuth target is configured — open one with ui_open_oauth_server_config first.",
          );
        }
        const before = oauthFlowStateRef.current;
        if (before.isInitiatingAuth) {
          throw createInspectorCommandClientError(
            "execution_failed",
            "A protocol step is already in flight — check ui_snapshot_app and retry once it settles.",
          );
        }
        if (before.currentStep === "complete") {
          throw createInspectorCommandClientError(
            "invalid_request",
            "The flow is already complete — use ui_reset_oauth_flow to run it again.",
          );
        }
        const previousStep = before.currentStep;
        // Mirror handleAdvance exactly, including its order at the PKCE step:
        // advance FIRST (that generates the authorizationUrl the auth modal
        // needs to render), then hand off to the human popup.
        if (
          previousStep === "authorization_request" ||
          previousStep === "generate_pkce_parameters"
        ) {
          if (previousStep === "generate_pkce_parameters") {
            await proceedToNextStep();
          }
          const after = oauthFlowStateRef.current;
          if (!after.authorizationUrl || after.error) {
            return buildAdvanceResult(previousStep, after);
          }
          setIsAuthModalOpen(true);
          return {
            status: "authorization_modal_opened",
            currentStep: after.currentStep,
            note: "A human must complete sign-in in the authorization popup — the agent cannot and must not do this. If no popup appeared, ask the user to check their popup blocker. The flow advances automatically after the callback; observe with ui_snapshot_app instead of calling this again.",
          };
        }
        // Known race, accepted: the 500ms post-callback exchange timer can
        // auto-advance concurrently — identical exposure to the human button.
        await proceedToNextStep();
        return buildAdvanceResult(previousStep, oauthFlowStateRef.current);
      },
      resetOauthFlow: () => {
        if (!hasProfile) {
          throw createInspectorCommandClientError(
            "invalid_request",
            "No OAuth target is configured — nothing to reset.",
          );
        }
        if (oauthFlowStateRef.current.isInitiatingAuth) {
          throw createInspectorCommandClientError(
            "execution_failed",
            "A protocol step is in flight — wait for it to settle before resetting.",
          );
        }
        resetOAuthFlow();
        return { status: "reset", currentStep: "idle" };
      },
    },
    snapshot: () => {
      const view = oauthFlowStateRef.current;
      return buildOAuthFlowSnapshot({
        hasProfile,
        serverName: hasProfile ? serverIdentifier : undefined,
        protocolVersion: hasProfile ? protocolVersion : undefined,
        registrationStrategy: hasProfile
          ? describeRegistrationStrategy(registrationStrategy)
          : undefined,
        scopes: hasProfile ? profile.scopes.trim() || undefined : undefined,
        clientId: hasProfile ? profile.clientId.trim() || undefined : undefined,
        customHeaderCount: profile.customHeaders.filter((h) => h.key.trim())
          .length,
        hasAccessToken: Boolean(view.accessToken),
        hasRefreshToken: Boolean(view.refreshToken),
        serverConnected: isServerConnected,
        readyToApplyTokens: Boolean(canApplyTokens),
        steps: hasProfile
          ? toSafeSequenceSteps(
              buildOAuthSequenceActions({
                protocolVersion,
                registrationStrategy,
                flowState: view,
              }),
            )
          : [],
        view,
      });
    },
  });

  // Extract tokens from flow state
  const extractTokensFromFlowState = useCallback(
    (): OAuthTokensFromFlow => ({
      accessToken: oauthFlowState.accessToken!,
      refreshToken: oauthFlowState.refreshToken,
      tokenType: oauthFlowState.tokenType,
      expiresIn: oauthFlowState.expiresIn,
      clientId: oauthFlowState.clientId,
      clientSecret: oauthFlowState.clientSecret,
      authorizationServerUrl: oauthFlowState.authorizationServerUrl,
    }),
    [
      oauthFlowState.accessToken,
      oauthFlowState.refreshToken,
      oauthFlowState.tokenType,
      oauthFlowState.expiresIn,
      oauthFlowState.clientId,
      oauthFlowState.clientSecret,
      oauthFlowState.authorizationServerUrl,
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

    const handleElectronOAuthCallback = (event: Event) => {
      const callbackUrl = (event as CustomEvent<string>).detail;
      if (!callbackUrl) {
        return;
      }

      try {
        const parsed = new URL(callbackUrl);
        if (parsed.searchParams.get("flow") !== "debug") {
          return;
        }

        const error = parsed.searchParams.get("error");
        const errorDescription = parsed.searchParams.get("error_description");
        if (error) {
          if (exchangeTimeoutRef.current) {
            clearTimeout(exchangeTimeoutRef.current);
            exchangeTimeoutRef.current = null;
          }

          updateOAuthFlowState({
            error: errorDescription ?? error,
          });
          return;
        }

        const code = parsed.searchParams.get("code");
        const state = parsed.searchParams.get("state");
        if (code) {
          processOAuthCallback(code, state ?? undefined);
        }
      } catch (error) {
        console.error("Failed to process Electron OAuth callback:", error);
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
    window.addEventListener(
      "electron-oauth-callback",
      handleElectronOAuthCallback as EventListener,
    );
    return () => {
      window.removeEventListener("message", handleMessage);
      window.removeEventListener(
        "electron-oauth-callback",
        handleElectronOAuthCallback as EventListener,
      );
      channel?.close();
    };
  }, [oauthStateMachine, updateOAuthFlowState]);

  useEffect(() => {
    track("oauth_flow_tab_viewed", {
      location: "oauth_flow_tab",
    });
  }, []);

  const headerDescription = hasProfile
    ? profile.serverUrl
    : "Paste an MCP base URL to start debugging the OAuth flow.";

  return (
    <div className="h-full flex flex-col bg-background">
      <div className="flex-1 overflow-hidden">
        {hasProfile ? (
          <ResizablePanelGroup direction="horizontal" className="h-full">
            <ResizablePanel defaultSize={50} minSize={30}>
              <OAuthSequenceDiagram
                flowState={oauthFlowState}
                registrationStrategy={registrationStrategy}
                protocolVersion={protocolVersion}
                focusedStep={focusedStep}
                hasProfile={hasProfile}
                onConfigure={() => openProfileModal("edit")}
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
                hasProfile={hasProfile}
                summary={{
                  label: hasProfile
                    ? serverIdentifier
                    : "No target configured",
                  description: headerDescription,
                  protocol: hasProfile ? protocolVersion : undefined,
                  registration: hasProfile
                    ? describeRegistrationStrategy(registrationStrategy)
                    : undefined,
                  step: oauthFlowState.currentStep,
                  serverUrl: hasProfile ? profile.serverUrl : undefined,
                  scopes:
                    hasProfile && profile.scopes.trim()
                      ? profile.scopes.trim()
                      : undefined,
                  clientId:
                    hasProfile && profile.clientId.trim()
                      ? profile.clientId.trim()
                      : undefined,
                  customHeadersCount: hasProfile
                    ? profile.customHeaders.filter((h) => h.key.trim()).length
                    : undefined,
                }}
                actions={{
                  onConfigure: () => openProfileModal("edit"),
                  onAddServer: () => openProfileModal("add"),
                  onReset: hasProfile ? () => resetOAuthFlow() : undefined,
                  // Hide Continue button when showing Connect/Refresh buttons
                  onContinue:
                    canApplyTokens || continueDisabled
                      ? undefined
                      : handleAdvance,
                  continueLabel,
                  continueDisabled: Boolean(
                    canApplyTokens || continueDisabled
                  ),
                  resetDisabled:
                    !hasProfile || oauthFlowState.isInitiatingAuth,
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
        ) : (
          // Empty / unconfigured: keep progressive disclosure tight — just the
          // diagram with its centered "Configure OAuth Target" overlay. The
          // logs sidebar only earns its space once a target is configured.
          <OAuthSequenceDiagram
            flowState={oauthFlowState}
            registrationStrategy={registrationStrategy}
            protocolVersion={protocolVersion}
            focusedStep={focusedStep}
            hasProfile={false}
            showConfigurePrompt={areServersHydrated && !hasHeaderServers}
            onConfigure={() => openProfileModal("edit")}
          />
        )}
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
        onOpenChange={handleProfileModalOpenChange}
        server={profileModalMode === "add" ? undefined : activeServer}
        existingServerNames={existingServerNames}
        agentSeed={agentSeed}
        onSave={async ({ formData, profile: savedProfile }) => {
          // Await and check the result: a failed save must not close the modal,
          // reset the flow, or move the selection onto a server that was never
          // written. The hook already toasted the reason, so throw a generic
          // message for the modal's inline error.
          const saved = await onSaveServerConfig?.(formData, {
            oauthProfile: savedProfile,
            originalServerName:
              profileModalMode === "add" ? undefined : activeServer?.name,
          });
          if (saved === false) {
            throw new Error("Could not save the server. Please try again.");
          }
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
