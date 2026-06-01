import { useMemo, useState, useEffect, useCallback } from "react";
import { useMutation, useConvexAuth } from "convex/react";
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
import type { EvalMatchOptions } from "@/shared/eval-matching";
import { MATCH_OPTIONS_DEFAULTS } from "@/shared/eval-matching";
import { TestCasesOverview } from "./test-cases-overview";
import { TestCaseDetailView } from "./test-case-detail-view";
import { SuiteDashboard } from "./suite-dashboard";
import { EvalExportModal } from "./eval-export-modal";
import { SuiteExecutionConfigEditor } from "./suite-execution-config-editor";
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
import { isMCPJamProvidedModel } from "@/shared/types";
import {
  useAiProviderKeys,
  type ProviderTokens,
} from "@/hooks/use-ai-provider-keys";
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
  onGenerateTestCases?: () => void;
  canGenerateTestCases?: boolean;
  generateTestCasesDisabledReason?: string;
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
  const [editedDescription, setEditedDescription] = useState(
    suite.description || ""
  );
  const [isEditingDescription, setIsEditingDescription] = useState(false);
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

  const { caseGroupsForSelectedRun, selectedRunChartData } = useRunDetailData(
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
  }, [
    viewMode,
    selectedRunDetails,
    caseGroupsForSelectedRun,
    runTrendData,
  ]);

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
      (iteration) => iteration.testCaseId === selectedRunTestCaseId,
    );
  }, [
    selectedRunId,
    selectedRunTestCaseId,
    caseGroupsForSelectedRun,
  ]);

  const selectedRunTestCase = useMemo(() => {
    if (!selectedRunTestCaseId) return null;
    return cases.find((testCase) => testCase._id === selectedRunTestCaseId) ?? null;
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

  // Update local description state when suite changes
  useEffect(() => {
    setEditedDescription(suite.description || "");
  }, [suite.description]);

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

  const handleDescriptionClick = useCallback(() => {
    setIsEditingDescription(true);
    setEditedDescription(suite.description || "");
  }, [suite.description]);

  const handleDescriptionBlur = useCallback(async () => {
    setIsEditingDescription(false);
    if (editedDescription !== suite.description) {
      try {
        await updateSuite({
          suiteId: suite._id,
          description: editedDescription,
        });
        toast.success("Suite description updated");
      } catch (error) {
        toast.error(
          getBillingErrorMessage(error, "Failed to update suite description")
        );
        console.error("Failed to update suite description:", error);
        setEditedDescription(suite.description || "");
      }
    } else {
      setEditedDescription(suite.description || "");
    }
  }, [editedDescription, suite.description, suite._id, updateSuite]);

  const handleDescriptionKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Escape") {
        setIsEditingDescription(false);
        setEditedDescription(suite.description || "");
      }
    },
    [suite.description]
  );

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
        attachments.length === 0 ? "Clients cleared" : "Clients updated"
      );
    } catch (error) {
      toast.error(getBillingErrorMessage(error, "Failed to update clients"));
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

  const { hasToken } = useAiProviderKeys();
  const missingReplayProviderKeys = useMemo(() => {
    if (!cases || cases.length === 0) return [];
    const providers = new Set<string>();
    for (const tc of cases) {
      for (const m of tc.models ?? []) {
        if (!isMCPJamProvidedModel(m.model, m.provider)) {
          providers.add(m.provider);
        }
      }
    }
    return [...providers].filter(
      (p) => !hasToken(p.toLowerCase() as keyof ProviderTokens)
    );
  }, [cases, hasToken]);

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
            onOpenExportSuite={handleOpenSuiteExport}
            readOnlyConfig={readOnlyConfig}
            hideRunActions={hideRunActions}
            unifiedSuiteDashboard={hideRunActions && !caseListInSidebar}
            casesSidebarHidden={casesSidebarHidden}
            onShowCasesSidebar={onShowCasesSidebar}
            onCreateTestCase={onCreateTestCase}
            onGenerateTestCases={onGenerateTestCases}
            canGenerateTestCases={canGenerateTestCases}
            generateTestCasesDisabledReason={generateTestCasesDisabledReason}
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
                  isDirectGuest={isDirectGuest}
                  ensureServersReady={ensureServersReady}
                  projectServers={projectServers}
                  onExportDraft={handleOpenDraftExport}
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
                  onOpenLastRun={(iteration) => {
                    if (!iteration.suiteRunId) {
                      return;
                    }
                    navigation.toRunDetail(
                      suite._id,
                      iteration.suiteRunId,
                      iteration._id
                    );
                  }}
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
                    initialHostMode={
                      runsViewMode === "cross-host" ? "by-host" : "by-case"
                    }
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
                      rerunningSuiteId || replayingRunId
                    )}
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
                          missingReplayProviderKeys={missingReplayProviderKeys}
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
                      initialHostMode={
                        runsViewMode === "cross-host" ? "by-host" : "by-case"
                      }
                      runsViewMode={
                        runsViewMode === "cross-host"
                          ? "test-cases"
                          : runsViewMode
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
                        rerunningSuiteId || replayingRunId
                      )}
                      connectedServerNames={connectedServerNames}
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
                    source={suite.source}
                    selectedRunChartData={selectedRunChartData}
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
                              { insightsFocus: true },
                            )
                        : undefined
                    }
                    runInsightsSelected={
                      !omitRunIterationList &&
                      route.type === "run-detail" &&
                      Boolean(
                        route.insightsFocus &&
                          !route.iteration &&
                          !route.testCaseId,
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
          <div className="p-6 max-w-5xl mx-auto space-y-8">
            <SuiteExecutionConfigEditor
              suite={suite}
              availableModels={availableModels}
              projectId={projectId}
            />

            {/* Suite Description Section */}
            <div className="space-y-3">
              <div>
                <h2 className="text-base font-semibold text-foreground">
                  Description
                </h2>
                <p className="text-xs text-muted-foreground mt-1">
                  Provide context about what this evaluation suite tests
                </p>
              </div>
              {isEditingDescription ? (
                <textarea
                  value={editedDescription}
                  onChange={(e) => setEditedDescription(e.target.value)}
                  onBlur={handleDescriptionBlur}
                  onKeyDown={handleDescriptionKeyDown}
                  placeholder="Enter a description for this suite..."
                  autoFocus
                  className="w-full px-4 py-3 text-sm border border-input rounded-lg focus:outline-none focus:ring-2 focus:ring-ring resize-none min-h-[100px] bg-background"
                  rows={4}
                />
              ) : (
                <button
                  onClick={handleDescriptionClick}
                  className="w-full px-4 py-3 text-sm text-left rounded-lg border border-border hover:border-input hover:bg-accent/50 whitespace-pre-wrap transition-all"
                >
                  {suite.description ? (
                    <span className="text-foreground leading-relaxed">
                      {suite.description}
                    </span>
                  ) : (
                    <span className="text-muted-foreground italic">
                      Click to add a description...
                    </span>
                  )}
                </button>
              )}
            </div>

            {/* Default Pass/Fail Criteria Section */}
            <div className="space-y-3">
              <div>
                <h2 className="text-base font-semibold text-foreground">
                  Default Pass/Fail Criteria
                </h2>
                <p className="text-xs text-muted-foreground mt-1">
                  Set the default criteria for <strong>new</strong> evaluation
                  runs of this suite. Existing runs keep their original
                  criteria.
                </p>
              </div>
              <PassCriteriaSelector
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
                      defaultPassCriteria: {
                        minimumPassRate: rate,
                      },
                    });
                    toast.success("Suite updated successfully");
                  } catch (error) {
                    toast.error(
                      getBillingErrorMessage(error, "Failed to update suite")
                    );
                    console.error("Failed to update suite:", error);
                    setDefaultMinimumPassRate(
                      suite.defaultPassCriteria?.minimumPassRate ?? 100
                    );
                  }
                }}
              />
            </div>

            {/* Default Validators Section */}
            <div className="space-y-3">
              <ValidatorsSection
                title="Default validators"
                description="Applied to every run unless a test case or 'this run' popover changes them."
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
            </div>

            {canDeleteSuite ? (
              <div className="border-t border-border pt-8 space-y-3">
                <h2 className="text-base font-semibold text-destructive">
                  Danger zone
                </h2>
                <p className="text-xs text-muted-foreground">
                  Deleting removes this suite from the project. Run history and
                  cases cannot be recovered.
                </p>
                <Button
                  type="button"
                  variant="outline"
                  className="border-destructive/50 text-destructive hover:bg-destructive/10"
                  onClick={() => onDelete(suite)}
                  disabled={deletingSuiteId === suite._id}
                >
                  {deletingSuiteId === suite._id ? (
                    <Loader2 className="h-4 w-4 animate-spin mr-2" />
                  ) : (
                    <Trash2 className="h-4 w-4 mr-2" />
                  )}
                  Delete suite
                </Button>
              </div>
            ) : null}
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
        suite={suite}
        cases={exportState?.cases ?? []}
        serverEntries={appState.servers}
      />
    </div>
  );
}
