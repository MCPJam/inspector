import { useMemo, useState, useEffect } from "react";
import { useMutation } from "convex/react";
import { toast } from "sonner";
import { SuiteHeader } from "./suite-header";
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

export function SuiteIterationsView({
  suite,
  cases,
  iterations,
  allIterations,
  runs,
  runsLoading,
  aggregate,
  onRerun,
  onCancelRun,
  onDelete,
  onDeleteRun,
  onDirectDeleteRun,
  connectedServerNames,
  rerunningSuiteId,
  cancellingRunId,
  deletingSuiteId,
  deletingRunId,
  availableModels,
  route,
}: {
  suite: EvalSuite;
  cases: EvalCase[];
  iterations: EvalIteration[];
  allIterations: EvalIteration[];
  runs: EvalSuiteRun[];
  runsLoading: boolean;
  aggregate: SuiteAggregate | null;
  onRerun: (suite: EvalSuite) => void;
  onCancelRun: (runId: string) => void;
  onDelete: (suite: EvalSuite) => void;
  onDeleteRun: (runId: string) => void;
  onDirectDeleteRun: (runId: string) => Promise<void>;
  connectedServerNames: Set<string>;
  rerunningSuiteId: string | null;
  cancellingRunId: string | null;
  deletingSuiteId: string | null;
  deletingRunId: string | null;
  availableModels: any[];
  route: EvalsRoute;
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
  const [showRunSummarySidebar, setShowRunSummarySidebar] = useState(false);
  const [runDetailSortBy, setRunDetailSortBy] = useState<
    "model" | "test" | "result"
  >("model");
  const [defaultMinimumPassRate, setDefaultMinimumPassRate] = useState(100);

  const updateSuite = useMutation("testSuites:updateTestSuite" as any);
  const updateTestCaseMutation = useMutation(
    "testSuites:updateTestCase" as any,
  );

  // Use custom hooks for data calculations
  const { runTrendData, modelStats, caseGroups, templateGroups } = useSuiteData(
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

  // Selected run details
  const selectedRunDetails = useMemo(() => {
    if (!selectedRunId) return null;
    const run = runs.find((r) => r._id === selectedRunId);
    return run ?? null;
  }, [selectedRunId, runs]);

  // Selected test details
  const selectedTestDetails = useMemo(() => {
    if (!selectedTestId) return null;

    const isTemplateKey = selectedTestId.startsWith("template:");

    let templateGroup;
    if (isTemplateKey) {
      const keyParts = selectedTestId.replace("template:", "").split("-");
      templateGroup = templateGroups.find((tg) => {
        const tgKey = `${tg.title}-${tg.query}`;
        return (
          tgKey === keyParts.join("-") || selectedTestId === `template:${tgKey}`
        );
      });
    } else {
      templateGroup = templateGroups.find((tg) =>
        tg.testCaseIds.includes(selectedTestId),
      );
    }

    if (!templateGroup) {
      const directTestCase = cases.find((c) => c._id === selectedTestId);
      if (directTestCase) {
        return {
          testCase: directTestCase,
          templateInfo: {
            title: directTestCase.title,
            query: directTestCase.query,
            modelCount: directTestCase.models?.length || 1,
          },
        };
      }
      return null;
    }

    if (templateGroup.testCaseIds.length === 0) {
      // Try to get config from the latest run
      const latestRun = runs.length > 0 ? runs[0] : null;
      const configTest = latestRun?.configSnapshot?.tests?.find((test: any) => {
        const templateTitle = test.title.replace(/\s*\[.*?\]\s*$/, "").trim();
        return (
          templateTitle === templateGroup.title &&
          test.query === templateGroup.query
        );
      });

      if (configTest) {
        return {
          testCase: {
            _id: selectedTestId,
            testSuiteId: suite._id,
            createdBy: suite.createdBy || "",
            title: templateGroup.title,
            query: templateGroup.query,
            models: [
              {
                model: configTest.model || "",
                provider: configTest.provider || "",
              },
            ],
            runs: configTest.runs || 1,
            expectedToolCalls: configTest.expectedToolCalls || [],
          },
          templateInfo: {
            title: templateGroup.title,
            query: templateGroup.query,
            modelCount: 1,
          },
        };
      }
      return null;
    }

    const group = caseGroups.find(
      (g) => g.testCase && templateGroup.testCaseIds.includes(g.testCase._id),
    );

    if (!group || !group.testCase) {
      const firstTestCase = cases.find((c) =>
        templateGroup.testCaseIds.includes(c._id),
      );
      if (!firstTestCase) return null;

      return {
        testCase: firstTestCase,
        templateInfo: {
          title: templateGroup.title,
          query: templateGroup.query,
          modelCount: templateGroup.testCaseIds.length,
        },
      };
    }

    return {
      testCase: group.testCase,
      templateInfo: {
        title: templateGroup.title,
        query: templateGroup.query,
        modelCount: templateGroup.testCaseIds.length,
      },
    };
  }, [selectedTestId, caseGroups, templateGroups, cases, suite]);

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

  const handleUpdateTests = async (models: any[]) => {
    try {
      for (const testCase of cases) {
        await updateTestCaseMutation({
          testCaseId: testCase._id,
          models: models.map((m) => ({
            model: m.model,
            provider: m.provider,
          })),
        });
      }
      toast.success("Models updated successfully");
    } catch (error) {
      toast.error("Failed to update models");
      console.error("Failed to update models:", error);
      throw error;
    }
  };

  const handleRunClick = (runId: string) => {
    navigateToEvalsRoute({
      type: "run-detail",
      suiteId: suite._id,
      runId,
    });
  };

  const handleBackToOverview = () => {
    setShowRunSummarySidebar(false);
    navigateToEvalsRoute({
      type: "suite-overview",
      suiteId: suite._id,
    });
  };

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="shrink-0">
        <SuiteHeader
          suite={suite}
          viewMode={viewMode}
          selectedRunDetails={selectedRunDetails}
          isEditMode={isEditMode}
          onRerun={onRerun}
          onDelete={onDelete}
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
        />
      </div>

      {/* Content */}
      {!isEditMode && (
        <div className="flex-1 min-h-0">
          {viewMode === "test-edit" && selectedTestId ? (
            <div className="h-full">
              <TestTemplateEditor
                suiteId={suite._id}
                selectedTestCaseId={selectedTestId}
                connectedServerNames={connectedServerNames}
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
                <TestCaseDetailView
                  testCase={selectedCase}
                  iterations={caseIterations}
                  runs={runs}
                  onBack={() => {
                    navigateToEvalsRoute({
                      type: "suite-overview",
                      suiteId: suite._id,
                      view: "test-cases",
                    });
                  }}
                  onViewRun={(runId) => {
                    navigateToEvalsRoute({
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
                  runs={runs}
                  runsLoading={runsLoading}
                  allIterations={allIterations}
                  runTrendData={runTrendData}
                  modelStats={modelStats}
                  onRunClick={handleRunClick}
                  onDirectDeleteRun={onDirectDeleteRun}
                  runsViewMode={runsViewMode}
                  onViewModeChange={(value) => {
                    navigateToEvalsRoute({
                      type: "suite-overview",
                      suiteId: suite._id,
                      view: value,
                    });
                  }}
                />
              ) : (
                <TestCasesOverview
                  cases={cases}
                  allIterations={allIterations}
                  runs={runs}
                  onTestCaseClick={(testCaseId) => {
                    navigateToEvalsRoute({
                      type: "test-detail",
                      suiteId: suite._id,
                      testId: testCaseId,
                    });
                  }}
                  runsViewMode={runsViewMode}
                  onViewModeChange={(value) => {
                    navigateToEvalsRoute({
                      type: "suite-overview",
                      suiteId: suite._id,
                      view: value,
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
              selectedRunChartData={selectedRunChartData}
              runDetailSortBy={runDetailSortBy}
              onSortChange={setRunDetailSortBy}
              showRunSummarySidebar={showRunSummarySidebar}
              setShowRunSummarySidebar={setShowRunSummarySidebar}
            />
          ) : null}
        </div>
      )}

      {isEditMode && (
        <div className="flex-1 min-h-0 overflow-auto">
          <div className="p-3 space-y-3">
            {/* Default Pass/Fail Criteria for New Runs */}
            <div className="space-y-2">
              <div>
                <h3 className="text-sm font-semibold">
                  Default Pass/Fail Criteria
                </h3>
                <p className="text-xs text-muted-foreground mt-0.5">
                  Set the default criteria for <strong>new</strong> evaluation
                  runs of this suite. These settings will be pre-selected when
                  you click "Rerun". Existing runs keep their original criteria.
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
                    toast.error("Failed to update suite");
                    console.error("Failed to update suite:", error);
                    setDefaultMinimumPassRate(
                      suite.defaultPassCriteria?.minimumPassRate ?? 100,
                    );
                  }
                }}
              />
            </div>

            {/* Tests Config */}
            <SuiteTestsConfig
              suite={suite}
              testCases={cases}
              onUpdate={handleUpdateTests}
              availableModels={availableModels}
            />
          </div>
        </div>
      )}
    </div>
  );
}
