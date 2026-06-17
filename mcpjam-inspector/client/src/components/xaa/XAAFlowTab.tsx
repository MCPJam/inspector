import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import posthog from "posthog-js";
import { Loader2, Play, ShieldAlert } from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@mcpjam/design-system/alert-dialog";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import type { ServerWithName } from "@/hooks/use-app-state";
import type { ServerFormData } from "@/shared/types.js";
import { detectEnvironment, detectPlatform } from "@/lib/PosthogUtils";
import { useXaaResourceApps } from "@/hooks/useXaaResourceApps";
import { useXaaRunSettings } from "@/hooks/useXaaRunSettings";
import {
  useXaaTestTarget,
  type XAAFlowInput,
} from "@/hooks/useXaaTestTarget";
import { XAASequenceDiagram } from "./XAASequenceDiagram";
import { XAAFlowLogger } from "./XAAFlowLogger";
import { XAAServerModal } from "./XAAServerModal";
import { XAASimulatedIdentity } from "./XAASimulatedIdentity";
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
} from "@/lib/xaa/types";
import { createInspectorXAAStateMachine } from "@/lib/xaa/debug-state-machine-adapter";
import { fetchXaaIdpUrls } from "@/lib/xaa/idp-endpoints";
import { hashXaaTargetId } from "@/lib/xaa/target-telemetry";

// Captured at module load: the XAA route returns null while the feature flag
// bootstraps and other startup code rewrites location.search, so reading the
// deep link lazily would race. Consumed once the registration list resolves.
const INITIAL_RESOURCE_PARAM =
  typeof window === "undefined"
    ? null
    : new URLSearchParams(window.location.search).get("resource");

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

interface XAAFlowTabProps {
  serverConfigs: Record<string, ServerWithName>;
  selectedServerName: string;
  organizationId?: string | null;
  /** Active Convex project id — resolves the selected server's id + project
   * for server-side secret resolution. */
  projectId?: string | null;
  // Shared server-bar callbacks (mirror the OAuth Debugger).
  onSelectServer?: (serverName: string) => void;
  onSaveServerConfig?: (formData: ServerFormData) => void | Promise<void>;
}

export function XAAFlowTab({
  serverConfigs,
  selectedServerName,
  organizationId,
  projectId,
  onSelectServer,
  onSaveServerConfig,
}: XAAFlowTabProps) {
  const [isServerModalOpen, setIsServerModalOpen] = useState(false);
  const [focusedStep, setFocusedStep] = useState<XAAFlowStep | null>(null);
  const [isRunningAll, setIsRunningAll] = useState(false);

  const selectedServer =
    selectedServerName !== "none"
      ? serverConfigs[selectedServerName]
      : undefined;

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

  // Selecting a bar chip clears an active registration so the bar server wins
  // (one canonical active target). Guarded by a ref so the deep-link
  // registration selection — which doesn't change the bar — isn't cleared.
  const prevSelectedServerName = useRef(selectedServerName);
  useEffect(() => {
    if (prevSelectedServerName.current === selectedServerName) return;
    prevSelectedServerName.current = selectedServerName;
    if (selectedServerName !== "none") {
      setSelectedRegistrationId(null);
    }
  }, [selectedServerName]);

  // ── Global run settings + resolved target ──────────────────────────
  const runSettings = useXaaRunSettings();
  const target = useXaaTestTarget({
    server: selectedServer,
    selectedServerName,
    selectedRegistration,
    runSettings,
    projectId: projectId ?? null,
  });
  const runInput = target.runInput;
  const { targetKey, isTestable } = target;

  const [flowState, setFlowState] = useState<XAAFlowState>(() =>
    buildFlowStateFromInput(target.runInput)
  );

  // The machine reads state through this ref (lazy getState). Keep it in
  // sync *synchronously* with every write so a run that resets and then
  // immediately advances never observes a stale snapshot.
  const flowStateRef = useRef(flowState);

  const applyFlowState = useCallback((next: XAAFlowState) => {
    flowStateRef.current = next;
    setFlowState(next);
  }, []);

  const updateFlowState = useCallback((updates: Partial<XAAFlowState>) => {
    flowStateRef.current = { ...flowStateRef.current, ...updates };
    setFlowState((current) => ({ ...current, ...updates }));
  }, []);

  // ── Telemetry (started / terminal completed, once per run) ─────────
  const completedFired = useRef(false);
  const authServerModeForTelemetry =
    selectedRegistration?.authServerMode ?? "own";
  // Captured in a ref so the success effect (which can fire on a re-render
  // after the run) reports the source the run actually used. Written in an
  // effect, never during render (React 18 concurrent rule).
  const targetSourceRef = useRef(target.targetSource);
  useEffect(() => {
    targetSourceRef.current = target.targetSource;
  }, [target.targetSource]);

  // In-memory: targets that have completed a successful flow this session,
  // keyed per target so a green run on one server can't unlock another's
  // scorecard. A page refresh clears it, re-locking the scorecard.
  const [positiveRunTargets, setPositiveRunTargets] = useState<Set<string>>(
    () => new Set()
  );

  const fireFlowStarted = useCallback(() => {
    completedFired.current = false;
    posthog.capture("xaa_flow_started", {
      mode: runInput.mode,
      target_source: target.targetSource,
      // Salted one-way bucket id — never a server name/URL/hostname.
      target_id: hashXaaTargetId(targetKey),
      auth_server_mode: authServerModeForTelemetry,
      platform: detectPlatform(),
      environment: detectEnvironment(),
    });
  }, [runInput.mode, target.targetSource, targetKey, authServerModeForTelemetry]);

  useEffect(() => {
    if (flowState.currentStep === "complete" && !completedFired.current) {
      completedFired.current = true;
      posthog.capture("xaa_flow_completed", {
        success: true,
        target_source: targetSourceRef.current,
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
      runInput.authzServerIssuer ||
      selectedRegistration?.issuer ||
      "";
    const resource =
      flowState.resourceMetadata?.resource || runInput.serverUrl || "";

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
          clientId: runInput.clientId || undefined,
          scope: runInput.scope || undefined,
        },
      };
    }

    // Confidential bar server: the secret + token endpoint are resolved
    // server-side from the stored config — only the issuer/resource matter.
    if (target.usesServerSideSecret && target.serverId) {
      if (!audience || !resource) {
        return {
          input: null,
          unavailableReason:
            "Run the flow once so the auth server issuer is known.",
        };
      }
      return {
        input: {
          serverId: target.serverId,
          projectId: target.projectId,
          audience,
          resource,
          clientId: runInput.clientId || undefined,
          scope: runInput.scope || undefined,
        },
      };
    }

    // Public bar server: the token endpoint comes from discovery during a run.
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
        clientId: runInput.clientId || undefined,
        scope: runInput.scope || undefined,
      },
    };
  }, [flowState, runInput, selectedRegistration, target]);

  // ── Single target-reset owner ──────────────────────────────────────
  // One effect keyed on (targetKey, negativeTestMode) rebuilds the flow when
  // the resolved target or the global mode changes. Guarded by value-compared
  // refs; confirms via AlertDialog before discarding a busy or completed run.
  const lastAppliedTargetKey = useRef<string | null>(null);
  const lastNegativeTestMode = useRef(runSettings.negativeTestMode);
  const [pendingReset, setPendingReset] = useState<{
    targetKey: string;
    negativeTestMode: NegativeTestMode;
  } | null>(null);

  const applyTargetReset = useCallback(
    (nextTargetKey: string, nextMode: NegativeTestMode) => {
      lastAppliedTargetKey.current = nextTargetKey;
      lastNegativeTestMode.current = nextMode;
      applyFlowState(buildFlowStateFromInput(runInput));
      setFocusedStep(null);
    },
    [applyFlowState, runInput]
  );

  useEffect(() => {
    const nextMode = runSettings.negativeTestMode;
    if (
      lastAppliedTargetKey.current === targetKey &&
      lastNegativeTestMode.current === nextMode
    ) {
      return;
    }

    const current = flowStateRef.current;
    const needsConfirm =
      lastAppliedTargetKey.current !== null &&
      (current.isBusy || current.currentStep === "complete");
    if (needsConfirm) {
      setPendingReset({ targetKey, negativeTestMode: nextMode });
      return;
    }
    applyTargetReset(targetKey, nextMode);
  }, [targetKey, runSettings.negativeTestMode, applyTargetReset]);

  useEffect(() => {
    setFocusedStep(null);
  }, [flowState.currentStep]);

  useEffect(() => {
    posthog.capture("xaa_tab_viewed", {
      location: "xaa_flow_tab",
      target_count: resourceApps.length + Object.keys(serverConfigs).length,
      platform: detectPlatform(),
      environment: detectEnvironment(),
    });
    // Fires once per mount; the counts are a point-in-time anchor.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const resetFlow = useCallback(() => {
    applyFlowState(buildFlowStateFromInput(runInput));
    setFocusedStep(null);
  }, [runInput, applyFlowState]);

  const handleChangeNegativeTestMode = useCallback(
    (mode: NegativeTestMode) => {
      runSettings.setNegativeTestMode(mode);
      setFocusedStep(null);
    },
    [runSettings]
  );

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
      serverUrl: runInput.serverUrl || "http://localhost",
      negativeTestMode: runInput.negativeTestMode,
      userId: runInput.userId,
      email: runInput.email,
      clientId: runInput.clientId,
      clientSecret: runInput.clientSecret,
      scope: runInput.scope,
      authzServerIssuer: runInput.authzServerIssuer,
      registrationId: runInput.registrationId,
      // Confidential bar-server runs send only serverId/projectId; the server
      // resolves the secret and discovers the token endpoint.
      ...(target.usesServerSideSecret && target.serverId
        ? { serverId: target.serverId, projectId: target.projectId }
        : {}),
      issuerBaseUrl: resolvedIssuerBaseUrl,
    });
  }, [runInput, target, updateFlowState, resolvedIssuerBaseUrl]);

  const handleAdvance = useCallback(async () => {
    if (!isTestable) {
      setIsServerModalOpen(true);
      return;
    }

    if (flowStateRef.current.currentStep === "idle") {
      fireFlowStarted();
    }
    await xaaStateMachine.proceedToNextStep();
  }, [isTestable, xaaStateMachine, fireFlowStarted]);

  const handleRunAll = useCallback(async () => {
    if (!isTestable) {
      setIsServerModalOpen(true);
      return;
    }

    // Every Run all begins from a clean slate so the chips reflect this run.
    applyFlowState(buildFlowStateFromInput(runInput));
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
        target_source: targetSourceRef.current,
        // The step the run stopped on — an enum, never a raw error string.
        error_category: final.currentStep,
        auth_server_mode: authServerModeForTelemetry,
        platform: detectPlatform(),
        environment: detectEnvironment(),
      });
    }
  }, [
    isTestable,
    runInput,
    xaaStateMachine,
    applyFlowState,
    fireFlowStarted,
    authServerModeForTelemetry,
  ]);

  const continueLabel = !isTestable
    ? "Configure Server to Test"
    : flowState.negativeProbe
    ? "Negative test complete"
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
    !isTestable ||
    flowState.isBusy ||
    isRunningAll ||
    flowState.currentStep === "complete" ||
    Boolean(flowState.negativeProbe);

  const runAllDisabled = !isTestable || flowState.isBusy || isRunningAll;

  const targetName = selectedRegistration
    ? selectedRegistration.name
    : selectedServerName !== "none"
    ? selectedServerName
    : "";
  const targetBadge = selectedRegistration
    ? "registered app"
    : isTestable
    ? "from server"
    : "not testable";

  // Announce only the resolved target NAME (not badge flips), debounced so a
  // quick succession of switches doesn't spam the live region.
  const [announcedTarget, setAnnouncedTarget] = useState("");
  useEffect(() => {
    const id = setTimeout(() => setAnnouncedTarget(targetName), 250);
    return () => clearTimeout(id);
  }, [targetName]);

  // A server is selected but can't be XAA-tested (STDIO / non-OAuth).
  const showNotTestable =
    target.targetSource === "bar_server" && !isTestable;

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
        <span
          className="max-w-[40%] shrink-0 truncate pl-3 text-xs text-muted-foreground"
          aria-hidden="true"
        >
          {targetName ? (
            <>
              Target: {targetName}{" "}
              <span className="text-muted-foreground/70">· {targetBadge}</span>
            </>
          ) : (
            "No server selected"
          )}
        </span>
        <span className="sr-only" aria-live="polite">
          {announcedTarget ? `Target: ${announcedTarget}` : "No server selected"}
        </span>
        <div className="ml-auto shrink-0">
          <XAASimulatedIdentity />
        </div>
      </div>
      {selectedRegistration ? (
        <div className="flex items-center justify-between gap-2 border-b border-border bg-muted/30 px-4 py-1.5 text-xs text-muted-foreground">
          <span>Using registered app — overrides the bar selection</span>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-6 text-xs"
            onClick={() => setSelectedRegistrationId(null)}
          >
            Use bar server
          </Button>
        </div>
      ) : null}
      <div className="flex-1 overflow-hidden">
        {showNotTestable ? (
          <div className="flex h-full items-center justify-center p-6">
            <div className="max-w-md rounded-lg border border-border bg-background p-8 text-center shadow-lg">
              <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-muted">
                <ShieldAlert className="h-6 w-6 text-muted-foreground" />
              </div>
              <h3 className="mb-2 text-lg font-semibold">Not XAA-compatible</h3>
              <p className="mb-6 text-sm text-muted-foreground">
                <span className="font-medium text-foreground">
                  {selectedServerName}
                </span>{" "}
                needs an HTTP URL and OAuth to run the cross-app access flow.
              </p>
              <div className="flex items-center justify-center gap-2">
                <Button
                  type="button"
                  onClick={() => setIsServerModalOpen(true)}
                >
                  Configure Server to Test
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => onSelectServer?.("none")}
                >
                  Back to start
                </Button>
              </div>
            </div>
          </div>
        ) : (
          <ResizablePanelGroup direction="horizontal" className="h-full">
            <ResizablePanel defaultSize={52} minSize={30}>
              <XAASequenceDiagram
                flowState={flowState}
                focusedStep={focusedStep}
                hasProfile={isTestable}
                onConfigure={() => setIsServerModalOpen(true)}
              />
            </ResizablePanel>

            <ResizableHandle withHandle />

            <ResizablePanel defaultSize={48} minSize={24} maxSize={52}>
              <XAAFlowLogger
                flowState={flowState}
                hasProfile={isTestable}
                activeStep={focusedStep ?? flowState.currentStep}
                onFocusStep={setFocusedStep}
                actions={{
                  onConfigure: () => setIsServerModalOpen(true),
                  onReset: isTestable ? () => resetFlow() : undefined,
                  onContinue: continueDisabled ? undefined : handleAdvance,
                  onChangeNegativeTestMode: handleChangeNegativeTestMode,
                  continueLabel,
                  continueDisabled,
                  resetDisabled:
                    !isTestable || flowState.isBusy || isRunningAll,
                }}
                summary={{
                  serverUrl: runInput.serverUrl,
                  authzServerIssuer: runInput.authzServerIssuer || undefined,
                  clientId: runInput.clientId || undefined,
                  scope: runInput.scope || undefined,
                  negativeTestMode: runInput.negativeTestMode,
                }}
              />
            </ResizablePanel>
          </ResizablePanelGroup>
        )}
      </div>

      <NegativeTestScorecard
        input={scorecard.input}
        unlocked={positiveRunTargets.has(targetKey)}
        unavailableReason={scorecard.unavailableReason}
      />

      <XAAServerModal
        open={isServerModalOpen}
        onOpenChange={setIsServerModalOpen}
        server={selectedServer}
        existingServerNames={Object.keys(serverConfigs)}
        onSave={({ formData }) => {
          void onSaveServerConfig?.(formData);
          onSelectServer?.(formData.name);
          // A bar server overrides any selected registration.
          setSelectedRegistrationId(null);
        }}
      />

      <AlertDialog
        open={pendingReset !== null}
        onOpenChange={(open) => {
          if (!open) {
            // Cancel: acknowledge the switch without resetting, so the effect
            // doesn't immediately re-prompt; the current run stays visible.
            if (pendingReset) {
              lastAppliedTargetKey.current = pendingReset.targetKey;
              lastNegativeTestMode.current = pendingReset.negativeTestMode;
            }
            setPendingReset(null);
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Switch target?</AlertDialogTitle>
            <AlertDialogDescription>
              The current run will be discarded and the flow reset for the new
              target.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep current run</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (pendingReset) {
                  applyTargetReset(
                    pendingReset.targetKey,
                    pendingReset.negativeTestMode
                  );
                }
                setPendingReset(null);
              }}
            >
              Switch and reset
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
