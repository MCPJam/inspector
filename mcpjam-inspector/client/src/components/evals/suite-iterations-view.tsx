import { useMemo, useState, useEffect, useCallback, useRef } from "react";
import { useMutation, useConvexAuth } from "convex/react";
import { useFeatureFlagEnabled } from "posthog-js/react";
import { useHostList } from "@/hooks/useClients";
import { toast } from "sonner";
import { motion, AnimatePresence, useReducedMotion } from "framer-motion";
import { compareRunsBySequence } from "./helpers";
import { SuiteHeader } from "./suite-header";
import { SuiteHeroStats } from "./suite-hero-stats";
import { RunOverview } from "./run-overview";
import { RunDetailView } from "./run-detail-view";
import { shouldShowRunAccuracyHero } from "./run-insight-rail";
import { RunTestCaseDetailView } from "./run-test-case-detail-view";
import type { RunCaseGroup } from "./run-case-groups";
import { RunDiffView } from "./run-diff-view";
import { TestTemplateEditor } from "./test-template-editor";
import { PassCriteriaSelector } from "./pass-criteria-selector";
import { ValidatorsSection } from "./validators-section";
import { JudgesSection } from "./judges-section";
import {
  AddCheckMenu,
  ChecksSection,
  areAllChecksValid,
  blankPredicate,
} from "./checks-section";
import type { EvalMatchOptions, Predicate } from "@/shared/eval-matching";
import { MATCH_OPTIONS_DEFAULTS } from "@/shared/eval-matching";
import { TestCasesOverview } from "./test-cases-overview";
import { TestCaseDetailView } from "./test-case-detail-view";
import { SuiteDashboard } from "./suite-dashboard";
import { ScheduleEditor } from "./schedule-editor";
import { EvalExportModal } from "./eval-export-modal";
// SuiteExecutionConfigEditor was previously rendered on the suite settings
// page; hidden there in the judge-config rework (see comment at the
// removed render site). Import kept dropped to avoid an unused-symbol
// lint and to make the removal obvious if someone reaches for it later.
import { useSuiteData, useRunDetailData } from "./use-suite-data";
import type {
  EvalCase,
  EvalIteration,
  EvalSuite,
  EvalSuiteRun,
  SuiteAggregate,
} from "./types";
import type { EvalRoute, SuiteOverviewView } from "@/lib/eval-route-types";
import { getBillingErrorMessage } from "@/lib/billing-entitlements";
import { useSharedAppState } from "@/state/app-state-context";
import { Button } from "@mcpjam/design-system/button";
import { Loader2, Trash2 } from "lucide-react";
import type { EvalChatHandoff } from "@/lib/eval-chat-handoff";
import type { EnsureServersReadyResult } from "@/hooks/use-app-state";
import type { RemoteServer } from "@/hooks/useProjects";
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
    }
  ) => void;
  toTestDetail: (suiteId: string, testId: string, iteration?: string) => void;
  toTestEdit: (
    suiteId: string,
    testId: string,
    options?: { openCompare?: boolean; replace?: boolean; iteration?: string }
  ) => void;
  toSuiteEdit: (suiteId: string) => void;
}

/**
 * Settings sheet primitives — used by the suite-edit branch below. Kept
 * file-local because they encode the eyebrow-label + hairline-divider
 * pattern that's specific to this surface; if a second consumer appears,
 * lift into a shared module then.
 */
function SettingsSection({
  label,
  hint,
  layout = "stack",
  children,
  inlineSlot,
}: {
  label: string;
  hint?: string;
  /**
   * "stack" — eyebrow on top, hint right-aligned next to it, content
   *           below in space-y-3 rows.
   * "inline" — single row: eyebrow on the left, `inlineSlot` on the
   *            right. `children` (if any) flow underneath. Used for
   *            sections that resolve to one primary control.
   */
  layout?: "stack" | "inline";
  inlineSlot?: React.ReactNode;
  children?: React.ReactNode;
}) {
  if (layout === "inline") {
    return (
      <section className="py-5 first:pt-2 last:pb-2">
        <div className="flex items-center justify-between gap-4">
          <h2 className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground/80">
            {label}
          </h2>
          {inlineSlot}
        </div>
        {children ? <div className="mt-3 space-y-2">{children}</div> : null}
      </section>
    );
  }
  return (
    <section className="py-6 first:pt-2 last:pb-2">
      <div className="mb-3 flex items-baseline justify-between gap-3">
        <h2 className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground/80">
          {label}
        </h2>
        {hint ? (
          <p className="text-[11px] text-muted-foreground/60">{hint}</p>
        ) : null}
      </div>
      <div className="space-y-3">{children}</div>
    </section>
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
  navigation,
  onSetupCi,
  onCreateTestCase,
  onCreateWidgetProbe,
  onGenerateTestCases,
  canGenerateTestCases = false,
  isGeneratingTestCases = false,
  caseListInSidebar = false,
  runDetailSortByOverride,
  onRunDetailSortByChange,
  omitRunIterationList = false,
  canDeleteSuite,
  canDeleteRuns = true,
  readOnlyConfig = false,
  hideRunActions = false,
  casesSidebarHidden,
  onShowCasesSidebar,
  omitSuiteHeader = false,
  alwaysShowEditIterationRows = false,
  onEditTestCase,
  onDeleteTestCasesBatch,
  onRunTestCase,
  runningTestCaseId = null,
  onContinueInChat,
  projectServers,
  generateTestCasesDisabledReason,
  evalRunsDisabledReason,
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
  navigation: SuiteNavigation;
  onSetupCi?: () => void;
  onCreateTestCase?: () => void;
  onCreateWidgetProbe?: () => void;
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
  /** Project admins only: run list batch delete and selection. */
  canDeleteRuns?: boolean;
  /** When true, hide suite editing and other destructive controls (e.g. desktop CI). */
  readOnlyConfig?: boolean;
  /** When true, suppress suite-level run/replay entry points in shared chrome. */
  hideRunActions?: boolean;
  casesSidebarHidden?: boolean;
  onShowCasesSidebar?: () => void;
  /** When true, hide {@link SuiteHeader} on run detail (e.g. CI where breadcrumbs + sidebar carry context). */
  omitSuiteHeader?: boolean;
  /** Playground run detail: show edit affordance on every row that has a test case id. */
  alwaysShowEditIterationRows?: boolean;
  /** Override default test edit navigation (e.g. playground hash navigation). */
  onEditTestCase?: (testCaseId: string) => void;
  /** Playground: batch delete test cases from the cases table (no runs UI). */
  onDeleteTestCasesBatch?: (testCaseIds: string[]) => Promise<void>;
  /** Per-case run from the cases overview table (Explore / CI). */
  onRunTestCase?: (
    testCase: EvalCase,
    opts?: { iterationOverride?: number }
  ) => void;
  runningTestCaseId?: string | null;
  onContinueInChat?: (handoff: Omit<EvalChatHandoff, "id">) => void;
  projectServers?: RemoteServer[];
  /** When true, this is rendering the direct-guest eval playground flow. */
  isDirectGuest?: boolean;
  /** Playground: connect suite MCP servers before compare run (same as per-case run). */
  ensureServersReady?: (
    serverNames: string[]
  ) => Promise<EnsureServersReadyResult>;
}) {
  const appState = useSharedAppState();
  // Derive view state from route
  const isEditMode = route.type === "suite-edit" && !readOnlyConfig;
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
      : route.type === "test-edit" && !readOnlyConfig
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
      }
    ) =>
      (
        onRerun as (
          suite: EvalSuite,
          opts?: {
            matchOptionsOverride?: EvalMatchOptions;
            iterationOverride?: number;
          }
        ) => void
      )(s, opts),
    [onRerun]
  );

  const onRunTestCaseWithOverride = useMemo<
    ((testCase: EvalCase) => void) | undefined
  >(
    () =>
      onRunTestCase
        ? (testCase: EvalCase) => onRunTestCase(testCase, { iterationOverride })
        : undefined,
    [onRunTestCase, iterationOverride]
  );
  const effectiveRunDetailSortBy = runDetailSortByOverride ?? runDetailSortBy;
  const effectiveRunDetailSortChange =
    onRunDetailSortByChange ?? setRunDetailSortBy;
  const [defaultMinimumPassRate, setDefaultMinimumPassRate] = useState(100);
  // Local in-progress state for the suite-default checks editor. Mirrors the
  // case editor's `editForm.predicates.list` mediation: `ChecksSection` fires
  // onChange on every keystroke (including the blank-template insertion from
  // `Add check`), so we keep edits local and only persist when every check
  // is valid. See `areAllChecksValid` and `test-template-editor.tsx`.
  const [draftDefaultPredicates, setDraftDefaultPredicates] = useState<
    Predicate[]
  >(suite.defaultPredicates ?? []);
  // Description editor is hidden in the current pass — handlers and draft
  // state were removed; re-add together when the About section returns.
  const [exportState, setExportState] = useState<{
    scope: "suite" | "test-case";
    cases: EvalExportCaseInput[];
  } | null>(null);

  const updateSuite = useMutation("testSuites:updateTestSuite" as any);
  const { isAuthenticated } = useConvexAuth();
  // Hosts available to attach in the header's "+ Attach host" picker. The
  // query is owned here (not inside SuiteOverviewClientBar) so the bar stays
  // pure-props and renderable in test environments without a Convex provider.
  const { hosts: projectHosts } = useHostList({
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
    aggregate
  );

  const { caseGroupsForSelectedRun } = useRunDetailData(
    selectedRunId,
    allIterations,
    effectiveRunDetailSortBy
  );

  // Selected run details
  const selectedRunDetails = useMemo(() => {
    if (!selectedRunId) return null;
    const run = runs.find((r) => r._id === selectedRunId);
    return run ?? null;
  }, [selectedRunId, runs]);

  const selectedCompareBaseRunId =
    route.type === "run-detail" ? route.compareToRunId ?? null : null;

  const previousCompletedRunForSelectedRun = useMemo(() => {
    if (!selectedRunDetails || selectedRunDetails.status !== "completed") {
      return null;
    }
    const earlierCompletedRuns = runs
      .filter(
        (run) =>
          run._id !== selectedRunDetails._id &&
          run.status === "completed" &&
          compareRunsBySequence(run, selectedRunDetails) < 0
      )
      .sort((a, b) => compareRunsBySequence(b, a));
    return earlierCompletedRuns[0] ?? null;
  }, [runs, selectedRunDetails]);

  // Resolve namedHostId → display name for any run-detail / list views
  // that want to surface which host a run was triggered against.
  const hostNamesById = useMemo(() => {
    const map = new Map<string, string | null>();
    for (const attachment of suite.hostAttachments ?? []) {
      map.set(attachment.namedHostId, attachment.hostName);
    }
    return map;
  }, [suite.hostAttachments]);

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
    route.type === "run-detail" ? route.iteration ?? null : null;

  const selectedRunTestCaseId =
    route.type === "run-detail" ? route.testCaseId ?? null : null;

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
      (iteration) => iteration.testCaseId === selectedRunTestCaseId
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
    if (readOnlyConfig) {
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

  // Sync local draft of default checks when the suite identity or its
  // persisted value changes. `suite._id` is included so navigating to a
  // different suite with the same persisted value (commonly
  // `undefined → undefined`) still resets the draft — otherwise the old
  // suite's in-progress edits would be saved into the new one on the next
  // valid keystroke.
  useEffect(() => {
    setDraftDefaultPredicates(suite.defaultPredicates ?? []);
  }, [suite._id, suite.defaultPredicates]);

  // Debounced commit of the default-checks draft. Earlier this was fired
  // directly inside ChecksSection's onChange, which kicked off one
  // unsynchronized `updateSuite` per keystroke — out-of-order responses
  // could land in the wrong order and persist stale predicate text, and
  // the toast spammed once per character.
  //
  // The debounce alone is not enough: if a user pauses (timer fires →
  // updateSuite A starts) and then keeps editing (timer fires again →
  // updateSuite B starts before A resolves), Convex's "last write wins"
  // means whichever request lands second persists, which can roll the
  // draft back to A's stale snapshot. We serialize: the next save waits
  // for any in-flight one to settle, then reads the latest draft and
  // fires exactly one write.
  const persistedDefaultPredicatesKey = useMemo(
    () => JSON.stringify(suite.defaultPredicates ?? []),
    [suite.defaultPredicates]
  );
  const draftDefaultPredicatesKey = useMemo(
    () => JSON.stringify(draftDefaultPredicates),
    [draftDefaultPredicates]
  );
  const defaultChecksInFlightRef = useRef<Promise<unknown> | null>(null);
  useEffect(() => {
    if (draftDefaultPredicatesKey === persistedDefaultPredicatesKey) return;
    if (!areAllChecksValid(draftDefaultPredicates)) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      void (async () => {
        // Wait for any in-flight save to settle before starting the next
        // one. The pending one captured an earlier draft; if we raced it
        // and lost, Convex would persist the stale snapshot.
        while (defaultChecksInFlightRef.current) {
          try {
            await defaultChecksInFlightRef.current;
          } catch {
            // Errors are surfaced by the call site that started the
            // in-flight promise; we just need it to settle.
          }
        }
        if (cancelled) return;
        const snapshot = draftDefaultPredicates;
        const promise = updateSuite({
          suiteId: suite._id,
          defaultPredicates: snapshot.length === 0 ? null : snapshot,
        });
        defaultChecksInFlightRef.current = promise as Promise<unknown>;
        try {
          await promise;
          toast.success("Default checks updated");
        } catch (error) {
          toast.error(getBillingErrorMessage(error, "Failed to update suite"));
          console.error("Failed to update default checks:", error);
        } finally {
          if (defaultChecksInFlightRef.current === promise) {
            defaultChecksInFlightRef.current = null;
          }
        }
      })();
    }, 400);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [
    draftDefaultPredicatesKey,
    persistedDefaultPredicatesKey,
    draftDefaultPredicates,
    suite._id,
    updateSuite,
  ]);

  // Load default pass criteria from suite
  useEffect(() => {
    if (suite.defaultPassCriteria?.minimumPassRate !== undefined) {
      setDefaultMinimumPassRate(suite.defaultPassCriteria.minimumPassRate);
      if (typeof window !== "undefined") {
        try {
          localStorage.setItem(
            `suite-${suite._id}-criteria-rate`,
            String(suite.defaultPassCriteria.minimumPassRate)
          );
        } catch (error) {
          console.warn(
            "Failed to sync default pass criteria to localStorage",
            error
          );
        }
      }
    } else if (typeof window !== "undefined") {
      try {
        const rate = localStorage.getItem(`suite-${suite._id}-criteria-rate`);
        if (rate) setDefaultMinimumPassRate(Number(rate));
      } catch (error) {
        console.warn("Failed to load default pass criteria", error);
      }
    }
  }, [suite._id, suite.defaultPassCriteria]);

  const handleUpdateHostAttachments = async (
    attachments: Array<{
      namedHostId: string;
      enabledOptionalServerIds: string[];
    }>
  ) => {
    try {
      await updateSuite({
        suiteId: suite._id,
        hostAttachments: attachments,
      });
      toast.success(
        attachments.length === 0 ? "Hosts cleared" : "Hosts updated"
      );
    } catch (error) {
      toast.error(getBillingErrorMessage(error, "Failed to update hosts"));
      console.error("Failed to update host attachments:", error);
      throw error;
    }
  };

  const handleRunClick = (runId: string) => {
    navigation.toRunDetail(suite._id, runId, undefined, {
      insightsFocus: true,
    });
  };

  const handleCompareRuns = useCallback(
    (baseRunId: string, compareRunId: string) => {
      navigation.toRunDetail(suite._id, compareRunId, undefined, {
        compareToRunId: baseRunId,
      });
    },
    [navigation, suite._id]
  );

  const handleBackToOverview = () => {
    navigation.toSuiteOverview(suite._id);
  };

  const ciEnabled = useFeatureFlagEnabled("evaluate-ci") === true;
  const syntheticMonitorsEnabled =
    useFeatureFlagEnabled("synthetic-monitors") === true;

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
        (run) => run._id === replayingRunId && run.hasServerReplayConfig
      ) &&
      runs
        .filter((run) => run.hasServerReplayConfig)
        .sort((a, b) => {
          const aTime = a.completedAt ?? a.createdAt ?? 0;
          const bTime = b.completedAt ?? b.createdAt ?? 0;
          return bTime - aTime;
        })[0]?._id === replayingRunId,
    [replayingRunId, runs]
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

  const showSuiteHeader =
    !omitSuiteHeader || viewMode !== "run-detail" || isEditMode;

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      {/* Header */}
      {showSuiteHeader ? (
        <div className="shrink-0">
          <SuiteHeader
            suite={suite}
            viewMode={viewMode}
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
            onOpenExportSuite={ciEnabled ? handleOpenSuiteExport : undefined}
            readOnlyConfig={readOnlyConfig}
            hideRunActions={hideRunActions}
            unifiedSuiteDashboard={hideRunActions && !caseListInSidebar}
            casesSidebarHidden={casesSidebarHidden}
            onShowCasesSidebar={onShowCasesSidebar}
            onCreateTestCase={onCreateTestCase}
            onCreateWidgetProbe={onCreateWidgetProbe}
            onGenerateTestCases={onGenerateTestCases}
            canGenerateTestCases={canGenerateTestCases}
            generateTestCasesDisabledReason={generateTestCasesDisabledReason}
            evalRunsDisabledReason={evalRunsDisabledReason}
            isGeneratingTestCases={isGeneratingTestCases}
            onRunTestCase={onRunTestCaseWithOverride}
            blockTestCaseRuns={Boolean(rerunningSuiteId || replayingRunId)}
            runningTestCaseId={runningTestCaseId}
            onSuiteHostAttachmentsUpdate={
              readOnlyConfig ? undefined : handleUpdateHostAttachments
            }
            projectHosts={projectHosts}
            omitRunDetailIdentity={omitRunDetailIdentity}
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
                  isDirectGuest={isDirectGuest}
                  ensureServersReady={ensureServersReady}
                  projectServers={projectServers}
                  onExportDraft={ciEnabled ? handleOpenDraftExport : undefined}
                  openCompareFromRoute={
                    route.type === "test-edit" && Boolean(route.openCompare)
                  }
                  openCompareIterationId={
                    route.type === "test-edit" ? route.iteration ?? null : null
                  }
                  onBackToList={() =>
                    navigation.toSuiteOverview(suite._id, "test-cases")
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
                />
              </motion.div>
            ) : viewMode === "test-detail" && selectedTestId ? (
              (() => {
                const selectedCase = cases.find(
                  (c) => c._id === selectedTestId
                );
                if (!selectedCase) return null;

                const caseIterations = allIterations.filter(
                  (iter) => iter.testCaseId === selectedTestId
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
                  className="min-h-0 flex-1 overflow-y-auto p-0.5"
                >
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
                    onRunClick={handleRunClick}
                    onRunTestCase={onRunTestCaseWithOverride}
                    runningTestCaseId={runningTestCaseId}
                    blockTestCaseRuns={Boolean(
                      rerunningSuiteId ||
                        replayingRunId ||
                        evalRunsDisabledReason
                    )}
                    runTestCaseDisabledReason={evalRunsDisabledReason}
                    connectedServerNames={connectedServerNames}
                    onDeleteTestCasesBatch={onDeleteTestCasesBatch}
                    testCasesClickHint="Click a case row to open the test case. Click the last-run summary to jump straight to compare results for that run."
                    userMap={userMap}
                  />
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
                          isSDK={suite.source === "sdk"}
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
                      runningTestCaseId={runningTestCaseId}
                      blockTestCaseRuns={Boolean(
                        rerunningSuiteId ||
                          replayingRunId ||
                          evalRunsDisabledReason
                      )}
                      runTestCaseDisabledReason={evalRunsDisabledReason}
                      connectedServerNames={connectedServerNames}
                      onGenerateTestCases={onGenerateTestCases}
                      canGenerateTestCases={canGenerateTestCases}
                      isGeneratingTestCases={isGeneratingTestCases}
                      onCreateTestCase={onCreateTestCase}
                      onCreateWidgetProbe={onCreateWidgetProbe}
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
                        { insightsFocus: true }
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
                  />
                ) : (
                  <RunDetailView
                    selectedRunDetails={selectedRunDetails}
                    caseGroupsForSelectedRun={caseGroupsForSelectedRun}
                    currentSuiteJudgeConfig={suite.judgeConfig ?? null}
                    source={suite.source}
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
                    onSelectRun={(runId) =>
                      navigation.toRunDetail(suite._id, runId)
                    }
                    kpiPlacement={
                      showSuiteHeader && viewMode === "run-detail"
                        ? "header"
                        : "body"
                    }
                    hideReplayLineage
                    omitIterationList={omitRunIterationList}
                    onOpenRunInsights={
                      !omitRunIterationList && route.type === "run-detail"
                        ? () =>
                            navigation.toRunDetail(
                              route.suiteId,
                              route.runId,
                              undefined,
                              { insightsFocus: true }
                            )
                        : undefined
                    }
                    runInsightsSelected={
                      !omitRunIterationList &&
                      route.type === "run-detail" &&
                      Boolean(
                        route.insightsFocus &&
                          !route.iteration &&
                          !route.testCaseId
                      )
                    }
                    onEditTestCase={onEditTestCase}
                    alwaysShowEditIterationRows={alwaysShowEditIterationRows}
                    runTrendData={runTrendData}
                  />
                )}
              </motion.div>
            ) : null}
          </AnimatePresence>
        </div>
      )}

      {isEditMode && (
        <div className="flex-1 min-h-0 overflow-auto">
          <div className="px-6 py-8 max-w-2xl mx-auto">
            {/* Settings sheet — a single quiet surface with hairline-divided
                sections. Each row follows the [label · helper] / [control]
                definition-list pattern, so the sheet reads top-to-bottom as
                a preference list rather than a stack of feature cards.
                Section labels are eyebrow-style (uppercase, tracking-wider,
                muted) — visual hierarchy without visual weight. */}
            <dl className="divide-y divide-border/60">
              {/* About / Description is intentionally hidden in the current
                  pass — surface lives elsewhere when the user wants context
                  on the suite. */}

              {/* ── Minimum accuracy (one row) ───────────────────────── */}
              <SettingsSection
                label="Minimum accuracy"
                layout="inline"
                inlineSlot={
                  <PassCriteriaSelector
                    hideLabel
                    minimumPassRate={defaultMinimumPassRate}
                    onMinimumPassRateChange={async (rate) => {
                      setDefaultMinimumPassRate(rate);
                      localStorage.setItem(
                        `suite-${suite._id}-criteria-rate`,
                        String(rate)
                      );
                      try {
                        await updateSuite({
                          suiteId: suite._id,
                          defaultPassCriteria: { minimumPassRate: rate },
                        });
                        toast.success("Suite updated successfully");
                      } catch (error) {
                        toast.error(
                          getBillingErrorMessage(
                            error,
                            "Failed to update suite"
                          )
                        );
                        console.error("Failed to update suite:", error);
                        setDefaultMinimumPassRate(
                          suite.defaultPassCriteria?.minimumPassRate ?? 100
                        );
                      }
                    }}
                  />
                }
              />

              {/* ── Tool calls ───────────────────────────────────────── */}
              <SettingsSection
                label="Tool calls"
                hint="Cases and run overrides can change these."
              >
                <ValidatorsSection
                  title=""
                  value={suite.defaultMatchOptions}
                  inheritedFrom={MATCH_OPTIONS_DEFAULTS}
                  onChange={async (next: EvalMatchOptions | undefined) => {
                    try {
                      await updateSuite({
                        suiteId: suite._id,
                        defaultMatchOptions: next ?? null,
                      });
                      toast.success("Default validators updated");
                    } catch (error) {
                      toast.error(
                        getBillingErrorMessage(error, "Failed to update suite")
                      );
                      console.error(
                        "Failed to update default validators:",
                        error
                      );
                    }
                  }}
                />
              </SettingsSection>

              {/* ── Checks ───────────────────────────────────────────── */}
              <SettingsSection
                label="Checks"
                layout="inline"
                inlineSlot={
                  <AddCheckMenu
                    onAdd={(kind) =>
                      setDraftDefaultPredicates((prev) => [
                        ...prev,
                        blankPredicate(kind),
                      ])
                    }
                  />
                }
              >
                {/* The list (when non-empty) renders under the eyebrow row.
                    Empty state copy + the inner AddCheckMenu are both
                    suppressed — the eyebrow row's AddCheckMenu is the only
                    affordance, so "no checks" reads as a clean section
                    with just the eyebrow + add button. */}
                <ChecksSection
                  title=""
                  hideAddButton
                  hideEmptyState
                  value={draftDefaultPredicates}
                  onChange={setDraftDefaultPredicates}
                />
              </SettingsSection>

              {/* ── Schedule (synthetic monitors, flag-gated) ────────── */}
              {syntheticMonitorsEnabled ? (
                <SettingsSection
                  label="Schedule"
                  hint="Run this suite automatically on a fixed interval."
                >
                  <ScheduleEditor
                    suiteId={suite._id}
                    schedule={suite.schedule}
                  />
                </SettingsSection>
              ) : null}

              {/* ── LLM as Judge ─────────────────────────────────────── */}
              <SettingsSection
                label="LLM as Judge"
                hint="Advisory grading against each case's objective. Calibrate per suite."
              >
                <JudgesSection
                  chrome="bare"
                  value={suite.judgeConfig}
                  availableModels={availableModels}
                  onChange={async (next) => {
                    try {
                      await updateSuite({
                        suiteId: suite._id,
                        judgeConfig: next ?? null,
                      });
                      toast.success("Judges updated");
                    } catch (error) {
                      toast.error(
                        getBillingErrorMessage(error, "Failed to update suite")
                      );
                      console.error("Failed to update judges:", error);
                    }
                  }}
                />
              </SettingsSection>

              {/* ── Delete ───────────────────────────────────────────── */}
              {canDeleteSuite ? (
                <div className="flex items-center justify-between gap-4 py-5">
                  <div className="min-w-0">
                    <div className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground/80">
                      Delete suite
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground/70">
                      Runs and cases can&apos;t be recovered.
                    </p>
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-8 gap-1.5 text-destructive hover:bg-destructive/10 hover:text-destructive"
                    onClick={() => onDelete(suite)}
                    disabled={deletingSuiteId === suite._id}
                  >
                    {deletingSuiteId === suite._id ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Trash2 className="h-3.5 w-3.5" />
                    )}
                    Delete
                  </Button>
                </div>
              ) : null}
            </dl>
          </div>
        </div>
      )}
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
    </div>
  );
}
