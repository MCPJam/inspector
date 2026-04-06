import { useMemo, useState, useEffect, useCallback } from "react";
import { useMutation } from "convex/react";
import { toast } from "sonner";
import { motion, AnimatePresence, useReducedMotion } from "framer-motion";
import { SuiteHeader } from "./suite-header";
import { SuiteHeroStats } from "./suite-hero-stats";
import { RunOverview } from "./run-overview";
import { RunDetailView } from "./run-detail-view";
import { SuiteTestsConfig } from "./suite-tests-config";
import { TestTemplateEditor } from "./test-template-editor";
import { PassCriteriaSelector } from "./pass-criteria-selector";
import { TestCasesOverview } from "./test-cases-overview";
import { TestCaseDetailView } from "./test-case-detail-view";
import { EvalExportModal } from "./eval-export-modal";
import { useSuiteData, useRunDetailData } from "./use-suite-data";
import type {
  EvalCase,
  EvalIteration,
  EvalSuite,
  EvalSuiteRun,
  SuiteAggregate,
} from "./types";
import type { EvalRoute } from "@/lib/eval-route-types";
import { getBillingErrorMessage } from "@/lib/billing-entitlements";
import { useSharedAppState } from "@/state/app-state-context";
import { isMCPJamProvidedModel } from "@/shared/types";
import {
  useAiProviderKeys,
  type ProviderTokens,
} from "@/hooks/use-ai-provider-keys";
import { Button } from "@/components/ui/button";
import { Loader2, Trash2 } from "lucide-react";
import {
  normalizeDraftEvalCaseForExport,
  normalizeEvalCaseForExport,
  pickSuiteExportCases,
  type EvalExportCaseInput,
  type EvalExportDraftInput,
} from "@/lib/evals/eval-export";

export interface SuiteNavigation {
  toSuiteOverview: (suiteId: string, view?: "runs" | "test-cases") => void;
  toRunDetail: (
    suiteId: string,
    runId: string,
    iteration?: string,
    options?: { insightsFocus?: boolean; replace?: boolean },
  ) => void;
  toTestDetail: (suiteId: string, testId: string, iteration?: string) => void;
  toTestEdit: (
    suiteId: string,
    testId: string,
    options?: { openCompare?: boolean; replace?: boolean },
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
  workspaceId = null,
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
  workspaceId?: string | null;
  navigation: SuiteNavigation;
  onSetupCi?: () => void;
  onCreateTestCase?: () => void;
  onGenerateTestCases?: () => void;
  canGenerateTestCases?: boolean;
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
  /** Workspace admins only: run list batch delete and selection. */
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
  onRunTestCase?: (testCase: EvalCase) => void;
  runningTestCaseId?: string | null;
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
  const runsViewMode =
    route.type === "suite-overview" && route.view === "test-cases"
      ? "test-cases"
      : "runs";

  // Local state that's not in the URL
  const [runDetailSortBy, setRunDetailSortBy] = useState<
    "model" | "test" | "result"
  >("model");
  const effectiveRunDetailSortBy = runDetailSortByOverride ?? runDetailSortBy;
  const effectiveRunDetailSortChange =
    onRunDetailSortByChange ?? setRunDetailSortBy;
  const [defaultMinimumPassRate, setDefaultMinimumPassRate] = useState(100);
  const [editedDescription, setEditedDescription] = useState(
    suite.description || "",
  );
  const [isEditingDescription, setIsEditingDescription] = useState(false);
  const [exportState, setExportState] = useState<{
    scope: "suite" | "test-case";
    cases: EvalExportCaseInput[];
  } | null>(null);

  const updateSuite = useMutation("testSuites:updateTestSuite" as any);
  const updateSuiteModels = useMutation("testSuites:updateSuiteModels" as any);

  // Use custom hooks for data calculations
  const { runTrendData, modelStats } = useSuiteData(
    suite,
    cases,
    iterations,
    allIterations,
    runs,
    aggregate,
  );

  const { caseGroupsForSelectedRun, selectedRunChartData } = useRunDetailData(
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

  // Derive selectedIterationId from route
  const selectedIterationId =
    route.type === "run-detail" ? (route.iteration ?? null) : null;

  // Auto-select the first iteration when on run-detail with iterations but no ?iteration= param.
  useEffect(() => {
    if (route.type !== "run-detail" || caseGroupsForSelectedRun.length === 0) {
      return;
    }

    if (route.insightsFocus && !route.iteration) {
      return;
    }

    const iterationIds = new Set(caseGroupsForSelectedRun.map((i) => i._id));

    if (!route.iteration || !iterationIds.has(route.iteration)) {
      navigation.toRunDetail(
        route.suiteId,
        route.runId,
        caseGroupsForSelectedRun[0]._id,
      );
    }
  }, [route, caseGroupsForSelectedRun, navigation]);

  const handleSelectIteration = (iterationId: string) => {
    if (route.type === "run-detail") {
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
            String(suite.defaultPassCriteria.minimumPassRate),
          );
        } catch (error) {
          console.warn(
            "Failed to sync default pass criteria to localStorage",
            error,
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
          getBillingErrorMessage(error, "Failed to update suite description"),
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
    [suite.description],
  );

  const handleUpdateTests = async (models: any[]) => {
    try {
      await updateSuiteModels({
        suiteId: suite._id,
        models: models.map((m) => ({
          model: m.model,
          provider: m.provider,
        })),
      });
      toast.success("Models updated successfully");
    } catch (error) {
      toast.error(getBillingErrorMessage(error, "Failed to update models"));
      console.error("Failed to update models:", error);
      throw error;
    }
  };

  const handleRunClick = (runId: string) => {
    navigation.toRunDetail(suite._id, runId, undefined, {
      insightsFocus: true,
    });
  };

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

  const handleClearOpenCompareRoute = useCallback(() => {
    if (route.type !== "test-edit") {
      return;
    }
    navigation.toTestEdit(suite._id, route.testId, { replace: true });
  }, [navigation, route, suite._id]);

  const { hasToken } = useAiProviderKeys();
  const missingReplayProviderKeys = useMemo(() => {
    if (!cases || cases.length === 0) return [];
    const providers = new Set<string>();
    for (const tc of cases) {
      for (const m of tc.models ?? []) {
        if (!isMCPJamProvidedModel(m.model)) {
          providers.add(m.provider);
        }
      }
    }
    return [...providers].filter(
      (p) => !hasToken(p.toLowerCase() as keyof ProviderTokens),
    );
  }, [cases, hasToken]);

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
      return `run-detail-${selectedRunId}`;
    return "empty";
  }, [viewMode, selectedTestId, selectedRunId, runsViewMode]);

  const showSuiteHeader =
    !omitSuiteHeader || viewMode !== "run-detail" || isEditMode;

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Header */}
      {showSuiteHeader ? (
        <div className="shrink-0">
          <SuiteHeader
            suite={suite}
            viewMode={viewMode}
            selectedRunDetails={selectedRunDetails}
            isEditMode={isEditMode}
            onRerun={onRerun}
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
            casesSidebarHidden={casesSidebarHidden}
            onShowCasesSidebar={onShowCasesSidebar}
            onCreateTestCase={onCreateTestCase}
            onGenerateTestCases={onGenerateTestCases}
            canGenerateTestCases={canGenerateTestCases}
            isGeneratingTestCases={isGeneratingTestCases}
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
                className="h-full min-h-0 min-w-0 overflow-hidden"
              >
                <TestTemplateEditor
                  suiteId={suite._id}
                  selectedTestCaseId={selectedTestId}
                  connectedServerNames={connectedServerNames}
                  workspaceId={workspaceId}
                  availableModels={availableModels}
                  onExportDraft={handleOpenDraftExport}
                  openCompareFromRoute={
                    route.type === "test-edit" && Boolean(route.openCompare)
                  }
                  onClearOpenCompareRoute={handleClearOpenCompareRoute}
                  onBackToList={() =>
                    navigation.toSuiteOverview(suite._id, "test-cases")
                  }
                  onOpenLastRun={(iteration) => {
                    if (!iteration.suiteRunId) {
                      return;
                    }
                    navigation.toRunDetail(
                      suite._id,
                      iteration.suiteRunId,
                      iteration._id,
                    );
                  }}
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
                      serverNames={(suite.environment?.servers || []).filter(
                        (name) => connectedServerNames.has(name),
                      )}
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
              runsViewMode === "runs" ? (
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
                      suite={suite}
                      cases={cases}
                      allIterations={allIterations}
                      runsViewMode={runsViewMode}
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
                      onOpenLastRun={(testCaseId) =>
                        navigation.toTestEdit(suite._id, testCaseId, {
                          openCompare: true,
                        })
                      }
                      onDeleteTestCasesBatch={onDeleteTestCasesBatch}
                      onRunTestCase={onRunTestCase}
                      runningTestCaseId={runningTestCaseId}
                      blockTestCaseRuns={Boolean(
                        rerunningSuiteId || replayingRunId,
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
                className="min-h-0 flex-1 overflow-y-auto"
              >
                <RunDetailView
                  selectedRunDetails={selectedRunDetails}
                  caseGroupsForSelectedRun={caseGroupsForSelectedRun}
                  source={suite.source}
                  selectedRunChartData={selectedRunChartData}
                  runDetailSortBy={effectiveRunDetailSortBy}
                  onSortChange={effectiveRunDetailSortChange}
                  serverNames={(suite.environment?.servers || []).filter(
                    (name) => connectedServerNames.has(name),
                  )}
                  selectedIterationId={selectedIterationId}
                  onSelectIteration={handleSelectIteration}
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
                    Boolean(route.insightsFocus && !route.iteration)
                  }
                  onEditTestCase={onEditTestCase}
                  alwaysShowEditIterationRows={alwaysShowEditIterationRows}
                />
              </motion.div>
            ) : null}
          </AnimatePresence>
        </div>
      )}

      {isEditMode && (
        <div className="flex-1 min-h-0 overflow-auto">
          <div className="p-6 max-w-5xl mx-auto space-y-8">
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
                    String(rate),
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
                      getBillingErrorMessage(error, "Failed to update suite"),
                    );
                    console.error("Failed to update suite:", error);
                    setDefaultMinimumPassRate(
                      suite.defaultPassCriteria?.minimumPassRate ?? 100,
                    );
                  }
                }}
              />
            </div>

            {/* Models Section */}
            <SuiteTestsConfig
              suite={suite}
              testCases={cases}
              onUpdate={handleUpdateTests}
              availableModels={availableModels}
            />

            {canDeleteSuite ? (
              <div className="border-t border-border pt-8 space-y-3">
                <h2 className="text-base font-semibold text-destructive">
                  Danger zone
                </h2>
                <p className="text-xs text-muted-foreground">
                  Deleting removes this suite from the workspace. Run history
                  and cases cannot be recovered.
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
