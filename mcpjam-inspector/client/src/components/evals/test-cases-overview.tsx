import { useMemo } from "react";
import { computeIterationResult } from "./pass-criteria";
import type { EvalCase, EvalIteration } from "./types";

interface TestCasesOverviewProps {
  suite: { _id: string; name: string; source?: "ui" | "sdk" };
  cases: EvalCase[];
  allIterations: EvalIteration[];
  runsViewMode: "runs" | "test-cases";
  onViewModeChange: (value: "runs" | "test-cases") => void;
  onTestCaseClick: (testCaseId: string) => void;
  runTrendData: Array<{
    runId: string;
    runIdDisplay: string;
    passRate: number;
    label: string;
  }>;
  modelStats: Array<{
    model: string;
    passRate: number;
    passed: number;
    failed: number;
    total: number;
  }>;
  runsLoading: boolean;
  onRunClick?: (runId: string) => void;
}

export function TestCasesOverview({
  suite,
  cases,
  allIterations,
  runsViewMode,
  onViewModeChange,
  onTestCaseClick,
  runTrendData,
  modelStats,
  runsLoading,
  onRunClick,
}: TestCasesOverviewProps) {
  // Calculate stats for each test case
  const testCaseStats = useMemo(() => {
    return cases.map((testCase) => {
      const caseIterations = allIterations.filter(
        (iter) => iter.testCaseId === testCase._id,
      );

      // Only count completed iterations - exclude pending/cancelled
      const iterationResults = caseIterations.map((iter) =>
        computeIterationResult(iter),
      );
      const passed = iterationResults.filter((r) => r === "passed").length;
      const total = iterationResults.filter(
        (r) => r === "passed" || r === "failed",
      ).length;
      const avgAccuracy = total > 0 ? Math.round((passed / total) * 100) : 0;

      // Calculate average duration
      const completedIterations = caseIterations.filter(
        (iter) => iter.startedAt && iter.updatedAt && iter.result !== "pending",
      );
      const totalDuration = completedIterations.reduce((sum, iter) => {
        const duration = (iter.updatedAt ?? 0) - (iter.startedAt ?? 0);
        return sum + duration;
      }, 0);
      const avgDuration =
        completedIterations.length > 0
          ? totalDuration / completedIterations.length
          : 0;

      return {
        testCase,
        iterations: total,
        avgAccuracy,
        avgDuration,
      };
    });
  }, [cases, allIterations]);

  const formatDuration = (durationMs: number) => {
    if (durationMs < 1000) {
      return `${durationMs}ms`;
    }

    const totalSeconds = Math.round(durationMs / 1000);
    if (totalSeconds < 60) {
      return `${totalSeconds}s`;
    }

    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return seconds ? `${minutes}m ${seconds}s` : `${minutes}m`;
  };

  return (
    <>
      {/* Cases List */}
      <div className="rounded-xl border bg-card text-card-foreground flex flex-col max-h-[600px]">
        <div className="border-b px-4 py-2 shrink-0 flex items-center justify-between">
          <div>
            <p className="text-xs text-muted-foreground">
              Click on a case to view its run history and performance.
            </p>
          </div>
          <select
            value={runsViewMode}
            onChange={(e) =>
              onViewModeChange(e.target.value as "runs" | "test-cases")
            }
            className="text-xs border rounded px-2 py-1 bg-background"
          >
            <option value="runs">Runs</option>
            <option value="test-cases">Cases</option>
          </select>
        </div>

        {/* Column Headers */}
        {testCaseStats.length > 0 && (
          <div className="flex items-center gap-6 w-full px-4 py-1.5 bg-muted/30 border-b text-xs font-medium text-muted-foreground">
            <div className="flex-1 min-w-[200px]">Case Name</div>
            <div className="min-w-[100px] text-right">Iterations</div>
            <div className="min-w-[100px] text-right">
              {suite.source === "sdk" ? "Avg Pass Rate" : "Avg Accuracy"}
            </div>
            <div className="min-w-[100px] text-right">Avg Duration</div>
          </div>
        )}

        <div className="divide-y overflow-y-auto">
          {testCaseStats.length === 0 ? (
            <div className="px-4 py-12 text-center text-sm text-muted-foreground">
              No cases found.
            </div>
          ) : (
            testCaseStats.map(
              ({ testCase, iterations, avgAccuracy, avgDuration }) => (
                <button
                  key={testCase._id}
                  onClick={() => onTestCaseClick(testCase._id)}
                  className="flex items-center gap-6 w-full px-4 py-2.5 text-left transition-colors hover:bg-muted/50 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
                >
                  <span className="text-xs font-medium flex-1 min-w-[200px] truncate">
                    {testCase.title || "Untitled test case"}
                  </span>
                  <span className="min-w-[100px] text-right text-xs font-mono text-muted-foreground">
                    {iterations}
                  </span>
                  <span className="min-w-[100px] text-right text-xs font-mono text-muted-foreground">
                    {iterations > 0 ? `${avgAccuracy}%` : "—"}
                  </span>
                  <span className="min-w-[100px] text-right text-xs font-mono text-muted-foreground">
                    {iterations > 0 ? formatDuration(avgDuration) : "—"}
                  </span>
                </button>
              ),
            )
          )}
        </div>
      </div>
    </>
  );
}
