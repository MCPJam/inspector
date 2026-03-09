import { useEffect, useMemo, useState } from "react";
import { SuiteHeader } from "./suite-header";
import { RunOverview } from "./run-overview";
import { RunDetailView } from "./run-detail-view";
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
import type { CiEvalsRoute } from "@/lib/ci-evals-router";
import { navigateToCiEvalsRoute } from "@/lib/ci-evals-router";

interface CiSuiteDetailProps {
  suite: EvalSuite;
  cases: EvalCase[];
  iterations: EvalIteration[];
  allIterations: EvalIteration[];
  runs: EvalSuiteRun[];
  runsLoading: boolean;
  aggregate: SuiteAggregate | null;
  onRerun: (suite: EvalSuite) => void;
  onCancelRun: (runId: string) => void;
  onDeleteSuite: (suite: EvalSuite) => void;
  onDeleteRun: (runId: string) => void;
  onDirectDeleteRun: (runId: string) => Promise<void>;
  connectedServerNames: Set<string>;
  rerunningSuiteId: string | null;
  cancellingRunId: string | null;
  deletingSuiteId: string | null;
  deletingRunId: string | null;
  route: CiEvalsRoute;
  userMap?: Map<string, { name: string; imageUrl?: string }>;
}

export function CiSuiteDetail({
  suite,
  cases,
  iterations,
  allIterations,
  runs,
  runsLoading,
  aggregate,
  onRerun,
  onCancelRun,
  onDeleteSuite,
  onDeleteRun,
  onDirectDeleteRun,
  connectedServerNames,
  rerunningSuiteId,
  cancellingRunId,
  deletingSuiteId,
  deletingRunId,
  route,
  userMap,
}: CiSuiteDetailProps) {
  const selectedTestId = route.type === "test-detail" ? route.testId : null;
  const selectedRunId = route.type === "run-detail" ? route.runId : null;
  const viewMode =
    route.type === "run-detail"
      ? "run-detail"
      : route.type === "test-detail"
        ? "test-detail"
        : "overview";
  const runsViewMode =
    route.type === "suite-overview" && route.view === "test-cases"
      ? "test-cases"
      : "runs";

  const [showRunSummarySidebar, setShowRunSummarySidebar] = useState(false);
  const [runDetailSortBy, setRunDetailSortBy] = useState<
    "model" | "test" | "result"
  >("test");

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
    runDetailSortBy,
  );

  const selectedRunDetails = useMemo(() => {
    if (!selectedRunId) return null;
    return runs.find((run) => run._id === selectedRunId) ?? null;
  }, [selectedRunId, runs]);

  // Derive selectedIterationId from route
  const selectedIterationId =
    route.type === "run-detail" ? (route.iteration ?? null) : null;

  // Auto-select the first iteration when on run-detail with iterations but no ?iteration= param.
  // Also handle stale iteration IDs that don't match any available iteration.
  useEffect(() => {
    if (route.type !== "run-detail" || caseGroupsForSelectedRun.length === 0) {
      return;
    }

    const iterationIds = new Set(caseGroupsForSelectedRun.map((i) => i._id));

    if (!route.iteration) {
      // No iteration selected — auto-select the first one
      navigateToCiEvalsRoute(
        {
          type: "run-detail",
          suiteId: route.suiteId,
          runId: route.runId,
          iteration: caseGroupsForSelectedRun[0]._id,
        },
        { replace: true },
      );
    } else if (!iterationIds.has(route.iteration)) {
      // Stale iteration — fall back to first available
      navigateToCiEvalsRoute(
        {
          type: "run-detail",
          suiteId: route.suiteId,
          runId: route.runId,
          iteration: caseGroupsForSelectedRun[0]._id,
        },
        { replace: true },
      );
    }
  }, [route, caseGroupsForSelectedRun]);

  const handleSelectIteration = (iterationId: string) => {
    if (route.type === "run-detail") {
      navigateToCiEvalsRoute({
        type: "run-detail",
        suiteId: route.suiteId,
        runId: route.runId,
        iteration: iterationId,
      });
    }
  };

  const handleRunClick = (runId: string) => {
    navigateToCiEvalsRoute({
      type: "run-detail",
      suiteId: suite._id,
      runId,
    });
  };

  const handleBackToOverview = () => {
    setShowRunSummarySidebar(false);
    navigateToCiEvalsRoute({
      type: "suite-overview",
      suiteId: suite._id,
      view: runsViewMode,
    });
  };

  const connectedSuiteServers = (suite.environment?.servers || []).filter(
    (name) => connectedServerNames.has(name),
  );

  return (
    <div className="flex h-full flex-col">
      <div className="shrink-0">
        <SuiteHeader
          suite={suite}
          viewMode={viewMode}
          selectedRunDetails={selectedRunDetails}
          isEditMode={false}
          onRerun={onRerun}
          onDelete={onDeleteSuite}
          onCancelRun={onCancelRun}
          onDeleteRun={onDeleteRun}
          onViewModeChange={handleBackToOverview}
          connectedServerNames={connectedServerNames}
          rerunningSuiteId={rerunningSuiteId}
          cancellingRunId={cancellingRunId}
          deletingSuiteId={deletingSuiteId}
          deletingRunId={deletingRunId}
          showRunSummarySidebar={showRunSummarySidebar}
          setShowRunSummarySidebar={setShowRunSummarySidebar}
          runsViewMode={runsViewMode}
          runs={runs}
          allIterations={allIterations}
          aggregate={aggregate}
          testCases={cases}
          availableModels={[]}
          readOnlyConfig={true}
        />
      </div>

      <div className="flex-1 min-h-0 overflow-hidden">
        {viewMode === "test-detail" && selectedTestId ? (
          (() => {
            const selectedCase = cases.find(
              (item) => item._id === selectedTestId,
            );
            if (!selectedCase) return null;

            const caseIterations = allIterations.filter(
              (iter) => iter.testCaseId === selectedTestId,
            );

            return (
              <TestCaseDetailView
                testCase={selectedCase}
                iterations={caseIterations}
                runs={runs}
                serverNames={connectedSuiteServers}
                onBack={() => {
                  navigateToCiEvalsRoute({
                    type: "suite-overview",
                    suiteId: suite._id,
                    view: "test-cases",
                  });
                }}
                onViewRun={(runId) => {
                  navigateToCiEvalsRoute({
                    type: "run-detail",
                    suiteId: suite._id,
                    runId,
                  });
                }}
              />
            );
          })()
        ) : viewMode === "overview" ? (
          <div key={runsViewMode} className="space-y-4">
            {runsViewMode === "runs" ? (
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
                onViewModeChange={(value) => {
                  navigateToCiEvalsRoute({
                    type: "suite-overview",
                    suiteId: suite._id,
                    view: value,
                  });
                }}
                userMap={userMap}
              />
            ) : (
              <TestCasesOverview
                suite={suite}
                cases={cases}
                allIterations={allIterations}
                runs={runs}
                runsViewMode={runsViewMode}
                onViewModeChange={(value) => {
                  navigateToCiEvalsRoute({
                    type: "suite-overview",
                    suiteId: suite._id,
                    view: value,
                  });
                }}
                onTestCaseClick={(testCaseId) => {
                  navigateToCiEvalsRoute({
                    type: "test-detail",
                    suiteId: suite._id,
                    testId: testCaseId,
                  });
                }}
                runTrendData={runTrendData}
                modelStats={modelStats}
                runsLoading={runsLoading}
                onRunClick={handleRunClick}
              />
            )}
          </div>
        ) : viewMode === "run-detail" && selectedRunDetails ? (
          <RunDetailView
            selectedRunDetails={selectedRunDetails}
            caseGroupsForSelectedRun={caseGroupsForSelectedRun}
            source={suite.source}
            selectedRunChartData={selectedRunChartData}
            runDetailSortBy={runDetailSortBy}
            onSortChange={setRunDetailSortBy}
            showRunSummarySidebar={showRunSummarySidebar}
            setShowRunSummarySidebar={setShowRunSummarySidebar}
            serverNames={connectedSuiteServers}
            selectedIterationId={selectedIterationId}
            onSelectIteration={handleSelectIteration}
          />
        ) : null}
      </div>
    </div>
  );
}
