import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import posthog from "posthog-js";
import { Loader2, Play } from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import type { ServerWithName } from "@/hooks/use-app-state";
import { detectEnvironment, detectPlatform } from "@/lib/PosthogUtils";
import { useXaaResourceApps } from "@/hooks/useXaaResourceApps";
import { XAASequenceDiagram } from "./XAASequenceDiagram";
import { XAAFlowLogger } from "./XAAFlowLogger";
import { XAAConfigModal } from "./XAAConfigModal";
import { XAAIdpCard } from "./XAAIdpCard";
import { XAAResourceAppsSection } from "./registration/XAAResourceAppsSection";
import { XAARunChips } from "./XAARunChips";
import { NegativeTestScorecard } from "./NegativeTestScorecard";
import type { NegativeTestsInput } from "@/lib/xaa/discovery-client";
import type { NegativeTestMode } from "@/shared/xaa.js";
import {
  createInitialXAAFlowState,
  type XAAFlowState,
  type XAAFlowStep,
  type XaaResourceApp,
} from "@/lib/xaa/types";
import {
  clearStoredXAADebugProfile,
  deriveXAADebugProfileFromServer,
  EMPTY_XAA_DEBUG_PROFILE,
  loadStoredXAADebugProfile,
  saveStoredXAADebugProfile,
  type XAADebugProfile,
} from "@/lib/xaa/profile";
import { createInspectorXAAStateMachine } from "@/lib/xaa/debug-state-machine-adapter";
import { fetchXaaIdpUrls } from "@/lib/xaa/idp-endpoints";

// Captured at module load: the XAA route returns null while the feature flag
// bootstraps and other startup code rewrites location.search, so reading the
// deep link lazily would race. Consumed once the registration list resolves.
const INITIAL_RESOURCE_PARAM =
  typeof window === "undefined"
    ? null
    : new URLSearchParams(window.location.search).get("resource");

const isHttpServer = (server?: ServerWithName) =>
  Boolean(server && "url" in server.config);

/**
 * The single mode-resolved input the runner consumes. Hosted runs against a
 * selected registration; everything else uses the manual debug profile.
 */
interface XAAFlowInput {
  mode: "hosted-registration" | "local-profile";
  registrationId?: string;
  serverUrl: string;
  authzServerIssuer: string;
  clientId: string;
  /** Manual-profile runs only; registration-backed runs resolve the stored
   * secret server-side and keep this empty. */
  clientSecret: string;
  scope: string;
  userId: string;
  email: string;
  negativeTestMode: NegativeTestMode;
}

function buildFlowStateFromInput(input: XAAFlowInput): XAAFlowState {
  return createInitialXAAFlowState({
    serverUrl: input.serverUrl || undefined,
    authzServerIssuer: input.authzServerIssuer || undefined,
    negativeTestMode: input.negativeTestMode,
    userId: input.userId || undefined,
    email: input.email || undefined,
    clientId: input.clientId || undefined,
    clientSecret: input.clientSecret || undefined,
    scope: input.scope || undefined,
  });
}

function inputFromProfile(profile: XAADebugProfile): XAAFlowInput {
  return {
    mode: "local-profile",
    serverUrl: profile.serverUrl,
    authzServerIssuer: profile.authzServerIssuer,
    clientId: profile.clientId,
    clientSecret: profile.clientSecret,
    scope: profile.scope,
    userId: profile.userId,
    email: profile.email,
    negativeTestMode: profile.negativeTestMode,
  };
}

function inputFromRegistration(
  registration: XaaResourceApp,
  profile: XAADebugProfile
): XAAFlowInput {
  return {
    mode: "hosted-registration",
    registrationId: registration.id,
    serverUrl: registration.resourceUrl,
    authzServerIssuer: registration.issuer ?? "",
    clientId: registration.targetClientId ?? "",
    // The stored secret never enters the browser; /proxy/token resolves it.
    clientSecret: "",
    scope: (registration.scopes ?? []).join(" "),
    // Synthetic identity stays user-configurable regardless of source.
    userId: profile.userId,
    email: profile.email,
    negativeTestMode: profile.negativeTestMode,
  };
}

interface XAAFlowTabProps {
  serverConfigs: Record<string, ServerWithName>;
  selectedServerName: string;
  organizationId?: string | null;
}

export function XAAFlowTab({
  serverConfigs,
  selectedServerName,
  organizationId,
}: XAAFlowTabProps) {
  const [isConfigModalOpen, setIsConfigModalOpen] = useState(false);
  const [focusedStep, setFocusedStep] = useState<XAAFlowStep | null>(null);
  const [isRunningAll, setIsRunningAll] = useState(false);

  const selectedServer =
    selectedServerName !== "none"
      ? serverConfigs[selectedServerName]
      : undefined;
  const activeServer = isHttpServer(selectedServer)
    ? selectedServer
    : undefined;

  const [profile, setProfile] = useState(() =>
    deriveXAADebugProfileFromServer(activeServer, loadStoredXAADebugProfile())
  );
  const [flowState, setFlowState] = useState<XAAFlowState>(() =>
    buildFlowStateFromInput(
      inputFromProfile(
        deriveXAADebugProfileFromServer(
          activeServer,
          loadStoredXAADebugProfile()
        )
      )
    )
  );

  // The machine reads state through this ref (lazy getState). Keep it in
  // sync *synchronously* with every write so a run that resets and then
  // immediately advances never observes a stale snapshot.
  const flowStateRef = useRef(flowState);

  // Set when the user explicitly clears their config, so the auto-derive-from
  // -server effect below doesn't immediately re-fill the target — letting the
  // tab return to the initial "Configure XAA Target" screen. Reset on save.
  const suppressAutoDerive = useRef(false);

  const applyFlowState = useCallback((next: XAAFlowState) => {
    flowStateRef.current = next;
    setFlowState(next);
  }, []);

  const updateFlowState = useCallback((updates: Partial<XAAFlowState>) => {
    flowStateRef.current = { ...flowStateRef.current, ...updates };
    setFlowState((current) => ({ ...current, ...updates }));
  }, []);

  // ── Registration selection (hosted) ────────────────────────────────
  const { resourceApps } = useXaaResourceApps(organizationId ?? null);
  const [selectedRegistrationId, setSelectedRegistrationId] = useState<
    string | null
  >(null);
  const deepLinkConsumed = useRef(false);

  useEffect(() => {
    if (deepLinkConsumed.current || !INITIAL_RESOURCE_PARAM) return;
    const match = resourceApps.find((app) => app.id === INITIAL_RESOURCE_PARAM);
    if (match) {
      deepLinkConsumed.current = true;
      setSelectedRegistrationId(match.id);
    }
  }, [resourceApps]);

  const selectedRegistration =
    resourceApps.find((app) => app.id === selectedRegistrationId) ?? null;

  const flowInput = useMemo(
    () =>
      selectedRegistration
        ? inputFromRegistration(selectedRegistration, profile)
        : inputFromProfile(profile),
    [selectedRegistration, profile]
  );

  // Target identity for the positive-run gate; "local-profile" is its own
  // session-scoped key.
  const targetKey = selectedRegistration?.id ?? "local-profile";

  // ── Telemetry (started / terminal completed, once per run) ─────────
  const completedFired = useRef(false);
  const authServerModeForTelemetry =
    selectedRegistration?.authServerMode ?? "own";

  // In-memory: targets that have completed a successful flow this session.
  // A page refresh clears it, re-locking the scorecard (§ negative-test gate).
  const [positiveRunTargets, setPositiveRunTargets] = useState<Set<string>>(
    () => new Set()
  );

  const fireFlowStarted = useCallback(() => {
    completedFired.current = false;
    posthog.capture("xaa_flow_started", {
      mode: flowInput.mode,
      auth_server_mode: authServerModeForTelemetry,
      platform: detectPlatform(),
      environment: detectEnvironment(),
    });
  }, [flowInput.mode, authServerModeForTelemetry]);

  useEffect(() => {
    if (flowState.currentStep === "complete" && !completedFired.current) {
      completedFired.current = true;
      posthog.capture("xaa_flow_completed", {
        success: true,
        auth_server_mode: authServerModeForTelemetry,
        platform: detectPlatform(),
        environment: detectEnvironment(),
      });
      // A green run proves the user holds valid client credentials the AS
      // issued — that authorizes broken-token testing against it.
      setPositiveRunTargets((current) => {
        if (current.has(targetKey)) return current;
        const next = new Set(current);
        next.add(targetKey);
        return next;
      });
    }
  }, [flowState.currentStep, authServerModeForTelemetry, targetKey]);

  // ── Negative-test scorecard input ───────────────────────────────────
  const scorecard = useMemo((): {
    input: NegativeTestsInput | null;
    unavailableReason?: string;
  } => {
    const audience =
      flowState.authzMetadata?.issuer ||
      flowInput.authzServerIssuer ||
      selectedRegistration?.issuer ||
      "";
    const resource =
      flowState.resourceMetadata?.resource || flowInput.serverUrl || "";

    if (selectedRegistration) {
      if (selectedRegistration.authServerMode === "mcpjam") {
        return {
          input: null,
          unavailableReason:
            "The MCPJam test auth server validates its own assertions — there's nothing to fire broken tokens at.",
        };
      }
      if (!audience || !resource) {
        return {
          input: null,
          unavailableReason:
            "Run the flow once so the auth server issuer is known.",
        };
      }
      return {
        input: {
          registrationId: selectedRegistration.id,
          audience,
          resource,
          clientId: flowInput.clientId || undefined,
          scope: flowInput.scope || undefined,
        },
      };
    }

    // Local profile: the token endpoint comes from discovery during a run.
    if (!flowState.tokenEndpoint) {
      return {
        input: null,
        unavailableReason:
          "Run the flow first so the token endpoint is discovered.",
      };
    }
    if (!audience || !resource) {
      return { input: null };
    }
    return {
      input: {
        tokenEndpoint: flowState.tokenEndpoint,
        audience,
        resource,
        clientId: flowInput.clientId || undefined,
        clientSecret: flowInput.clientSecret || undefined,
        scope: flowInput.scope || undefined,
      },
    };
  }, [flowState, flowInput, selectedRegistration]);

  // ── Flow-state lifecycle ────────────────────────────────────────────
  useEffect(() => {
    if (
      suppressAutoDerive.current ||
      selectedRegistration ||
      profile.serverUrl.trim()
    ) {
      return;
    }

    const derived = deriveXAADebugProfileFromServer(activeServer, profile);
    setProfile(derived);
    applyFlowState(buildFlowStateFromInput(inputFromProfile(derived)));
    // Matches the original effect: keyed on serverUrl, not the profile
    // object, so the derived profile (a fresh object) can't retrigger it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeServer, profile.serverUrl, selectedRegistration]);

  useEffect(() => {
    setFocusedStep(null);
  }, [flowState.currentStep]);

  useEffect(() => {
    posthog.capture("xaa_tab_viewed", {
      location: "xaa_flow_tab",
      platform: detectPlatform(),
      environment: detectEnvironment(),
    });
  }, []);

  // Switching the run target (registration picked/cleared) starts a fresh
  // flow against it.
  const lastAppliedRegistrationId = useRef<string | null>(null);
  useEffect(() => {
    if (lastAppliedRegistrationId.current === selectedRegistrationId) {
      return;
    }
    lastAppliedRegistrationId.current = selectedRegistrationId;
    applyFlowState(buildFlowStateFromInput(flowInput));
    setFocusedStep(null);
  }, [selectedRegistrationId, flowInput, applyFlowState]);

  const resetFlow = useCallback(
    (nextProfile?: XAADebugProfile) => {
      const input = nextProfile
        ? selectedRegistration
          ? inputFromRegistration(selectedRegistration, nextProfile)
          : inputFromProfile(nextProfile)
        : flowInput;
      applyFlowState(buildFlowStateFromInput(input));
      setFocusedStep(null);
    },
    [flowInput, selectedRegistration, applyFlowState]
  );

  const handleChangeNegativeTestMode = useCallback((mode: NegativeTestMode) => {
    setProfile((current) => {
      const next = { ...current, negativeTestMode: mode };
      saveStoredXAADebugProfile(next);
      return next;
    });
    setFocusedStep(null);
  }, []);

  // Rebuild the flow when the negative-test mode changes (profile-sourced in
  // both modes).
  const lastNegativeTestMode = useRef(profile.negativeTestMode);
  useEffect(() => {
    if (lastNegativeTestMode.current === profile.negativeTestMode) {
      return;
    }
    lastNegativeTestMode.current = profile.negativeTestMode;
    applyFlowState(buildFlowStateFromInput(flowInput));
  }, [profile.negativeTestMode, flowInput, applyFlowState]);

  const hasTarget = Boolean(flowInput.serverUrl.trim());

  // Resolve the real IdP issuer from the server's OpenID config so the ID-JAG
  // inspection step lints against the issuer actually stamped into `iss`, not
  // the browser origin (which differs from the backend through the dev proxy).
  const [resolvedIssuerBaseUrl, setResolvedIssuerBaseUrl] = useState<
    string | undefined
  >(undefined);
  useEffect(() => {
    const controller = new AbortController();
    void fetchXaaIdpUrls(controller.signal).then((urls) => {
      if (urls && !controller.signal.aborted) {
        setResolvedIssuerBaseUrl(urls.issuerBaseUrl);
      }
    });
    return () => controller.abort();
  }, []);

  const xaaStateMachine = useMemo(() => {
    return createInspectorXAAStateMachine({
      getState: () => flowStateRef.current,
      updateState: updateFlowState,
      serverUrl: flowInput.serverUrl || "http://localhost",
      negativeTestMode: flowInput.negativeTestMode,
      userId: flowInput.userId,
      email: flowInput.email,
      clientId: flowInput.clientId,
      clientSecret: flowInput.clientSecret,
      scope: flowInput.scope,
      authzServerIssuer: flowInput.authzServerIssuer,
      registrationId: flowInput.registrationId,
      issuerBaseUrl: resolvedIssuerBaseUrl,
    });
  }, [flowInput, updateFlowState, resolvedIssuerBaseUrl]);

  const handleAdvance = useCallback(async () => {
    if (!hasTarget) {
      setIsConfigModalOpen(true);
      return;
    }

    if (flowStateRef.current.currentStep === "idle") {
      fireFlowStarted();
    }
    await xaaStateMachine.proceedToNextStep();
  }, [hasTarget, xaaStateMachine, fireFlowStarted]);

  const handleRunAll = useCallback(async () => {
    if (!hasTarget) {
      setIsConfigModalOpen(true);
      return;
    }

    // Every Run all begins from a clean slate so the chips reflect this run.
    applyFlowState(buildFlowStateFromInput(flowInput));
    setFocusedStep(null);
    fireFlowStarted();
    setIsRunningAll(true);
    try {
      await xaaStateMachine.runAll();
    } finally {
      setIsRunningAll(false);
    }

    const final = flowStateRef.current;
    if (final.currentStep !== "complete" && !completedFired.current) {
      completedFired.current = true;
      posthog.capture("xaa_flow_completed", {
        success: false,
        // The step the run stopped on — an enum, never a raw error string.
        error_category: final.currentStep,
        auth_server_mode: authServerModeForTelemetry,
        platform: detectPlatform(),
        environment: detectEnvironment(),
      });
    }
  }, [
    hasTarget,
    flowInput,
    xaaStateMachine,
    applyFlowState,
    fireFlowStarted,
    authServerModeForTelemetry,
  ]);

  const continueLabel = !hasTarget
    ? "Configure Target"
    : flowState.currentStep === "idle"
    ? "Start"
    : flowState.currentStep === "inspect_id_jag"
    ? "Request Access Token"
    : flowState.currentStep === "received_access_token"
    ? "Call MCP Server"
    : flowState.currentStep === "complete"
    ? "Flow Complete"
    : "Continue";

  const continueDisabled =
    !hasTarget ||
    flowState.isBusy ||
    isRunningAll ||
    flowState.currentStep === "complete";

  const runAllDisabled = !hasTarget || flowState.isBusy || isRunningAll;

  return (
    <div className="h-full flex flex-col bg-background">
      <XAAIdpCard />
      <XAAResourceAppsSection
        organizationId={organizationId ?? null}
        selectedId={selectedRegistrationId}
        onSelect={(app) =>
          setSelectedRegistrationId((current) =>
            current === app.id ? null : app.id
          )
        }
      />
      <div className="flex items-center gap-3 border-b border-border px-4 py-2">
        <Button
          type="button"
          size="sm"
          onClick={handleRunAll}
          disabled={runAllDisabled}
        >
          {isRunningAll ? (
            <>
              <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
              Running
            </>
          ) : (
            <>
              <Play className="mr-1 h-3.5 w-3.5" />
              Run all
            </>
          )}
        </Button>
        <XAARunChips
          flowState={flowState}
          activeStep={focusedStep ?? flowState.currentStep}
          onFocusStep={setFocusedStep}
        />
        <span className="ml-auto min-w-0 truncate pl-2 text-xs text-muted-foreground">
          {selectedRegistration
            ? `Target: ${selectedRegistration.name}`
            : hasTarget
            ? `Target: ${flowInput.serverUrl}`
            : "No target configured"}
        </span>
      </div>
      <div className="flex-1 overflow-hidden">
        <ResizablePanelGroup direction="horizontal" className="h-full">
          <ResizablePanel defaultSize={52} minSize={30}>
            <XAASequenceDiagram
              flowState={flowState}
              focusedStep={focusedStep}
              hasProfile={hasTarget}
              onConfigure={() => setIsConfigModalOpen(true)}
            />
          </ResizablePanel>

          <ResizableHandle withHandle />

          <ResizablePanel defaultSize={48} minSize={24} maxSize={52}>
            <XAAFlowLogger
              flowState={flowState}
              hasProfile={hasTarget}
              activeStep={focusedStep ?? flowState.currentStep}
              onFocusStep={setFocusedStep}
              actions={{
                onConfigure: () => setIsConfigModalOpen(true),
                onReset: hasTarget ? () => resetFlow() : undefined,
                onContinue: continueDisabled ? undefined : handleAdvance,
                onChangeNegativeTestMode: handleChangeNegativeTestMode,
                continueLabel,
                continueDisabled,
                resetDisabled: !hasTarget || flowState.isBusy || isRunningAll,
              }}
              summary={{
                serverUrl: flowInput.serverUrl,
                authzServerIssuer: flowInput.authzServerIssuer || undefined,
                clientId: flowInput.clientId || undefined,
                scope: flowInput.scope || undefined,
                negativeTestMode: flowInput.negativeTestMode,
              }}
            />
          </ResizablePanel>
        </ResizablePanelGroup>
      </div>

      <NegativeTestScorecard
        input={scorecard.input}
        unlocked={positiveRunTargets.has(targetKey)}
        unavailableReason={scorecard.unavailableReason}
      />

      <XAAConfigModal
        open={isConfigModalOpen}
        onOpenChange={setIsConfigModalOpen}
        value={profile}
        onSave={(nextProfile) => {
          suppressAutoDerive.current = false;
          saveStoredXAADebugProfile(nextProfile);
          setProfile(nextProfile);
          resetFlow(nextProfile);
        }}
        onClear={() => {
          clearStoredXAADebugProfile();
          // Return to the initial "Configure XAA Target" screen and keep it
          // there — suppress the auto-derive effect so it doesn't re-fill.
          suppressAutoDerive.current = true;
          setSelectedRegistrationId(null);
          setProfile(EMPTY_XAA_DEBUG_PROFILE);
          applyFlowState(
            buildFlowStateFromInput(inputFromProfile(EMPTY_XAA_DEBUG_PROFILE))
          );
          setFocusedStep(null);
          setIsConfigModalOpen(false);
        }}
      />
    </div>
  );
}
