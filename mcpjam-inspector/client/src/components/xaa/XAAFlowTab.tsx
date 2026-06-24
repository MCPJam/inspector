import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import posthog from "posthog-js";
import { Loader2, ShieldAlert } from "lucide-react";
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
import { XAAIdpCard } from "./XAAIdpCard";
import { XAAResourceAppsSection } from "./registration/XAAResourceAppsSection";
import { NegativeTestScorecard } from "./NegativeTestScorecard";
import type { NegativeTestsInput } from "@/lib/xaa/discovery-client";
import type { NegativeTestMode } from "@/shared/xaa.js";
import {
  createInitialXAAFlowState,
  type XAAFlowState,
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
  /**
   * Bumped by the shell when the header "Add Server" button is clicked while
   * this tab is active, so the Configure-Server-to-Test modal opens instead of
   * the generic Add Server modal. Each new value (not the initial one) opens it.
   */
  openServerModalSignal?: number;
}

export function XAAFlowTab({
  serverConfigs,
  selectedServerName,
  organizationId,
  projectId,
  onSelectServer,
  onSaveServerConfig,
  openServerModalSignal,
}: XAAFlowTabProps) {
  const [isServerModalOpen, setIsServerModalOpen] = useState(false);
  const [isRunningAll, setIsRunningAll] = useState(false);

  // Open the modal when the shell bumps the signal (header "Add Server"). Skip
  // the initial value so it doesn't pop open on mount.
  const prevOpenSignalRef = useRef(openServerModalSignal);
  useEffect(() => {
    if (openServerModalSignal === prevOpenSignalRef.current) return;
    prevOpenSignalRef.current = openServerModalSignal;
    setIsServerModalOpen(true);
  }, [openServerModalSignal]);

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
          // Use the flow's simulated identity (not the server's user-12345
          // default) so an app with Allowed Users set doesn't reject every
          // negative test on `sub` before its own check is evaluated.
          subject: runInput.userId || undefined,
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
          subject: runInput.userId || undefined,
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
        subject: runInput.userId || undefined,
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
  // The simulated identity the flow was last (re)built with. Tracked so an
  // identity edit rebuilds the flow (clearing the already-minted ID token /
  // ID-JAG that carry the old sub) — without that, advancing step-by-step
  // keeps sending the stale subject. Seeded from the initial identity so no
  // spurious reset fires on mount.
  const lastAppliedIdentity = useRef({
    userId: runSettings.userId,
    email: runSettings.email,
  });
  const [pendingReset, setPendingReset] = useState<{
    targetKey: string;
    negativeTestMode: NegativeTestMode;
  } | null>(null);

  // Rebuild the flow from the current input and record the identity it was
  // built with. Every rebuild path goes through here so the debounced identity
  // reset can tell whether another path (Run all, Reset, target switch) already
  // applied the current identity — and skip a stale timer that would otherwise
  // wipe a freshly-started run.
  const rebuildFlow = useCallback(() => {
    lastAppliedIdentity.current = {
      userId: runInput.userId,
      email: runInput.email,
    };
    applyFlowState(buildFlowStateFromInput(runInput));
  }, [applyFlowState, runInput]);

  const applyTargetReset = useCallback(
    (nextTargetKey: string, nextMode: NegativeTestMode) => {
      lastAppliedTargetKey.current = nextTargetKey;
      lastNegativeTestMode.current = nextMode;
      rebuildFlow();
    },
    [rebuildFlow]
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

  // Identity edits rebuild the flow so the next run mints tokens for the new
  // sub/email. Unlike target/mode (which change discretely), the identity
  // inputs fire on every keystroke, so the rebuild is debounced — typing
  // "john" resets once, not four times. No confirm dialog: editing the
  // identity is a deliberate "test as someone else", and the chips clearing is
  // the feedback. The live-read in the auth step covers the debounce window.
  useEffect(() => {
    const nextUserId = runSettings.userId;
    const nextEmail = runSettings.email;
    if (
      lastAppliedIdentity.current.userId === nextUserId &&
      lastAppliedIdentity.current.email === nextEmail
    ) {
      return;
    }
    const timer = setTimeout(() => {
      // Another path (Run all, Reset, target switch) may have rebuilt the flow
      // with this identity while the timer was pending. If so the tracker
      // already matches — bail rather than wipe that fresh (possibly running)
      // state a second time.
      if (
        lastAppliedIdentity.current.userId === nextUserId &&
        lastAppliedIdentity.current.email === nextEmail
      ) {
        return;
      }
      rebuildFlow();
    }, 400);
    return () => clearTimeout(timer);
  }, [runSettings.userId, runSettings.email, rebuildFlow]);

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
    rebuildFlow();
  }, [rebuildFlow]);

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
    // rebuildFlow also syncs the identity tracker, so a debounced identity
    // reset armed just before this click can't fire mid-run and wipe it.
    rebuildFlow();
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
    rebuildFlow,
    xaaStateMachine,
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

  // A confidential server whose secret can't be resolved yet must not run —
  // sending an empty secret would make the auth server reject the client.
  const secretBlocked = target.secretUnavailable;
  const secretBlockedReason = secretBlocked
    ? target.serversLoading
      ? "Resolving this server's saved secret…"
      : "Couldn't resolve this server's saved secret. Re-save it in Configure Server to Test so its secret syncs to this project."
    : null;

  const continueDisabled =
    !isTestable ||
    secretBlocked ||
    flowState.isBusy ||
    isRunningAll ||
    flowState.currentStep === "complete" ||
    Boolean(flowState.negativeProbe);

  const runAllDisabled =
    !isTestable || secretBlocked || flowState.isBusy || isRunningAll;

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
      {secretBlockedReason ? (
        <div
          className="flex items-center gap-2 border-b border-border bg-muted/30 px-4 py-1.5 text-xs text-muted-foreground"
          role="status"
        >
          {target.serversLoading ? (
            <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" />
          ) : (
            <ShieldAlert className="h-3.5 w-3.5 shrink-0 text-destructive" />
          )}
          <span>{secretBlockedReason}</span>
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
        ) : isTestable ? (
          <ResizablePanelGroup direction="horizontal" className="h-full">
            <ResizablePanel defaultSize={52} minSize={30} className="min-w-0">
              <XAASequenceDiagram
                flowState={flowState}
                hasProfile={isTestable}
                onConfigure={() => setIsServerModalOpen(true)}
              />
            </ResizablePanel>

            <ResizableHandle withHandle />

            <ResizablePanel
              defaultSize={48}
              minSize={24}
              maxSize={52}
              className="min-w-0"
            >
              <XAAFlowLogger
                flowState={flowState}
                hasProfile={isTestable}
                activeStep={flowState.currentStep}
                actions={{
                  onConfigure: () => setIsServerModalOpen(true),
                  onReset: isTestable ? () => resetFlow() : undefined,
                  onContinue: continueDisabled ? undefined : handleAdvance,
                  onRunAll: isTestable ? handleRunAll : undefined,
                  continueLabel,
                  continueDisabled,
                  runAllDisabled,
                  isRunningAll,
                  resetDisabled:
                    !isTestable || flowState.isBusy || isRunningAll,
                }}
                summary={{
                  serverUrl: runInput.serverUrl,
                  authzServerIssuer: runInput.authzServerIssuer || undefined,
                  clientId: runInput.clientId || undefined,
                  scope: runInput.scope || undefined,
                }}
              />
            </ResizablePanel>
          </ResizablePanelGroup>
        ) : (
          // Empty / unconfigured: keep progressive disclosure tight — just the
          // diagram with its centered "Configure Server to Test" overlay. The
          // run sidebar and negative-test footer only earn their space once
          // there's a testable server, so they stay hidden until then.
          <XAASequenceDiagram
            flowState={flowState}
            hasProfile={false}
            onConfigure={() => setIsServerModalOpen(true)}
          />
        )}
      </div>

      {isTestable && (
        <NegativeTestScorecard
          input={scorecard.input}
          unlocked={positiveRunTargets.has(targetKey)}
          unavailableReason={scorecard.unavailableReason}
        />
      )}

      <XAAServerModal
        open={isServerModalOpen}
        onOpenChange={setIsServerModalOpen}
        server={selectedServer}
        existingServerNames={Object.keys(serverConfigs)}
        simulatedUserId={runSettings.userId}
        simulatedEmail={runSettings.email}
        onIdentityChange={runSettings.setIdentity}
        onSave={async ({ formData }) => {
          // Await so the modal can keep itself open (and preserve the entered
          // values) if the save rejects. Selection only follows a save that
          // didn't throw.
          await onSaveServerConfig?.(formData);
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
