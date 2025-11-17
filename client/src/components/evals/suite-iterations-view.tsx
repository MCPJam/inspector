import { useMemo, useState, useEffect } from "react";
import { useMutation } from "convex/react";
import { toast } from "sonner";
import { SuiteHeader } from "./suite-header";
import { RunOverview } from "./run-overview";
import { RunDetailView } from "./run-detail-view";
import { SuiteTestsConfig } from "./suite-tests-config";
import { TestTemplateEditor } from "./test-template-editor";
import { PassCriteriaSelector } from "./pass-criteria-selector";
import { useSuiteData, useRunDetailData } from "./use-suite-data";
import { formatRunId, formatTime } from "./helpers";
import type {
  EvalCase,
  EvalIteration,
  EvalSuite,
  EvalSuiteRun,
  SuiteAggregate,
} from "./types";

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
  selectedTestId,
  onTestIdChange,
  mode,
  onModeChange,
  viewResetKey,
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
  selectedTestId: string | null;
  onTestIdChange: (testId: string | null) => void;
  mode?: "runs" | "edit";
  onModeChange?: (mode: "runs" | "edit") => void;
  viewResetKey?: number;
}) {
  const activeTab = mode || "runs";
  const [viewMode, setViewMode] = useState<
    "overview" | "run-detail" | "test-detail"
  >("overview");
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
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

  // Iterations for selected test (across all runs)
  const iterationsForSelectedTest = useMemo(() => {
    if (!selectedTestId) return [];

    const templateGroup = templateGroups.find((tg) =>
      tg.testCaseIds.includes(selectedTestId),
    );

    if (templateGroup) {
      return templateGroup.iterations;
    }

    const group = caseGroups.find((g) => g.testCase?._id === selectedTestId);
    return group ? group.iterations : [];
  }, [selectedTestId, caseGroups, templateGroups]);

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
          iterations: [],
          summary: {
            runs: 0,
            passed: 0,
            failed: 0,
            cancelled: 0,
            pending: 0,
            tokens: 0,
            avgDuration: null,
          },
          templateInfo: {
            title: directTestCase.title,
            query: directTestCase.query,
            modelCount: 1,
          },
        };
      }
      return null;
    }

    if (templateGroup.testCaseIds.length === 0) {
      const configTest = suite.config?.tests?.find((test: any) => {
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
            evalTestSuiteId: suite._id,
            createdBy: suite.createdBy || "",
            title: templateGroup.title,
            query: templateGroup.query,
            provider: configTest.provider || "",
            model: configTest.model || "",
            expectedToolCalls: configTest.expectedToolCalls || [],
          },
          iterations: [],
          summary: {
            runs: 0,
            passed: 0,
            failed: 0,
            cancelled: 0,
            pending: 0,
            tokens: 0,
            avgDuration: null,
          },
          templateInfo: {
            title: templateGroup.title,
            query: templateGroup.query,
            modelCount: 0,
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
        iterations: templateGroup.iterations,
        summary: templateGroup.summary,
        templateInfo: {
          title: templateGroup.title,
          query: templateGroup.query,
          modelCount: templateGroup.testCaseIds.length,
        },
      };
    }

    return {
      testCase: {
        ...group.testCase,
        model: "",
        provider: "",
      },
      iterations: templateGroup.iterations,
      summary: templateGroup.summary,
      templateInfo: {
        title: templateGroup.title,
        query: templateGroup.query,
        modelCount: templateGroup.testCaseIds.length,
      },
    };
  }, [selectedTestId, caseGroups, templateGroups, cases, suite]);

  // Trend data for selected test
  const selectedTestTrendData = useMemo(() => {
    if (!selectedTestId || iterationsForSelectedTest.length === 0) return [];

    const iterationsByRun = new Map<string, EvalIteration[]>();
    iterationsForSelectedTest.forEach((iteration) => {
      if (iteration.suiteRunId) {
        if (!iterationsByRun.has(iteration.suiteRunId)) {
          iterationsByRun.set(iteration.suiteRunId, []);
        }
        iterationsByRun.get(iteration.suiteRunId)!.push(iteration);
      }
    });

    const data: Array<{
      runId: string;
      runIdDisplay: string;
      passRate: number;
      label: string;
    }> = [];
    runs.forEach((run) => {
      const runIters = iterationsByRun.get(run._id);
      if (runIters && runIters.length > 0) {
        const passed = runIters.filter(
          (iter) => iter.result === "passed",
        ).length;
        const total = runIters.length;
        const passRate = total > 0 ? Math.round((passed / total) * 100) : 0;

        data.push({
          runId: run._id,
          runIdDisplay: formatRunId(run._id),
          passRate,
          label: formatTime(run.completedAt ?? run.createdAt),
        });
      }
    });

    return data.sort((a, b) => {
      const runA = runs.find((r) => r._id === a.runId);
      const runB = runs.find((r) => r._id === b.runId);
      const timeA = runA?.createdAt ?? 0;
      const timeB = runB?.createdAt ?? 0;
      return timeA - timeB;
    });
  }, [selectedTestId, iterationsForSelectedTest, runs]);

  // Per-model breakdown for selected test
  const selectedTestModelBreakdown = useMemo(() => {
    if (!selectedTestId || !selectedTestDetails?.templateInfo) return [];

    const templateGroup = templateGroups.find((tg) =>
      tg.testCaseIds.includes(selectedTestId),
    );

    if (!templateGroup) return [];

    const modelMap = new Map<
      string,
      {
        provider: string;
        model: string;
        passed: number;
        failed: number;
        cancelled: number;
        pending: number;
        total: number;
        passRate: number;
      }
    >();

    const testCaseMap = new Map<string, { provider: string; model: string }>();
    caseGroups.forEach((group) => {
      if (
        group.testCase &&
        templateGroup.testCaseIds.includes(group.testCase._id)
      ) {
        testCaseMap.set(group.testCase._id, {
          provider: group.testCase.provider,
          model: group.testCase.model,
        });
      }
    });

    templateGroup.iterations.forEach((iteration) => {
      const testCaseInfo = iteration.testCaseId
        ? testCaseMap.get(iteration.testCaseId)
        : null;
      if (!testCaseInfo) return;

      const key = `${testCaseInfo.provider}/${testCaseInfo.model}`;

      if (!modelMap.has(key)) {
        modelMap.set(key, {
          provider: testCaseInfo.provider,
          model: testCaseInfo.model,
          passed: 0,
          failed: 0,
          cancelled: 0,
          pending: 0,
          total: 0,
          passRate: 0,
        });
      }

      const stats = modelMap.get(key)!;
      stats.total += 1;

      if (iteration.result === "passed") stats.passed += 1;
      else if (iteration.result === "failed") stats.failed += 1;
      else if (iteration.result === "cancelled") stats.cancelled += 1;
      else stats.pending += 1;
    });

    return Array.from(modelMap.values())
      .map((stats) => ({
        ...stats,
        passRate:
          stats.total > 0 ? Math.round((stats.passed / stats.total) * 100) : 0,
      }))
      .sort((a, b) => b.passRate - a.passRate);
  }, [selectedTestId, selectedTestDetails, templateGroups, caseGroups]);

  // Reset viewMode when viewResetKey changes or when switching contexts
  useEffect(() => {
    if (activeTab === "runs" && selectedTestId === null) {
      if (selectedRunId === null) {
        setViewMode("overview");
        setShowRunSummarySidebar(false);
      }
    }
  }, [activeTab, suite._id, selectedTestId, viewResetKey, selectedRunId]);

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

  // Update view mode when selectedTestId changes
  useEffect(() => {
    if (selectedTestId) {
      setViewMode("test-detail");
      if (onModeChange && activeTab !== "runs") {
        onModeChange("runs");
      }
    } else {
      setViewMode((current) =>
        current === "test-detail" ? "overview" : current,
      );
    }
  }, [selectedTestId, activeTab, onModeChange]);

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
    setSelectedRunId(runId);
    setViewMode("run-detail");
  };

  const handleBackToOverview = () => {
    setViewMode("overview");
    setSelectedRunId(null);
    setShowRunSummarySidebar(false);
  };

  return (
    <div className="space-y-4">
      {/* Header */}
      <SuiteHeader
        suite={suite}
        viewMode={viewMode}
        selectedRunDetails={selectedRunDetails}
        isEditMode={activeTab === "edit"}
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

      {/* Content */}
      {activeTab === "runs" && (
        <div className="space-y-4">
          {viewMode === "test-detail" &&
          selectedTestDetails &&
          selectedTestId ? (
            <div className="h-[calc(100vh-200px)]">
              <TestTemplateEditor
                suiteId={suite._id}
                selectedTestCaseId={selectedTestId}
                selectedTestTrendData={selectedTestTrendData}
                iterationsForSelectedTest={iterationsForSelectedTest}
                selectedTestDetails={selectedTestDetails}
                runs={runs}
                caseGroups={caseGroups}
                onViewRun={(runId: string) => {
                  setSelectedRunId(runId);
                  onTestIdChange(null);
                  setViewMode("run-detail");
                  if (onModeChange) onModeChange("runs");
                }}
                onTestIdChange={onTestIdChange}
                onModeChange={onModeChange}
                selectedTestModelBreakdown={selectedTestModelBreakdown}
              />
            </div>
          ) : viewMode === "overview" ? (
            <RunOverview
              runs={runs}
              runsLoading={runsLoading}
              allIterations={allIterations}
              runTrendData={runTrendData}
              modelStats={modelStats}
              onRunClick={handleRunClick}
              onDirectDeleteRun={onDirectDeleteRun}
            />
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

      {activeTab === "edit" && (
        <div className="space-y-4">
          {/* Default Pass/Fail Criteria for New Runs */}
          <div className="space-y-3">
            <div>
              <h3 className="text-base font-semibold">
                Default Pass/Fail Criteria
              </h3>
              <p className="text-sm text-muted-foreground mt-1">
                Set the default criteria for <strong>new</strong> evaluation
                runs of this suite. These settings will be pre-selected when you
                click "Rerun". Existing runs keep their original criteria.
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
      )}
    </div>
  );
}
