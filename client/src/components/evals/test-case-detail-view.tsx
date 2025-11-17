import { useMemo, useState } from "react";
import { X, ChevronDown, ChevronRight, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { AccuracyChart } from "./accuracy-chart";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from "@/components/ui/chart";
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts";
import { computeIterationPassed } from "./pass-criteria";
import { getIterationBorderColor, formatRunId } from "./helpers";
import { IterationDetails } from "./iteration-details";
import type { EvalCase, EvalIteration, EvalSuiteRun } from "./types";

interface TestCaseDetailViewProps {
  testCase: EvalCase;
  iterations: EvalIteration[];
  runs: EvalSuiteRun[];
  onBack: () => void;
  onViewRun?: (runId: string) => void;
  serverNames?: string[];
}

export function TestCaseDetailView({
  testCase,
  iterations,
  runs,
  onBack,
  onViewRun,
  serverNames = [],
}: TestCaseDetailViewProps) {
  const [openIterationId, setOpenIterationId] = useState<string | null>(null);

  // Filter out iterations from inactive runs
  const activeIterations = useMemo(() => {
    const inactiveRunIds = new Set(
      runs.filter((run) => run.isActive === false).map((run) => run._id),
    );
    return iterations.filter(
      (iter) => !iter.suiteRunId || !inactiveRunIds.has(iter.suiteRunId),
    );
  }, [iterations, runs]);

  // Performance trend data
  const trendData = useMemo(() => {
    const iterationsByRun = new Map<string, EvalIteration[]>();
    activeIterations.forEach((iteration) => {
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
      // Skip inactive runs
      if (run.isActive === false) return;

      const runIters = iterationsByRun.get(run._id);
      if (runIters && runIters.length > 0) {
        const passed = runIters.filter((iter) =>
          computeIterationPassed(iter),
        ).length;
        const total = runIters.length;
        const passRate = total > 0 ? Math.round((passed / total) * 100) : 0;

        data.push({
          runId: run._id,
          runIdDisplay: run._id.slice(-6),
          passRate,
          label: new Date(run.completedAt ?? run.createdAt).toLocaleString(),
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
  }, [activeIterations, runs]);

  // Model breakdown
  const modelBreakdown = useMemo(() => {
    const modelMap = new Map<
      string,
      {
        provider: string;
        model: string;
        passed: number;
        failed: number;
        total: number;
      }
    >();

    activeIterations.forEach((iteration) => {
      const snapshot = iteration.testCaseSnapshot;
      if (!snapshot) return;

      const key = `${snapshot.provider}/${snapshot.model}`;

      if (!modelMap.has(key)) {
        modelMap.set(key, {
          provider: snapshot.provider,
          model: snapshot.model,
          passed: 0,
          failed: 0,
          total: 0,
        });
      }

      const stats = modelMap.get(key)!;
      stats.total += 1;

      if (computeIterationPassed(iteration)) {
        stats.passed += 1;
      } else {
        stats.failed += 1;
      }
    });

    return Array.from(modelMap.values())
      .map((stats) => ({
        model: `${stats.provider}/${stats.model}`,
        passRate:
          stats.total > 0 ? Math.round((stats.passed / stats.total) * 100) : 0,
        passed: stats.passed,
        failed: stats.failed,
      }))
      .sort((a, b) => b.passRate - a.passRate);
  }, [activeIterations]);

  const modelChartConfig = {
    passRate: {
      label: "Pass Rate",
      color: "var(--chart-1)",
    },
  };

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold">
            {testCase.title || "Untitled test case"}
          </h2>
          {testCase.query && (
            <p className="text-sm text-muted-foreground mt-0.5">
              {testCase.query}
            </p>
          )}
        </div>
        <Button variant="ghost" size="icon" onClick={onBack}>
          <X className="h-4 w-4" />
        </Button>
      </div>

      {/* Charts Side by Side */}
      <div className="grid gap-4 lg:grid-cols-2">
        {/* Performance Chart */}
        {trendData.length > 0 && (
          <div className="rounded-xl border bg-card text-card-foreground">
            <div className="px-4 pt-3 pb-2">
              <div className="text-xs font-medium text-muted-foreground">
                Performance across runs
              </div>
            </div>
            <div className="px-4 pb-4">
              <AccuracyChart
                data={trendData}
                height="h-32"
                showLabel={true}
                onClick={onViewRun}
              />
            </div>
          </div>
        )}

        {/* Model Breakdown */}
        {modelBreakdown.length > 0 && (
          <div className="rounded-xl border bg-card text-card-foreground">
            <div className="px-4 pt-3 pb-2">
              <div className="text-xs font-medium text-muted-foreground">
                Performance by model
              </div>
            </div>
            <div className="px-4 pb-4">
              <ChartContainer
                config={modelChartConfig}
                className="aspect-auto h-32 w-full"
              >
                <BarChart
                  data={modelBreakdown}
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
                      const parts = value.split("/");
                      if (parts.length === 2 && parts[1].length > 15) {
                        return `${parts[0]}/${parts[1].substring(0, 12)}...`;
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
            </div>
          </div>
        )}
      </div>

      {/* Iterations List */}
      <div className="space-y-2">
        <Label className="text-xs font-medium text-muted-foreground">
          Iterations
        </Label>
        {activeIterations.length === 0 ? (
          <div className="py-12 text-center text-sm text-muted-foreground">
            No iterations found for this test.
          </div>
        ) : (
          <div className="rounded-md border bg-card text-card-foreground divide-y overflow-hidden">
            {activeIterations.map((iteration) => {
              const snapshot = iteration.testCaseSnapshot;
              const startedAt = iteration.startedAt ?? iteration.createdAt;
              const completedAt = iteration.updatedAt ?? iteration.createdAt;
              const durationMs =
                startedAt && completedAt
                  ? Math.max(completedAt - startedAt, 0)
                  : null;
              const actualToolCalls = iteration.actualToolCalls || [];
              const isPending = iteration.result === "pending";
              const isOpen = openIterationId === iteration._id;

              const formatDuration = (ms: number) => {
                if (ms < 1000) return `${ms}ms`;
                const seconds = Math.round(ms / 1000);
                if (seconds < 60) return `${seconds}s`;
                const minutes = Math.floor(seconds / 60);
                const secs = seconds % 60;
                return secs ? `${minutes}m ${secs}s` : `${minutes}m`;
              };

              return (
                <div
                  key={iteration._id}
                  className={`relative ${isPending ? "opacity-60" : ""}`}
                >
                  <div
                    className={`absolute left-0 top-0 h-full w-1 ${getIterationBorderColor(iteration.result)}`}
                  />
                  <button
                    onClick={() =>
                      setOpenIterationId(isOpen ? null : iteration._id)
                    }
                    className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/60 cursor-pointer hover:bg-muted/50"
                  >
                    <div className="flex min-w-0 flex-1 items-center gap-3 pl-2">
                      <div className="text-muted-foreground shrink-0">
                        {isOpen ? (
                          <ChevronDown className="h-3.5 w-3.5" />
                        ) : (
                          <ChevronRight className="h-3.5 w-3.5" />
                        )}
                      </div>
                      <div className="flex min-w-0 flex-1 items-center gap-2">
                        <span className="text-xs font-medium capitalize">
                          {iteration.result}
                        </span>
                      </div>
                    </div>
                    <div className="flex items-center gap-4 text-xs text-muted-foreground shrink-0">
                      <div className="min-w-[120px] text-left truncate">
                        <span className="font-mono text-xs">
                          {snapshot
                            ? `${snapshot.provider}/${snapshot.model}`
                            : "—"}
                        </span>
                      </div>
                      <div className="min-w-[50px] text-center">
                        <span className="font-mono">
                          {isPending ? "—" : actualToolCalls.length}
                        </span>
                      </div>
                      <div className="min-w-[60px] text-center">
                        <span className="font-mono">
                          {isPending
                            ? "—"
                            : Number(
                                iteration.tokensUsed || 0,
                              ).toLocaleString()}
                        </span>
                      </div>
                      <div className="font-mono min-w-[40px] text-right">
                        {isPending
                          ? "—"
                          : durationMs !== null
                            ? formatDuration(durationMs)
                            : "—"}
                      </div>
                      {iteration.suiteRunId && onViewRun && !isPending && (
                        <div className="min-w-[100px]">
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-5 text-[11px] px-2"
                            onClick={(e) => {
                              e.stopPropagation();
                              onViewRun(iteration.suiteRunId!);
                            }}
                          >
                            Run {formatRunId(iteration.suiteRunId)}
                          </Button>
                        </div>
                      )}
                      {isPending && (
                        <div className="w-3.5 flex items-center justify-center">
                          <Loader2 className="h-3.5 w-3.5 animate-spin text-amber-600" />
                        </div>
                      )}
                    </div>
                  </button>
                  {isOpen && (
                    <div className="border-t bg-muted/20 px-4 pb-4 pt-3 pl-8">
                      <IterationDetails
                        iteration={iteration}
                        testCase={testCase}
                        serverNames={serverNames}
                      />
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
