import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
  type ReactNode,
} from "react";
import type { ImperativePanelHandle } from "react-resizable-panels";
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
import { useXaaPeople } from "@/hooks/useXaaPeople";
import {
  useXaaTestTarget,
  type XAAFlowInput,
} from "@/hooks/useXaaTestTarget";
import {
  XAAPeopleStrip,
  type XaaPersonOutcome,
} from "./XAAPeopleStrip";
import { XAASequenceDiagram } from "./XAASequenceDiagram";
import { XAAFlowLogger } from "./XAAFlowLogger";
import { XAAServerModal } from "./XAAServerModal";
import { XAAIdpCard } from "./XAAIdpCard";
import { XAAResourceAppsSection } from "./registration/XAAResourceAppsSection";
import { NegativeTestScorecard } from "./NegativeTestScorecard";
import type { NegativeTestsInput } from "@/lib/xaa/discovery-client";
import {
  DEFAULT_IDENTITY_ASSERTION_FORMAT,
  normalizeIdentityAssertionFormat,
  normalizeRegistrationStrategy,
  type IdentityAssertionFormat,
  type NegativeTestMode,
  type SubjectIdentifierFormat,
} from "@/shared/xaa.js";
import {
  createInitialXAAFlowState,
  type XaaEphemeralDcrCredentials,
  type RegistrationStrategy,
  type XAAFlowState,
} from "@/lib/xaa/types";
import type { XAAFlowStep } from "@/lib/xaa/types";
import { XAADcrReRegisterControl } from "./XAADcrReRegisterControl";
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

// The persisted per-server preset drives BOTH independent draft axes: the
// input axis (which assertion the mock IdP mints, which subject_token_type
// the exchange presents) and the output axis (whether the ID-JAG carries a
// saml-nameid `sub_id`). The SDK keeps the axes separate for programmatic
// mixing; the debugger UI intentionally sets them together.
function subjectIdentifierFormatFor(
  format: IdentityAssertionFormat
): SubjectIdentifierFormat {
  return format === "saml" ? "saml-nameid" : "oauth-sub";
}

function buildFlowStateFromInput(
  input: XAAFlowInput,
  registrationStrategy: RegistrationStrategy = "preregistered",
  // A prior ambiguous DCR POST may have created a remote client. This risk is
  // tracked per-target OUTSIDE flow state so an ordinary reset re-seeds it —
  // clearing it only through the confirmed "Register another client" path.
  dcrRetryMayCreateDuplicate = false,
  identityAssertionFormat: IdentityAssertionFormat = DEFAULT_IDENTITY_ASSERTION_FORMAT
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
    // Sticky like negativeTestMode: seeded on every rebuild, changed only
    // through the reset owner below.
    identityAssertionFormat,
    subjectIdentifierFormat: subjectIdentifierFormatFor(
      identityAssertionFormat
    ),
    ...(dcrRetryMayCreateDuplicate ? { dcrRetryMayCreateDuplicate: true } : {}),
  });
}

// ── Per-person outcome recording (session-only) ─────────────────────────────

/** A recorded outcome plus the context that scopes its validity: it renders
 * only while the person is unedited (updatedAt) and the target's material
 * inputs are unchanged (fingerprint). */
interface RecordedPersonOutcome extends XaaPersonOutcome {
  personUpdatedAt: number;
  targetFingerprint: string;
}

/** Material run inputs whose change invalidates a recorded outcome — a result
 * against one server/AS/client/scope says nothing about another. */
function computeTargetFingerprint(input: XAAFlowInput): string {
  return [
    input.serverUrl,
    input.authzServerIssuer,
    input.clientId,
    input.scope,
  ].join("|");
}

/** RFC 6749/8693/8707 error codes we recognize. Only an allowlisted code is
 * ever stored/rendered — never a raw error string, which can embed tokens. */
const OAUTH_ERROR_CODES = [
  "invalid_grant",
  "access_denied",
  "invalid_client",
  "invalid_request",
  "unauthorized_client",
  "unsupported_grant_type",
  "invalid_scope",
  "invalid_target",
] as const;

function extractOauthErrorCode(
  error: string | undefined,
  lastResponse: XAAFlowState["lastResponse"]
): string | undefined {
  // Prefer the structured token response (`{error}` or the proxy envelope's
  // `{body: {error}}`) over substring-matching the message.
  const body = lastResponse?.body as Record<string, unknown> | undefined;
  const candidates = [
    body?.error,
    (body?.body as Record<string, unknown> | undefined)?.error,
  ];
  for (const candidate of candidates) {
    if (
      typeof candidate === "string" &&
      (OAUTH_ERROR_CODES as readonly string[]).includes(candidate)
    ) {
      return candidate;
    }
  }
  if (typeof error === "string") {
    return OAUTH_ERROR_CODES.find((code) => error.includes(code));
  }
  return undefined;
}

function parseScopeSet(value: string | undefined): Set<string> {
  return new Set((value ?? "").split(/\s+/).filter(Boolean));
}

/** Per RFC 6749 §5.1 an omitted `scope` on the token response means "as
 * requested" — only an explicitly narrower grant counts as downscoped. */
function isDownscoped(
  requested: string | undefined,
  granted: string | undefined
): boolean {
  const requestedSet = parseScopeSet(requested);
  if (requestedSet.size === 0 || granted === undefined) return false;
  const grantedSet = parseScopeSet(granted);
  for (const scope of requestedSet) {
    if (!grantedSet.has(scope)) return true;
  }
  return false;
}

function sameOutcome(
  a: RecordedPersonOutcome,
  b: RecordedPersonOutcome
): boolean {
  return (
    a.status === b.status &&
    a.oauthErrorCode === b.oauthErrorCode &&
    a.failedStep === b.failedStep &&
    a.personUpdatedAt === b.personUpdatedAt &&
    a.targetFingerprint === b.targetFingerprint
  );
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

function XAAWorkspaceLayout({
  children,
  scorecard,
  scorecardPanelRef,
  compactScorecardContentHeight,
  scorecardHasResults,
}: {
  children: ReactNode;
  scorecard?: ReactNode;
  scorecardPanelRef?: RefObject<ImperativePanelHandle | null>;
  compactScorecardContentHeight?: number | null;
  scorecardHasResults?: boolean;
}) {
  const layoutRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (
      scorecardHasResults ||
      !compactScorecardContentHeight ||
      !scorecardPanelRef?.current
    ) {
      return;
    }
    const resizeToContent = () => {
      const height = layoutRef.current?.getBoundingClientRect().height;
      if (!height) return;

      // Card margins + the resize handle need a little room beyond the card's
      // measured content height. Keep the panel within its declared bounds.
      const size = Math.min(
        90,
        Math.max(5, ((compactScorecardContentHeight + 20) / height) * 100)
      );
      scorecardPanelRef.current?.resize(size);
    };
    resizeToContent();

    // A compact card needs a smaller percentage on taller screens. Recompute
    // when the workspace changes height instead of retaining the old slice.
    if (typeof ResizeObserver === "undefined" || !layoutRef.current) return;
    const observer = new ResizeObserver(resizeToContent);
    observer.observe(layoutRef.current);
    return () => observer.disconnect();
  }, [compactScorecardContentHeight, scorecardHasResults, scorecardPanelRef]);

  return (
    <div ref={layoutRef} className="min-h-0 flex-1">
      <ResizablePanelGroup direction="vertical" className="h-full">
        <ResizablePanel
          id="xaa-workspace"
          order={1}
          defaultSize={scorecard ? 92 : 100}
          minSize={5}
          className="min-h-0 overflow-hidden"
        >
          {children}
        </ResizablePanel>

        {scorecard && (
          <>
            <ResizableHandle
              withHandle
              aria-label="Resize negative-test scorecard"
            />
            <ResizablePanel
              id="xaa-negative-test-scorecard"
              order={2}
              defaultSize={8}
              minSize={5}
              maxSize={90}
              className="min-h-0 overflow-hidden"
              ref={scorecardPanelRef}
            >
              {scorecard}
            </ResizablePanel>
          </>
        )}
      </ResizablePanelGroup>
    </div>
  );
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
  const [scorecardHasResults, setScorecardHasResults] = useState(false);
  const [compactScorecardContentHeight, setCompactScorecardContentHeight] =
    useState<number | null>(null);
  const scorecardPanelRef = useRef<ImperativePanelHandle>(null);
  const collapseScorecard = useCallback(() => {
    setScorecardHasResults(false);
    setCompactScorecardContentHeight(null);
  }, []);
  const expandScorecardForResults = useCallback(() => {
    setScorecardHasResults(true);
    scorecardPanelRef.current?.resize(50);
  }, []);
  const handleScorecardExpandedChange = useCallback(
    (expanded: boolean, hasResults: boolean) => {
      if (expanded && hasResults) {
        expandScorecardForResults();
        return;
      }
      setScorecardHasResults(false);
      setCompactScorecardContentHeight(null);
    },
    [expandScorecardForResults]
  );
  const updateCompactScorecardContentHeight = useCallback((height: number) => {
    if (!height) return;
    setCompactScorecardContentHeight((current) =>
      current !== null && Math.abs(current - height) < 1 ? current : height
    );
  }, []);

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
  // ── "Run as" people (project-scoped synthetic test identities) ──────
  const {
    people,
    isLoading: peopleLoading,
    isAvailable: peopleAvailable,
  } = useXaaPeople({ projectId: projectId ?? null });
  const selectedPersonId = projectId
    ? (runSettings.selectedPersonIdByProject[projectId] ?? null)
    : null;
  const selectedPerson = useMemo(
    () => people?.find((p) => p._id === selectedPersonId) ?? null,
    [people, selectedPersonId]
  );
  const { setSelectedPersonId } = runSettings;
  // Tidy a stale selection (person deleted elsewhere) only once the roster
  // has LOADED without it — clearing while loading would wipe a valid
  // selection on every mount.
  useEffect(() => {
    if (!projectId || !selectedPersonId || peopleLoading || !people) return;
    if (!people.some((p) => p._id === selectedPersonId)) {
      setSelectedPersonId(projectId, null);
    }
  }, [projectId, selectedPersonId, peopleLoading, people, setSelectedPersonId]);

  const target = useXaaTestTarget({
    server: selectedServer,
    selectedServerName,
    selectedRegistration,
    runSettings,
    selectedPerson,
    projectId: projectId ?? null,
  });
  const runInput = target.runInput;
  const { targetKey, isTestable } = target;

  // The positive-run unlock must be specific to the exact issuer the run
  // exercised: switching issuer mode (local↔hosted) or organization changes
  // the minted `iss`, so a green run under one must NOT unlock negative tests
  // under another. Key the gate on target + issuer mode + org.
  const runGateKey = `${targetKey}|${hostedIssuerOptIn ? "hosted" : "local"}|${
    organizationId ?? ""
  }`;

  // ── Registration strategy (Client↔Resource-AS leg) ──────────────────
  // Persisted per-server and chosen in the "Configure Server to Test" modal;
  // the modal is the source of truth (no on-flow selector). The DCR credential
  // cache below stays session-only — a persisted `dcr` re-registers a fresh
  // client on the next run, guarded by the duplicate-risk gate.
  const persistedStrategy =
    normalizeRegistrationStrategy(selectedServer?.registrationMode) ??
    "preregistered";
  // Dynamic strategies (DCR/CIMD) need AS discovery, so they apply only to
  // manual bar-server targets (not registration/resource-app runs). An explicit
  // dynamic choice is honored even when the server has a stored secret: the run
  // ignores the stored pre-registered credentials (the serverId / secret gating
  // below is suppressed) and establishes a fresh dynamic client identity.
  const strategyAppliesToTarget =
    target.targetSource === "bar_server" &&
    isTestable &&
    !runInput.registrationId;
  const effectiveStrategy: RegistrationStrategy = strategyAppliesToTarget
    ? persistedStrategy
    : "preregistered";
  // When the run establishes its own dynamic client identity, any stored
  // pre-registered credentials (serverId-resolved secret) must be ignored.
  const runsDynamicRegistration = effectiveStrategy !== "preregistered";

  // ── Identity assertion format (per-server preset) ────────────────────
  // Chosen in the "Configure Server to Test" modal, persisted per-server.
  // Applies to bar-server runs only — like the per-server simulated identity,
  // it must not leak onto a selected resource-app registration, which stays
  // on the OIDC default. Unknown persisted values fall back to the default.
  const persistedAssertionFormat =
    normalizeIdentityAssertionFormat(
      selectedServer?.xaaIdentityAssertionFormat
    ) ?? DEFAULT_IDENTITY_ASSERTION_FORMAT;
  const effectiveAssertionFormat: IdentityAssertionFormat =
    target.targetSource === "bar_server"
      ? persistedAssertionFormat
      : DEFAULT_IDENTITY_ASSERTION_FORMAT;

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
      dcrDuplicateRiskRef.current.has(targetKey),
      effectiveAssertionFormat
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

  // In-memory per-person outcomes, keyed `${runGateKey}|${personId}` so
  // hosted/local/org variants never cross-contaminate. Session-only by
  // design (mirrors positiveRunTargets).
  const [personOutcomes, setPersonOutcomes] = useState<
    Map<string, RecordedPersonOutcome>
  >(() => new Map());
  const targetFingerprint = computeTargetFingerprint(runInput);
  // The whole run context is captured atomically at run START — recording
  // against live values at completion could attribute an old run to a newly
  // selected person/target/mode.
  const runContextRef = useRef<{
    personId: string;
    personUpdatedAt: number;
    runGateKey: string;
    negativeTestMode: NegativeTestMode;
    targetFingerprint: string;
  } | null>(null);
  // The error branch below re-evaluates on every isBusy toggle (single-step
  // runs park `error` with isBusy=false between steps) — record at most one
  // error per run.
  const errorRecordedRef = useRef(false);

  const fireFlowStarted = useCallback(() => {
    completedFired.current = false;
    errorRecordedRef.current = false;
    runContextRef.current = selectedPerson
      ? {
          personId: selectedPerson._id,
          personUpdatedAt: selectedPerson.updatedAt,
          runGateKey,
          negativeTestMode: runInput.negativeTestMode,
          targetFingerprint,
        }
      : null;
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
    runInput.negativeTestMode,
    target.targetSource,
    targetKey,
    runGateKey,
    targetFingerprint,
    selectedPerson,
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
      if (flowStateRef.current.registrationStrategy === "preregistered") {
        setPositiveRunTargets((current) => {
          if (current.has(runGateKey)) return current;
          const next = new Set(current);
          next.add(runGateKey);
          return next;
        });
      }
    }
  }, [flowState.currentStep, authServerModeForTelemetry, runGateKey]);

  // Record the run's outcome for the person it STARTED as (captured context —
  // never the currently-selected person/target). Only valid-mode runs count:
  // a deliberately-broken negative run says nothing about a subject's access.
  useEffect(() => {
    const ctx = runContextRef.current;
    if (!ctx || ctx.negativeTestMode !== "valid") return;

    let outcome: RecordedPersonOutcome | null = null;
    if (flowState.currentStep === "complete") {
      // "Complete" does not prove full access — compare the requested scope
      // against what the AS actually granted (draft-04 leaves scope decisions
      // to the RAS).
      outcome = {
        status: isDownscoped(flowState.scope, flowState.grantedScope)
          ? "downscoped"
          : "allowed",
        personUpdatedAt: ctx.personUpdatedAt,
        targetFingerprint: ctx.targetFingerprint,
      };
    } else if (flowState.error && !flowState.isBusy) {
      if (errorRecordedRef.current) return;
      errorRecordedRef.current = true;
      const failedStep: XAAFlowStep = flowState.currentStep;
      const code = extractOauthErrorCode(
        flowState.error,
        flowState.lastResponse
      );
      // Only a policy-shaped refusal of the jwt-bearer redemption counts as
      // "rejected" — anything else (discovery, network, invalid_client, an
      // MCP 401) is a test problem, not your AS ruling on the subject. Even
      // invalid_grant can be technical, so the code is displayed, not
      // editorialized.
      const isPolicyRejection =
        failedStep === "jwt_bearer_request" &&
        (code === "invalid_grant" || code === "access_denied");
      outcome = {
        status: isPolicyRejection ? "rejected" : "test_error",
        ...(code ? { oauthErrorCode: code } : {}),
        failedStep,
        personUpdatedAt: ctx.personUpdatedAt,
        targetFingerprint: ctx.targetFingerprint,
      };
    }
    if (!outcome) return;

    const key = `${ctx.runGateKey}|${ctx.personId}`;
    const next = outcome;
    // Last-write-wins: a person who failed and then succeeds after the user
    // fixes their AS must flip. Skip the setState only when the value is
    // identical (NOT when the key exists — that would freeze the first result).
    setPersonOutcomes((current) => {
      const existing = current.get(key);
      if (existing && sameOutcome(existing, next)) return current;
      const map = new Map(current);
      map.set(key, next);
      return map;
    });
  }, [
    flowState.currentStep,
    flowState.error,
    flowState.isBusy,
    flowState.scope,
    flowState.grantedScope,
    flowState.lastResponse,
  ]);

  // ── Negative-test scorecard input ───────────────────────────────────
  const scorecard = useMemo((): {
    input: NegativeTestsInput | null;
    unavailableReason?: string;
  } => {
    const audience =
      flowState.authzMetadata?.issuer ||
      flowState.authzServerIssuer ||
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
    // Skipped for dynamic strategies, which ignore the stored secret and mint
    // their own client identity in the browser.
    if (
      target.usesServerSideSecret &&
      target.serverId &&
      !runsDynamicRegistration
    ) {
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
  }, [
    flowState,
    runInput,
    selectedRegistration,
    target,
    runsDynamicRegistration,
  ]);

  // ── Single target-reset owner ──────────────────────────────────────
  // One effect keyed on (targetKey, negativeTestMode) rebuilds the flow when
  // the resolved target or the global mode changes. Guarded by value-compared
  // refs; confirms via AlertDialog before discarding a busy or completed run.
  const lastAppliedTargetKey = useRef<string | null>(null);
  const lastNegativeTestMode = useRef(runSettings.negativeTestMode);
  const lastAssertionFormat = useRef<IdentityAssertionFormat>(
    effectiveAssertionFormat
  );
  const lastRegistrationStrategy =
    useRef<RegistrationStrategy>(effectiveStrategy);
  // The EFFECTIVE identity the flow was last (re)built with (person override,
  // server override, or run-settings default — whatever runInput resolved).
  // Tracked so an identity change rebuilds the flow (clearing the
  // already-minted ID token / ID-JAG that carry the old sub) — without that,
  // advancing step-by-step keeps sending the stale subject. Seeded from the
  // initial runInput (which built the initial flow state) so no spurious
  // reset fires on mount, including for servers with a stored xaaSubject.
  const lastAppliedIdentity = useRef({
    userId: runInput.userId,
    email: runInput.email,
  });
  const [pendingReset, setPendingReset] = useState<{
    targetKey: string;
    negativeTestMode: NegativeTestMode;
    registrationStrategy: RegistrationStrategy;
    identityAssertionFormat: IdentityAssertionFormat;
  } | null>(null);

  // Rebuild the flow from the current input and record the identity it was
  // built with. Every rebuild path goes through here so the debounced identity
  // reset can tell whether another path (Run all, Reset, target switch) already
  // applied the current identity — and skip a stale timer that would otherwise
  // wipe a freshly-started run.
  const rebuildFlow = useCallback(
    (
      strategyOverride?: RegistrationStrategy,
      assertionFormatOverride?: IdentityAssertionFormat
    ) => {
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
          dcrDuplicateRiskRef.current.has(targetKey),
          assertionFormatOverride ?? effectiveAssertionFormat
        )
      );
    },
    [
      applyFlowState,
      runInput,
      effectiveStrategy,
      effectiveAssertionFormat,
      targetKey,
    ]
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
      nextStrategy: RegistrationStrategy,
      nextAssertionFormat: IdentityAssertionFormat
    ) => {
      lastAppliedTargetKey.current = nextTargetKey;
      lastNegativeTestMode.current = nextMode;
      lastRegistrationStrategy.current = nextStrategy;
      lastAssertionFormat.current = nextAssertionFormat;
      rebuildFlow(nextStrategy, nextAssertionFormat);
    },
    [rebuildFlow]
  );

  useEffect(() => {
    const nextMode = runSettings.negativeTestMode;
    const nextStrategy = effectiveStrategy;
    const nextAssertionFormat = effectiveAssertionFormat;
    if (
      lastAppliedTargetKey.current === targetKey &&
      lastNegativeTestMode.current === nextMode &&
      lastRegistrationStrategy.current === nextStrategy &&
      lastAssertionFormat.current === nextAssertionFormat
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
        identityAssertionFormat: nextAssertionFormat,
      });
      return;
    }
    applyTargetReset(targetKey, nextMode, nextStrategy, nextAssertionFormat);
  }, [
    targetKey,
    runSettings.negativeTestMode,
    effectiveStrategy,
    effectiveAssertionFormat,
    applyTargetReset,
  ]);

  // Identity edits rebuild the flow so the next run mints tokens for the new
  // sub/email. Unlike target/mode (which change discretely), typed identity
  // inputs fire on every keystroke, so the rebuild is debounced — typing
  // "john" resets once, not four times. No confirm dialog: editing the
  // identity is a deliberate "test as someone else", and the chips clearing is
  // the feedback. Compared against the EFFECTIVE runInput identity (not raw
  // run settings) so an already-applied person/server override never arms a
  // spurious timer.
  useEffect(() => {
    const nextUserId = runInput.userId;
    const nextEmail = runInput.email;
    if (
      lastAppliedIdentity.current.userId === nextUserId &&
      lastAppliedIdentity.current.email === nextEmail
    ) {
      return;
    }
    const timer = setTimeout(() => {
      // Another path (Run all, Reset, target switch, person switch) may have
      // rebuilt the flow with this identity while the timer was pending. If so
      // the tracker already matches — bail rather than wipe that fresh
      // (possibly running) state a second time.
      if (
        lastAppliedIdentity.current.userId === nextUserId &&
        lastAppliedIdentity.current.email === nextEmail
      ) {
        return;
      }
      rebuildFlow();
    }, 400);
    return () => clearTimeout(timer);
  }, [runInput.userId, runInput.email, rebuildFlow]);

  // A person switch is discrete and resets SYNCHRONOUSLY — a debounce window
  // here would let the next step reuse an assertion already minted for the
  // previous person. This also covers a persisted selection resolving after
  // the roster loads, and edits/deletes of the selected person. It never
  // rebuilds mid-run (chips are disabled while busy; a roster change during a
  // run defers to run end — the tracker stays stale so this re-fires when
  // isBusy flips back).
  const personIdentityKey = selectedPerson
    ? `${selectedPerson._id}|${selectedPerson.subject}|${selectedPerson.email}`
    : null;
  const lastAppliedPersonKey = useRef(personIdentityKey);
  useEffect(() => {
    if (lastAppliedPersonKey.current === personIdentityKey) return;
    if (flowStateRef.current.isBusy || isRunningAll) return;
    lastAppliedPersonKey.current = personIdentityKey;
    rebuildFlow();
  }, [personIdentityKey, flowState.isBusy, isRunningAll, rebuildFlow]);

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
      // Client-identity strategy (forced to preregistered inside the machine
      // for registrationId/serverId runs) plus the session credential cache
      // DCR runs mint into and redeem from.
      registrationStrategy: effectiveStrategy,
      // Both draft axes, derived from the per-server preset (the machine
      // prefers the sticky flow-state values seeded by the same preset; these
      // config fallbacks keep a fresh machine consistent with them).
      identityAssertionFormat: effectiveAssertionFormat,
      subjectIdentifierFormat: subjectIdentifierFormatFor(
        effectiveAssertionFormat
      ),
      dcrCredentialCache,
      dcrCacheTargetKey: targetKey,
      // Confidential bar-server runs send only serverId/projectId; the server
      // resolves the secret and discovers the token endpoint. Dynamic
      // strategies skip this: they ignore the stored secret and register their
      // own client, so sending serverId (which the machine forces back to
      // preregistered) would defeat the explicit DCR/CIMD choice.
      ...(target.usesServerSideSecret &&
      target.serverId &&
      !runsDynamicRegistration
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
    effectiveAssertionFormat,
    runsDynamicRegistration,
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

  const handleSelectPerson = useCallback(
    (personId: string | null) => {
      if (!projectId) return;
      // Switching identities mid-run could reuse an assertion minted for the
      // previous person — the strip disables its chips; this is the backstop.
      if (flowStateRef.current.isBusy || isRunningAll) return;
      setSelectedPersonId(projectId, personId);
    },
    [projectId, isRunningAll, setSelectedPersonId]
  );

  const outcomeForPerson = useCallback(
    (personId: string): XaaPersonOutcome | undefined => {
      const record = personOutcomes.get(`${runGateKey}|${personId}`);
      if (!record || record.targetFingerprint !== targetFingerprint) {
        return undefined;
      }
      // An edited person invalidates their stale result — the subject/email
      // that produced it may have changed.
      const person = people?.find((p) => p._id === personId);
      if (!person || person.updatedAt !== record.personUpdatedAt) {
        return undefined;
      }
      return record;
    },
    [personOutcomes, runGateKey, targetFingerprint, people]
  );

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
  // Dynamic strategies don't use the stored secret, so they're never blocked
  // on resolving it.
  const secretBlocked = target.secretUnavailable && !runsDynamicRegistration;
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
  const showNotTestable = target.targetSource === "bar_server" && !isTestable;

  return (
    <div className="h-full flex flex-col bg-background">
      <XAAIdpCard
        organizationId={organizationId ?? null}
        issuerMode={runSettings.issuerMode}
        onIssuerModeChange={runSettings.setIssuerMode}
        canUseHostedIssuer={canUseHostedIssuer}
        hostedIssuerDisabledReason={hostedIssuerDisabledReason}
      />
      <XAAPeopleStrip
        people={people}
        isLoading={peopleLoading}
        isAvailable={peopleAvailable}
        projectId={projectId ?? null}
        selectedPersonId={selectedPersonId}
        onSelectPerson={handleSelectPerson}
        disabled={flowState.isBusy || isRunningAll}
        outcomeFor={outcomeForPerson}
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
      {/* The registration strategy is chosen in the Configure Server modal;
          only DCR's mid-run "register another client" recovery lives here (the
          one action that clears the duplicate-risk gate). */}
      {effectiveStrategy === "dcr" &&
      (dcrHasSessionRegistration ||
        Boolean(flowState.dcrRetryMayCreateDuplicate)) ? (
        <XAADcrReRegisterControl
          disabled={flowState.isBusy || isRunningAll}
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
      <XAAWorkspaceLayout
        scorecard={
          isTestable ? (
            <NegativeTestScorecard
              input={
                scorecard.input
                  ? {
                      ...scorecard.input,
                      organizationId: organizationId ?? null,
                      ...(hostedIssuerOptIn
                        ? { issuerMode: "hosted" as const }
                        : {}),
                    }
                  : null
              }
              unlocked={positiveRunTargets.has(runGateKey)}
              unavailableReason={scorecard.unavailableReason}
              onResultsReady={expandScorecardForResults}
              onTargetChange={collapseScorecard}
              onExpandedChange={handleScorecardExpandedChange}
              onCompactContentHeightChange={updateCompactScorecardContentHeight}
            />
          ) : undefined
        }
        scorecardPanelRef={scorecardPanelRef}
        compactScorecardContentHeight={compactScorecardContentHeight}
        scorecardHasResults={scorecardHasResults}
      >
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
      </XAAWorkspaceLayout>

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
            // Cancel ("Keep current run"): acknowledge the pending target/mode/
            // strategy so the effect doesn't immediately re-prompt; the current
            // run stays visible. The strategy is already persisted, so every
            // fresh-run path (Reset, Run all, a later target/mode change)
            // rebuilds from it — nothing is pinned to the discarded run.
            if (pendingReset) {
              lastAppliedTargetKey.current = pendingReset.targetKey;
              lastNegativeTestMode.current = pendingReset.negativeTestMode;
              lastRegistrationStrategy.current =
                pendingReset.registrationStrategy;
              lastAssertionFormat.current =
                pendingReset.identityAssertionFormat;
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
                    pendingReset.registrationStrategy,
                    pendingReset.identityAssertionFormat
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
