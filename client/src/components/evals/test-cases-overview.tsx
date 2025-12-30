import { useMemo } from "react";
import { computeIterationResult } from "./pass-criteria";
import type { EvalCase, EvalIteration, EvalSuiteRun } from "./types";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from "@/components/ui/chart";
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts";
import { AccuracyChart } from "./accuracy-chart";

interface TestCasesOverviewProps {
  suite: { _id: string; name: string };
  cases: EvalCase[];
  allIterations: EvalIteration[];
  runs: EvalSuiteRun[];
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
  runs,
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
    // Create a set of inactive run IDs for fast lookup
    const inactiveRunIds = new Set(
      runs.filter((run) => run.isActive === false).map((run) => run._id),
    );

    return cases.map((testCase) => {
      // Filter out iterations from inactive runs
      const caseIterations = allIterations.filter(
        (iter) =>
          iter.testCaseId === testCase._id &&
          (!iter.suiteRunId || !inactiveRunIds.has(iter.suiteRunId)),
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
  }, [cases, allIterations, runs]);

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

  const modelChartConfig = {
    passRate: {
      label: "Pass Rate",
      color: "var(--chart-1)",
    },
  };

  return (
    <>
      {/* Charts Side by Side */}
      <div className="grid gap-4 lg:grid-cols-2">
        {/* Accuracy */}
        <div className="rounded-xl border bg-card text-card-foreground">
          <div className="px-4 pt-3 pb-2">
            <div className="text-xs font-medium text-muted-foreground">
              Accuracy
            </div>
          </div>
          <div className="px-4 pb-4">
            <AccuracyChart
              data={runTrendData}
              isLoading={runsLoading}
              height="h-32"
              onClick={onRunClick}
            />
          </div>
        </div>

        {/* Per-Model Performance */}
        <div className="rounded-xl border bg-card text-card-foreground">
          <div className="px-4 pt-3 pb-2">
            <div className="text-xs font-medium text-muted-foreground">
              Performance by model
            </div>
          </div>
          <div className="px-4 pb-4">
            {modelStats.length > 0 ? (
              <ChartContainer
                config={modelChartConfig}
                className="aspect-auto h-32 w-full"
              >
                <BarChart
                  data={modelStats}
                  width={undefined}
                  height={undefined}
                >
                  <CartesianGrid
                    strokeDasharray="3 3"
                    vertical={false}
                    stroke="hsl(var(--muted-foreground) / 0.2)"
                  />
                  <XAxis
                    dataKey="model"
                    tickLine={false}
                    axisLine={false}
                    tickMargin={8}
                    tick={{ fontSize: 11 }}
                    interval={0}
                    height={40}
                    tickFormatter={(value) => {
                      if (value.length > 15) {
                        return value.substring(0, 12) + "...";
                      }
                      return value;
                    }}
                  />
                  <YAxis
                    domain={[0, 100]}
                    tickLine={false}
                    axisLine={false}
                    tickMargin={8}
                    tick={{ fontSize: 12 }}
                    tickFormatter={(value) => `${value}%`}
                  />
                  <ChartTooltip
                    cursor={false}
                    content={({ active, payload }) => {
                      if (!active || !payload || payload.length === 0)
                        return null;
                      const data = payload[0].payload;
                      return (
                        <div className="rounded-lg border bg-background p-2 shadow-sm">
                          <div className="grid gap-2">
                            <div className="flex flex-col">
                              <span className="text-xs font-semibold">
                                {data.model}
                              </span>
                              <span className="text-xs text-muted-foreground mt-0.5">
                                {data.passed} passed · {data.failed} failed
                              </span>
                            </div>
                            <div className="flex items-center gap-2">
                              <div
                                className="h-2 w-2 rounded-full"
                                style={{
                                  backgroundColor: "var(--color-passRate)",
                                }}
                              />
                              <span className="text-sm font-semibold">
                                {data.passRate}%
                              </span>
                            </div>
                          </div>
                        </div>
                      );
                    }}
                  />
                  <Bar
                    dataKey="passRate"
                    fill="var(--color-passRate)"
                    radius={[4, 4, 0, 0]}
                    isAnimationActive={false}
                    minPointSize={8}
                  />
                </BarChart>
              </ChartContainer>
            ) : (
              <p className="text-xs text-muted-foreground">
                No model data available.
              </p>
            )}
          </div>
        </div>
      </div>

      {/* Test Cases List */}
      <div className="rounded-xl border bg-card text-card-foreground flex flex-col max-h-[600px]">
        <div className="border-b px-4 py-2 shrink-0 flex items-center justify-between">
          <div>
            <p className="text-xs text-muted-foreground">
              Click on a test case to view its run history and performance.
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
            <option value="test-cases">Test Cases</option>
          </select>
        </div>

        {/* Column Headers */}
        {testCaseStats.length > 0 && (
          <div className="flex items-center gap-6 w-full px-4 py-1.5 bg-muted/30 border-b text-xs font-medium text-muted-foreground">
            <div className="flex-1 min-w-[200px]">Test Case Name</div>
            <div className="min-w-[100px] text-right">Iterations</div>
            <div className="min-w-[100px] text-right">Avg Accuracy</div>
            <div className="min-w-[100px] text-right">Avg Duration</div>
          </div>
        )}

        <div className="divide-y overflow-y-auto">
          {testCaseStats.length === 0 ? (
            <div className="px-4 py-12 text-center text-sm text-muted-foreground">
              No test cases found.
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
