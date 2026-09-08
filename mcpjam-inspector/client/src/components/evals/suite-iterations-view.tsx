import {
  useMemo,
  useState,
  useEffect,
  useCallback,
  useReducer,
  useRef,
} from "react";
import { useMutation, useConvexAuth, useQuery } from "convex/react";
import { useFeatureFlagEnabled } from "posthog-js/react";
import { useHostList } from "@/hooks/useClients";
import { useComputersEnabled } from "@/hooks/useComputersEnabled";
import { useScheduledEvalsEnabled } from "@/hooks/useScheduledEvalsEnabled";
import { useSandboxImages } from "@/hooks/useSandboxImages";
import { useEphemeralCloudAvailable } from "@/hooks/useProjectComputer";
import { useProjectEnvironments } from "@/hooks/useProjectEnvironments";
import { useActorCanQuery } from "@/hooks/use-actor-can-query";
import type { HostConfigDtoV2 } from "@/lib/client-config-v2";
import {
  useProjectServers,
  useProjectServerAttachments,
} from "@/hooks/useViews";
import { disambiguateLabels, environmentLabel } from "@/lib/environment-label";
import {
  SuiteStageFactsList,
  type StageFactsTarget,
} from "./suite-stage-facts-panel";
import {
  CloudUnreachableNotice,
  EVAL_SANDBOX_CLOUD_UNREACHABLE_MESSAGE,
} from "@/components/computer/CloudUnreachableNotice";
import { useEvalComposeCapable } from "@/components/environment-composer/use-eval-compose-capable";
import { SuiteEnvironmentComposerBar } from "./suite-environment-composer-bar";
import { toast } from "sonner";
import { motion, AnimatePresence, useReducedMotion } from "framer-motion";
import {
  buildHostNamesById,
  compareRunsBySequence,
  evalSuitePinsSandboxImage,
  getLatestRunMetricSource,
  getRunMetricSource,
  runEnvironmentRef,
} from "./helpers";
import { SuiteHeader } from "./suite-header";
import { SuiteHeroStats } from "./suite-hero-stats";
import { RunOverview } from "./run-overview";
import { RunDetailView } from "./run-detail-view";
import { CrossHostDashboard } from "./cross-host/cross-host-dashboard";
import { shouldShowRunAccuracyHero } from "./run-insight-rail";
import { RunTestCaseDetailView } from "./run-test-case-detail-view";
import type { RunCaseGroup } from "./run-case-groups";
import { RunDiffView } from "./run-diff-view";
import { TestTemplateEditor } from "./test-template-editor";
import { useEvalRunIterationChains } from "@/hooks/use-eval-run-iteration-chains";
import { PassCriteriaSelector } from "./pass-criteria-selector";
import { SuitePassOrFailSection } from "./suite-pass-or-fail-section";
import { JudgeRubricEditor, isRubricValid } from "./judge-rubric-editor";
import { JudgeGatePanel } from "./judge-gate-panel";
import { useGroundedness } from "./use-groundedness";
import { JudgeBacktestPanel } from "./judge-backtest-panel";
import {
  VerdictPolicyUpgradeButton,
  VerdictPolicyV2Controls,
  VerdictValidityControls,
} from "./suite-policy-controls";
import { SuiteQualityGateSection } from "./suite-quality-gate-section";
import { areAllChecksValid } from "./checks-section";
import { splitPredicatesForMigration } from "@/shared/predicate-migration";
import type { EvalMatchOptions, Predicate } from "@/shared/eval-matching";
import { TestCasesOverview } from "./test-cases-overview";
import { TestCaseDetailView } from "./test-case-detail-view";
import { SuiteDashboard } from "./suite-dashboard";
import { SuiteDetailOverview } from "../evaluate/suite-detail-overview";
import { EvaluateRunPage } from "../evaluate/evaluate-run-page";
import { EvaluateRunContent } from "../evaluate/evaluate-run-content";
import { RunDecisionSummarySection } from "./run-decision-summary-section";
import { SuiteAutomationRow } from "./suite-automation-row";
import { SuiteGithubChecksSection } from "./suite-github-checks-section";
import {
  useGithubChecksAvailability,
  useGithubChecksSettings,
} from "@/hooks/useGithubChecksSettings";
import { ErrorBoundary } from "@/components/ui/error-boundary";
import { EvalExportModal } from "./eval-export-modal";
import { ExportTracesModal } from "./export-traces-modal";
import { ShareDialog } from "@/components/sharing/ShareDialog";
import { ResourceSharePanel } from "@/components/sharing/ResourceSharePanel";
import { buildEvalSharePath } from "@/lib/app-navigation";
// SuiteExecutionConfigEditor was previously rendered on the suite settings
// page; hidden there in the judge-config rework (see comment at the
// removed render site). Import kept dropped to avoid an unused-symbol
// lint and to make the removal obvious if someone reaches for it later.
import { useSuiteData, useRunDetailData } from "./use-suite-data";
import { useSuiteCapabilities } from "@/hooks/use-suite-capabilities";
import {
  CAPABILITY_REASON_COPY,
  CI_OWNED_REASON_COPY,
  DEPLOYMENT_REASON_COPY,
  featureDisabledReason,
  PERMISSION_REASON_COPY,
} from "./capability-reasons";
import type {
  EvalCase,
  EvalIteration,
  EvalSuite,
  EvalSuiteRun,
  SuiteAggregate,
} from "./types";
import type { EvalRoute, SuiteOverviewView } from "@/lib/eval-route-types";
import { getBillingErrorMessage } from "@/lib/billing-entitlements";
import {
  canCommit,
  committedSuiteSettingsValues,
  describeDraft,
  dirtyKeys,
  initSuiteSettingsDraft,
  readSuiteSettingsValues,
  suiteSettingsReducer,
  type SuiteSettingsKey,
} from "./suite-settings-draft";
import { SuiteSettingsRow } from "./suite-settings-row";
import { SuiteSettingsSectionChain } from "./suite-settings-section-chain";
import {
  SuiteSettingsGroupTabs,
  SuiteSettingsSubsectionNav,
} from "./suite-settings-group-nav";
import {
  SUITE_SETTINGS_GROUPS,
  NESTED_SETTING_KEYS,
  LEGACY_CLIENTS_ROW_LABEL,
  type SuiteSettingsGroupId,
  type SuiteSettingsTabId,
} from "./suite-settings-groups";
import {
  getSubsectionsForGroup,
  subsectionForSettingKey,
  subsectionScrollTarget,
} from "./suite-settings-subsections";
import { summarizeGithubChecks } from "./suite-settings-summary";
import { useSuiteSettingsCommit } from "./use-suite-settings-draft";
import { SuiteSettingsCommitBar } from "./suite-settings-commit-bar";
import { ReviewAndSaveDialog } from "./review-and-save-dialog";
import { useUnsavedChangesGuard } from "@/hooks/use-unsaved-changes-guard";
import { useSharedAppState } from "@/state/app-state-context";
import { Button } from "@mcpjam/design-system/button";
import { Loader2, Trash2 } from "lucide-react";
import type { EvalChatHandoff } from "@/lib/eval-chat-handoff";
import type { EnsureServersReadyResult } from "@/hooks/use-app-state";
import type { RemoteServer } from "@/hooks/useProjects";
import type { EvalSuiteSettingKey } from "@/shared/eval-suite-settings-manifest";
import {
  normalizeDraftEvalCaseForExport,
  normalizeEvalCaseForExport,
  pickSuiteExportCases,
  type EvalExportCaseInput,
  type EvalExportDraftInput,
} from "@/lib/evals/eval-export";

export interface SuiteNavigation {
  toSuiteOverview: (suiteId: string, view?: SuiteOverviewView) => void;
  toRunDetail: (
    suiteId: string,
    runId: string,
    iteration?: string,
    options?: {
      insightsFocus?: boolean;
      replace?: boolean;
      compareToRunId?: string;
      testCaseId?: string;
    },
  ) => void;
  toTestDetail: (suiteId: string, testId: string, iteration?: string) => void;
  toTestEdit: (
    suiteId: string,
    testId: string,
    options?: { openCompare?: boolean; replace?: boolean; iteration?: string },
  ) => void;
  toSuiteEdit: (suiteId: string) => void;
}

const ROW_DRAFT_KEYS: Partial<Record<EvalSuiteSettingKey, SuiteSettingsKey[]>> =
  {
    name: ["name"],
    policy: [
      "defaultPassCriteria",
      "minIterations",
      "verdictPolicyVersion",
      "verdictPolicyDefaults",
      "gatePolicy",
    ],
    validity: ["verdictPolicyDefaults"],
    passOrFail: [
      "defaultMatchOptions",
      "defaultPredicates",
      "judgeConfig",
      "judgeRubric",
    ],
    computerEnvironment: ["computerEnvironmentId"],
  };

function LedgerRowChips({
  dirty,
  conflict,
}: {
  dirty: boolean;
  conflict: boolean;
}) {
  if (!dirty && !conflict) return null;
  return (
    <>
      {dirty ? (
        <span className="rounded-md border border-border px-1.5 py-px text-[11px] text-muted-foreground">
          Unsaved
        </span>
      ) : null}
      {conflict ? (
        <span className="rounded-md border border-warning/40 px-1.5 py-px text-[11px] text-warning-foreground">
          Changed elsewhere
        </span>
      ) : null}
    </>
  );
}

/**
 * The GitHub Checks section, availability read and chrome included.
 *
 * The read lives HERE rather than in `SuiteIterationsView` for one reason: it
 * can throw, and it must be able to fail inside a boundary. Availability is
 * backend-decided, and the backend REFUSES rather than answers for a caller who
 * is not a signed-in member of the org (a guest actor, a stale org id in client
 * state) — see `useGithubChecksSettings`. `useQuery` re-throws that during
 * render, so a hook called in `SuiteIterationsView` itself takes the entire
 * suite page down with it. It did: the two settings call sites have always
 * wrapped this hook in an `ErrorBoundary`, the call site added here did not.
 *
 * A refused beta gate means "no section", never "no page", so the boundary at
 * the render site below renders nothing. It still reports to Sentry — silence
 * is the UI choice, not the telemetry one.
 *
 * Not a PostHog flag like its neighbours in the settings sheet: a client-side
 * twin of a server-evaluated gate could disagree with it, offering a section
 * whose every write the server then refuses. One authority, asked once.
 */
function SuiteGithubChecksSettingsSection({
  suiteId,
  projectId,
  organizationId,
}: {
  suiteId: string;
  projectId?: string | null;
  organizationId?: string | null;
}) {
  const availability = useGithubChecksAvailability(organizationId);
  const settings = useGithubChecksSettings(organizationId);
  if (availability?.state === "disabled") return null;
  const summary = summarizeGithubChecks({
    availability,
    rows: settings.repos,
    suiteId,
  });

  return (
    <SuiteSettingsRow
      settingKey="githubChecks"
      data-subsection-id="githubChecks"
      appliesImmediately
      hint="Run this suite on every pull request to a connected repository."
    >
      {availability?.state === "enabled" ? (
        <SuiteGithubChecksSection
          suiteId={suiteId}
          projectId={projectId}
          organizationId={organizationId}
        />
      ) : (
        <p className="text-[11px] text-muted-foreground">{summary.text}</p>
      )}
    </SuiteSettingsRow>
  );
}

/**
 * The suite's runs NEWEST FIRST. `compareRunsBySequence` sorts ascending by
 * run number, so a bare sort puts run #1 first — which is how a suite with
 * fifty runs once backtested a draft rubric against its very first run.
 */
export function sortRunsNewestFirst(runs: EvalSuiteRun[]): EvalSuiteRun[] {
  return [...runs].sort((a, b) => compareRunsBySequence(b, a));
}

const TERMINAL_RUN_STATUSES = new Set([
  "completed",
  "failed",
  "cancelled",
  "timed_out",
]);

/**
 * S6 — the run a rubric edit can be backtested against.
 *
 * The newest TERMINAL run that was actually judged: a run whose
 * `goalCompletion` is absent or `null` has no stored verdict to compare a
 * draft against, and a run still going has nothing to re-grade at all.
 * `null` means the panel is not offered rather than offered and refused.
 */
export function pickBacktestableRun(runs: EvalSuiteRun[]): EvalSuiteRun | null {
  return (
    sortRunsNewestFirst(runs).find(
      (run) =>
        TERMINAL_RUN_STATUSES.has(run.status ?? "") &&
        run.goalCompletion != null,
    ) ?? null
  );
}

/**
 * Why the settings below cannot be changed here, and the way forward.
 *
 * At the TOP of the sheet, not on the control that refuses: someone opens
 * Settings to change something specific, and a reason discoverable only by
 * clicking the thing that does not work is a reason most people never read.
 */
function SuiteCiOwnedNotice({ onDuplicate }: { onDuplicate?: () => void }) {
  return (
    <div
      data-testid="suite-settings-ci-owned"
      className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border/60 bg-muted/40 px-4 py-3"
    >
      <p className="text-xs text-muted-foreground">{CI_OWNED_REASON_COPY}</p>
      {onDuplicate ? (
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="h-8 shrink-0"
          onClick={onDuplicate}
          data-testid="suite-settings-duplicate-to-edit"
        >
          Duplicate to edit
        </Button>
      ) : null}
    </div>
  );
}

export function SuiteIterationsView({
  suite,
  cases,
  iterations,
  allIterations,
  runs,
  runsLoading,
  aggregate,
  onRerun,
  onReplayRun,
  onCancelRun,
  onDelete,
  onDeleteRun: _onDeleteRun,
  onDirectDeleteRun,
  connectedServerNames,
  rerunningSuiteId,
  replayingRunId,
  cancellingRunId,
  deletingSuiteId,
  deletingRunId: _deletingRunId,
  availableModels,
  route,
  userMap,
  projectId = null,
  organizationId = null,
  navigation,
  onSetupCi,
  onCreateTestCase: onCreateTestCaseProp,
  onRecordTestCase: onRecordTestCaseProp,
  onGenerateTestCases: onGenerateTestCasesProp,
  canGenerateTestCases = false,
  isGeneratingTestCases = false,
  caseListInSidebar = false,
  runDetailSortByOverride,
  onRunDetailSortByChange,
  omitRunIterationList = false,
  canDeleteSuite,
  canDeleteRuns = true,
  canDeleteRun,
  readOnlyConfig = false,
  configLocked: configLockedProp = false,
  onDuplicateSuite,
  hideRunActions = false,
  casesSidebarHidden,
  onShowCasesSidebar,
  omitSuiteHeader = false,
  suiteDetailOverview = false,
  evaluateDecisionSummary = false,
  evaluateCaseEditor = false,
  alwaysShowEditIterationRows = false,
  onEditTestCase,
  onDeleteTestCasesBatch: onDeleteTestCasesBatchProp,
  onRunTestCase,
  runningTestCaseId = null,
  onContinueInChat,
  projectServers,
  generateTestCasesDisabledReason,
  evalRunsDisabledReason: evalRunsDisabledReasonProp,
  isDirectGuest = false,
  ensureServersReady,
}: {
  suite: EvalSuite;
  cases: EvalCase[];
  iterations: EvalIteration[];
  allIterations: EvalIteration[];
  runs: EvalSuiteRun[];
  runsLoading: boolean;
  aggregate: SuiteAggregate | null;
  onRerun: (suite: EvalSuite) => void;
  onReplayRun?: (suite: EvalSuite, run: EvalSuiteRun) => void;
  onCancelRun: (runId: string) => void;
  onDelete: (suite: EvalSuite) => void;
  onDeleteRun: (runId: string) => void;
  onDirectDeleteRun: (runId: string) => Promise<void>;
  connectedServerNames: Set<string>;
  rerunningSuiteId: string | null;
  replayingRunId?: string | null;
  cancellingRunId: string | null;
  deletingSuiteId: string | null;
  deletingRunId: string | null;
  availableModels: any[];
  route: EvalRoute;
  userMap?: Map<string, { name: string; imageUrl?: string }>;
  projectId?: string | null;
  /** Active org, for the backend-gated GitHub Checks section. Absent ⇒ hidden. */
  organizationId?: string | null;
  navigation: SuiteNavigation;
  onSetupCi?: () => void;
  onCreateTestCase?: () => void;
  onRecordTestCase?: () => void;
  onGenerateTestCases?: () => void;
  canGenerateTestCases?: boolean;
  generateTestCasesDisabledReason?: string;
  evalRunsDisabledReason?: string | null;
  isGeneratingTestCases?: boolean;
  /** When true, the case list lives in a parent sidebar; omit the duplicate cases table on suite overview. */
  caseListInSidebar?: boolean;
  /** When set with onRunDetailSortByChange, controls iteration sort (e.g. CI Runs parent sidebar). */
  runDetailSortByOverride?: "model" | "test" | "result";
  onRunDetailSortByChange?: (sort: "model" | "test" | "result") => void;
  /** When true, hide the iteration list in run detail (shown in a parent sidebar instead). */
  omitRunIterationList?: boolean;
  /** When true, show suite delete affordances. */
  canDeleteSuite: boolean;
  /** Whether the run selection + batch delete surface is shown at all. */
  canDeleteRuns?: boolean;
  /**
   * Per ROW, because deleting a run takes the project manage tier OR
   * authorship of that run. Omitted means every listed run may be deleted.
   */
  canDeleteRun?: (run: EvalSuiteRun) => boolean;
  /** When true, hide suite editing and other destructive controls (e.g. desktop CI). */
  readOnlyConfig?: boolean;
  /**
   * The suite's configuration lives in a repository (a committed suite file, or
   * SDK ingest), so the app refuses to edit it — see `isCiOwnedSuite`.
   *
   * DELIBERATELY NOT `readOnlyConfig`. That prop also hides Run, because it
   * means "this surface does not offer suite controls" (desktop CI). This one
   * means "this suite refuses edits", and running it is exactly what stays —
   * merging the two would take Run away from every CI-owned suite, which is the
   * thing the lock exists to keep working.
   *
   * The backend refuses these writes itself; this only decides whether a
   * control is offered, so a client that races an ownership change still meets
   * a clean refusal at the mutation.
   */
  configLocked?: boolean;
  /**
   * Take an editable copy of this suite. Rendered only when
   * {@link configLocked} — a suite the app refuses to edit needs a way
   * forward, and `duplicateTestSuite` produces one that is app-owned
   * (`source: 'ui'`, no declared id).
   */
  onDuplicateSuite?: () => void;
  /** When true, suppress suite-level run/replay entry points in shared chrome. */
  hideRunActions?: boolean;
  casesSidebarHidden?: boolean;
  onShowCasesSidebar?: () => void;
  /** When true, hide {@link SuiteHeader} on run detail (e.g. CI where breadcrumbs + sidebar carry context). */
  omitSuiteHeader?: boolean;
  /**
   * Evaluate (New) only: render {@link SuiteDetailOverview} — identity, run
   * history, cases — instead of the unified dashboard on suite overview, and
   * {@link EvaluateRunPage} instead of the SuiteResultsSplit rail on run
   * detail.
   *
   * OFF by default on purpose. This is a shared component: the shipped
   * Evaluate tab, CI Runs, and the desktop surfaces all mount it, and the
   * redesign is behind `evaluate-enabled`. Only `EvaluateTab` passes it.
   */
  suiteDetailOverview?: boolean;
  /**
   * Evaluate (New) only: read and render D9's canonical run decision summary
   * on run detail and on the suite's run history.
   *
   * OFF by default, and the default is what keeps `/evals` byte-identical:
   * with this false nothing here subscribes, so a non-Evaluate mount issues
   * exactly zero decision-summary requests. Only `EvaluateTab` passes it.
   */
  evaluateDecisionSummary?: boolean;
  /**
   * Evaluate (New) only: author cases with the simple case editor
   * (`components/evaluate/simple-case/`) — the three-question form, the
   * per-trial chain and route rollup on quick runs, and the
   * Generate / Record / Write empty state.
   *
   * OFF by default, which is what keeps `/evals` byte-identical: with this
   * false the case editor renders the flat step list exactly as it does
   * today. Only `EvaluateTab` passes it.
   */
  evaluateCaseEditor?: boolean;
  /** Playground run detail: show edit affordance on every row that has a test case id. */
  alwaysShowEditIterationRows?: boolean;
  /** Override default test edit navigation (e.g. playground hash navigation). */
  onEditTestCase?: (testCaseId: string) => void;
  /** Playground: batch delete test cases from the cases table (no runs UI). */
  onDeleteTestCasesBatch?: (testCaseIds: string[]) => Promise<void>;
  /** Per-case run from the cases overview table (Explore / CI). */
  onRunTestCase?: (
    testCase: EvalCase,
    opts?: { iterationOverride?: number },
  ) => void;
  runningTestCaseId?: string | null;
  onContinueInChat?: (handoff: Omit<EvalChatHandoff, "id">) => void;
  projectServers?: RemoteServer[];
  /** When true, this is rendering the direct-guest eval playground flow. */
  isDirectGuest?: boolean;
  /** Playground: connect suite MCP servers before compare run (same as per-case run). */
  ensureServersReady?: (
    serverNames: string[],
  ) => Promise<EnsureServersReadyResult>;
}) {
  const appState = useSharedAppState();
  // Derive view state from route
  //
  // `isEditMode` is whether the settings SHEET renders, and it deliberately
  // does NOT include the CI lock — see the long note further down. It is
  // computed here, ahead of the lock, because the capabilities query below is
  // scoped to it and the lock reads that query's answer.
  const isEditMode = route.type === "suite-edit" && !readOnlyConfig;

  // WHAT THE SUITE IS, asked twice, and both answers count.
  //
  // Re-asked on the suite's revision number: a save that changes what someone
  // may do next (acknowledging a judge gate, upgrading the verdict policy)
  // should change the rows, not leave them describing the suite as it was when
  // the page loaded. Bumped by an acknowledgement, which changes what the gate
  // switch may do WITHOUT changing the suite's revision — the acknowledgement
  // is stored on the suite but is not a settings edit, so nothing else would
  // re-ask.
  const [capabilitiesRefresh, setCapabilitiesRefresh] = useState(0);
  const { state: capabilitiesState, capabilities } = useSuiteCapabilities(
    isEditMode ? suite._id : null,
    `${suite.revisionNumber ?? "none"}:${capabilitiesRefresh}`,
  );
  // The ONE rule every row below shares: when capabilities could not be read,
  // behave exactly as the page did before they existed. Capabilities make a
  // page more honest; they must never make it less usable than the page that
  // had none.
  const capabilitiesReady = capabilitiesState === "ready" && capabilities;

  // IS THIS SUITE CI'S? — asked of two sources, and answered once.
  //
  // OR-ed, because they fail in opposite directions. The SUITE ROW
  // (`isCiOwnedSuite`, resolved by the caller) is complete — `declaredSuiteId`
  // and `source` both live on it — and answers before any query resolves, which
  // is why it cannot simply be replaced. `getSuiteCapabilities.ownership` is the
  // backend's own answer, from the same predicate that will refuse the write,
  // and it is the one that stays right if the cached row is stale. Neither
  // alone; a lock that disagrees with the server is the bug this whole change
  // exists to remove.
  //
  // It SHADOWS the prop rather than sitting beside it, so there is exactly one
  // answer in this component. Beside it, the two disagreed in a way nobody
  // would have predicted from reading either line: the settings column locked
  // on the combined answer while the case callbacks, the pass-downs and the
  // CI-owned notice all still read the row — a suite the backend calls CI's
  // would grey out its settings, offer Add case anyway, and explain nothing.
  //
  // No cycle: `isEditMode` above is derived from the route and `readOnlyConfig`
  // only, so it never reads this.
  const configLocked =
    configLockedProp ||
    (capabilitiesReady && capabilities.ownership?.ciOwned === true);

  // Every EDITING gate reads this, not `readOnlyConfig`: a CI-owned suite is
  // read-only in exactly the same way, but keeps its Run controls.
  const editingDisabled = readOnlyConfig || configLocked;

  // ── CASE AUTHORING, WITHHELD RATHER THAN GATED ────────────────────────────
  //
  // `case.create`, `case.edit` and `case.delete` are all in the platform's
  // locked set, so on a CI-owned suite every one of these ends in a `409`
  // after the click. The affordance is the bug, not the refusal.
  //
  // Withheld at the top rather than gated at each render site, for the same
  // reason the settings column is one `fieldset[disabled]` rather than thirty
  // `disabled` props: these callbacks reach the header, the dashboard, the
  // folded dashboard, the sidebar case list and the run page — five call sites
  // today, and the sixth is the one somebody forgets. Every consumer already
  // hides its control when the prop is absent, because a surface that cannot
  // author cases is not a new state for any of them.
  //
  // `onDuplicateSuite` is deliberately NOT in here: duplicating is the way out
  // of the lock, and it writes a new suite rather than this one.
  const onCreateTestCase = configLocked ? undefined : onCreateTestCaseProp;
  const onRecordTestCase = configLocked ? undefined : onRecordTestCaseProp;
  const onGenerateTestCases = configLocked
    ? undefined
    : onGenerateTestCasesProp;
  const onDeleteTestCasesBatch = configLocked
    ? undefined
    : onDeleteTestCasesBatchProp;
  // WHY `isEditMode` ABOVE DOES NOT INCLUDE THE LOCK.
  //
  // A CI-owned suite's settings are its documentation: they are exactly what a
  // person needs to read to understand what CI is running, and the sheet is the
  // only surface that shows them. Folding the lock in here made the whole sheet
  // unreachable while the Settings control still navigated to `suite-edit` — the
  // URL changed and nothing appeared. `readOnlyConfig` is different: it means
  // this surface offers no suite settings at all (desktop CI), so it still
  // closes the sheet.
  //
  // What the lock does instead is make the sheet a VIEWER: `editingDisabled`
  // hides the commit bar and `settingsLockedReason` disables every control
  // inside, so nothing there can be typed into and then silently dropped.
  const selectedTestId =
    route.type === "test-detail" || route.type === "test-edit"
      ? route.testId
      : null;
  const selectedRunId = route.type === "run-detail" ? route.runId : null;
  const viewMode =
    route.type === "run-detail"
      ? "run-detail"
      : route.type === "test-detail"
        ? "test-detail"
        : route.type === "test-edit" && !editingDisabled
          ? "test-edit"
          : route.type === "test-edit"
            ? "test-detail"
            : "overview";
  const runsViewMode: SuiteOverviewView =
    route.type === "suite-overview" && route.view === "test-cases"
      ? "test-cases"
      : route.type === "suite-overview" && route.view === "cross-host"
        ? "cross-host"
        : "runs";

  // Local state that's not in the URL
  const [runDetailSortBy, setRunDetailSortBy] = useState<
    "model" | "test" | "result"
  >("model");
  /**
   * Transient per-run iteration count (1-10) applied to Run-all-cases and
   * per-case quick runs triggered from this suite view. Defaults to
   * `undefined` (Auto) so the per-case persisted `EvalCase.runs` is honored
   * until the user picks an explicit value. Never written back to
   * persistence. Server enforces an absolute cap above 10.
   */
  const [iterationOverride, setIterationOverride] = useState<
    number | undefined
  >(undefined);

  const onRerunWithOverride = useCallback(
    (
      s: EvalSuite,
      opts?: {
        matchOptionsOverride?: EvalMatchOptions;
        iterationOverride?: number;
      },
    ) =>
      (
        onRerun as (
          suite: EvalSuite,
          opts?: {
            matchOptionsOverride?: EvalMatchOptions;
            iterationOverride?: number;
          },
        ) => void
      )(s, opts),
    [onRerun],
  );

  const onRunTestCaseWithOverride = useMemo<
    ((testCase: EvalCase) => void) | undefined
  >(
    () =>
      onRunTestCase
        ? (testCase: EvalCase) => onRunTestCase(testCase, { iterationOverride })
        : undefined,
    [onRunTestCase, iterationOverride],
  );
  const effectiveRunDetailSortBy = runDetailSortByOverride ?? runDetailSortBy;
  const effectiveRunDetailSortChange =
    onRunDetailSortByChange ?? setRunDetailSortBy;
  // ── The settings draft (S1) ─────────────────────────────────────────────
  //
  // One piece of state for every drafted setting, replacing the per-control
  // local state each writer used to keep. The controls still fire on every
  // keystroke — `ChecksSection` inserts a blank template on `Add check` — but
  // now those keystrokes land in a draft that is saved deliberately rather
  // than in a debounce racing its own previous write.
  const [draft, dispatchDraft] = useReducer(
    suiteSettingsReducer,
    suite,
    // Lazy: this ran on every render and threw the result away, and it is not
    // free — it rebuilds the whole settings envelope for a suite document that
    // changes identity on every run-progress tick.
    (initial) =>
      initSuiteSettingsDraft({
        suiteId: initial._id,
        values: readSuiteSettingsValues(initial),
      }),
  );
  const [reviewOpen, setReviewOpen] = useState(false);
  const { commit, isCommitting } = useSuiteSettingsCommit();
  const draftDefaultPredicates = draft.current.defaultPredicates;
  const setDraftDefaultPredicates = useCallback(
    // Both forms, matching the `useState` setter this replaced — `AddCheckMenu`
    // passes an updater, and the reducer resolves it against the authoritative
    // draft rather than whatever this render closed over.
    (next: Predicate[] | ((previous: Predicate[]) => Predicate[])) =>
      dispatchDraft({ type: "edit", key: "defaultPredicates", value: next }),
    [],
  );
  const defaultMinimumPassRate =
    draft.current.defaultPassCriteria?.minimumPassRate ?? 100;
  const draftChanges = useMemo(() => describeDraft(draft), [draft]);
  // Memoized with the changes: `canCommit` re-runs `dirtyKeys` (a stringify per
  // key) and a zod parse over every default check, and this component re-renders
  // on every run-progress tick of every suite in the project.
  const draftCanCommit = useMemo(
    // A half-written rubric is refused HERE rather than by the backend, for the
    // same reason a half-written check is: the save is one batched mutation, so
    // a rubric the platform rejects takes the settings beside it down with it.
    () =>
      canCommit(draft, areAllChecksValid) &&
      isRubricValid(draft.current.judgeRubric),
    [draft],
  );
  const hasUnsavedSettings = draftChanges.length > 0;
  const dirtySettingKeys = useMemo(() => new Set(dirtyKeys(draft)), [draft]);
  const rowIsDirty = useCallback(
    (key: EvalSuiteSettingKey) =>
      (ROW_DRAFT_KEYS[key] ?? []).some((draftKey) =>
        dirtySettingKeys.has(draftKey),
      ),
    [dirtySettingKeys],
  );
  const rowIsConflict = useCallback(
    (key: EvalSuiteSettingKey) =>
      (ROW_DRAFT_KEYS[key] ?? []).some((draftKey) =>
        draft.conflicts.includes(draftKey),
      ),
    [draft.conflicts],
  );
  const nameRowError =
    draft.current.name.trim().length === 0
      ? {
          message: "Name is required",
          focusSelector: 'input[aria-label="Suite name"]',
        }
      : undefined;
  const passOrFailRowError = !isRubricValid(draft.current.judgeRubric)
    ? { message: "A criterion is missing a label" }
    : !areAllChecksValid(draftDefaultPredicates)
      ? { message: "A check is incomplete" }
      : undefined;
  // Which POLICY the sheet is editing. Read from the DRAFT, not the suite, so
  // the v2 rows appear the moment someone drafts the upgrade rather than only
  // after they save it — the review dialog is where they confirm, and a page
  // that still shows the legacy percent while the draft says otherwise is
  // describing a suite nobody is about to have.
  // S3 — what this person can do with this suite, and why not.
  //
  // Re-asked on the suite's revision number: a save that changes what someone
  // may do next (acknowledging a judge gate, upgrading the verdict policy)
  // should change the rows, not leave them describing the suite as it was when
  // the page loaded.
  // Bumped by an acknowledgement, which changes what the gate switch may do
  // WITHOUT changing the suite's revision — the acknowledgement is stored on
  // the suite but is not a settings edit, so nothing else would re-ask.
  const isVerdictPolicyV2 = draft.current.verdictPolicyVersion === 2;
  const scheduledEvalsEnabled = useScheduledEvalsEnabled();
  const { capable: composeCapable } = useEvalComposeCapable(projectId);
  const settingsScrollRef = useRef<HTMLDivElement>(null);
  const [activeGroupId, setActiveGroupId] = useState<SuiteSettingsTabId>(
    SUITE_SETTINGS_GROUPS[0].id,
  );
  // The legacy policy restated in v2 terms. `minIterations` is the suite's
  // iteration floor and `minimumPassRate` its percent, so the upgrade proposes
  // the same bar rather than a new one — a migration that silently moved the
  // threshold would be a policy change wearing a version bump's clothes.
  const verdictPolicyUpgradeProposal = useMemo(
    () => ({
      repetitions: draft.current.minIterations ?? 1,
      passThreshold:
        (draft.current.defaultPassCriteria?.minimumPassRate ?? 100) / 100,
    }),
    [draft.current.minIterations, draft.current.defaultPassCriteria],
  );
  // Offered only when the deployment and the caller can actually perform the
  // upgrade. The backend refuses otherwise (`EVAL_VERDICT_POLICY_UNAVAILABLE`),
  // and a button whose only outcome is an error is worse than no button — so
  // until the per-suite capabilities read lands it stays disabled with the
  // honest reason rather than optimistically enabled.
  // Discarding is what the person just agreed to when they confirmed the
  // prompt. Without it the draft outlives the sheet: the guard re-prompts on
  // every later navigation, ⌘S opens the review dialog from the run list, and
  // the edits they were told they were leaving behind are still there.
  useUnsavedChangesGuard(hasUnsavedSettings, () =>
    dispatchDraft({ type: "discard" }),
  );

  // The suite moved under us. An untouched row simply refreshes; a row the
  // person has edited AND someone else changed is marked rather than merged,
  // because that is the one case an automatic answer would get wrong for one
  // of the two people involved. A different suite id resets the draft outright
  // — see the reducer.
  const liveSettingsKey = useMemo(
    () => `${suite._id}:${JSON.stringify(readSuiteSettingsValues(suite))}`,
    [suite],
  );
  useEffect(() => {
    dispatchDraft({
      type: "rebase",
      suiteId: suite._id,
      live: readSuiteSettingsValues(suite),
    });
    // Keyed on the serialized live values so this fires when the SUITE moves,
    // not on every render that produces a new object identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveSettingsKey]);

  // S6 — the run a rubric edit can be backtested against (see the helper).
  const backtestableRun = useMemo(() => pickBacktestableRun(runs), [runs]);

  const handleCommitSettings = useCallback(
    async (note: string) => {
      const outcome = await commit({
        draft,
        suiteId: suite._id,
        note: note.trim() || undefined,
        expectedRevisionNumber: suite.revisionNumber,
        liveEnvironment: suite.environment,
      });
      if (outcome.status === "saved") {
        setReviewOpen(false);
        // What the save actually WROTE: the normalized form of the keys it
        // carried, and the untouched keys exactly as they were. `toUpdateArgs`
        // trims a dirty name, so rebasing onto the raw draft would leave the
        // person looking at their own whitespace — and normalizing a name this
        // save never sent would make the draft disagree with the database.
        //
        // `retained` keeps the keys a legacy deployment could not carry dirty,
        // so the toast's promise that they are still there to save holds.
        // `suiteId` is the save's OWN suite, so a mutation that resolves after
        // the person navigated cannot land on the suite they moved to.
        dispatchDraft({
          type: "commitSucceeded",
          suiteId: suite._id,
          live: committedSuiteSettingsValues(draft),
          retained: outcome.droppedKeys,
        });
      } else if (outcome.status === "conflict") {
        // The draft SURVIVES. Throwing away someone's edits because a
        // colleague saved first is the outcome the precondition exists to
        // prevent, not one to implement on its refusal.
        setReviewOpen(false);
        toast.error(
          "This suite changed since you opened it. Your edits are still here — review them against the new values and save again.",
        );
        // No rebase here on purpose. `suite` is still the document we already
        // had — the one the server just told us is stale — so rebasing onto it
        // would compare the draft against the same values and mark nothing.
        // The subscription delivers the newer document a moment later, and the
        // rebase effect above does the real comparison then.
      }
    },
    [commit, draft, suite],
  );

  // ⌘S opens the review rather than saving: the shortcut means "commit what I
  // did", and in a sheet with a review step the honest response is to show
  // them what that is.
  useEffect(() => {
    if (!hasUnsavedSettings) return;
    const handler = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.key !== "s") return;
      event.preventDefault();
      if (draftCanCommit) setReviewOpen(true);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [hasUnsavedSettings, draftCanCommit]);
  const suiteScenarioMigrationCount = useMemo(
    () =>
      splitPredicatesForMigration(draftDefaultPredicates).scenarioAsserts
        .length,
    [draftDefaultPredicates],
  );
  // Description editor is hidden in the current pass — handlers and draft
  // state were removed; re-add together when the About section returns.
  const [exportState, setExportState] = useState<{
    scope: "suite" | "test-case";
    cases: EvalExportCaseInput[];
  } | null>(null);
  const [tracesExportOpen, setTracesExportOpen] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const unifiedShareEvals =
    useFeatureFlagEnabled("unified-share-evals") === true;
  // chatSessionIds for the currently-selected run (unified-trace iterations
  // only; legacy `blob`-only iterations have no chatSessions row to export).
  const runChatSessionIds = useMemo(
    () =>
      selectedRunId
        ? allIterations
            .filter((it) => it.suiteRunId === selectedRunId && it.chatSessionId)
            .map((it) => it.chatSessionId as string)
        : [],
    [allIterations, selectedRunId],
  );

  const updateSuite = useMutation("testSuites:updateTestSuite" as any);
  const { isAuthenticated } = useConvexAuth();
  // Reproducible-evals env picker (gated by the computers feature flag). Only
  // fetch the project's environments when the flag is on and we have a project.
  const computersEnabled = useComputersEnabled();
  const computerEnvironments = useSandboxImages(
    computersEnabled && projectId ? projectId : null,
  );
  const ephemeralCloudAvailable = useEphemeralCloudAvailable();
  // Cloud-sandbox preflight, derived ONCE here — the parent owns every run
  // control (header Run all, run-detail rerun/replay, per-case play buttons
  // in both dashboards), so deriving any lower down leaves some of them
  // ungated. Folded into the same disabled-reason channel billing uses.
  // Ad-hoc rows INCLUDED, and not gated on the suite having attachments —
  // both because of what a model matrix is. Every cell it mints is an ad-hoc
  // row, and a compose-and-run launches without attaching at all, so the
  // narrower read returned a list with none of the environments the runs below
  // actually reference: the matrix could not tell two models on one client
  // apart, and the collision split never had two rows to compare.
  //
  // Widening is safe for `evalSuitePinsSandboxImage`, which looks up only the
  // ids the suite itself lists — a superset cannot make it read true.
  const projectEnvironments = useProjectEnvironments(projectId ?? null, {
    includeAdhoc: true,
  });
  const suitePinsSandboxImage = evalSuitePinsSandboxImage(
    suite,
    projectEnvironments ?? undefined,
  );
  const evalRunsDisabledReason =
    evalRunsDisabledReasonProp ??
    (suitePinsSandboxImage && ephemeralCloudAvailable === false
      ? EVAL_SANDBOX_CLOUD_UNREACHABLE_MESSAGE
      : null);
  // A LOOKUP feeding `hostNamesById` below — nothing here offers a client to
  // pick, so it opts into private scenario-backing clients. Naming and
  // offering are different questions: a run that already resolved against a
  // backing client should print that client's name rather than "unknown", and
  // withholding the name hides history instead of preventing anything.
  const { hosts: namableHosts } = useHostList({
    isAuthenticated,
    projectId: projectId ?? null,
    includePrivateBacking: true,
  });

  // The connection/discovery facts under the Grading tab's runner-measured
  // stages. Read here rather than in the panel because both are project-wide
  // lists: one query each, however many run targets the suite fans out to.
  //
  // NOT the `projectServers` prop, deliberately. CiEvalsTab passes none, and
  // the two tabs that do default it to `[]` — so an in-flight read is
  // indistinguishable from a project with no servers, and every server would
  // render "No longer in this project" until the rows landed. This hook keeps
  // `undefined` meaning "still loading"; Convex dedupes the subscription
  // against the parent's, so the extra call costs nothing.
  // The suite's OWN host config — what an attachment-less suite runs under.
  const canQuerySuiteHostConfig = useActorCanQuery();
  const suiteOwnHostConfig = useQuery(
    "hostConfigsV2:getSuiteConfig" as never,
    canQuerySuiteHostConfig && suite._id
      ? ({ suiteId: suite._id } as never)
      : "skip",
  ) as HostConfigDtoV2 | null | undefined;

  const { servers: factsProjectServers } = useProjectServers({
    isAuthenticated,
    projectId: projectId ?? null,
  });
  const { serverAttachments } = useProjectServerAttachments({
    isAuthenticated,
    projectId: projectId ?? null,
  });

  // Use custom hooks for data calculations
  const { runTrendData, modelStats } = useSuiteData(
    suite,
    cases,
    iterations,
    allIterations,
    runs,
    aggregate,
  );

  const { caseGroupsForSelectedRun } = useRunDetailData(
    selectedRunId,
    allIterations,
    effectiveRunDetailSortBy,
  );

  // Selected run details
  const selectedRunDetails = useMemo(() => {
    if (!selectedRunId) return null;
    const run = runs.find((r) => r._id === selectedRunId);
    return run ?? null;
  }, [selectedRunId, runs]);

  const latestCompletedRun = useMemo(
    () =>
      sortRunsNewestFirst(runs).find((run) => run.status === "completed") ??
      null,
    [runs],
  );
  const groundedness = useGroundedness(latestCompletedRun);

  /**
   * Every trial's chain for the run currently open, keyed by iteration.
   *
   * ONE read for the whole run, shared by the rows beneath it — which is what
   * the run-scoped case table needs and what a cross-run table could not have
   * without a read per run. Gated on the same Evaluate opt-in and project id
   * as the decision card, so with either missing it issues no request.
   */
  const runTrialChains = useEvalRunIterationChains({
    projectId,
    run: selectedRunDetails,
    enabled: Boolean(evaluateDecisionSummary && projectId),
  });

  const selectedCompareBaseRunId =
    route.type === "run-detail" ? (route.compareToRunId ?? null) : null;

  const previousCompletedRunForSelectedRun = useMemo(() => {
    if (!selectedRunDetails || selectedRunDetails.status !== "completed") {
      return null;
    }
    const earlierCompletedRuns = runs
      .filter(
        (run) =>
          run._id !== selectedRunDetails._id &&
          run.status === "completed" &&
          compareRunsBySequence(run, selectedRunDetails) < 0,
      )
      .sort((a, b) => compareRunsBySequence(b, a));
    return earlierCompletedRuns[0] ?? null;
  }, [runs, selectedRunDetails]);

  // Resolve namedHostId → display name for any run-detail / list views
  // that want to surface which host a run was triggered against. The project
  // host list backs hosts the suite has no attachment for — an environment-
  // backed suite has none at all, yet its runs still stamp the environment's
  // resolved host.
  const hostNamesById = useMemo(
    () => buildHostNamesById(suite.hostAttachments, namableHosts),
    [suite.hostAttachments, namableHosts],
  );

  /**
   * The run targets the connection/discovery facts describe.
   *
   * The same two modes the environments row renders: attached environments when
   * this deployment composes cells, else the legacy host attachments. A target
   * that names a server GROUP knows its ids here; one that uses the client's
   * own servers cannot know them until the host config loads, so the panel
   * finishes that half.
   */
  const stageFactTargets = useMemo<StageFactsTarget[]>(() => {
    const attachmentById = new Map(
      (serverAttachments ?? []).map((row) => [row._id, row]),
    );
    // NOT gated on `composeCapable`: that capability decides whether this
    // deployment can EDIT client x model cells, not what a run fans out over.
    // A suite with attached environments runs one per environment either way —
    // `summarizeEnvironments` reads them the same way — so gating here reported
    // "no run target" for a suite that has several.
    if ((suite.environmentIds?.length ?? 0) > 0) {
      const rows = (suite.environmentIds ?? []).map((environmentId) => {
        const environment = projectEnvironments?.find(
          (row) => row.environmentId === environmentId,
        );
        return { environmentId, environment };
      });
      const labeled = disambiguateLabels(
        rows.map(({ environmentId, environment }) => ({
          environmentId,
          label: environment
            ? environmentLabel(environment, {
                hostName: (id) => hostNamesById.get(id) ?? undefined,
              })
            : environmentId,
        })),
      );
      return rows.map(({ environmentId, environment }, index) => {
        const attachment = environment?.serverAttachmentId
          ? attachmentById.get(environment.serverAttachmentId)
          : undefined;
        return {
          key: environmentId,
          label: labeled[index].label,
          hostId: environment?.hostId ?? "",
          environmentId,
          attachment: attachment
            ? { id: attachment._id, name: attachment.name }
            : null,
          servers: attachment
            ? { kind: "attachment" as const, ids: attachment.serverIds }
            : { kind: "host" as const, extraIds: [] },
        };
      });
    }
    // Legacy: a suite-level server attachment replaces every host's own picks
    // (see `EvalSuite.serverAttachmentId`), so it wins for all of them.
    const suiteAttachment = suite.serverAttachmentId
      ? attachmentById.get(suite.serverAttachmentId)
      : undefined;
    if ((suite.hostAttachments ?? []).length === 0) {
      // No environment and no attached client is still a RUN TARGET: the suite
      // executes under its own saved host config, falling back to the default
      // MCPJam client when it never wrote one (`loadSuiteHostConfig`). Saying
      // "no run target yet" here sent a reader to attach something the run does
      // not need. No `hostId`, because this config belongs to the suite rather
      // than to a client row there would be a page for.
      return suiteOwnHostConfig
        ? [
            {
              key: "suite-host",
              label: "This suite's own client",
              hostId: "",
              hostConfig: suiteOwnHostConfig,
              attachment: null,
              servers: { kind: "host" as const, extraIds: [] },
            },
          ]
        : [];
    }
    return (suite.hostAttachments ?? []).map((attachmentRow) => ({
      key: attachmentRow.namedHostId,
      label:
        hostNamesById.get(attachmentRow.namedHostId) ??
        attachmentRow.hostName ??
        attachmentRow.namedHostId,
      hostId: attachmentRow.namedHostId,
      attachment: suiteAttachment
        ? { id: suiteAttachment._id, name: suiteAttachment.name }
        : null,
      servers: suiteAttachment
        ? { kind: "attachment" as const, ids: suiteAttachment.serverIds }
        : {
            kind: "host" as const,
            extraIds: attachmentRow.enabledOptionalServerIds ?? [],
          },
    }));
  }, [
    suiteOwnHostConfig,
    suite.environmentIds,
    suite.hostAttachments,
    suite.serverAttachmentId,
    projectEnvironments,
    serverAttachments,
    hostNamesById,
  ]);

  const omitRunDetailIdentity = useMemo(() => {
    if (viewMode !== "run-detail" || !selectedRunDetails) {
      return false;
    }
    return shouldShowRunAccuracyHero({
      run: selectedRunDetails,
      iterations: caseGroupsForSelectedRun,
      runTrendData,
    });
  }, [viewMode, selectedRunDetails, caseGroupsForSelectedRun, runTrendData]);

  // Derive selectedIterationId from route
  const selectedIterationId =
    route.type === "run-detail" ? (route.iteration ?? null) : null;

  const selectedRunTestCaseId =
    route.type === "run-detail" ? (route.testCaseId ?? null) : null;

  const handleSelectTestCase = (group: RunCaseGroup) => {
    if (route.type !== "run-detail" || !group.testCaseId) {
      return;
    }
    navigation.toRunDetail(route.suiteId, route.runId, undefined, {
      testCaseId: group.testCaseId,
    });
  };

  const handleBackToRunOverview = () => {
    if (route.type !== "run-detail") return;
    navigation.toRunDetail(route.suiteId, route.runId, undefined, {
      insightsFocus: true,
    });
  };

  const iterationsForSelectedRunTestCase = useMemo(() => {
    if (!selectedRunId || !selectedRunTestCaseId) return [];
    return caseGroupsForSelectedRun.filter(
      (iteration) => iteration.testCaseId === selectedRunTestCaseId,
    );
  }, [selectedRunId, selectedRunTestCaseId, caseGroupsForSelectedRun]);

  const selectedRunTestCase = useMemo(() => {
    if (!selectedRunTestCaseId) return null;
    return (
      cases.find((testCase) => testCase._id === selectedRunTestCaseId) ?? null
    );
  }, [cases, selectedRunTestCaseId]);

  const handleSelectIteration = (iterationId: string) => {
    if (route.type !== "run-detail") {
      return;
    }
    const iter = caseGroupsForSelectedRun.find((i) => i._id === iterationId);
    if (editingDisabled) {
      navigation.toRunDetail(route.suiteId, route.runId, iterationId, {
        testCaseId: selectedRunTestCaseId ?? iter?.testCaseId ?? undefined,
      });
      return;
    }
    if (iter?.testCaseId) {
      navigation.toTestEdit(route.suiteId, iter.testCaseId, {
        openCompare: true,
        iteration: iterationId,
      });
    } else {
      navigation.toRunDetail(route.suiteId, route.runId, iterationId);
    }
  };

  // The debounced default-checks committer, the localStorage pass-criteria
  // mirror and the per-suite draft-reset effect all lived here. All three
  // were machinery for saving on every keystroke: a debounce that serialized
  // its own writes so an out-of-order response could not persist stale text,
  // and a local mirror so a value the server had not accepted yet survived a
  // reload. The draft makes them unnecessary — nothing is written until the
  // person says so, and `rebase` handles a suite that moves underneath.

  const handleUpdateHostAttachments = async (
    attachments: Array<{
      namedHostId: string;
      enabledOptionalServerIds: string[];
    }>,
  ) => {
    try {
      await updateSuite({
        suiteId: suite._id,
        hostAttachments: attachments,
      });
      toast.success(
        attachments.length === 0 ? "Clients cleared" : "Clients updated",
      );
    } catch (error) {
      toast.error(getBillingErrorMessage(error, "Failed to update clients"));
      console.error("Failed to update host attachments:", error);
      throw error;
    }
  };

  const handleServerAttachmentUpdate = async (serverAttachmentId: string) => {
    // Picker calls this synchronously inside onClick — don't rethrow,
    // or the unawaited promise becomes an unhandled rejection.
    try {
      await updateSuite({
        suiteId: suite._id,
        serverAttachmentId,
      });
      toast.success("Server group updated");
    } catch (error) {
      toast.error(
        getBillingErrorMessage(error, "Failed to update server group"),
      );
    }
  };

  const handleRunClick = (runId: string) => {
    navigation.toRunDetail(suite._id, runId, undefined, {
      insightsFocus: true,
    });
  };

  // The suite's newest run, for the history panel's "Compare with run", and
  // the one before it as the compare base. Absent on a suite that has never
  // run, in which case the footer action is not offered rather than being
  // offered and doing nothing; a suite with a single run opens it uncompared.
  const handleCompareRuns = useCallback(
    (baseRunId: string, compareRunId: string) => {
      navigation.toRunDetail(suite._id, compareRunId, undefined, {
        compareToRunId: baseRunId,
      });
    },
    [navigation, suite._id],
  );

  const handleBackToOverview = () => {
    navigation.toSuiteOverview(suite._id);
  };

  // ── The three rows that used to vanish ─────────────────────────────────
  //
  // Each keeps its ORIGINAL gate as an additional condition, so a deployment
  // whose capabilities read fails behaves exactly as it did before this. What
  // changes is what happens when capabilities ARE readable and say no: the row
  // renders disabled with the reason instead of disappearing.
  const computerEnvironmentRowVisible = capabilitiesReady
    ? Boolean(projectId)
    : computersEnabled && Boolean(projectId);
  //
  // CI OWNERSHIP IS CHECKED FIRST, ahead of every feature flag and every
  // permission. It has to be: a role change cannot unlock these rows, so
  // "you don't have permission to change this" would send the reader to ask an
  // admin for access they already hold. It is also the only reason here that
  // stands without a capabilities read — the suite row says it — which is what
  // keeps the sheet honest against a backend that predates the lock.
  const ciOwnedReason = configLocked
    ? CI_OWNED_REASON_COPY
    : capabilitiesReady && capabilities.ownership?.ciOwned
      ? CI_OWNED_REASON_COPY
      : undefined;
  const computerEnvironmentDisabledReason =
    ciOwnedReason ??
    (!capabilitiesReady
      ? undefined
      : (featureDisabledReason(capabilities.features?.computers) ??
        (capabilities.permissions?.["suite.configure"] === false
          ? PERMISSION_REASON_COPY
          : undefined)));
  const scheduleDisabledReason =
    ciOwnedReason ??
    (!capabilitiesReady
      ? undefined
      : capabilities.features?.scheduledEvals?.enabled === false
        ? DEPLOYMENT_REASON_COPY
        : capabilities.permissions?.["suite.schedule"] === false
          ? PERMISSION_REASON_COPY
          : undefined);
  const deleteDisabledReason =
    ciOwnedReason ??
    (capabilitiesReady && capabilities.permissions?.["suite.delete"] === false
      ? PERMISSION_REASON_COPY
      : undefined);

  const visibleSettingsGroups = useMemo(
    () =>
      SUITE_SETTINGS_GROUPS.filter(
        (group) => group.id !== "danger" || canDeleteSuite,
      ),
    [canDeleteSuite],
  );
  const subsectionOptions = useMemo(
    () => ({
      isVerdictPolicyV2,
      showComputerEnvironment: computerEnvironmentRowVisible,
      showSchedule: scheduledEvalsEnabled,
      showDelete: canDeleteSuite,
    }),
    [
      isVerdictPolicyV2,
      computerEnvironmentRowVisible,
      scheduledEvalsEnabled,
      canDeleteSuite,
    ],
  );
  const visibleSettingsTabs = visibleSettingsGroups;
  const activeSubsections = useMemo(() => {
    return getSubsectionsForGroup(
      activeGroupId as SuiteSettingsGroupId,
      subsectionOptions,
    );
  }, [activeGroupId, subsectionOptions]);
  const selectSettingsGroup = useCallback((groupId: SuiteSettingsTabId) => {
    setActiveGroupId(groupId);
  }, []);
  const selectSettingsSubsection = useCallback(
    (subsectionId: string) => {
      const root = settingsScrollRef.current;
      if (!root) return;
      const subsection = getSubsectionsForGroup(
        activeGroupId as SuiteSettingsGroupId,
        subsectionOptions,
      ).find((candidate) => candidate.id === subsectionId);
      if (!subsection) return;
      root
        .querySelector(subsectionScrollTarget(subsection))
        ?.scrollIntoView({ behavior: "smooth", block: "start" });
    },
    [activeGroupId, subsectionOptions],
  );
  const openSetting = useCallback(
    (key: EvalSuiteSettingKey) => {
      if (key === "name") {
        settingsScrollRef.current?.scrollTo({ top: 0, behavior: "smooth" });
        return;
      }
      const group = SUITE_SETTINGS_GROUPS.find((candidate) => {
        if ((candidate.rows as readonly string[]).includes(key)) return true;
        return candidate.rows.some((row) =>
          NESTED_SETTING_KEYS[row]?.includes(key),
        );
      });
      if (group) {
        setActiveGroupId(group.id);
        const subsection = subsectionForSettingKey(
          key,
          group.id,
          subsectionOptions,
        );
        if (subsection) {
          requestAnimationFrame(() => {
            const root = settingsScrollRef.current;
            root
              ?.querySelector(subsectionScrollTarget(subsection))
              ?.scrollIntoView({ behavior: "smooth", block: "start" });
          });
        }
      }
    },
    [subsectionOptions],
  );

  const verdictPolicyUpgradeDisabledReason: string | undefined =
    !capabilitiesReady
      ? // A read that FAILED is not one still in flight; "Checking…" after the
        // answer came back as "could not ask" described a wait that would
        // never end.
        capabilitiesState === "unavailable"
        ? CAPABILITY_REASON_COPY.flag_unavailable
        : "Checking whether this deployment allows verdict policy v2…"
      : capabilities.verdictPolicyV2.canUpgrade
        ? undefined
        : capabilities.verdictPolicyV2.deploymentMode === "off"
          ? DEPLOYMENT_REASON_COPY
          : "This suite is already on verdict policy v2";

  const handleOpenSuiteExport = useCallback(() => {
    setExportState({
      scope: "suite",
      cases: pickSuiteExportCases(cases, runs),
    });
  }, [cases, runs]);

  const handleOpenTestCaseExport = useCallback((testCase: EvalCase) => {
    setExportState({
      scope: "test-case",
      cases: [normalizeEvalCaseForExport(testCase)],
    });
  }, []);

  const handleOpenDraftExport = useCallback((draft: EvalExportDraftInput) => {
    setExportState({
      scope: "test-case",
      cases: [normalizeDraftEvalCaseForExport(draft)],
    });
  }, []);

  const isReplayingLatestRun = useMemo(
    () =>
      replayingRunId != null &&
      runs.some(
        (run) => run._id === replayingRunId && run.hasServerReplayConfig,
      ) &&
      runs
        .filter((run) => run.hasServerReplayConfig)
        .sort((a, b) => {
          const aTime = a.completedAt ?? a.createdAt ?? 0;
          const bTime = b.completedAt ?? b.createdAt ?? 0;
          return bTime - aTime;
        })[0]?._id === replayingRunId,
    [replayingRunId, runs],
  );

  const shouldReduceMotion = useReducedMotion();

  const contentKey = useMemo(() => {
    if (viewMode === "test-edit" && selectedTestId)
      return `test-edit-${selectedTestId}`;
    if (viewMode === "test-detail" && selectedTestId)
      return `test-detail-${selectedTestId}`;
    if (viewMode === "overview") return `overview-${runsViewMode}`;
    if (viewMode === "run-detail" && selectedRunId)
      return selectedCompareBaseRunId
        ? `run-diff-${selectedCompareBaseRunId}-${selectedRunId}`
        : `run-detail-${selectedRunId}-${selectedRunTestCaseId ?? "overview"}`;
    return "empty";
  }, [
    viewMode,
    selectedTestId,
    selectedRunId,
    selectedRunTestCaseId,
    selectedCompareBaseRunId,
    runsViewMode,
  ]);

  // Evaluate (New) suite overview uses the checkout-flow identity + run
  // history + cases layout. Run detail uses EvaluateRunPage (this run +
  // Compare), not the SuiteResultsSplit rail.
  //
  // `viewMode` falls through to "overview" for the suite-edit route, so edit
  // mode has to be excluded explicitly: SuiteHeader is the ONLY place the
  // edit-mode chrome lives (the name editor and Done). The environment
  // composer lives on the settings sheet, not the overview header.
  const showEvaluateSuiteDetail =
    suiteDetailOverview &&
    hideRunActions &&
    !caseListInSidebar &&
    !isEditMode &&
    viewMode === "overview";

  const showEvaluateRunPage =
    suiteDetailOverview &&
    hideRunActions &&
    !caseListInSidebar &&
    !isEditMode &&
    viewMode === "run-detail" &&
    Boolean(selectedRunDetails) &&
    !selectedCompareBaseRunId &&
    !selectedRunTestCaseId;

  const showSuiteHeader =
    !showEvaluateSuiteDetail &&
    !showEvaluateRunPage &&
    (!omitSuiteHeader || viewMode !== "run-detail" || isEditMode);

  // The unified results split (run-group rail + scoped right pane) is the
  // default suite surface; the single-run detail folds into its right pane
  // wherever the dashboard renders (same guard as the overview SuiteDashboard
  // branch so the two surfaces switch together).
  const foldRunDetail =
    hideRunActions && !caseListInSidebar && !suiteDetailOverview;

  // Keep suite chrome (name, Run all, Generate) visible in run detail — run
  // identity belongs in the body. CI opts out via omitSuiteHeader.
  const headerViewMode =
    !omitSuiteHeader && viewMode === "run-detail" ? "overview" : viewMode;

  // The folded run view uses the SAME cross-host matrix as All-runs / a group,
  // scoped to this one run's host (one column), so the table is visually
  // identical across the three rail selections — only the column set + the
  // surrounding run chrome (KPIs, AI insights, judge) change. Legacy suites with
  // no host attachments fall through (`undefined`) to RunDetailView's built-in
  // per-iteration table — except an environment-backed run, which names its
  // resolved host on the run itself and so still yields a one-column matrix.
  const runMatrixPane =
    foldRunDetail &&
    selectedRunDetails &&
    ((suite.hostAttachments?.length ?? 0) >= 1 ||
      runEnvironmentRef(selectedRunDetails) !== null) ? (
      <CrossHostDashboard
        suite={
          selectedRunDetails.namedHostId
            ? {
                ...suite,
                hostAttachments: (suite.hostAttachments ?? []).filter(
                  (a) => a.namedHostId === selectedRunDetails.namedHostId,
                ),
              }
            : suite
        }
        cases={cases}
        runs={[selectedRunDetails]}
        allIterations={caseGroupsForSelectedRun}
        expanded
        onTestCaseClick={(testCaseId) =>
          navigation.toTestEdit(suite._id, testCaseId)
        }
        onCellOpen={(cell, _hostId, caseId) => {
          // A cell is one (case, host) result → open that iteration in the
          // standardized split editor (no `openCompare` → no legacy header).
          const iteration = cell.iterations[0];
          navigation.toTestEdit(
            suite._id,
            caseId,
            iteration ? { iteration: iteration._id } : undefined,
          );
        }}
        hostNamesById={hostNamesById}
        environments={projectEnvironments}
      />
    ) : undefined;

  // One factory so the overview branch and the folded-in run-detail branch
  // share the exact same SuiteDashboard prop wiring.
  const renderUnifiedDashboard = (
    extra: {
      selectedRunId?: string | null;
      runDetailPane?: React.ReactNode;
      onExitRun?: () => void;
    } = {},
  ) => (
    <SuiteDashboard
      suite={suite}
      cases={cases}
      allIterations={allIterations}
      runs={runs}
      runsLoading={runsLoading}
      runTrendData={runTrendData}
      modelStats={modelStats}
      onTestCaseClick={(testCaseId) =>
        navigation.toTestEdit(suite._id, testCaseId)
      }
      onOpenLastRun={(testCaseId, iterationId) =>
        navigation.toTestEdit(suite._id, testCaseId, {
          openCompare: true,
          iteration: iterationId,
        })
      }
      onOpenCaseIteration={(testCaseId, iterationId) =>
        // Standardized split editor (no legacy compare header) focused on this
        // iteration — `iteration` without `openCompare` keeps editorMode "config".
        navigation.toTestEdit(suite._id, testCaseId, {
          iteration: iterationId,
        })
      }
      onRunClick={handleRunClick}
      onDirectDeleteRun={onDirectDeleteRun}
      onRunTestCase={onRunTestCaseWithOverride}
      quickRunIterationOverride={iterationOverride}
      runningTestCaseId={runningTestCaseId}
      blockTestCaseRuns={Boolean(
        rerunningSuiteId || replayingRunId || evalRunsDisabledReason,
      )}
      runTestCaseDisabledReason={evalRunsDisabledReason}
      connectedServerNames={connectedServerNames}
      onDeleteTestCasesBatch={onDeleteTestCasesBatch}
      testCasesClickHint="Click a case row to open the test case. Click the last-run summary to jump straight to compare results for that run."
      userMap={userMap}
      onGenerateTestCases={onGenerateTestCases}
      canGenerateTestCases={canGenerateTestCases}
      generateTestCasesDisabledReason={generateTestCasesDisabledReason}
      isGeneratingTestCases={isGeneratingTestCases}
      onCreateTestCase={onCreateTestCase}
      onRecordTestCase={onRecordTestCase}
      simpleCaseEditor={evaluateCaseEditor}
      hostNamesById={hostNamesById}
      environments={projectEnvironments}
      {...extra}
    />
  );

  const runDetailView = selectedRunDetails ? (
    <RunDetailView
      selectedRunDetails={selectedRunDetails}
      caseGroupsForSelectedRun={caseGroupsForSelectedRun}
      onExportTraces={projectId ? () => setTracesExportOpen(true) : undefined}
      onShare={
        unifiedShareEvals &&
        selectedRunDetails &&
        (selectedRunDetails.status === "completed" ||
          selectedRunDetails.status === "failed" ||
          selectedRunDetails.status === "timed_out")
          ? () => setShareOpen(true)
          : undefined
      }
      currentSuiteJudgeConfig={suite.judgeConfig ?? null}
      source={getRunMetricSource(selectedRunDetails, suite.source)}
      runDetailSortBy={effectiveRunDetailSortBy}
      onSortChange={effectiveRunDetailSortChange}
      serverNames={suite.environment?.servers || []}
      selectedIterationId={selectedIterationId}
      onSelectIteration={handleSelectIteration}
      selectedTestCaseId={selectedRunTestCaseId}
      onSelectTestCase={handleSelectTestCase}
      hostNamesById={hostNamesById}
      compareBaseRun={previousCompletedRunForSelectedRun}
      onCompareWithRun={(baseRunId) =>
        handleCompareRuns(baseRunId, selectedRunDetails._id)
      }
      onSelectRun={(runId) => navigation.toRunDetail(suite._id, runId)}
      kpiPlacement={
        showSuiteHeader && viewMode === "run-detail" && !foldRunDetail
          ? "header"
          : "body"
      }
      hideReplayLineage
      hideRecentRuns={foldRunDetail || showEvaluateRunPage}
      hideKpiStrip={foldRunDetail}
      hideAccuracyHero={foldRunDetail}
      caseTableSlot={runMatrixPane}
      omitIterationList={omitRunIterationList}
      onOpenRunInsights={
        !omitRunIterationList && route.type === "run-detail"
          ? () =>
              navigation.toRunDetail(route.suiteId, route.runId, undefined, {
                insightsFocus: true,
              })
          : undefined
      }
      runInsightsSelected={
        !omitRunIterationList &&
        route.type === "run-detail" &&
        Boolean(route.insightsFocus && !route.iteration && !route.testCaseId)
      }
      onEditTestCase={onEditTestCase}
      alwaysShowEditIterationRows={alwaysShowEditIterationRows}
      runTrendData={runTrendData}
      // The stage findings ride the SAME opt-in as the decision card beside
      // them, and the same project gate: the read is per-project and the
      // browser never resolves or guesses one. With this false the underlying
      // read issues no request at all.
      stageFindingsEnabled={Boolean(evaluateDecisionSummary && projectId)}
      onViewStageTrace={({ iterationId, testCaseId }) =>
        // Identical routing to the decision card's own trace link, and for the
        // reason its comment gives: `tracePath` is an API path rather than an
        // app route, and the CASE editor is the one path that actually
        // consumes an iteration id.
        navigation.toTestEdit(suite._id, testCaseId, {
          iteration: iterationId,
        })
      }
      decisionSummarySlot={
        // Only Evaluate opts in, and only with a project id in hand: the read
        // is per-project and the browser never resolves or guesses one.
        evaluateDecisionSummary && projectId ? (
          <RunDecisionSummarySection
            projectId={projectId}
            run={selectedRunDetails}
            enabled
            onViewTrace={({ iterationId, testCaseId }) =>
              // `tracePath` is an API path, not an app route, so this goes
              // through the app's own routing. It goes to the CASE editor
              // rather than run detail because that is the one path that
              // actually consumes an iteration id: the route's `iteration`
              // becomes `openCompareIterationId` and the editor opens on it.
              // Run detail takes a `selectedIterationId` that
              // `RunIterationsSidebar` marks deprecated and never forwards, so
              // sending the reader there would land them on the page they are
              // already looking at with nothing opened.
              navigation.toTestEdit(suite._id, testCaseId, {
                iteration: iterationId,
              })
            }
          />
        ) : undefined
      }
    />
  ) : null;

  // Keep the run-group rail mounted when opening a run — only the right pane
  // swaps. Wrapping overview ↔ run-detail in AnimatePresence faded the whole
  // split (rail included), which felt like a page transition on every click.
  const showFoldedUnifiedDashboard =
    foldRunDetail &&
    (viewMode === "overview" ||
      (viewMode === "run-detail" &&
        selectedRunDetails &&
        !selectedCompareBaseRunId &&
        !selectedRunTestCaseId));

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      {/* Header */}
      {showSuiteHeader ? (
        <div className="shrink-0">
          <SuiteHeader
            suite={suite}
            viewMode={headerViewMode}
            selectedRunDetails={selectedRunDetails}
            isEditMode={isEditMode}
            onRerun={onRerunWithOverride}
            iterationOverride={iterationOverride}
            onIterationOverrideChange={setIterationOverride}
            onReplayRun={onReplayRun}
            onCancelRun={onCancelRun}
            onViewModeChange={handleBackToOverview}
            connectedServerNames={connectedServerNames}
            rerunningSuiteId={rerunningSuiteId}
            replayingRunId={replayingRunId}
            cancellingRunId={cancellingRunId}
            runsViewMode={runsViewMode}
            runs={runs}
            allIterations={allIterations}
            aggregate={aggregate}
            testCases={cases}
            onSetupCi={onSetupCi}
            onOpenExportSuite={handleOpenSuiteExport}
            readOnlyConfig={readOnlyConfig}
            configLocked={configLocked}
            hideRunActions={hideRunActions}
            unifiedSuiteDashboard={hideRunActions && !caseListInSidebar}
            casesSidebarHidden={casesSidebarHidden}
            onShowCasesSidebar={onShowCasesSidebar}
            onCreateTestCase={onCreateTestCase}
            onGenerateTestCases={onGenerateTestCases}
            canGenerateTestCases={canGenerateTestCases}
            generateTestCasesDisabledReason={generateTestCasesDisabledReason}
            evalRunsDisabledReason={evalRunsDisabledReason}
            isGeneratingTestCases={isGeneratingTestCases}
            onRunTestCase={onRunTestCaseWithOverride}
            blockTestCaseRuns={Boolean(rerunningSuiteId || replayingRunId)}
            runningTestCaseId={runningTestCaseId}
            omitRunDetailIdentity={omitRunDetailIdentity}
            settingsDraftName={
              isEditMode
                ? {
                    value: draft.current.name,
                    onChange: (value) =>
                      dispatchDraft({ type: "edit", key: "name", value }),
                    error: nameRowError?.message,
                  }
                : undefined
            }
          />
        </div>
      ) : null}

      {/* Content */}
      {!isEditMode && (
        <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
          <AnimatePresence mode="wait">
            {viewMode === "test-edit" && selectedTestId ? (
              <motion.div
                key={contentKey}
                initial={shouldReduceMotion ? false : { opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={shouldReduceMotion ? undefined : { opacity: 0 }}
                transition={
                  shouldReduceMotion ? { duration: 0 } : { duration: 0.15 }
                }
                className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
              >
                <TestTemplateEditor
                  suiteId={suite._id}
                  selectedTestCaseId={selectedTestId}
                  connectedServerNames={connectedServerNames}
                  projectId={projectId}
                  availableModels={availableModels}
                  suiteIterations={allIterations}
                  suiteRuns={runs}
                  // The same opt-in and project gate the decision card beside
                  // it rides. With this false the trace pane issues no chain
                  // request at all.
                  trialChainEnabled={Boolean(
                    evaluateDecisionSummary && projectId,
                  )}
                  simpleCaseEditor={evaluateCaseEditor}
                  isDirectGuest={isDirectGuest}
                  ensureServersReady={ensureServersReady}
                  projectServers={projectServers}
                  onExportDraft={handleOpenDraftExport}
                  openCompareFromRoute={
                    route.type === "test-edit" && Boolean(route.openCompare)
                  }
                  openCompareIterationId={
                    route.type === "test-edit"
                      ? (route.iteration ?? null)
                      : null
                  }
                  onContinueInChat={onContinueInChat}
                  onSelectTab={(tab) =>
                    navigation.toTestEdit(suite._id, selectedTestId, {
                      openCompare: tab === "runs",
                      replace: true,
                    })
                  }
                  onDraftSaved={(newTestCaseId) =>
                    navigation.toTestEdit(suite._id, newTestCaseId, {
                      replace: true,
                    })
                  }
                  onOpenSuiteSettings={() =>
                    navigation.toSuiteOverview(suite._id)
                  }
                />
              </motion.div>
            ) : viewMode === "test-detail" && selectedTestId ? (
              (() => {
                const selectedCase = cases.find(
                  (c) => c._id === selectedTestId,
                );
                if (!selectedCase) return null;

                const caseIterations = allIterations.filter(
                  (iter) => iter.testCaseId === selectedTestId,
                );

                return (
                  <motion.div
                    key={contentKey}
                    initial={shouldReduceMotion ? false : { opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={shouldReduceMotion ? undefined : { opacity: 0 }}
                    transition={
                      shouldReduceMotion ? { duration: 0 } : { duration: 0.15 }
                    }
                    className="min-h-0 flex-1 overflow-y-auto"
                  >
                    <TestCaseDetailView
                      testCase={selectedCase}
                      runs={runs}
                      iterations={caseIterations}
                      onOpenExportCase={() =>
                        handleOpenTestCaseExport(selectedCase)
                      }
                      serverNames={suite.environment?.servers || []}
                      suiteName={suite.name}
                      onNavigateToSuite={() =>
                        navigation.toSuiteOverview(suite._id)
                      }
                      onBack={() =>
                        navigation.toSuiteOverview(suite._id, "test-cases")
                      }
                      onViewRun={(runId) =>
                        navigation.toRunDetail(suite._id, runId, undefined, {
                          insightsFocus: true,
                        })
                      }
                    />
                  </motion.div>
                );
              })()
            ) : showEvaluateRunPage && selectedRunDetails ? (
              <motion.div
                key={contentKey}
                initial={shouldReduceMotion ? false : { opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={shouldReduceMotion ? undefined : { opacity: 0 }}
                transition={
                  shouldReduceMotion ? { duration: 0 } : { duration: 0.15 }
                }
                className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
              >
                <EvaluateRunPage
                  run={selectedRunDetails}
                  hostNamesById={hostNamesById}
                  iterations={caseGroupsForSelectedRun}
                  otherRuns={runs.filter(
                    (candidate) =>
                      candidate._id !== selectedRunDetails._id &&
                      candidate.result !== "inconclusive",
                  )}
                  defaultCompareRunId={
                    previousCompletedRunForSelectedRun?._id ?? null
                  }
                  onCompareWithRun={(baseRunId) =>
                    handleCompareRuns(baseRunId, selectedRunDetails._id)
                  }
                  onExport={
                    projectId ? () => setTracesExportOpen(true) : undefined
                  }
                >
                  {projectId ? (
                    <EvaluateRunContent
                      projectId={projectId}
                      run={selectedRunDetails}
                      iterations={caseGroupsForSelectedRun}
                      allIterations={allIterations}
                      previousRunId={
                        previousCompletedRunForSelectedRun?._id ?? null
                      }
                      decisionSummaryEnabled={Boolean(evaluateDecisionSummary)}
                      onOpenIteration={({ testCaseId, iterationId }) =>
                        // Same routing rule the decision card follows: an
                        // iteration id is only consumed by the case editor, so
                        // sending a reader to run detail would land them on the
                        // page they are already looking at with nothing opened.
                        navigation.toTestEdit(suite._id, testCaseId, {
                          iteration: iterationId,
                        })
                      }
                      {...(onEditTestCase && !editingDisabled
                        ? { onEditCase: onEditTestCase }
                        : {})}
                      fallbackBody={runDetailView}
                    />
                  ) : (
                    runDetailView
                  )}
                </EvaluateRunPage>
              </motion.div>
            ) : showEvaluateSuiteDetail ? (
              <motion.div
                key={contentKey}
                initial={shouldReduceMotion ? false : { opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={shouldReduceMotion ? undefined : { opacity: 0 }}
                transition={
                  shouldReduceMotion ? { duration: 0 } : { duration: 0.15 }
                }
                className="flex min-h-0 flex-1 flex-col overflow-y-auto"
              >
                <SuiteDetailOverview
                  suite={suite}
                  cases={cases}
                  runs={runs}
                  runsLoading={runsLoading}
                  allIterations={allIterations}
                  hostNamesById={hostNamesById}
                  onRerun={onRerunWithOverride}
                  onEditSuite={() => navigation.toSuiteEdit(suite._id)}
                  onEditCases={onCreateTestCase}
                  onGenerateTestCases={onGenerateTestCases}
                  canGenerateTestCases={canGenerateTestCases}
                  generateTestCasesDisabledReason={
                    generateTestCasesDisabledReason
                  }
                  isGeneratingTestCases={isGeneratingTestCases}
                  onRunClick={handleRunClick}
                  onTestCaseClick={(testCaseId) =>
                    navigation.toTestEdit(suite._id, testCaseId)
                  }
                  rerunningSuiteId={rerunningSuiteId}
                  replayingRunId={replayingRunId}
                  runningTestCaseId={runningTestCaseId}
                  evalRunsDisabledReason={evalRunsDisabledReason}
                  readOnlyConfig={readOnlyConfig}
                  configLocked={configLocked}
                  onDuplicateSuite={onDuplicateSuite}
                  projectId={projectId}
                  decisionSummaryEnabled={evaluateDecisionSummary}
                />
              </motion.div>
            ) : showFoldedUnifiedDashboard ? (
              <div
                key="unified-results-split"
                className="flex min-h-0 flex-1 flex-col overflow-hidden p-0.5"
              >
                {renderUnifiedDashboard(
                  viewMode === "run-detail" && selectedRunDetails
                    ? {
                        selectedRunId: selectedRunDetails._id,
                        runDetailPane: runDetailView,
                        onExitRun: handleBackToOverview,
                      }
                    : {},
                )}
              </div>
            ) : viewMode === "overview" ? (
              hideRunActions && !caseListInSidebar ? (
                <motion.div
                  key={contentKey}
                  initial={shouldReduceMotion ? false : { opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={shouldReduceMotion ? undefined : { opacity: 0 }}
                  transition={
                    shouldReduceMotion ? { duration: 0 } : { duration: 0.15 }
                  }
                  className="flex min-h-0 flex-1 flex-col overflow-hidden p-0.5"
                >
                  {renderUnifiedDashboard()}
                </motion.div>
              ) : runsViewMode === "runs" ? (
                <motion.div
                  key={contentKey}
                  initial={shouldReduceMotion ? false : { opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={shouldReduceMotion ? undefined : { opacity: 0 }}
                  transition={
                    shouldReduceMotion ? { duration: 0 } : { duration: 0.15 }
                  }
                  className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden p-0.5"
                >
                  <RunOverview
                    suite={suite}
                    runs={runs}
                    runsLoading={runsLoading}
                    allIterations={allIterations}
                    runTrendData={runTrendData}
                    modelStats={modelStats}
                    onRunClick={handleRunClick}
                    onCompareRuns={handleCompareRuns}
                    onDirectDeleteRun={onDirectDeleteRun}
                    runsViewMode={runsViewMode}
                    onViewModeChange={(value) =>
                      navigation.toSuiteOverview(suite._id, value)
                    }
                    userMap={userMap}
                    canDeleteRuns={canDeleteRuns && !hideRunActions}
                    canDeleteRun={canDeleteRun}
                    canDeleteSuite={canDeleteSuite && !hideRunActions}
                    onDeleteSuite={() => onDelete(suite)}
                    deletingSuiteId={deletingSuiteId}
                    hideViewModeSelect={hideRunActions}
                  />
                </motion.div>
              ) : (
                <motion.div
                  key={contentKey}
                  initial={shouldReduceMotion ? false : { opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={shouldReduceMotion ? undefined : { opacity: 0 }}
                  transition={
                    shouldReduceMotion ? { duration: 0 } : { duration: 0.15 }
                  }
                  className="min-h-0 flex-1 space-y-4 overflow-y-auto p-0.5"
                >
                  {caseListInSidebar ? (
                    hideRunActions ? (
                      <div className="rounded-xl border bg-card px-4 py-10 text-center text-sm text-muted-foreground">
                        <p>
                          Select a case from the list on the left to edit it and
                          run it individually.
                        </p>
                      </div>
                    ) : (
                      <div className="space-y-4">
                        <SuiteHeroStats
                          runs={runs}
                          allIterations={allIterations}
                          runTrendData={runTrendData}
                          modelStats={modelStats}
                          testCaseCount={cases.length}
                          isSDK={
                            getLatestRunMetricSource(runs, suite.source) ===
                            "sdk"
                          }
                          onRunClick={handleRunClick}
                          onReplayLatestRun={
                            onReplayRun
                              ? (run) => onReplayRun(suite, run)
                              : undefined
                          }
                          isReplayingLatestRun={isReplayingLatestRun}
                        />
                        <div className="rounded-xl border bg-card px-4 py-10 text-center text-sm text-muted-foreground">
                          <p>
                            Select a case from the list on the left to view its
                            history and performance.
                          </p>
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            className="mt-4"
                            onClick={() =>
                              navigation.toSuiteOverview(suite._id, "runs")
                            }
                          >
                            View runs table
                          </Button>
                        </div>
                      </div>
                    )
                  ) : (
                    <TestCasesOverview
                      isDirectGuest={isDirectGuest}
                      suite={suite}
                      cases={cases}
                      runs={runs}
                      allIterations={allIterations}
                      runsViewMode={
                        // For multi-host suites the matrix is the "runs" mode;
                        // remap cross-host so TestCasesOverview's by-host gate
                        // (runsViewMode === "runs") still fires for deep links.
                        runsViewMode === "cross-host" ? "runs" : runsViewMode
                      }
                      onViewModeChange={(value) =>
                        navigation.toSuiteOverview(suite._id, value)
                      }
                      onTestCaseClick={(testCaseId) =>
                        hideRunActions
                          ? navigation.toTestEdit(suite._id, testCaseId)
                          : navigation.toTestDetail(suite._id, testCaseId)
                      }
                      clickHint={
                        hideRunActions
                          ? "Click a case row to open the test case. Click the last-run summary to jump straight to compare results for that run."
                          : undefined
                      }
                      runTrendData={runTrendData}
                      modelStats={modelStats}
                      runsLoading={runsLoading}
                      onRunClick={handleRunClick}
                      hideViewModeSelect={hideRunActions}
                      onOpenLastRun={(testCaseId, iterationId) =>
                        navigation.toTestEdit(suite._id, testCaseId, {
                          openCompare: true,
                          iteration: iterationId,
                        })
                      }
                      onDeleteTestCasesBatch={onDeleteTestCasesBatch}
                      onRunTestCase={onRunTestCaseWithOverride}
                      quickRunIterationOverride={iterationOverride}
                      runningTestCaseId={runningTestCaseId}
                      blockTestCaseRuns={Boolean(
                        rerunningSuiteId ||
                        replayingRunId ||
                        evalRunsDisabledReason,
                      )}
                      runTestCaseDisabledReason={evalRunsDisabledReason}
                      connectedServerNames={connectedServerNames}
                      onGenerateTestCases={onGenerateTestCases}
                      canGenerateTestCases={canGenerateTestCases}
                      generateTestCasesDisabledReason={
                        generateTestCasesDisabledReason
                      }
                      isGeneratingTestCases={isGeneratingTestCases}
                      onCreateTestCase={onCreateTestCase}
                      onRecordTestCase={onRecordTestCase}
                      simpleCaseEditor={evaluateCaseEditor}
                      hostNamesById={hostNamesById}
                      environments={projectEnvironments}
                    />
                  )}
                </motion.div>
              )
            ) : viewMode === "run-detail" && selectedRunDetails ? (
              <motion.div
                key={contentKey}
                initial={shouldReduceMotion ? false : { opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={shouldReduceMotion ? undefined : { opacity: 0 }}
                transition={
                  shouldReduceMotion ? { duration: 0 } : { duration: 0.15 }
                }
                className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
              >
                {selectedCompareBaseRunId ? (
                  <RunDiffView
                    baseRunId={selectedCompareBaseRunId}
                    compareRunId={selectedRunDetails._id}
                    onBackToRun={() =>
                      navigation.toRunDetail(
                        suite._id,
                        selectedRunDetails._id,
                        undefined,
                        { insightsFocus: true },
                      )
                    }
                    onOpenIteration={(runId, iterationId) =>
                      navigation.toRunDetail(suite._id, runId, iterationId)
                    }
                  />
                ) : selectedRunTestCaseId && selectedRunDetails ? (
                  <RunTestCaseDetailView
                    run={selectedRunDetails}
                    testCase={selectedRunTestCase}
                    iterations={iterationsForSelectedRunTestCase}
                    onBack={handleBackToRunOverview}
                    serverNames={suite.environment?.servers || []}
                    chainFor={(iterationId) =>
                      runTrialChains.chains.get(iterationId)
                    }
                  />
                ) : (
                  runDetailView
                )}
              </motion.div>
            ) : null}
          </AnimatePresence>
        </div>
      )}

      {isEditMode && (
        <div ref={settingsScrollRef} className="flex-1 min-h-0 overflow-auto">
          <div className="mx-auto w-full max-w-5xl space-y-6 px-6 py-8">
            <SuiteSettingsGroupTabs
              groups={visibleSettingsTabs}
              activeId={activeGroupId}
              onSelect={selectSettingsGroup}
            />
            {configLocked ? (
              <SuiteCiOwnedNotice onDuplicate={onDuplicateSuite} />
            ) : null}
            <div className="flex flex-col gap-4 md:grid md:grid-cols-[minmax(0,1fr)_auto] md:gap-x-12">
              {/*
                A `fieldset[disabled]` rather than a `disabled` prop threaded
                into ~30 rows. Two reasons it is the better instrument here:
                the browser disables EVERY nested form control natively, so a
                row added later is locked without anybody remembering; and a
                threaded prop that one row forgot would leave a control that
                looks editable, accepts input, and drops it — which is worse
                than no lock at all. The UA border/padding/margin are reset so
                this is invisible in the unlocked case.
              */}
              <fieldset
                disabled={editingDisabled}
                className="m-0 min-w-0 border-0 p-0 md:col-start-1"
                data-testid={
                  editingDisabled ? "suite-settings-locked" : undefined
                }
              >
                {activeGroupId === "grading" ? (
                  <section data-step-id="grading">
                    <SuiteSettingsSectionChain>
                      <SuiteSettingsRow
                        settingKey="policy"
                        data-subsection-id="policy"
                        accessory={
                          <LedgerRowChips
                            dirty={rowIsDirty("policy")}
                            conflict={rowIsConflict("policy")}
                          />
                        }
                        hint={
                          isVerdictPolicyV2
                            ? "What a run must meet to pass."
                            : "This suite uses a suite-wide minimum accuracy. Switch to per-case grading to set repetitions and a pass threshold."
                        }
                      >
                        {isVerdictPolicyV2 ? (
                          <VerdictPolicyV2Controls
                            defaults={draft.current.verdictPolicyDefaults}
                            onChange={(next) =>
                              dispatchDraft({
                                type: "edit",
                                key: "verdictPolicyDefaults",
                                value: next,
                              })
                            }
                          />
                        ) : (
                          <>
                            {/* Stamped by hand, nested inside the Policy row: these are
                        the legacy policy's two fields, and each stays reachable
                        from the API on its own. The parity ratchet reads the
                        attribute, not the component. */}
                            <div
                              className="flex items-center justify-between gap-4"
                              data-setting-key="minimumAccuracy"
                            >
                              <span className="text-xs text-muted-foreground">
                                Minimum accuracy
                              </span>
                              <PassCriteriaSelector
                                hideLabel
                                minimumPassRate={defaultMinimumPassRate}
                                onMinimumPassRateChange={(rate) =>
                                  dispatchDraft({
                                    type: "edit",
                                    key: "defaultPassCriteria",
                                    value: { minimumPassRate: rate },
                                  })
                                }
                              />
                            </div>
                            <div
                              className="flex items-center justify-between gap-4"
                              data-setting-key="minimumIterations"
                            >
                              <span className="text-xs text-muted-foreground">
                                Minimum iterations
                              </span>
                              <select
                                className="h-8 rounded-md border border-input bg-background px-2 text-xs text-foreground"
                                value={draft.current.minIterations ?? ""}
                                aria-label="Minimum iterations per case for every run"
                                onChange={(e) => {
                                  const raw = e.target.value;
                                  dispatchDraft({
                                    type: "edit",
                                    key: "minIterations",
                                    value: raw === "" ? undefined : Number(raw),
                                  });
                                }}
                              >
                                <option value="">Off</option>
                                {Array.from(
                                  { length: 10 },
                                  (_, i) => i + 1,
                                ).map((n) => (
                                  <option key={n} value={n}>
                                    {n}
                                  </option>
                                ))}
                              </select>
                            </div>
                            <p className="text-[11px] text-muted-foreground/60">
                              Every case runs at least this many times per run.
                              A case set higher keeps its count; a per-run
                              override still wins.
                            </p>
                            <VerdictPolicyUpgradeButton
                              disabledReason={
                                verdictPolicyUpgradeDisabledReason
                              }
                              proposal={verdictPolicyUpgradeProposal}
                              onUpgrade={(defaults) => {
                                dispatchDraft({
                                  type: "edit",
                                  key: "verdictPolicyVersion",
                                  value: 2,
                                });
                                dispatchDraft({
                                  type: "edit",
                                  key: "verdictPolicyDefaults",
                                  value: defaults,
                                });
                              }}
                            />
                          </>
                        )}
                        {isVerdictPolicyV2 ? (
                          <div data-setting-key="validity" className="space-y-2">
                            <p className="text-xs font-medium text-foreground">
                              Validity
                            </p>
                            <p className="text-[11px] text-muted-foreground/60">
                              Mark the run inconclusive instead of failed when…
                            </p>
                            <VerdictValidityControls
                              defaults={draft.current.verdictPolicyDefaults}
                              onChange={(next) =>
                                dispatchDraft({
                                  type: "edit",
                                  key: "verdictPolicyDefaults",
                                  value: next,
                                })
                              }
                            />
                          </div>
                        ) : null}
                        <SuiteQualityGateSection
                          policy={draft.current.gatePolicy}
                          onChange={(next) =>
                            dispatchDraft({
                              type: "edit",
                              key: "gatePolicy",
                              value: next,
                            })
                          }
                          capabilities={
                            capabilitiesReady ? capabilities : null
                          }
                          capabilitiesState={capabilitiesState}
                        />
                      </SuiteSettingsRow>

                      <div data-setting-key="passOrFail" className="contents">
                        <SuitePassOrFailSection
                          capabilities={
                            capabilitiesReady ? capabilities : null
                          }
                          unavailableReason={
                            capabilitiesState === "unavailable"
                              ? CAPABILITY_REASON_COPY.flag_unavailable
                              : undefined
                          }
                          stageFacts={{
                            connection: (
                              <SuiteStageFactsList
                                stage="connection"
                                targets={stageFactTargets}
                                projectServers={factsProjectServers}
                                isAuthenticated={isAuthenticated}
                                composeCapable={composeCapable}
                                onGoToWhereItRuns={() =>
                                  selectSettingsGroup("runs")
                                }
                              />
                            ),
                            discovery: (
                              <SuiteStageFactsList
                                stage="discovery"
                                targets={stageFactTargets}
                                projectServers={factsProjectServers}
                                isAuthenticated={isAuthenticated}
                                composeCapable={composeCapable}
                                onGoToWhereItRuns={() =>
                                  selectSettingsGroup("runs")
                                }
                              />
                            ),
                          }}
                          matchOptions={draft.current.defaultMatchOptions}
                          onMatchOptionsChange={(
                            next: EvalMatchOptions | undefined,
                          ) =>
                            dispatchDraft({
                              type: "edit",
                              key: "defaultMatchOptions",
                              value: next,
                            })
                          }
                          predicates={draftDefaultPredicates}
                          onPredicatesChange={setDraftDefaultPredicates}
                          judgeConfig={draft.current.judgeConfig}
                          onJudgeConfigChange={(next) =>
                            dispatchDraft({
                              type: "edit",
                              key: "judgeConfig",
                              value: next,
                            })
                          }
                          availableModels={availableModels}
                          judgeAccessory={
                            <JudgeGatePanel
                              suiteId={suite._id}
                              judge={
                                capabilitiesReady
                                  ? capabilities.judge
                                  : undefined
                              }
                              unavailableReason={
                                capabilitiesState === "unavailable"
                                  ? CAPABILITY_REASON_COPY.flag_unavailable
                                  : undefined
                              }
                              judgeConfig={draft.current.judgeConfig}
                              onJudgeConfigChange={(next) =>
                                dispatchDraft({
                                  type: "edit",
                                  key: "judgeConfig",
                                  value: next,
                                })
                              }
                              onAcknowledged={() =>
                                setCapabilitiesRefresh((n) => n + 1)
                              }
                            />
                          }
                          rubricEditor={
                            <JudgeRubricEditor
                              value={draft.current.judgeRubric}
                              onChange={(next) =>
                                dispatchDraft({
                                  type: "edit",
                                  key: "judgeRubric",
                                  value: next,
                                })
                              }
                            />
                          }
                          groundednessEvidence={{
                            result: groundedness.result ?? null,
                            pending: groundedness.pending,
                          }}
                          scenarioMigrationNotice={
                            suiteScenarioMigrationCount > 0 ? (
                              <p className="text-[11px] text-amber-700 dark:text-amber-400">
                                {suiteScenarioMigrationCount} scenario check
                                {suiteScenarioMigrationCount === 1
                                  ? ""
                                  : "s"}{" "}
                                in defaults — migrate per case in Steps.
                              </p>
                            ) : null
                          }
                        />
                      </div>
                    </SuiteSettingsSectionChain>
                  </section>
                ) : null}

                {activeGroupId === "runs" ? (
                  <section data-step-id="runs">
                    <SuiteSettingsSectionChain>
                      {/* Both rows of this group render together, environments first: the
                  clients × models × computers matrix is what this tab is for, and it
                  must not sit behind a rail click. */}
                      <SuiteSettingsRow
                        settingKey="environments"
                        data-subsection-id="environments"
                        label={
                          composeCapable ? undefined : LEGACY_CLIENTS_ROW_LABEL
                        }
                        hint={
                          composeCapable
                            ? "Run all launches one run per environment, in this order."
                            : "Run all launches one run per client, paired with each case's model."
                        }
                        appliesImmediately
                      >
                        <SuiteEnvironmentComposerBar
                          containerVariant="panel"
                          className="bg-transparent py-0"
                          suite={suite}
                          onUpdate={handleUpdateHostAttachments}
                          onUpdateServerAttachment={
                            handleServerAttachmentUpdate
                          }
                          omitComputers={computersEnabled && Boolean(projectId)}
                        />
                      </SuiteSettingsRow>

                      {computerEnvironmentRowVisible ? (
                        <SuiteSettingsRow
                          settingKey="computerEnvironment"
                          data-subsection-id="computerEnvironment"
                          disabledReason={computerEnvironmentDisabledReason}
                          hint="Each trial boots a fresh MCPJam cloud sandbox from this image, never on this machine. Build the image first, or the run fails fast."
                        >
                          <select
                            className="h-8 max-w-[16rem] rounded-md border border-input bg-background px-2 text-xs text-foreground"
                            value={draft.current.computerEnvironmentId ?? ""}
                            aria-label="Reproducible computer environment for eval runs"
                            onChange={(e) =>
                              dispatchDraft({
                                type: "edit",
                                key: "computerEnvironmentId",
                                value: e.target.value || undefined,
                              })
                            }
                          >
                            <option value="">None (default image)</option>
                            {(computerEnvironments ?? []).map((env) => {
                              const ready =
                                env.currentBuild?.status === "ready";
                              return (
                                <option
                                  key={env.environmentId}
                                  value={env.environmentId}
                                >
                                  {env.name}
                                  {ready ? "" : " (not built)"}
                                </option>
                              );
                            })}
                          </select>
                          {suitePinsSandboxImage &&
                          ephemeralCloudAvailable === false ? (
                            <div className="mt-2">
                              <CloudUnreachableNotice
                                data-testid="suite-eval-cloud-unreachable"
                                message={EVAL_SANDBOX_CLOUD_UNREACHABLE_MESSAGE}
                                detail="Runs started here would fail their computer setup — Run all is disabled until cloud sandboxes are reachable."
                              />
                            </div>
                          ) : null}
                        </SuiteSettingsRow>
                      ) : null}
                    </SuiteSettingsSectionChain>
                  </section>
                ) : null}

                {activeGroupId === "triggers" ? (
                  <section data-step-id="triggers">
                    <SuiteSettingsSectionChain>
                      {scheduledEvalsEnabled ? (
                        <SuiteSettingsRow
                          settingKey="schedule"
                          data-subsection-id="schedule"
                          appliesImmediately
                          disabledReason={scheduleDisabledReason}
                          hint="Saves immediately."
                        >
                          <SuiteAutomationRow
                            suiteId={suite._id}
                            schedule={suite.schedule}
                            scheduleNextDueAt={suite.scheduleNextDueAt}
                            runs={runs}
                            userMap={userMap}
                            projectId={projectId}
                            environmentIds={suite.environmentIds}
                            canTakeOver={scheduleDisabledReason === undefined}
                            editor="inline"
                          />
                          <p className="text-[11px] text-muted-foreground/60">
                            Runs the whole suite on a fixed interval, as the
                            person who enabled it. A paused schedule notifies
                            that person and the organization&apos;s admins.
                          </p>
                        </SuiteSettingsRow>
                      ) : null}

                      <ErrorBoundary
                        key={organizationId ?? "no-organization"}
                        name="suite_github_checks"
                        fallback={
                          <SuiteSettingsRow
                            settingKey="githubChecks"
                            appliesImmediately
                            disabledReason="GitHub Checks could not be loaded for this organization"
                            hint="Could not load GitHub Checks for this organization."
                          />
                        }
                      >
                        <SuiteGithubChecksSettingsSection
                          suiteId={suite._id}
                          projectId={projectId}
                          organizationId={organizationId}
                        />
                      </ErrorBoundary>
                    </SuiteSettingsSectionChain>
                  </section>
                ) : null}

                {activeGroupId === "danger" && canDeleteSuite ? (
                  <section data-step-id="danger">
                    <SuiteSettingsSectionChain>
                      <SuiteSettingsRow
                        settingKey="deleteSuite"
                        data-subsection-id="deleteSuite"
                        appliesImmediately
                        disabledReason={deleteDisabledReason}
                        labelClassName="text-destructive"
                        hint="Runs and cases can't be recovered."
                      >
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          className="h-8 gap-1.5 text-destructive hover:bg-destructive/10 hover:text-destructive"
                          onClick={() => onDelete(suite)}
                          disabled={
                            deletingSuiteId === suite._id ||
                            deleteDisabledReason !== undefined
                          }
                        >
                          {deletingSuiteId === suite._id ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          ) : (
                            <Trash2 className="h-3.5 w-3.5" />
                          )}
                          Delete
                        </Button>
                      </SuiteSettingsRow>
                    </SuiteSettingsSectionChain>
                  </section>
                ) : null}

                {editingDisabled ? null : (
                  <SuiteSettingsCommitBar
                    changeCount={draftChanges.length}
                    conflictCount={draft.conflicts.length}
                    canCommit={draftCanCommit}
                    isCommitting={isCommitting}
                    onDiscard={() => dispatchDraft({ type: "discard" })}
                    onReview={() => setReviewOpen(true)}
                    revisionNumber={suite.revisionNumber}
                    changedLabels={draftChanges.map((change) => change.label)}
                    blockingErrors={[
                      ...(nameRowError
                        ? [
                            {
                              message: nameRowError.message,
                              onFix: () => openSetting("name"),
                            },
                          ]
                        : []),
                      ...(passOrFailRowError
                        ? [
                            {
                              message: passOrFailRowError.message,
                              onFix: () => openSetting("passOrFail"),
                            },
                          ]
                        : []),
                    ]}
                  />
                )}
              </fieldset>
              <SuiteSettingsSubsectionNav
                subsections={activeGroupId === "runs" ? [] : activeSubsections}
                onSelect={selectSettingsSubsection}
                className="md:col-start-2 md:row-start-1"
              />
            </div>
          </div>
        </div>
      )}
      <ReviewAndSaveDialog
        open={reviewOpen}
        onOpenChange={setReviewOpen}
        requireNote={dirtySettingKeys.has("gatePolicy")}
        changes={draftChanges}
        conflicts={draft.conflicts.map(
          (key) =>
            draftChanges.find((change) => change.key === key)?.label ?? key,
        )}
        isCommitting={isCommitting}
        onConfirm={handleCommitSettings}
        extraContent={
          // Only when the RUBRIC is what changed, and only when there is a
          // judged run to compare against. The backtest spends credits, so it
          // is never offered for a save it could not inform.
          draftChanges.some((change) => change.key === "judgeRubric") &&
          backtestableRun ? (
            <JudgeBacktestPanel
              suiteId={suite._id}
              runId={backtestableRun._id}
              runNumber={backtestableRun.runNumber}
              draftRubric={draft.current.judgeRubric}
            />
          ) : undefined
        }
      />
      <EvalExportModal
        open={exportState !== null}
        onOpenChange={(open) => {
          if (!open) {
            setExportState(null);
          }
        }}
        scope={exportState?.scope ?? "suite"}
        projectId={projectId}
        suite={suite}
        cases={exportState?.cases ?? []}
        serverEntries={appState.servers}
      />
      {tracesExportOpen ? (
        <ExportTracesModal
          open={tracesExportOpen}
          onOpenChange={setTracesExportOpen}
          projectId={projectId}
          runChatSessionIds={runChatSessionIds}
        />
      ) : null}
      {unifiedShareEvals && selectedRunDetails ? (
        <ShareDialog
          open={shareOpen}
          onOpenChange={setShareOpen}
          title="Share eval run"
          description="A frozen redacted snapshot. Guests who redeem the link are auditable browser sessions, not verified individuals."
        >
          <ResourceSharePanel
            resourceType="evalRun"
            resourceId={selectedRunDetails._id}
            footerSlot={
              <p className="text-xs text-muted-foreground">
                Transcripts, tool arguments, credentials, and full server URLs
                are never included.
              </p>
            }
            linkLabel="Share link"
            buildShareUrl={(token) =>
              `${window.location.origin}${buildEvalSharePath(token)}`
            }
            testIdPrefix="eval-share"
          />
        </ShareDialog>
      ) : null}
    </div>
  );
}
