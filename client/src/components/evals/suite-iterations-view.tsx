import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { ChevronDown, ChevronRight, Loader2, RotateCw } from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Skeleton } from "@/components/ui/skeleton";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from "@/components/ui/chart";
import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from "recharts";
import { IterationDetails } from "./iteration-details";
import { SuiteTestsConfig } from "./suite-tests-config";
import { formatTime } from "./helpers";
import {
  EvalCase,
  EvalIteration,
  EvalSuite,
  EvalSuiteRun,
  SuiteAggregate,
  EvalSuiteConfigTest,
} from "./types";
import { RUN_FILTER_ALL, RUN_FILTER_LEGACY, type RunFilterValue } from "./constants";
import { useMutation } from "convex/react";
import { toast } from "sonner";

export function SuiteIterationsView({
  suite,
  cases,
  iterations,
  allIterations,
  legacyIterations,
  runs,
  runFilter,
  onRunFilterChange,
  selectedRun,
  runsLoading,
  aggregate,
  onBack,
  onRerun,
  connectedServerNames,
  rerunningSuiteId,
}: {
  suite: EvalSuite;
  cases: EvalCase[];
  iterations: EvalIteration[];
  allIterations: EvalIteration[];
  legacyIterations: EvalIteration[];
  runs: EvalSuiteRun[];
  runFilter: RunFilterValue;
  onRunFilterChange: (value: RunFilterValue) => void;
  selectedRun: EvalSuiteRun | null;
  runsLoading: boolean;
  aggregate: SuiteAggregate | null;
  onBack: () => void;
  onRerun: (suite: EvalSuite) => void;
  connectedServerNames: Set<string>;
  rerunningSuiteId: string | null;
}) {
  const [openIterationId, setOpenIterationId] = useState<string | null>(null);
  const [expandedQueries, setExpandedQueries] = useState<Set<string>>(
    new Set(),
  );
  const [activeTab, setActiveTab] = useState<"results" | "tests">("results");

  const updateSuite = useMutation("evals:updateSuite" as any);

  const handleUpdateTests = async (tests: EvalSuiteConfigTest[]) => {
    try {
      await updateSuite({
        suiteId: suite._id,
        config: {
          tests,
          environment: suite.config?.environment || { servers: [] },
        },
      });
      toast.success("Tests updated successfully");
    } catch (error) {
      toast.error("Failed to update tests");
      console.error("Failed to update tests:", error);
    }
  };


  const handleRunFilterChange = (value: string) => {
    onRunFilterChange(value as RunFilterValue);
  };

  const runOptions = useMemo(
    () => {
      const options: Array<{ value: RunFilterValue; label: string }> = [];
      const totalIterations = allIterations.length;

      options.push({
        value: RUN_FILTER_ALL,
        label:
          runs.length > 0
            ? `All runs (${runs.length})`
            : `All iterations (${totalIterations})`,
      });

      if (legacyIterations.length > 0) {
        options.push({
          value: RUN_FILTER_LEGACY,
          label: `Legacy iterations (${legacyIterations.length})`,
        });
      }

      runs.forEach((run, index) => {
        const runIndex = runs.length - index;
        const timestamp = run.completedAt ?? run.createdAt;
        const passRate =
          run.summary != null
            ? Math.round(run.summary.passRate * 100)
            : null;
        const labelParts = [
          `Run ${runIndex}`,
          passRate != null ? `${passRate}%` : "In progress",
          formatTime(timestamp),
        ];
        options.push({
          value: run._id,
          label: labelParts.filter(Boolean).join(' • '),
        });
      });

      return options;
    },
    [allIterations.length, legacyIterations.length, runs],
  );

  const summary = useMemo(() => {
    const totals = aggregate?.totals;
    if (selectedRun?.summary) {
      const runTotals = selectedRun.summary;
      const passRate = Math.round(runTotals.passRate * 100);
      return {
        passRate,
        passed: runTotals.passed,
        failed: runTotals.failed,
        total: runTotals.total,
        cancelled: totals?.cancelled ?? 0,
        pending: totals?.pending ?? 0,
      };
    }

    if (!totals) {
      return {
        passRate: 0,
        passed: 0,
        failed: 0,
        total: 0,
        cancelled: 0,
        pending: 0,
      };
    }

    const total =
      totals.passed + totals.failed + totals.cancelled + totals.pending;

    const passRate =
      total > 0 ? Math.round((totals.passed / total) * 100) : 0;

    return {
      passRate,
      passed: totals.passed,
      failed: totals.failed,
      total,
      cancelled: totals.cancelled,
      pending: totals.pending,
    };
  }, [aggregate, selectedRun]);

  const { passRate, passed, failed, total, cancelled, pending } = summary;

  const runTrendData = useMemo(() => {
    const data = runs
      .slice()
      .reverse()
      .map((run, index) => {
        if (!run.summary) {
          return null;
        }
        return {
          runIndex: index + 1,
          passRate: Math.round(run.summary.passRate * 100),
          label: formatTime(run.completedAt ?? run.createdAt),
        };
      })
      .filter(
        (item): item is { runIndex: number; passRate: number; label: string } =>
          item !== null,
      );
    console.log('[Evals] Run trend data:', data);
    return data;
  }, [runs]);

  const chartConfig = {
    passRate: {
      label: "Pass rate",
      color: "var(--chart-1)",
    },
  };

  const runStatusLabel = selectedRun
    ? selectedRun.status.charAt(0).toUpperCase() + selectedRun.status.slice(1)
    : runFilter === RUN_FILTER_LEGACY
      ? "Legacy iterations"
      : runFilter === RUN_FILTER_ALL
        ? runs.length > 0
          ? "All runs"
          : "All iterations"
        : "All runs";

  const runTimestampLabel = selectedRun
    ? formatTime(selectedRun.completedAt ?? selectedRun.createdAt)
    : runFilter === RUN_FILTER_LEGACY
      ? `${legacyIterations.length} iteration${
          legacyIterations.length === 1 ? "" : "s"
        }`
      : `${allIterations.length} iteration${
          allIterations.length === 1 ? "" : "s"
        }`;
  const caseGroups = useMemo(() => {
    const groups = new Map<
      string,
      {
        testCase: EvalCase | null;
        iterations: EvalIteration[];
        summary: {
          runs: number;
          passed: number;
          failed: number;
          cancelled: number;
          pending: number;
          tokens: number;
          avgDuration: number | null;
        };
      }
    >();

    const computeSummary = (items: EvalIteration[]) => {
      const summary = {
        runs: items.length,
        passed: 0,
        failed: 0,
        cancelled: 0,
        pending: 0,
        tokens: 0,
        avgDuration: null as number | null,
      };

      let totalDuration = 0;
      let durationCount = 0;

      items.forEach((iteration) => {
        if (iteration.result === "passed") summary.passed += 1;
        else if (iteration.result === "failed") summary.failed += 1;
        else if (iteration.result === "cancelled") summary.cancelled += 1;
        else summary.pending += 1;

        summary.tokens += iteration.tokensUsed || 0;

        const startedAt = iteration.startedAt ?? iteration.createdAt;
        const completedAt = iteration.updatedAt ?? iteration.createdAt;
        if (startedAt && completedAt) {
          const duration = Math.max(completedAt - startedAt, 0);
          totalDuration += duration;
          durationCount += 1;
        }
      });

      if (durationCount > 0) {
        summary.avgDuration = totalDuration / durationCount;
      }

      return summary;
    };

    cases.forEach((testCase) => {
      groups.set(testCase._id, {
        testCase,
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
      });
    });

    const unassigned: {
      testCase: EvalCase | null;
      iterations: EvalIteration[];
      summary: {
        runs: number;
        passed: number;
        failed: number;
        cancelled: number;
        pending: number;
        tokens: number;
        avgDuration: number | null;
      };
    } = {
      testCase: null,
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
    };

    iterations.forEach((iteration) => {
      const targetGroup = iteration.testCaseId
        ? groups.get(iteration.testCaseId)
        : undefined;

      if (targetGroup) {
        targetGroup.iterations.push(iteration);
      } else {
        unassigned.iterations.push(iteration);
      }
    });

    const orderedGroups = cases.map((testCase) => {
      const group = groups.get(testCase._id)!;
      const sortedIterations = [...group.iterations].sort((a, b) => {
        if (a.iterationNumber != null && b.iterationNumber != null) {
          return a.iterationNumber - b.iterationNumber;
        }
        return (a.createdAt ?? 0) - (b.createdAt ?? 0);
      });
      return {
        ...group,
        iterations: sortedIterations,
        summary: computeSummary(sortedIterations),
      };
    });

    if (unassigned.iterations.length > 0) {
      const sortedUnassigned = [...unassigned.iterations].sort((a, b) => {
        if (a.iterationNumber != null && b.iterationNumber != null) {
          return a.iterationNumber - b.iterationNumber;
        }
        return (a.createdAt ?? 0) - (b.createdAt ?? 0);
      });
      orderedGroups.push({
        ...unassigned,
        iterations: sortedUnassigned,
        summary: computeSummary(sortedUnassigned),
      });
    }

    return orderedGroups;
  }, [cases, iterations]);

  const getIterationBorderColor = (result: string) => {
    if (result === "passed") return "bg-emerald-500/50";
    if (result === "failed") return "bg-red-500/50";
    if (result === "cancelled") return "bg-zinc-300/50";
    return "bg-amber-500/50"; // pending
  };

  // Check if all servers are connected
  const suiteServers = suite.config?.environment?.servers || [];
  const missingServers = suiteServers.filter(
    (server) => !connectedServerNames.has(server),
  );
  const canRerun = missingServers.length === 0;
  const isRerunning = rerunningSuiteId === suite._id;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <Button variant="ghost" size="sm" onClick={onBack}>
          ← Back to suites
        </Button>
        <Tooltip>
          <TooltipTrigger asChild>
            <span>
              <Button
                variant="outline"
                size="sm"
                onClick={() => onRerun(suite)}
                disabled={!canRerun || isRerunning}
                className="gap-2"
              >
                <RotateCw
                  className={`h-4 w-4 ${isRerunning ? "animate-spin" : ""}`}
                />
                Rerun
              </Button>
            </span>
          </TooltipTrigger>
          <TooltipContent>
            {!canRerun
              ? `Connect the following servers: ${missingServers.join(", ")}`
              : "Rerun evaluation"}
          </TooltipContent>
        </Tooltip>
      </div>

      <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as "results" | "tests")}>
        <TabsList>
          <TabsTrigger value="results">Results</TabsTrigger>
          <TabsTrigger value="tests">Tests</TabsTrigger>
        </TabsList>

        <TabsContent value="results" className="mt-4">
      <div className="rounded-xl border bg-card text-card-foreground">
        <div className="flex flex-col gap-3 border-b px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <div className="text-sm font-semibold">Run history</div>
            <p className="text-xs text-muted-foreground">
              Compare performance across runs and inspect regressions.
            </p>
          </div>
          <Select value={runFilter} onValueChange={handleRunFilterChange}>
            <SelectTrigger className="w-full sm:w-64">
              <SelectValue placeholder="Select run" />
            </SelectTrigger>
            <SelectContent>
              {runOptions.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="grid gap-4 px-4 py-4 lg:grid-cols-[1.5fr_2fr]">
          <div className="grid gap-3 rounded-lg border bg-background/80 p-4">
            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <span>{runTimestampLabel}</span>
              <span className="font-medium text-foreground">{runStatusLabel}</span>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <RunMetric label="Pass rate" value={`${passRate}%`} />
              <RunMetric label="Passed" value={passed.toLocaleString()} />
              <RunMetric label="Failed" value={failed.toLocaleString()} />
              <RunMetric label="Cancelled" value={cancelled.toLocaleString()} />
              <RunMetric label="Pending" value={pending.toLocaleString()} />
              <RunMetric label="Total" value={total.toLocaleString()} />
            </div>
          </div>
          <div className="rounded-lg border bg-background/80 p-4">
            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <span>Pass rate trend</span>
              <span>
                {runs.length} run{runs.length === 1 ? "" : "s"}
              </span>
            </div>
            {runsLoading ? (
              <Skeleton className="mt-4 h-28 w-full" />
            ) : runTrendData.length > 0 ? (
              <ChartContainer config={chartConfig} className="mt-4 aspect-auto h-32 w-full">
                <AreaChart data={runTrendData} width={undefined} height={undefined}>
                  <CartesianGrid
                    strokeDasharray="3 3"
                    vertical={false}
                    stroke="hsl(var(--muted-foreground) / 0.2)"
                  />
                  <XAxis dataKey="runIndex" hide />
                  <YAxis domain={[0, 100]} hide />
                  <ChartTooltip cursor={false} content={<ChartTooltipContent />} />
                  <Area
                    type="monotone"
                    dataKey="passRate"
                    stroke="var(--color-passRate)"
                    fill="var(--color-passRate)"
                    fillOpacity={0.15}
                    strokeWidth={2}
                    isAnimationActive={false}
                  />
                </AreaChart>
              </ChartContainer>
            ) : (
              <p className="mt-4 text-xs text-muted-foreground">
                No completed runs yet.
              </p>
            )}
          </div>
        </div>
      </div>
      <div className="space-y-4">
        {caseGroups.map((group, index) => {
          const { testCase, iterations: groupIterations } = group;
          const hasIterations = groupIterations.length > 0;
          const caseId = testCase?._id ?? `unassigned-${index}`;
          const isQueryExpanded = expandedQueries.has(caseId);
          const queryMaxLength = 100;
          const shouldTruncate =
            testCase?.query && testCase.query.length > queryMaxLength;
          const displayQuery =
            shouldTruncate && !isQueryExpanded
              ? testCase.query.slice(0, queryMaxLength) + "..."
              : testCase?.query;

          const toggleQuery = () => {
            setExpandedQueries((prev) => {
              const newSet = new Set(prev);
              if (newSet.has(caseId)) {
                newSet.delete(caseId);
              } else {
                newSet.add(caseId);
              }
              return newSet;
            });
          };

          return (
            <div key={caseId} className="overflow-hidden rounded-xl border">
              <div className="border-b bg-muted/50 px-4 py-2.5">
                <div className="space-y-2">
                  <div className="flex items-center gap-2">
                    <h3 className="text-sm font-semibold pr-2">
                      {testCase ? testCase.title : "Unassigned iterations"}
                    </h3>
                    {testCase?.provider ? (
                      <>
                        <span className="text-xs text-muted-foreground">
                          {testCase.provider}
                        </span>
                      </>
                    ) : null}
                    {testCase?.model ? (
                      <>
                        <span className="text-muted-foreground">•</span>
                        <span className="text-xs text-muted-foreground">
                          {testCase.model}
                        </span>
                      </>
                    ) : null}
                  </div>
                  {testCase?.query ? (
                    <div className="flex items-start gap-2">
                      <p className="text-xs text-muted-foreground italic flex-1">
                        "{displayQuery}"
                      </p>
                      {shouldTruncate ? (
                        <button
                          onClick={toggleQuery}
                          className="text-xs text-primary hover:underline focus:outline-none whitespace-nowrap"
                        >
                          {isQueryExpanded ? "Show less" : "Show more"}
                        </button>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              </div>

              {hasIterations ? (
                <div className="divide-y">
                  {groupIterations.map((iteration) => {
                    const isOpen = openIterationId === iteration._id;
                    const startedAt =
                      iteration.startedAt ?? iteration.createdAt;
                    const completedAt =
                      iteration.updatedAt ?? iteration.createdAt;
                    const durationMs =
                      startedAt && completedAt
                        ? Math.max(completedAt - startedAt, 0)
                        : null;
                    const isPending = iteration.result === "pending";

                    return (
                      <div
                        key={iteration._id}
                        className={`relative ${isPending ? "opacity-60" : ""}`}
                      >
                        <div
                          className={`absolute left-0 top-0 h-full w-1 ${getIterationBorderColor(iteration.result)}`}
                        />
                        <button
                          onClick={() => {
                            if (!isPending) {
                              setOpenIterationId((current) =>
                                current === iteration._id
                                  ? null
                                  : iteration._id,
                              );
                            }
                          }}
                          disabled={isPending}
                          className={`flex w-full items-center gap-4 px-4 py-3 text-left transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/60 ${
                            isPending
                              ? "cursor-not-allowed"
                              : "cursor-pointer hover:bg-muted/50"
                          }`}
                        >
                          <div className="grid min-w-0 flex-1 grid-cols-[auto_1fr_auto_auto] items-center gap-4 pl-3">
                            <div className="text-muted-foreground">
                              {isPending ? (
                                <ChevronRight className="h-4 w-4" />
                              ) : isOpen ? (
                                <ChevronDown className="h-4 w-4" />
                              ) : (
                                <ChevronRight className="h-4 w-4" />
                              )}
                            </div>
                            <div className="flex items-center gap-2">
                              <span className="text-sm font-medium">
                                Iteration #{iteration.iterationNumber}
                              </span>
                              {isPending ? (
                                <Loader2 className="h-4 w-4 animate-spin text-amber-600" />
                              ) : null}
                            </div>
                            <div className="text-sm text-muted-foreground">
                              {isPending
                                ? "—"
                                : `${Number(iteration.tokensUsed || 0).toLocaleString()} tokens`}
                            </div>
                            <div className="text-sm text-muted-foreground">
                              {isPending
                                ? "—"
                                : durationMs !== null
                                  ? formatDuration(durationMs)
                                  : "—"}
                            </div>
                          </div>
                        </button>
                        {isOpen && !isPending ? (
                          <div className="border-t bg-muted/20 px-4 pb-4 pt-3 pl-8">
                            <IterationDetails
                              iteration={iteration}
                              testCase={testCase}
                            />
                          </div>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              ) : (
                <div className="px-4 py-6 text-center text-sm text-muted-foreground">
                  No iterations recorded for this test case yet.
                </div>
              )}
            </div>
          );
        })}
      </div>
        </TabsContent>

        <TabsContent value="tests" className="mt-4">
          <SuiteTestsConfig suite={suite} onUpdate={handleUpdateTests} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function RunMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border bg-background px-3 py-2">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="text-base font-semibold">{value}</div>
    </div>
  );
}

function formatDuration(durationMs: number) {
  if (durationMs < 1000) {
    return `${durationMs}ms`;
  }

  const totalSeconds = Math.round(durationMs / 1000);
  if (totalSeconds < 60) {
    return `${totalSeconds}s`;
  }

  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) {
    return seconds ? `${minutes}m ${seconds}s` : `${minutes}m`;
  }

  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes ? `${hours}h ${remainingMinutes}m` : `${hours}h`;
}
