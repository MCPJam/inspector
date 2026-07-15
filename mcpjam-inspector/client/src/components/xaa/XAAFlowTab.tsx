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
import { useConvexAuth } from "convex/react";
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
import { useOrgXaaPeople } from "@/hooks/useOrgXaaPeople";
import { useOrganizationQueries } from "@/hooks/useOrganizations";
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
import { XAARegistrationWizard } from "./registration/XAARegistrationWizard";
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
  buildXaaDcrCredentialCacheKey,
  createInitialXAAFlowState,
  isXaaDcrClientSecretExpired,
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

function buildXaaFlowConfigurationKey(
  input: XAAFlowInput,
  usesServerSideSecret: boolean
): string {
  return [
    input.serverUrl.trim(),
    input.authzServerIssuer.trim(),
    input.clientId.trim(),
    input.scope.trim(),
    // Never include the secret itself. Presence is enough for the key; a
    // replacement is handled by the successful server-config save signal.
    usesServerSideSecret || Boolean(input.clientSecret.trim())
      ? "confidential"
      : "public",
  ]
    .map(encodeURIComponent)
    .join("|");
}

// ── Per-person outcome recording (session-only) ─────────────────────────────

/** A recorded outcome plus the context that scopes its validity: it renders
 * only while the person is unedited (updatedAt), the target's material
 * inputs are unchanged (fingerprint), and — for dynamic strategies — the
 * client identity that produced it hasn't been re-registered (generation). */
interface RecordedPersonOutcome extends XaaPersonOutcome {
  personUpdatedAt: number;
  targetFingerprint: string;
  /** Client-identity strategy the run actually used (state-authoritative). */
  registrationStrategy: RegistrationStrategy;
  /** Fresh-registration generation the run's result belongs to. Compared at
   * read time only for dynamic strategies — a preregistered run's client
   * identity never changes underneath it. */
  registrationGeneration: number;
}

/** Material run inputs whose change invalidates a recorded outcome — a result
 * against one server/AS/client/scope says nothing about another. */
function computeTargetFingerprint(
  input: XAAFlowInput,
  registrationStrategy: RegistrationStrategy
): string {
  return [
    input.serverUrl,
    input.authzServerIssuer,
    input.clientId,
    input.scope,
    // Managed-policy context: a managed ruling says nothing about an
    // unmanaged run (and vice versa), and rulings are per resource app.
    // `testIdentityId` is deliberately EXCLUDED — the per-person dimension is
    // the outcome-map key itself, and folding the CURRENTLY-selected person
    // into the display fingerprint would hide every other person's badge.
    input.policyMode ?? "",
    input.resourceAppId ?? "",
    // Client-identity strategy: a preregistered result must not stay
    // attributed after switching to DCR/CIMD — a different client identity
    // at the AS is a different question.
    registrationStrategy,
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
    a.reasonCode === b.reasonCode &&
    a.failedStep === b.failedStep &&
    a.personUpdatedAt === b.personUpdatedAt &&
    a.targetFingerprint === b.targetFingerprint &&
    a.registrationStrategy === b.registrationStrategy &&
    a.registrationGeneration === b.registrationGeneration
  );
}

interface XAAFlowTabProps {
  serverConfigs: Record<string, ServerWithName>;
  selectedServerName: string;
  organizationId?: string | null;
  /** Active Convex project id — resolves the selected server's id + project
   * for server-side secret resolution. */
  projectId?: string | null;
  /** The active project's admin-controlled XAA test-identity default —
   * precedence slot between the per-server override and the run-settings
   * fallback, and the override-field placeholders in the Configure modal. */
  projectXaaTestDefaults?: {
    defaultIdentity: { subject: string; email: string };
  } | null;
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
  projectXaaTestDefaults = null,
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
  const { resourceApps, isAuthenticated: registrationApiAvailable } =
    useXaaResourceApps(organizationId ?? null);
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
  // cloud AS can discover the issuer. Requires an active org — signed-in
  // users mint under the membership-gated org-scoped issuer (/o/<orgId>);
  // guest sessions mint under the visibly separate ANONYMOUS TEST issuer
  // (/g/<personalOrgId>), which a RAS must explicitly allowlist and which is
  // NOT enterprise-managed-authorization conformance. The server fails
  // closed without an org rather than downgrading to the forgeable unscoped
  // issuer. (Dev-only caveat: a guest bearer signed by a locally-provisioned
  // Convex key is rejected by the hosted issuer and surfaces as a 401 on the
  // forward.)
  const hostedIssuerKind: "org" | "anonymous" = signedInUser
    ? "org"
    : "anonymous";
  const canUseHostedIssuer = !HOSTED_MODE && Boolean(organizationId);
  const hostedIssuerDisabledReason =
    HOSTED_MODE || canUseHostedIssuer
      ? undefined
      : "waiting for an organization — sign in or continue as guest to mint through the hosted issuer";
  const hostedIssuerOptIn =
    canUseHostedIssuer && runSettings.issuerMode === "hosted";

  // ── Managed-IdP mode (org-registered resource-app runs) ─────────────
  const { isAuthenticated: isConvexAuthenticated } = useConvexAuth();
  const { sortedOrganizations } = useOrganizationQueries({
    isAuthenticated: isConvexAuthenticated,
  });
  const activeOrg = sortedOrganizations.find((o) => o._id === organizationId);
  // Admin derivation mirrors XAASetupPage / XAAResourceAppsSection.
  const isOrgAdmin =
    activeOrg?.myRole === "owner" ||
    activeOrg?.myRole === "admin" ||
    activeOrg?.isCreator === true;
  // Managed policy needs an org-registered target AND the org-scoped hosted
  // issuer (direct on hosted builds, or the local hosted-issuer opt-in) —
  // the local unscoped issuer has no evaluator to consult.
  const managedCapable =
    Boolean(selectedRegistration) &&
    Boolean(organizationId) &&
    (HOSTED_MODE || hostedIssuerOptIn);
  // Admin-only escape hatch back to direct RAS testing. Session-only by
  // design (a bypass should never survive a reload unnoticed); the toggle is
  // pure UX — the issuer's evaluator independently enforces the admin check
  // server-side and denies a non-admin bypass.
  const [unmanagedOverride, setUnmanagedOverride] = useState(false);
  const policyMode: "managed" | "unmanaged" | undefined = managedCapable
    ? unmanagedOverride && isOrgAdmin
      ? "unmanaged"
      : "managed"
    : undefined;

  // ── "Run as" people ──────────────────────────────────────────────────
  // Managed-capable runs use the ORG roster (the managed test IdP's shared
  // identities, edited in the setup center); everything else keeps the
  // project fixtures — an unregistered/bar-server run is untouched.
  const {
    people: projectPeople,
    isLoading: projectPeopleLoading,
    isAvailable: projectPeopleAvailable,
  } = useXaaPeople({ projectId: projectId ?? null });
  const orgPeople = useOrgXaaPeople(
    managedCapable ? (organizationId ?? null) : null
  );
  // Suspended people are hidden from selection (the strip filters the same
  // way) — the evaluator is guaranteed to deny them at mint, so they can't
  // be a run identity either.
  const selectableOrgPeople = useMemo(
    () => orgPeople.people.filter((p) => p.status !== "suspended"),
    [orgPeople.people]
  );
  const people = managedCapable ? orgPeople.people : projectPeople;
  const peopleLoading = managedCapable
    ? orgPeople.isLoading
    : projectPeopleLoading;
  const peopleAvailable = managedCapable
    ? orgPeople.isAuthenticated
    : projectPeopleAvailable;
  const selectablePeople = managedCapable ? selectableOrgPeople : projectPeople;
  // Selection is persisted per project (fixtures) or per org (managed
  // roster) — two maps with identical reset/stale semantics.
  const selectedPersonId = managedCapable
    ? organizationId
      ? (runSettings.selectedOrgPersonIdByOrg[organizationId] ?? null)
      : null
    : projectId
      ? (runSettings.selectedPersonIdByProject[projectId] ?? null)
      : null;
  const selectedPerson = useMemo(
    () => selectablePeople?.find((p) => p._id === selectedPersonId) ?? null,
    [selectablePeople, selectedPersonId]
  );
  const { setSelectedPersonId, setSelectedOrgPersonId } = runSettings;
  // Tidy a stale selection (person deleted/archived/suspended elsewhere)
  // only once the roster has LOADED without it — clearing while loading
  // would wipe a valid selection on every mount.
  useEffect(() => {
    if (managedCapable) {
      if (
        !organizationId ||
        !selectedPersonId ||
        orgPeople.isLoading ||
        !orgPeople.isAuthenticated
      ) {
        return;
      }
      if (!selectableOrgPeople.some((p) => p._id === selectedPersonId)) {
        setSelectedOrgPersonId(organizationId, null);
      }
      return;
    }
    if (
      !projectId ||
      !selectedPersonId ||
      projectPeopleLoading ||
      !projectPeople
    ) {
      return;
    }
    if (!projectPeople.some((p) => p._id === selectedPersonId)) {
      setSelectedPersonId(projectId, null);
    }
  }, [
    managedCapable,
    organizationId,
    projectId,
    selectedPersonId,
    orgPeople.isLoading,
    orgPeople.isAuthenticated,
    selectableOrgPeople,
    projectPeopleLoading,
    projectPeople,
    setSelectedPersonId,
    setSelectedOrgPersonId,
  ]);

  const target = useXaaTestTarget({
    server: selectedServer,
    selectedServerName,
    selectedRegistration,
    runSettings,
    selectedPerson,
    projectId: projectId ?? null,
    projectDefault: projectXaaTestDefaults?.defaultIdentity ?? null,
    policyMode,
  });
  const runInput = target.runInput;
  const { targetKey, isTestable } = target;
  const flowConfigurationKey = buildXaaFlowConfigurationKey(
    runInput,
    target.usesServerSideSecret
  );

  // ── Bar-server register prompt ───────────────────────────────────────
  // A managed-capable org running against a plain bar server: policy can't
  // apply until the target is registered. Offer registering it (wizard
  // prefilled, admin-gated) or continuing unmanaged — runs are NOT blocked.
  const [dismissedBarPromptTargets, setDismissedBarPromptTargets] = useState<
    Set<string>
  >(() => new Set());
  const [registerTargetWizardOpen, setRegisterTargetWizardOpen] =
    useState(false);
  const orgPolicyAvailable =
    Boolean(organizationId) &&
    (HOSTED_MODE || hostedIssuerOptIn) &&
    registrationApiAvailable;
  const showBarServerRegisterPrompt =
    orgPolicyAvailable &&
    target.targetSource === "bar_server" &&
    isTestable &&
    !dismissedBarPromptTargets.has(targetKey);
  // Stable across renders so the wizard's open-seeded draft isn't re-seeded
  // (and user edits wiped) by a parent re-render while it's open.
  const registerTargetPrefill = useMemo(
    () => ({
      name: selectedServerName !== "none" ? selectedServerName : "",
      resourceType: "mcp" as const,
      resourceUrl: runInput.serverUrl,
      issuer: runInput.authzServerIssuer,
      targetClientId: runInput.clientId,
      scopes: runInput.scope,
    }),
    [
      selectedServerName,
      runInput.serverUrl,
      runInput.authzServerIssuer,
      runInput.clientId,
      runInput.scope,
    ]
  );

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
  const [configurationSaveVersion, setConfigurationSaveVersion] = useState(0);

  // Person outcomes need a stable key while a dynamic run establishes its
  // client ID. Dynamic identity changes are invalidated by the per-target
  // registration generation below; the scorecard gate remains intentionally
  // specific to the resolved client ID and auth method.
  const personOutcomeKey = [
    targetKey,
    hostedIssuerOptIn ? "hosted" : "local",
    organizationId ?? "",
    hostedIssuerKind,
    policyMode ?? "",
  ].join("|");

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

  // In-memory per-person outcomes, keyed `${personOutcomeKey}|${personId}` so
  // hosted/local/org variants never cross-contaminate. Session-only by
  // design.
  const [personOutcomes, setPersonOutcomes] = useState<
    Map<string, RecordedPersonOutcome>
  >(() => new Map());
  const targetFingerprint = computeTargetFingerprint(
    runInput,
    effectiveStrategy
  );

  // Fresh-registration generations, PER TARGET: bumped when a target
  // establishes a NEW dynamic client identity (a DCR/CIMD run registering a
  // fresh client, or the explicit "Register another client" action), so person
  // outcomes recorded against that target's previous client identity stop
  // rendering. Per-target so a re-registration on one target can never
  // invalidate another target's badges. The ref mirrors the state so the
  // recording effect can stamp the CURRENT value — a run that itself
  // registered a fresh client mid-flight attributes its result to the
  // identity it actually used.
  const [registrationGenerationByTarget, setRegistrationGenerationByTarget] =
    useState<ReadonlyMap<string, number>>(() => new Map());
  const registrationGenerationByTargetRef = useRef(new Map<string, number>());
  const bumpRegistrationGeneration = useCallback((key: string) => {
    const next = (registrationGenerationByTargetRef.current.get(key) ?? 0) + 1;
    registrationGenerationByTargetRef.current.set(key, next);
    setRegistrationGenerationByTarget((current) => {
      const map = new Map(current);
      map.set(key, next);
      return map;
    });
  }, []);
  const registrationGeneration =
    registrationGenerationByTarget.get(targetKey) ?? 0;
  // Owned by the single target-reset owner below (the key it last rebuilt the
  // flow for). Declared up here because the generation effect must attribute
  // dynamic clientIds to the target the CURRENT flow state was built for —
  // on a target switch, effects re-run with the NEW targetKey while flowState
  // still holds the OLD target's flow.
  const lastAppliedTargetKey = useRef<string | null>(null);
  // The last dynamic clientId each target established. A dynamic (DCR/CIMD)
  // run establishing a NEW client identity bumps that target's generation:
  // the machine writes the freshly-registered clientId into flow state, while
  // a reused session registration re-writes the SAME clientId (no bump —
  // prior results still describe that client), and an ordinary reset re-seeds
  // the CONFIGURED clientId, which is not a dynamic identity at all (no
  // bump). Declared BEFORE the recording effect below: when the registration
  // and the terminal state land in one commit, the ref must already carry the
  // new generation when the outcome is stamped.
  const lastDynamicClientIdByTargetRef = useRef(new Map<string, string>());
  useEffect(() => {
    if (flowState.registrationStrategy === "preregistered") return;
    const clientId = flowState.clientId;
    // Only a machine-established identity counts — a rebuild re-seeding the
    // configured clientId must not read as a fresh registration.
    if (!clientId || clientId === runInput.clientId) return;
    // Attribute to the target the flow was actually built for (see the
    // lastAppliedTargetKey comment above — flowState can lag a target switch).
    if (lastAppliedTargetKey.current !== targetKey) return;
    if (lastDynamicClientIdByTargetRef.current.get(targetKey) === clientId) {
      return;
    }
    lastDynamicClientIdByTargetRef.current.set(targetKey, clientId);
    bumpRegistrationGeneration(targetKey);
  }, [
    flowState.clientId,
    flowState.registrationStrategy,
    runInput.clientId,
    targetKey,
    bumpRegistrationGeneration,
  ]);
  // The whole run context is captured atomically at run START — recording
  // against live values at completion could attribute an old run to a newly
  // selected person/target/mode.
  const runContextRef = useRef<{
    personId: string;
    personUpdatedAt: number;
    /** The run's target — the per-target generation is read against it at
     * recording time (never the currently-selected target). */
    targetKey: string;
    personOutcomeKey: string;
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
          targetKey,
          personOutcomeKey,
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
    personOutcomeKey,
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
    }
  }, [flowState.currentStep, authServerModeForTelemetry]);

  // Record the run's outcome for the person it STARTED as (captured context —
  // never the currently-selected person/target). Only valid-mode runs count:
  // a deliberately-broken negative run says nothing about a subject's access.
  useEffect(() => {
    const ctx = runContextRef.current;
    if (!ctx || ctx.negativeTestMode !== "valid") return;

    let outcome: RecordedPersonOutcome | null = null;
    // Validity context beyond the captured run context: the strategy is
    // state-authoritative for the run, and the generation is read at
    // RECORDING time so a dynamic run that itself registered a fresh client
    // attributes its result to the identity it actually used.
    const validity = {
      personUpdatedAt: ctx.personUpdatedAt,
      targetFingerprint: ctx.targetFingerprint,
      registrationStrategy: flowState.registrationStrategy,
      registrationGeneration:
        registrationGenerationByTargetRef.current.get(ctx.targetKey) ?? 0,
    };
    if (flowState.currentStep === "complete") {
      // "Complete" does not prove full access — either stage may have
      // narrowed the grant. Earliest stage wins: a managed-IdP downscope at
      // mint is reported as such, and the RAS comparison baseline SHIFTS to
      // the ID-JAG's granted scope — the RAS honoring an already-narrowed
      // grant is not a second downscope (no double-reporting).
      const idpPolicy = flowState.idpPolicy;
      const status: XaaPersonOutcome["status"] =
        idpPolicy?.outcome === "downscoped"
          ? "idp_downscoped"
          : isDownscoped(
                idpPolicy?.grantedScope ?? flowState.scope,
                flowState.grantedScope
              )
            ? "ras_downscoped"
            : "allowed";
      outcome = { status, ...validity };
    } else if (flowState.error && !flowState.isBusy) {
      if (errorRecordedRef.current) return;
      errorRecordedRef.current = true;
      const failedStep: XAAFlowStep = flowState.currentStep;
      const code = extractOauthErrorCode(
        flowState.error,
        flowState.lastResponse
      );
      const idpPolicy = flowState.idpPolicy;
      // The managed IdP refusing the mint is a policy ruling about this
      // person — EXCEPT an evaluator outage (`temporarily_unavailable`),
      // which says nothing about the subject and stays a test problem.
      const isIdpDenial =
        failedStep === "token_exchange_request" &&
        idpPolicy?.outcome === "denied" &&
        idpPolicy.errorCode !== "temporarily_unavailable";
      // Only a policy-shaped refusal of the jwt-bearer redemption counts as
      // the RAS rejecting the subject — anything else (discovery, network,
      // invalid_client, an MCP 401) is a test problem, not your AS ruling on
      // the subject. Even invalid_grant can be technical, so the code is
      // displayed, not editorialized.
      const isRasRejection =
        failedStep === "jwt_bearer_request" &&
        (code === "invalid_grant" || code === "access_denied");
      outcome = {
        status: isIdpDenial
          ? "idp_denied"
          : isRasRejection
            ? "ras_rejected"
            : "test_error",
        // Prefer the response-derived code; an IdP denial falls back to the
        // SDK's allowlisted policy errorCode. Never a raw string.
        ...(code
          ? { oauthErrorCode: code }
          : isIdpDenial && idpPolicy?.errorCode
            ? { oauthErrorCode: idpPolicy.errorCode }
            : {}),
        ...(isIdpDenial && idpPolicy?.reasonCode
          ? { reasonCode: idpPolicy.reasonCode }
          : {}),
        failedStep,
        ...validity,
      };
    }
    if (!outcome) return;

    const key = `${ctx.personOutcomeKey}|${ctx.personId}`;
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
    flowState.idpPolicy,
    flowState.registrationStrategy,
  ]);

  // ── Negative-test scorecard input ───────────────────────────────────
  const scorecard = useMemo((): {
    input: NegativeTestsInput | null;
    resolveInput?: () => NegativeTestsInput;
    unavailableReason?: string;
  } => {
    // A partial per-server override is a configuration error that blocks every
    // XAA test path. The negative-test scorecard has its own ownership
    // override that bypasses the positive-run lock, so it must be suppressed
    // here explicitly — otherwise it could still fire against a server whose
    // identity the run itself refuses to mint.
    if (target.identityError) {
      return {
        input: null,
        unavailableReason: `${target.identityError} in Configure Server to Test.`,
      };
    }

    const audience =
      flowState.authzMetadata?.issuer ||
      flowState.authzServerIssuer ||
      runInput.authzServerIssuer ||
      selectedRegistration?.issuer ||
      "";
    const resource =
      flowState.resourceMetadata?.resource || runInput.serverUrl || "";

    if (flowState.registrationStrategy === "cimd") {
      return {
        input: null,
        unavailableReason: "CIMD negative tests are not supported yet.",
      };
    }

    if (flowState.registrationStrategy === "dcr") {
      const registrationEndpoint =
        flowState.authzMetadata?.registration_endpoint;
      if (
        !flowState.tokenEndpoint ||
        !flowState.clientId ||
        !registrationEndpoint
      ) {
        return {
          input: null,
          unavailableReason:
            "Run dynamic client registration first so the client credentials and token endpoint are known.",
        };
      }

      const cacheKey = buildXaaDcrCredentialCacheKey({
        targetKey,
        registrationEndpoint,
        scope: flowState.scope,
      });
      const credentials = dcrCredentialCacheRef.current.get(cacheKey);
      if (!credentials || credentials.clientId !== flowState.clientId) {
        return {
          input: null,
          unavailableReason:
            "This session's dynamic registration credentials are no longer available. Register another client to run negative tests.",
        };
      }
      if (isXaaDcrClientSecretExpired(credentials)) {
        return {
          input: null,
          unavailableReason:
            "This session's dynamic client secret has expired. Register another client to run negative tests.",
        };
      }
      if (hostedIssuerOptIn && credentials.clientSecret) {
        return {
          input: null,
          unavailableReason:
            "Negative tests for confidential DCR clients are unavailable when using the hosted issuer.",
        };
      }
      if (!audience || !resource) return { input: null };

      const input: NegativeTestsInput = {
        tokenEndpoint: flowState.tokenEndpoint,
        audience,
        resource,
        subject: runInput.userId || undefined,
        clientId: flowState.clientId,
        tokenEndpointAuthMethod: credentials.tokenEndpointAuthMethod,
        scope: runInput.scope || undefined,
      };

      return {
        input,
        // Re-read immediately before the request. A secret may expire or the
        // cache may be cleared after render; never retain it in React state.
        resolveInput: () => {
          const current = dcrCredentialCacheRef.current.get(cacheKey);
          if (!current || current.clientId !== input.clientId) {
            throw new Error(
              "This session's dynamic registration credentials are no longer available. Register another client and rerun the flow."
            );
          }
          if (isXaaDcrClientSecretExpired(current)) {
            throw new Error(
              "This session's dynamic client secret has expired. Register another client and rerun the flow."
            );
          }
          return {
            ...input,
            tokenEndpointAuthMethod: current.tokenEndpointAuthMethod,
            ...(current.clientSecret
              ? { clientSecret: current.clientSecret }
              : {}),
          };
        },
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
          // negative test on `sub` before its own check is evaluated. The
          // email rides along because the managed evaluator's exact
          // claims-match requires BOTH subject and email — a managed
          // scorecard without it is denied `identity_claims_mismatch`.
          subject: runInput.userId || undefined,
          email: runInput.email || undefined,
          clientId: runInput.clientId || undefined,
          scope: runInput.scope || undefined,
          // Managed-IdP policy context: the server evaluates policy once
          // before firing the broken-token matrix, so a denied person's
          // scorecard surfaces the policy error instead of a misleading
          // all-green (or all-red) matrix.
          ...(runInput.policyMode
            ? {
                policyMode: runInput.policyMode,
                resourceAppId: runInput.resourceAppId,
                ...(runInput.testIdentityId
                  ? { testIdentityId: runInput.testIdentityId }
                  : {}),
              }
            : {}),
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
          email: runInput.email || undefined,
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
        email: runInput.email || undefined,
        clientId: runInput.clientId || undefined,
        scope: runInput.scope || undefined,
      },
    };
  }, [
    flowState,
    runInput,
    selectedRegistration,
    target,
    targetKey,
    runsDynamicRegistration,
    hostedIssuerOptIn,
  ]);

  // ── Single target-reset owner ──────────────────────────────────────
  // One effect keyed on the target and all run-defining configuration rebuilds
  // the flow. Guarded by value-compared refs; confirms via AlertDialog before
  // discarding a busy or completed run. (lastAppliedTargetKey is declared with
  // the registration-generation tracking above, which needs it earlier.)
  const lastAppliedFlowConfigurationKey = useRef<string | null>(null);
  const lastAppliedConfigurationSaveVersion = useRef(0);
  const lastNegativeTestMode = useRef(runSettings.negativeTestMode);
  const lastAssertionFormat = useRef<IdentityAssertionFormat>(
    effectiveAssertionFormat
  );
  const lastRegistrationStrategy =
    useRef<RegistrationStrategy>(effectiveStrategy);
  // Managed↔unmanaged (and ↔no-policy) switches rebuild too: intermediate
  // artifacts minted under the previous policy mode (an already-minted
  // ID-JAG) must never be redeemed while the UI claims the new mode.
  const lastPolicyMode = useRef<"managed" | "unmanaged" | undefined>(
    policyMode
  );
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
    flowConfigurationKey: string;
    configurationSaveVersion: number;
    negativeTestMode: NegativeTestMode;
    registrationStrategy: RegistrationStrategy;
    identityAssertionFormat: IdentityAssertionFormat;
    policyMode: "managed" | "unmanaged" | undefined;
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
      nextFlowConfigurationKey: string,
      nextConfigurationSaveVersion: number,
      nextMode: NegativeTestMode,
      nextStrategy: RegistrationStrategy,
      nextAssertionFormat: IdentityAssertionFormat,
      nextPolicyMode: "managed" | "unmanaged" | undefined
    ) => {
      const previousTargetKey = lastAppliedTargetKey.current;
      lastAppliedTargetKey.current = nextTargetKey;
      const dcrConfigurationChanged =
        previousTargetKey === nextTargetKey &&
        lastAppliedFlowConfigurationKey.current !== null &&
        lastAppliedFlowConfigurationKey.current !== nextFlowConfigurationKey;
      if (dcrConfigurationChanged) {
        const targetPrefix = `${encodeURIComponent(nextTargetKey)}::`;
        for (const key of Array.from(dcrCredentialCacheRef.current.keys())) {
          if (key.startsWith(targetPrefix)) {
            dcrCredentialCacheRef.current.delete(key);
          }
        }
      }
      lastAppliedFlowConfigurationKey.current = nextFlowConfigurationKey;
      lastAppliedConfigurationSaveVersion.current =
        nextConfigurationSaveVersion;
      lastNegativeTestMode.current = nextMode;
      lastRegistrationStrategy.current = nextStrategy;
      lastAssertionFormat.current = nextAssertionFormat;
      lastPolicyMode.current = nextPolicyMode;
      rebuildFlow(nextStrategy, nextAssertionFormat);
    },
    [rebuildFlow]
  );

  useEffect(() => {
    const nextMode = runSettings.negativeTestMode;
    const nextStrategy = effectiveStrategy;
    const nextAssertionFormat = effectiveAssertionFormat;
    const nextConfigurationSaveVersion = configurationSaveVersion;
    const nextPolicyMode = policyMode;
    if (
      lastAppliedTargetKey.current === targetKey &&
      lastAppliedFlowConfigurationKey.current === flowConfigurationKey &&
      lastAppliedConfigurationSaveVersion.current ===
        nextConfigurationSaveVersion &&
      lastNegativeTestMode.current === nextMode &&
      lastRegistrationStrategy.current === nextStrategy &&
      lastAssertionFormat.current === nextAssertionFormat &&
      lastPolicyMode.current === nextPolicyMode
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
        flowConfigurationKey,
        configurationSaveVersion: nextConfigurationSaveVersion,
        negativeTestMode: nextMode,
        registrationStrategy: nextStrategy,
        identityAssertionFormat: nextAssertionFormat,
        policyMode: nextPolicyMode,
      });
      return;
    }
    applyTargetReset(
      targetKey,
      flowConfigurationKey,
      nextConfigurationSaveVersion,
      nextMode,
      nextStrategy,
      nextAssertionFormat,
      nextPolicyMode
    );
  }, [
    targetKey,
    flowConfigurationKey,
    configurationSaveVersion,
    runSettings.negativeTestMode,
    effectiveStrategy,
    effectiveAssertionFormat,
    policyMode,
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
    // Defer to run end: an async identity source (a project default resolving,
    // the roster loading) must not reset an in-progress run. The tracker stays
    // stale while busy, so this effect re-fires and rebuilds once isBusy/
    // isRunningAll clear — matching the person-switch path below.
    if (flowStateRef.current.isBusy || isRunningAll) return;
    const timer = setTimeout(() => {
      // Another path (Run all, Reset, target switch, person switch) may have
      // rebuilt the flow with this identity while the timer was pending, or a
      // run may have started inside the debounce window. Bail rather than wipe
      // that fresh (possibly running) state a second time.
      if (
        flowStateRef.current.isBusy ||
        isRunningAll ||
        (lastAppliedIdentity.current.userId === nextUserId &&
          lastAppliedIdentity.current.email === nextEmail)
      ) {
        return;
      }
      rebuildFlow();
    }, 400);
    return () => clearTimeout(timer);
  }, [
    runInput.userId,
    runInput.email,
    flowState.isBusy,
    isRunningAll,
    rebuildFlow,
  ]);

  // A person switch is discrete and resets SYNCHRONOUSLY — a debounce window
  // here would let the next step reuse an assertion already minted for the
  // previous person. This also covers a persisted selection resolving after
  // the roster loads, and edits/deletes of the selected person. It never
  // rebuilds mid-run: not while busy, and not while a step-through run is
  // PAUSED between steps (isBusy=false but the flow is neither idle nor
  // complete — rebuilding there would silently drop the in-progress state).
  // A deferred change re-fires when the run finishes (the tracker stays
  // stale until the guard passes).
  const personIdentityKey = selectedPerson
    ? `${selectedPerson._id}|${selectedPerson.subject}|${selectedPerson.email}`
    : null;
  const lastAppliedPersonKey = useRef(personIdentityKey);
  useEffect(() => {
    if (lastAppliedPersonKey.current === personIdentityKey) return;
    if (flowStateRef.current.isBusy || isRunningAll) return;
    const step = flowStateRef.current.currentStep;
    if (step !== "idle" && step !== "complete") return;
    lastAppliedPersonKey.current = personIdentityKey;
    rebuildFlow();
  }, [
    personIdentityKey,
    flowState.isBusy,
    flowState.currentStep,
    isRunningAll,
    rebuildFlow,
  ]);

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
    // A new client identity is about to be established: person outcomes
    // recorded against this target's previous registration must stop
    // rendering (other targets' registrations are untouched).
    bumpRegistrationGeneration(targetKey);
    rebuildFlow();
  }, [targetKey, rebuildFlow, bumpRegistrationGeneration]);

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
    // Thread issuerKind so a hosted guest discovers its /g/ (anonymous) issuer
    // rather than /o/ — otherwise the ID-JAG inspection would lint the
    // /g/-minted `iss` against the wrong /o/ issuer and report a mismatch.
    void fetchXaaIdpUrls(
      controller.signal,
      organizationId,
      hostedIssuerKind
    ).then((urls) => {
      if (urls && !controller.signal.aborted) {
        setResolvedIssuerBaseUrl(urls.issuerBaseUrl);
      }
    });
    return () => controller.abort();
  }, [organizationId, hostedIssuerKind]);

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
      // Managed-IdP policy context — the machine emits it on the ID-JAG mint
      // (headers on the spec /token form, body fields on the JSON mint) so
      // the org-scoped issuer can enforce per-person policy.
      ...(runInput.policyMode
        ? {
            policyMode: runInput.policyMode,
            resourceAppId: runInput.resourceAppId,
            ...(runInput.testIdentityId
              ? { testIdentityId: runInput.testIdentityId }
              : {}),
          }
        : {}),
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
      issuerKind: hostedIssuerKind,
    });
  }, [
    runInput,
    target,
    updateFlowState,
    resolvedIssuerBaseUrl,
    organizationId,
    hostedIssuerOptIn,
    hostedIssuerKind,
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
      // Switching identities mid-run could reuse an assertion minted for the
      // previous person — the strip disables its chips; this is the backstop.
      // Covers paused step-through runs too (isBusy=false, mid-flow).
      if (flowStateRef.current.isBusy || isRunningAll) return;
      const step = flowStateRef.current.currentStep;
      if (step !== "idle" && step !== "complete") return;
      if (managedCapable) {
        if (!organizationId) return;
        setSelectedOrgPersonId(organizationId, personId);
        return;
      }
      if (!projectId) return;
      setSelectedPersonId(projectId, personId);
    },
    [
      managedCapable,
      organizationId,
      projectId,
      isRunningAll,
      setSelectedPersonId,
      setSelectedOrgPersonId,
    ]
  );

  const outcomeForPerson = useCallback(
    (personId: string): XaaPersonOutcome | undefined => {
      const record = personOutcomes.get(`${personOutcomeKey}|${personId}`);
      if (!record || record.targetFingerprint !== targetFingerprint) {
        return undefined;
      }
      // A dynamic-strategy result is valid only for the client identity that
      // produced it — a later fresh registration (re-register action or a
      // new DCR/CIMD client) invalidates it. Preregistered results ignore
      // the generation: their client identity never changes underneath them.
      if (
        record.registrationStrategy !== "preregistered" &&
        record.registrationGeneration !== registrationGeneration
      ) {
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
    [
      personOutcomes,
      personOutcomeKey,
      targetFingerprint,
      registrationGeneration,
      people,
    ]
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

  // A partial legacy identity override can't resolve an atomic identity —
  // block the run with the same actionable error Connect surfaces.
  const identityBlockedReason = target.identityError
    ? `${target.identityError} in Configure Server to Test.`
    : null;

  const continueDisabled =
    !isTestable ||
    secretBlocked ||
    Boolean(target.identityError) ||
    flowState.isBusy ||
    isRunningAll ||
    flowState.currentStep === "complete" ||
    Boolean(flowState.negativeProbe);

  const runAllDisabled =
    !isTestable ||
    secretBlocked ||
    Boolean(target.identityError) ||
    flowState.isBusy ||
    isRunningAll;

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
        issuerKind={hostedIssuerKind}
      />
      <XAAPeopleStrip
        people={people}
        isLoading={peopleLoading}
        isAvailable={peopleAvailable}
        projectId={projectId ?? null}
        selectedPersonId={selectedPersonId}
        onSelectPerson={handleSelectPerson}
        // Disabled while busy AND while a step-through run is paused between
        // steps — a person change mid-run (switch, edit, delete) would drop
        // the in-progress state or mutate the running identity.
        disabled={
          flowState.isBusy ||
          isRunningAll ||
          (flowState.currentStep !== "idle" &&
            flowState.currentStep !== "complete")
        }
        outcomeFor={outcomeForPerson}
        mode={managedCapable ? "org" : "project"}
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
      {managedCapable ? (
        <div
          className="flex items-center justify-between gap-2 border-b border-border bg-muted/30 px-4 py-1.5 text-xs text-muted-foreground"
          role="status"
        >
          <span>
            {policyMode === "unmanaged"
              ? "Org policy bypassed — this run goes straight to the authorization server."
              : "Org IdP policy applies — pick a person to run as."}
          </span>
          {isOrgAdmin ? (
            // Session-only UX toggle; the issuer independently enforces the
            // admin check server-side, so this can never GRANT a bypass. A
            // change reroutes through the single target-reset owner
            // (policyMode is part of its key), so artifacts minted under the
            // previous mode — an already-minted ID-JAG — are never sent while
            // the banner claims the new one.
            <label className="flex shrink-0 cursor-pointer items-center gap-1.5">
              <input
                type="checkbox"
                className="h-3 w-3 accent-primary"
                checked={unmanagedOverride}
                disabled={flowState.isBusy || isRunningAll}
                onChange={(event) =>
                  setUnmanagedOverride(event.target.checked)
                }
              />
              Advanced: bypass org policy
            </label>
          ) : null}
        </div>
      ) : null}
      {showBarServerRegisterPrompt ? (
        <div
          className="flex items-center justify-between gap-2 border-b border-border bg-muted/30 px-4 py-1.5 text-xs text-muted-foreground"
          role="status"
        >
          <span>
            This server isn&apos;t registered with your org&apos;s test IdP —
            no per-person policy applies to this run.
          </span>
          <div className="flex shrink-0 items-center gap-1">
            {isOrgAdmin ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-6 text-xs"
                onClick={() => setRegisterTargetWizardOpen(true)}
              >
                Register this server
              </Button>
            ) : null}
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-6 text-xs"
              onClick={() =>
                setDismissedBarPromptTargets((current) => {
                  const next = new Set(current);
                  next.add(targetKey);
                  return next;
                })
              }
            >
              Run unmanaged
            </Button>
          </div>
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
      {identityBlockedReason ? (
        <div
          className="flex items-center gap-2 border-b border-border bg-muted/30 px-4 py-1.5 text-xs text-muted-foreground"
          role="status"
        >
          <ShieldAlert className="h-3.5 w-3.5 shrink-0 text-destructive" />
          <span>{identityBlockedReason}</span>
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
                      // Guests mint under /g/; without issuerKind the
                      // negative-test run would default to /o/ and 403.
                      issuerKind: hostedIssuerKind,
                      ...(hostedIssuerOptIn
                        ? { issuerMode: "hosted" as const }
                        : {}),
                    }
                  : null
              }
              resolveInput={
                scorecard.resolveInput
                  ? () => ({
                      ...scorecard.resolveInput!(),
                      organizationId: organizationId ?? null,
                      issuerKind: hostedIssuerKind,
                      ...(hostedIssuerOptIn
                        ? { issuerMode: "hosted" as const }
                        : {}),
                    })
                  : undefined
              }
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
        projectDefaultIdentity={
          projectXaaTestDefaults?.defaultIdentity ?? null
        }
        projectId={target.barServerProjectId}
        hostedServerId={target.barServerId}
        onSave={async ({ formData }) => {
          // Await so the modal can keep itself open (and preserve the entered
          // values) if the save rejects. Selection only follows a save that
          // didn't throw.
          await onSaveServerConfig?.(formData);
          setConfigurationSaveVersion((version) => version + 1);
          onSelectServer?.(formData.name);
          // A bar server overrides any selected registration.
          setSelectedRegistrationId(null);
        }}
      />

      {/* "Register this server" from the bar-server prompt: create-mode
          wizard seeded with the current target; saving selects the new
          registration so the run flips to managed immediately. */}
      <XAARegistrationWizard
        open={registerTargetWizardOpen}
        onOpenChange={setRegisterTargetWizardOpen}
        organizationId={organizationId ?? null}
        prefill={registerTargetPrefill}
        onSaved={(id) => setSelectedRegistrationId(id)}
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
              lastAppliedFlowConfigurationKey.current =
                pendingReset.flowConfigurationKey;
              lastAppliedConfigurationSaveVersion.current =
                pendingReset.configurationSaveVersion;
              lastNegativeTestMode.current = pendingReset.negativeTestMode;
              lastRegistrationStrategy.current =
                pendingReset.registrationStrategy;
              lastAssertionFormat.current =
                pendingReset.identityAssertionFormat;
              lastPolicyMode.current = pendingReset.policyMode;
            }
            setPendingReset(null);
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Reset flow?</AlertDialogTitle>
            <AlertDialogDescription>
              The current run will be discarded and rebuilt with the new
              configuration.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep current run</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (pendingReset) {
                  applyTargetReset(
                    pendingReset.targetKey,
                    pendingReset.flowConfigurationKey,
                    pendingReset.configurationSaveVersion,
                    pendingReset.negativeTestMode,
                    pendingReset.registrationStrategy,
                    pendingReset.identityAssertionFormat,
                    pendingReset.policyMode
                  );
                }
                setPendingReset(null);
              }}
            >
              Switch and reset flow
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
