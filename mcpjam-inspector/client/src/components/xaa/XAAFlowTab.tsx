import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAuth } from "@workos-inc/authkit-react";
import { track } from "@/lib/analytics";
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
  type XaaEphemeralDcrCredentials,
  type XaaRegistrationStrategy,
  type XAAFlowState,
} from "@/lib/xaa/types";
import { XAARegistrationStrategyControl } from "./XAARegistrationStrategyControl";
import { createInspectorXAAStateMachine } from "@/lib/xaa/debug-state-machine-adapter";
import { fetchXaaIdpUrls } from "@/lib/xaa/idp-endpoints";
import { HOSTED_MODE } from "@/lib/config";
import { hashXaaTargetId } from "@/lib/xaa/target-telemetry";

// Captured at module load: the XAA route returns null while the feature flag
// bootstraps and other startup code rewrites location.search, so reading the
// deep link lazily would race. Consumed once the registration list resolves.
const INITIAL_RESOURCE_PARAM =
  typeof window === "undefined"
    ? null
    : new URLSearchParams(window.location.search).get("resource");

function buildFlowStateFromInput(
  input: XAAFlowInput,
  registrationStrategy: XaaRegistrationStrategy = "pre_registered",
  // A prior ambiguous DCR POST may have created a remote client. This risk is
  // tracked per-target OUTSIDE flow state so an ordinary reset re-seeds it —
  // clearing it only through the confirmed "Register another client" path.
  dcrRetryMayCreateDuplicate = false
): XAAFlowState {
  return createInitialXAAFlowState({
    serverUrl: input.serverUrl || undefined,
    authzServerIssuer: input.authzServerIssuer || undefined,
    negativeTestMode: input.negativeTestMode,
    userId: input.userId || undefined,
    email: input.email || undefined,
    clientId: input.clientId || undefined,
    clientSecret: input.clientSecret || undefined,
    scope: input.scope || undefined,
    // The machine treats its state value as authoritative after init, so
    // every rebuild path must seed the currently-effective strategy — a
    // clean rebuild must not silently reset a selected DCR run.
    registrationStrategy,
    ...(dcrRetryMayCreateDuplicate
      ? { dcrRetryMayCreateDuplicate: true }
      : {}),
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
  const { user: signedInUser } = useAuth();
  // Local-only hosted-issuer opt-in: mints route through app.mcpjam.com so a
  // cloud AS can discover the issuer. Requires a signed-in session AND an
  // active org — the hosted mint targets the membership-gated org-scoped
  // issuer (/o/<orgId>), and the server fails closed without one rather than
  // downgrading to the forgeable unscoped issuer. (A local guest bearer is
  // signed with a local key the hosted issuer rejects.)
  const canUseHostedIssuer =
    !HOSTED_MODE && Boolean(signedInUser) && Boolean(organizationId);
  // Why the toggle is disabled — the two gates fail for different reasons and
  // the hint must name the one the user can act on.
  const hostedIssuerDisabledReason =
    HOSTED_MODE || canUseHostedIssuer
      ? undefined
      : !signedInUser
      ? "sign in to mint through the hosted issuer"
      : "select an organization to mint through the hosted issuer";
  const hostedIssuerOptIn =
    canUseHostedIssuer && runSettings.issuerMode === "hosted";
  const target = useXaaTestTarget({
    server: selectedServer,
    selectedServerName,
    selectedRegistration,
    runSettings,
    projectId: projectId ?? null,
  });
  const runInput = target.runInput;
  const { targetKey, isTestable } = target;

  // The positive-run unlock must be specific to the exact issuer the run
  // exercised: switching issuer mode (local↔hosted) or organization changes
  // the minted `iss`, so a green run under one must NOT unlock negative tests
  // under another. Key the gate on target + issuer mode + org.
  const runGateKey = `${targetKey}|${
    hostedIssuerOptIn ? "hosted" : "local"
  }|${organizationId ?? ""}`;

  // ── Registration strategy (target-scoped, session-only) ─────────────
  // Deliberately NOT persisted to run settings / localStorage: DCR creates
  // remote state at the target AS, so a globally saved preference must not
  // silently apply to a different AS after navigation or reload.
  const [strategyByTarget, setStrategyByTarget] = useState<
    Record<string, XaaRegistrationStrategy>
  >({});
  // Dynamic strategies need AS discovery (registration_endpoint / the CIMD
  // advertisement): manual public bar-server targets only. The CIMD
  // support gate is deliberately NOT part of eligibility — it's discovered
  // mid-run and parking on it IS the finding.
  const dynamicStrategyEligible =
    target.targetSource === "bar_server" &&
    isTestable &&
    !target.usesServerSideSecret &&
    !runInput.registrationId;
  const selectedStrategy = strategyByTarget[targetKey] ?? "pre_registered";
  const effectiveStrategy: XaaRegistrationStrategy = dynamicStrategyEligible
    ? selectedStrategy
    : "pre_registered";

  // DCR-minted credentials, keyed by target + registration endpoint. A
  // useRef-backed Map so machine recreation neither loses nor re-exposes the
  // secret mid-run; never copied into React state, storage, telemetry, or a
  // debug export. Page refresh clears it — the remote registration persists.
  const dcrCredentialCacheRef = useRef(
    new Map<string, XaaEphemeralDcrCredentials>()
  );
  // Per-target "a prior POST may have created a remote client" risk. Lives
  // outside flow state so it survives ordinary resets/Run all; cleared only by
  // the confirmed "Register another client" action. Page refresh clears it.
  const dcrDuplicateRiskRef = useRef(new Set<string>());
  const dcrCredentialCache = useMemo(
    () => ({
      get: (key: string) => dcrCredentialCacheRef.current.get(key),
      set: (key: string, value: XaaEphemeralDcrCredentials) => {
        dcrCredentialCacheRef.current.set(key, value);
      },
      delete: (key: string) => {
        dcrCredentialCacheRef.current.delete(key);
      },
    }),
    []
  );

  const [flowState, setFlowState] = useState<XAAFlowState>(() =>
    buildFlowStateFromInput(
      target.runInput,
      effectiveStrategy,
      dcrDuplicateRiskRef.current.has(targetKey)
    )
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
    track("xaa_flow_started", {
      location: "xaa_flow_tab",
      mode: runInput.mode,
      target_source: target.targetSource,
      // Salted one-way bucket id — never a server name/URL/hostname.
      target_id: hashXaaTargetId(targetKey),
      auth_server_mode: authServerModeForTelemetry,
      // Enum only — never an endpoint, client id, or credential.
      registration_strategy: effectiveStrategy,
    });
  }, [
    runInput.mode,
    target.targetSource,
    targetKey,
    authServerModeForTelemetry,
    effectiveStrategy,
  ]);

  useEffect(() => {
    if (flowState.currentStep === "complete" && !completedFired.current) {
      completedFired.current = true;
      track("xaa_flow_completed", {
        location: "xaa_flow_tab",
        success: true,
        target_source: targetSourceRef.current,
        auth_server_mode: authServerModeForTelemetry,
        // The strategy the completed run actually used (state-authoritative).
        registration_strategy: flowStateRef.current.registrationStrategy,
      });
      // A green run proves the user holds valid client credentials the AS
      // issued — that authorizes broken-token testing against it. Only unlock
      // for pre-registered runs though: a dcr/cimd run's negative tests would
      // fire with the configured (often absent) client, not the identity the
      // run established, so the scorecard stays disabled for those (see the
      // scorecard memo) and must not be unlocked here either.
      if (flowStateRef.current.registrationStrategy === "pre_registered") {
        setPositiveRunTargets((current) => {
          if (current.has(runGateKey)) return current;
          const next = new Set(current);
          next.add(runGateKey);
          return next;
        });
      }
    }
  }, [flowState.currentStep, authServerModeForTelemetry, runGateKey]);

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

    // The scorecard fires broken tokens using the run's CONFIGURED client
    // (runInput.clientId), not the identity a dcr/cimd run established. For a
    // dynamic run those don't match — often the config client_id is empty —
    // so results would be about the wrong (or no) client and could read as an
    // all-green pass that proves nothing. Disable it rather than mislead.
    if (
      flowState.registrationStrategy === "dcr" ||
      flowState.registrationStrategy === "cimd"
    ) {
      return {
        input: null,
        unavailableReason:
          "Negative tests run against the pre-registered client credentials, not the client this DCR/CIMD run established — so they can't be trusted here. Switch to the pre-registered strategy to exercise the scorecard.",
      };
    }

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
  const lastRegistrationStrategy = useRef<XaaRegistrationStrategy>(
    effectiveStrategy
  );
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
    registrationStrategy: XaaRegistrationStrategy;
  } | null>(null);

  // Rebuild the flow from the current input and record the identity it was
  // built with. Every rebuild path goes through here so the debounced identity
  // reset can tell whether another path (Run all, Reset, target switch) already
  // applied the current identity — and skip a stale timer that would otherwise
  // wipe a freshly-started run.
  const rebuildFlow = useCallback(
    (strategyOverride?: XaaRegistrationStrategy) => {
      lastAppliedIdentity.current = {
        userId: runInput.userId,
        email: runInput.email,
      };
      applyFlowState(
        buildFlowStateFromInput(
          runInput,
          strategyOverride ?? effectiveStrategy,
          // Re-seed the per-target duplicate-registration risk so an ordinary
          // reset can't drop the confirmation gate.
          dcrDuplicateRiskRef.current.has(targetKey)
        )
      );
    },
    [applyFlowState, runInput, effectiveStrategy, targetKey]
  );

  // Mirror the machine's duplicate-registration risk into the target-scoped
  // ref so it outlives flow-state rebuilds. (One-way: the machine only ever
  // sets it true; the ref is cleared solely by "Register another client".)
  // Guard on lastAppliedTargetKey: on a target switch this effect re-runs
  // with the NEW targetKey while flowState still holds the OLD target's flow
  // (the reset-owner effect rebuilds afterwards) — without the guard the old
  // run's risk would wrongly block registration on the new target.
  useEffect(() => {
    if (
      flowState.dcrRetryMayCreateDuplicate &&
      lastAppliedTargetKey.current === targetKey
    ) {
      dcrDuplicateRiskRef.current.add(targetKey);
    }
  }, [flowState.dcrRetryMayCreateDuplicate, targetKey]);

  const applyTargetReset = useCallback(
    (
      nextTargetKey: string,
      nextMode: NegativeTestMode,
      nextStrategy: XaaRegistrationStrategy
    ) => {
      lastAppliedTargetKey.current = nextTargetKey;
      lastNegativeTestMode.current = nextMode;
      lastRegistrationStrategy.current = nextStrategy;
      rebuildFlow(nextStrategy);
    },
    [rebuildFlow]
  );

  useEffect(() => {
    const nextMode = runSettings.negativeTestMode;
    const nextStrategy = effectiveStrategy;
    if (
      lastAppliedTargetKey.current === targetKey &&
      lastNegativeTestMode.current === nextMode &&
      lastRegistrationStrategy.current === nextStrategy
    ) {
      return;
    }

    const current = flowStateRef.current;
    const needsConfirm =
      lastAppliedTargetKey.current !== null &&
      (current.isBusy || current.currentStep === "complete");
    if (needsConfirm) {
      setPendingReset({
        targetKey,
        negativeTestMode: nextMode,
        registrationStrategy: nextStrategy,
      });
      return;
    }
    applyTargetReset(targetKey, nextMode, nextStrategy);
  }, [
    targetKey,
    runSettings.negativeTestMode,
    effectiveStrategy,
    applyTargetReset,
  ]);

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
    track("xaa_tab_viewed", {
      location: "xaa_flow_tab",
      target_count: resourceApps.length + Object.keys(serverConfigs).length,
    });
    // Fires once per mount; the counts are a point-in-time anchor.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const resetFlow = useCallback(() => {
    // Ordinary reset retains the session credential cache, so a DCR run
    // reuses its registration instead of minting another remote client.
    rebuildFlow();
  }, [rebuildFlow]);

  // Explicit, confirmed action: drop this target's cached registration(s)
  // and reset, so the next run performs a fresh registration POST. This is
  // also the only path that clears dcrRetryMayCreateDuplicate.
  const registerAnotherClient = useCallback(() => {
    // The cache key's first component is the encoded target key (see
    // dcrCacheKeyFor); match on that encoded prefix.
    const targetPrefix = `${encodeURIComponent(targetKey)}::`;
    for (const key of Array.from(dcrCredentialCacheRef.current.keys())) {
      if (key.startsWith(targetPrefix)) {
        dcrCredentialCacheRef.current.delete(key);
      }
    }
    // The confirmed action is the ONLY thing that clears the duplicate-risk
    // gate — the user has acknowledged a second remote client may be created.
    dcrDuplicateRiskRef.current.delete(targetKey);
    rebuildFlow();
  }, [targetKey, rebuildFlow]);

  const dcrHasSessionRegistration =
    effectiveStrategy === "dcr" &&
    Array.from(dcrCredentialCacheRef.current.keys()).some((key) =>
      key.startsWith(`${encodeURIComponent(targetKey)}::`)
    );

  // Resolve the real IdP issuer from the server's OpenID config so the ID-JAG
  // inspection step lints against the issuer actually stamped into `iss`, not
  // the browser origin (which differs from the backend through the dev proxy).
  const [resolvedIssuerBaseUrl, setResolvedIssuerBaseUrl] = useState<
    string | undefined
  >(undefined);
  useEffect(() => {
    const controller = new AbortController();
    // Reset synchronously on org change (mirrors XAAIdpCard). Otherwise the
    // prior org's issuer lingers until the async fetch resolves — and stays
    // forever if it returns null — so the ID-JAG inspection would compare the
    // new org's `iss` against the old issuer and report a spurious mismatch.
    // With it cleared, the machine falls back to the correct current-org guess.
    setResolvedIssuerBaseUrl(undefined);
    void fetchXaaIdpUrls(controller.signal, organizationId).then((urls) => {
      if (urls && !controller.signal.aborted) {
        setResolvedIssuerBaseUrl(urls.issuerBaseUrl);
      }
    });
    return () => controller.abort();
  }, [organizationId]);

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
      // Client-identity strategy (forced to pre_registered inside the machine
      // for registrationId/serverId runs) plus the session credential cache
      // DCR runs mint into and redeem from.
      registrationStrategy: effectiveStrategy,
      dcrCredentialCache,
      dcrCacheTargetKey: targetKey,
      // Confidential bar-server runs send only serverId/projectId; the server
      // resolves the secret and discovers the token endpoint.
      ...(target.usesServerSideSecret && target.serverId
        ? { serverId: target.serverId, projectId: target.projectId }
        : {}),
      // Hosted-issuer runs let the adapter derive the app.mcpjam.com issuer;
      // the locally-fetched discovery doc would lint against the wrong `iss`.
      issuerBaseUrl: hostedIssuerOptIn ? undefined : resolvedIssuerBaseUrl,
      organizationId,
      issuerMode: hostedIssuerOptIn ? "hosted" : "local",
    });
  }, [
    runInput,
    target,
    updateFlowState,
    resolvedIssuerBaseUrl,
    organizationId,
    hostedIssuerOptIn,
    effectiveStrategy,
    dcrCredentialCache,
    targetKey,
  ]);

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
      track("xaa_flow_completed", {
        location: "xaa_flow_tab",
        success: false,
        target_source: targetSourceRef.current,
        // The step the run stopped on — an enum, never a raw error string.
        error_category: final.currentStep,
        auth_server_mode: authServerModeForTelemetry,
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
      <XAAIdpCard
        organizationId={organizationId ?? null}
        issuerMode={runSettings.issuerMode}
        onIssuerModeChange={runSettings.setIssuerMode}
        canUseHostedIssuer={canUseHostedIssuer}
        hostedIssuerDisabledReason={hostedIssuerDisabledReason}
      />
      <XAAResourceAppsSection
        organizationId={organizationId ?? null}
        selectedId={selectedRegistrationId}
        onSelect={(app) =>
          setSelectedRegistrationId((current) =>
            current === app.id ? null : app.id
          )
        }
      />
      {dynamicStrategyEligible ? (
        <XAARegistrationStrategyControl
          value={selectedStrategy}
          onChange={(next) =>
            setStrategyByTarget((current) => ({
              ...current,
              [targetKey]: next,
            }))
          }
          disabled={flowState.isBusy || isRunningAll}
          showRegisterAnotherClient={
            dcrHasSessionRegistration ||
            Boolean(flowState.dcrRetryMayCreateDuplicate)
          }
          onRegisterAnotherClient={registerAnotherClient}
        />
      ) : null}
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
                  // Prefer the flow's clientId so a DCR-minted or CIMD URL
                  // identity is shown accurately; pre-registered runs fall
                  // back to the configured value unchanged.
                  clientId:
                    flowState.clientId || runInput.clientId || undefined,
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
          input={
            scorecard.input
              ? {
                  ...scorecard.input,
                  organizationId: organizationId ?? null,
                  ...(hostedIssuerOptIn ? { issuerMode: "hosted" as const } : {}),
                }
              : null
          }
          unlocked={positiveRunTargets.has(runGateKey)}
          unavailableReason={scorecard.unavailableReason}
        />
      )}

      <XAAServerModal
        open={isServerModalOpen}
        onOpenChange={setIsServerModalOpen}
        server={selectedServer}
        existingServerNames={Object.keys(serverConfigs)}
        signedInEmail={signedInUser?.email}
        projectId={target.barServerProjectId}
        hostedServerId={target.barServerId}
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
              // Capture BEFORE overwriting: was this dialog a pure strategy
              // toggle on the still-selected target, or a target switch?
              const wasSameTarget =
                pendingReset.targetKey === lastAppliedTargetKey.current;
              lastAppliedTargetKey.current = pendingReset.targetKey;
              lastNegativeTestMode.current = pendingReset.negativeTestMode;
              if (
                wasSameTarget &&
                pendingReset.registrationStrategy !==
                  lastRegistrationStrategy.current
              ) {
                // Same-target strategy toggle, cancelled: revert the selector
                // to the strategy the still-running flow uses so UI config and
                // the state-authoritative strategy can't diverge. Keep
                // lastRegistrationStrategy.current (= prior) so no re-prompt.
                const prior = lastRegistrationStrategy.current;
                const revertKey = pendingReset.targetKey;
                setStrategyByTarget((current) => ({
                  ...current,
                  [revertKey]: prior,
                }));
              } else {
                // Target switch (or no strategy change) cancelled: acknowledge
                // the new target's strategy so the effect doesn't re-prompt.
                // Never write one target's strategy onto another's key.
                lastRegistrationStrategy.current =
                  pendingReset.registrationStrategy;
              }
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
                    pendingReset.negativeTestMode,
                    pendingReset.registrationStrategy
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
