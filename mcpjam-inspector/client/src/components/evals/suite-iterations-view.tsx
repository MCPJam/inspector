import { useMemo, useState, useEffect, useCallback } from "react";
import { useMutation } from "convex/react";
import { toast } from "sonner";
import { SuiteHeader } from "./suite-header";
import { SuiteHeroStats } from "./suite-hero-stats";
import { RunOverview } from "./run-overview";
import { RunDetailView } from "./run-detail-view";
import { SuiteTestsConfig } from "./suite-tests-config";
import { TestTemplateEditor } from "./test-template-editor";
import { PassCriteriaSelector } from "./pass-criteria-selector";
import { TestCasesOverview } from "./test-cases-overview";
import { TestCaseDetailView } from "./test-case-detail-view";
import { useSuiteData, useRunDetailData } from "./use-suite-data";
import type {
  EvalCase,
  EvalIteration,
  EvalSuite,
  EvalSuiteRun,
  SuiteAggregate,
} from "./types";
import type { EvalsRoute } from "@/lib/evals-router";
import { navigateToEvalsRoute } from "@/lib/evals-router";
import type { CiEvalsRoute } from "@/lib/ci-evals-router";
import { getBillingErrorMessage } from "@/lib/billing-entitlements";
import { Button } from "@/components/ui/button";
import { Loader2, Trash2 } from "lucide-react";

type SuiteRoute = EvalsRoute | CiEvalsRoute;

export interface SuiteNavigation {
  toSuiteOverview: (suiteId: string, view?: "runs" | "test-cases") => void;
  toRunDetail: (suiteId: string, runId: string, iteration?: string) => void;
  toTestDetail: (suiteId: string, testId: string, iteration?: string) => void;
  toTestEdit: (suiteId: string, testId: string) => void;
  toSuiteEdit: (suiteId: string) => void;
}

const defaultNavigation: SuiteNavigation = {
  toSuiteOverview: (suiteId, view) =>
    navigateToEvalsRoute({ type: "suite-overview", suiteId, view }),
  toRunDetail: (suiteId, runId, iteration) =>
    navigateToEvalsRoute({ type: "run-detail", suiteId, runId, iteration }),
  toTestDetail: (suiteId, testId, iteration) =>
    navigateToEvalsRoute({ type: "test-detail", suiteId, testId, iteration }),
  toTestEdit: (suiteId, testId) =>
    navigateToEvalsRoute({ type: "test-edit", suiteId, testId }),
  toSuiteEdit: (suiteId) =>
    navigateToEvalsRoute({ type: "suite-edit", suiteId }),
};

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
  onDeleteRun,
  onDirectDeleteRun,
  connectedServerNames,
  rerunningSuiteId,
  replayingRunId,
  cancellingRunId,
  deletingSuiteId,
  deletingRunId,
  availableModels,
  route,
  userMap,
  workspaceId = null,
  navigation = defaultNavigation,
  onSetupCi,
  caseListInSidebar = false,
  runDetailSortByOverride,
  onRunDetailSortByChange,
  omitRunIterationList = false,
  canDeleteRuns = true,
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
  route: SuiteRoute;
  userMap?: Map<string, { name: string; imageUrl?: string }>;
  workspaceId?: string | null;
  navigation?: SuiteNavigation;
  onSetupCi?: () => void;
  /** When true, the case list lives in a parent sidebar; omit the duplicate cases table on suite overview. */
  caseListInSidebar?: boolean;
  /** When set with onRunDetailSortByChange, controls iteration sort (e.g. CI Runs parent sidebar). */
  runDetailSortByOverride?: "model" | "test" | "result";
  onRunDetailSortByChange?: (sort: "model" | "test" | "result") => void;
  /** When true, hide the iteration list in run detail (shown in a parent sidebar instead). */
  omitRunIterationList?: boolean;
  /** Workspace admins only: run list batch delete and selection. */
  canDeleteRuns?: boolean;
}) {
  // Derive view state from route
  const isEditMode = route.type === "suite-edit";
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
        : route.type === "test-edit"
          ? "test-edit"
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
    navigation.toRunDetail(suite._id, runId);
  };

  const handleBackToOverview = () => {
    navigation.toSuiteOverview(suite._id);
  };

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

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Header */}
      <div className="shrink-0">
        <SuiteHeader
          suite={suite}
          viewMode={viewMode}
          selectedRunDetails={selectedRunDetails}
          isEditMode={isEditMode}
          onRerun={onRerun}
          onReplayRun={onReplayRun}
          onDelete={onDelete}
          onCancelRun={onCancelRun}
          onDeleteRun={onDeleteRun}
          onViewModeChange={handleBackToOverview}
          connectedServerNames={connectedServerNames}
          rerunningSuiteId={rerunningSuiteId}
          replayingRunId={replayingRunId}
          cancellingRunId={cancellingRunId}
          deletingSuiteId={deletingSuiteId}
          deletingRunId={deletingRunId}
          runsViewMode={runsViewMode}
          runs={runs}
          allIterations={allIterations}
          aggregate={aggregate}
          testCases={cases}
          availableModels={availableModels}
          onUpdateModels={handleUpdateTests}
          onEditSuite={() => navigation.toSuiteEdit(suite._id)}
          onSetupCi={onSetupCi}
        />
      </div>

      {/* Content */}
      {!isEditMode && (
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
          {viewMode === "test-edit" && selectedTestId ? (
            <div className="h-full min-h-0 overflow-y-auto">
              <TestTemplateEditor
                suiteId={suite._id}
                selectedTestCaseId={selectedTestId}
                connectedServerNames={connectedServerNames}
                workspaceId={workspaceId}
              />
            </div>
          ) : viewMode === "test-detail" && selectedTestId ? (
            (() => {
              const selectedCase = cases.find((c) => c._id === selectedTestId);
              if (!selectedCase) return null;

              const caseIterations = allIterations.filter(
                (iter) => iter.testCaseId === selectedTestId,
              );

              return (
                <div className="min-h-0 flex-1 overflow-y-auto">
                  <TestCaseDetailView
                    testCase={selectedCase}
                    iterations={caseIterations}
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
                      navigation.toRunDetail(suite._id, runId)
                    }
                  />
                </div>
              );
            })()
          ) : viewMode === "overview" ? (
            runsViewMode === "runs" ? (
              <div
                key={runsViewMode}
                className="flex min-h-0 flex-1 flex-col overflow-hidden p-0.5"
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
                  canDeleteRuns={canDeleteRuns}
                />
              </div>
            ) : (
              <div
                key={runsViewMode}
                className="min-h-0 flex-1 space-y-4 overflow-y-auto p-0.5"
              >
                {caseListInSidebar ? (
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
                      navigation.toTestDetail(suite._id, testCaseId)
                    }
                    runTrendData={runTrendData}
                    modelStats={modelStats}
                    runsLoading={runsLoading}
                    onRunClick={handleRunClick}
                  />
                )}
              </div>
            )
          ) : viewMode === "run-detail" && selectedRunDetails ? (
            <div className="min-h-0 flex-1 overflow-y-auto">
              <RunDetailView
                selectedRunDetails={selectedRunDetails}
                caseGroupsForSelectedRun={caseGroupsForSelectedRun}
                source={suite.source}
                selectedRunChartData={selectedRunChartData}
                runDetailSortBy={effectiveRunDetailSortBy}
                onSortChange={effectiveRunDetailSortChange}
                serverNames={(suite.environment?.servers || []).filter((name) =>
                  connectedServerNames.has(name),
                )}
                selectedIterationId={selectedIterationId}
                onSelectIteration={handleSelectIteration}
                hideReplayLineage
                omitIterationList={omitRunIterationList}
              />
            </div>
          ) : null}
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

            <div className="border-t border-border pt-8 space-y-3">
              <h2 className="text-base font-semibold text-destructive">
                Danger zone
              </h2>
              <p className="text-xs text-muted-foreground">
                Deleting removes this suite from the workspace. Run history and
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
          </div>
        </div>
      )}
    </div>
  );
}
