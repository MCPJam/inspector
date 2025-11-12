import { useMemo, useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ChevronDown, ChevronRight, Loader2, RotateCw, Trash2 } from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Skeleton } from "@/components/ui/skeleton";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from "@/components/ui/chart";
import { Area, AreaChart, Bar, BarChart, CartesianGrid, Pie, PieChart, XAxis, YAxis, Cell, Label } from "recharts";
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
import { useMutation } from "convex/react";
import { toast } from "sonner";

export function SuiteIterationsView({
  suite,
  cases,
  iterations,
  allIterations,
  runs,
  runsLoading,
  aggregate,
  onBack,
  onRerun,
  onDelete,
  connectedServerNames,
  rerunningSuiteId,
  deletingSuiteId,
}: {
  suite: EvalSuite;
  cases: EvalCase[];
  iterations: EvalIteration[];
  allIterations: EvalIteration[];
  runs: EvalSuiteRun[];
  runsLoading: boolean;
  aggregate: SuiteAggregate | null;
  onBack: () => void;
  onRerun: (suite: EvalSuite) => void;
  onDelete: (suite: EvalSuite) => void;
  connectedServerNames: Set<string>;
  rerunningSuiteId: string | null;
  deletingSuiteId: string | null;
}) {
  const [openIterationId, setOpenIterationId] = useState<string | null>(null);
  const [expandedQueries, setExpandedQueries] = useState<Set<string>>(
    new Set(),
  );
  const [activeTab, setActiveTab] = useState<"results" | "tests">("results");
  const [viewMode, setViewMode] = useState<"overview" | "run-detail" | "test-detail">("overview");
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [selectedTestId, setSelectedTestId] = useState<string | null>(null);

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



  // General overview summary (all iterations)
  const generalSummary = useMemo(() => {
    const totals = aggregate?.totals;
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
  }, [aggregate]);

  // Selected run summary
  const selectedRunDetails = useMemo(() => {
    if (!selectedRunId) return null;
    const run = runs.find((r) => r._id === selectedRunId);
    return run ?? null;
  }, [selectedRunId, runs]);

  const runTrendData = useMemo(() => {
    const data = runs
      .slice()
      .reverse()
      .map((run) => {
        if (!run.summary) {
          return null;
        }
        return {
          runIndex: run.runNumber,
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

    // Initialize groups for all test cases from database
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

    // Group iterations - use snapshot if available, otherwise use testCaseId
    iterations.forEach((iteration) => {
      // For iterations with snapshots, group by snapshot content
      if (iteration.testCaseSnapshot) {
        // Create a key based on the test content to group similar tests together
        const snapshotKey = `snapshot-${iteration.testCaseSnapshot.title}-${iteration.testCaseSnapshot.query}`;
        if (!groups.has(snapshotKey)) {
          // Create a virtual test case from the snapshot
          const virtualTestCase: EvalCase = {
            _id: snapshotKey,
            evalTestSuiteId: suite._id,
            createdBy: iteration.createdBy || "",
            title: iteration.testCaseSnapshot.title,
            query: iteration.testCaseSnapshot.query,
            provider: iteration.testCaseSnapshot.provider,
            model: iteration.testCaseSnapshot.model,
            expectedToolCalls: iteration.testCaseSnapshot.expectedToolCalls,
          };
          groups.set(snapshotKey, {
            testCase: virtualTestCase,
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
        }
        groups.get(snapshotKey)!.iterations.push(iteration);
      } else if (iteration.testCaseId) {
        // Fall back to testCaseId for legacy iterations
        const group = groups.get(iteration.testCaseId);
        if (group) {
          group.iterations.push(iteration);
        } else {
          unassigned.iterations.push(iteration);
        }
      } else {
        unassigned.iterations.push(iteration);
      }
    });

    // Build ordered groups
    const orderedGroups = Array.from(groups.values())
      .filter((group) => group.iterations.length > 0)
      .map((group) => {
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
  }, [cases, iterations, suite._id]);

  // Iterations for selected run (for runs section)
  const iterationsForSelectedRun = useMemo(() => {
    if (!selectedRunId) return [];
    return allIterations.filter((iteration) => iteration.suiteRunId === selectedRunId);
  }, [selectedRunId, allIterations]);

  // Case groups for selected run
  const caseGroupsForSelectedRun = useMemo(() => {
    if (!selectedRunId) return [];

    const groups = new Map<
      string,
      {
        testCase: EvalCase | null;
        iterations: EvalIteration[];
      }
    >();

    // Initialize groups for all test cases
    cases.forEach((testCase) => {
      groups.set(testCase._id, {
        testCase,
        iterations: [],
      });
    });

    // Group iterations for this run
    iterationsForSelectedRun.forEach((iteration) => {
      if (iteration.testCaseSnapshot) {
        const snapshotKey = `snapshot-${iteration.testCaseSnapshot.title}-${iteration.testCaseSnapshot.query}`;
        if (!groups.has(snapshotKey)) {
          const virtualTestCase: EvalCase = {
            _id: snapshotKey,
            evalTestSuiteId: suite._id,
            createdBy: iteration.createdBy || "",
            title: iteration.testCaseSnapshot.title,
            query: iteration.testCaseSnapshot.query,
            provider: iteration.testCaseSnapshot.provider,
            model: iteration.testCaseSnapshot.model,
            expectedToolCalls: iteration.testCaseSnapshot.expectedToolCalls,
          };
          groups.set(snapshotKey, {
            testCase: virtualTestCase,
            iterations: [],
          });
        }
        groups.get(snapshotKey)!.iterations.push(iteration);
      } else if (iteration.testCaseId) {
        const group = groups.get(iteration.testCaseId);
        if (group) {
          group.iterations.push(iteration);
        }
      }
    });

    return Array.from(groups.values())
      .filter((group) => group.iterations.length > 0)
      .map((group) => ({
        ...group,
        iterations: [...group.iterations].sort((a, b) => {
          if (a.iterationNumber != null && b.iterationNumber != null) {
            return a.iterationNumber - b.iterationNumber;
          }
          return (a.createdAt ?? 0) - (b.createdAt ?? 0);
        }),
      }));
  }, [selectedRunId, iterationsForSelectedRun, cases, suite._id]);

  // Data for run detail charts
  const selectedRunChartData = useMemo(() => {
    if (!selectedRunId || caseGroupsForSelectedRun.length === 0) {
      return { donutData: [], durationData: [] };
    }

    // Calculate overall pass/fail for donut chart
    let totalPassed = 0;
    let totalFailed = 0;
    let totalPending = 0;
    let totalCancelled = 0;

    // Calculate duration per test for bar chart
    const durationData = caseGroupsForSelectedRun.map((group, index) => {
      const iterations = group.iterations;
      const passed = iterations.filter((i) => i.result === "passed").length;
      const failed = iterations.filter((i) => i.result === "failed").length;
      const pending = iterations.filter((i) => i.result === "pending").length;
      const cancelled = iterations.filter((i) => i.result === "cancelled").length;

      totalPassed += passed;
      totalFailed += failed;
      totalPending += pending;
      totalCancelled += cancelled;

      // Calculate average duration for this test
      let totalDuration = 0;
      let durationCount = 0;
      iterations.forEach((iter) => {
        const startedAt = iter.startedAt ?? iter.createdAt;
        const completedAt = iter.updatedAt ?? iter.createdAt;
        if (startedAt && completedAt && iter.result !== "pending") {
          totalDuration += Math.max(completedAt - startedAt, 0);
          durationCount++;
        }
      });
      const avgDuration = durationCount > 0 ? totalDuration / durationCount : 0;

      return {
        name: group.testCase?.title || `Test ${index + 1}`,
        duration: avgDuration,
        durationSeconds: avgDuration / 1000,
      };
    });

    // Build donut data
    const donutData = [];
    if (totalPassed > 0) {
      donutData.push({ name: "Passed", value: totalPassed, fill: "hsl(142.1 76.2% 36.3%)" });
    }
    if (totalFailed > 0) {
      donutData.push({ name: "Failed", value: totalFailed, fill: "hsl(0 84.2% 60.2%)" });
    }
    if (totalPending > 0) {
      donutData.push({ name: "Pending", value: totalPending, fill: "hsl(45.4 93.4% 47.5%)" });
    }
    if (totalCancelled > 0) {
      donutData.push({ name: "Cancelled", value: totalCancelled, fill: "hsl(240 3.7% 15.9%)" });
    }

    return { donutData, durationData };
  }, [selectedRunId, caseGroupsForSelectedRun]);

  // Iterations for selected test (across all runs)
  const iterationsForSelectedTest = useMemo(() => {
    if (!selectedTestId) return [];
    const group = caseGroups.find((g) => g.testCase?._id === selectedTestId);
    return group ? group.iterations : [];
  }, [selectedTestId, caseGroups]);

  // Selected test details
  const selectedTestDetails = useMemo(() => {
    if (!selectedTestId) return null;
    const group = caseGroups.find((g) => g.testCase?._id === selectedTestId);
    return group ?? null;
  }, [selectedTestId, caseGroups]);

  // Trend data for selected test (showing how this test performed across runs)
  const selectedTestTrendData = useMemo(() => {
    if (!selectedTestId || iterationsForSelectedTest.length === 0) return [];

    // Group iterations by run
    const iterationsByRun = new Map<string, EvalIteration[]>();
    iterationsForSelectedTest.forEach((iteration) => {
      if (iteration.suiteRunId) {
        if (!iterationsByRun.has(iteration.suiteRunId)) {
          iterationsByRun.set(iteration.suiteRunId, []);
        }
        iterationsByRun.get(iteration.suiteRunId)!.push(iteration);
      }
    });

    // Calculate pass rate for each run
    const data: Array<{ runIndex: number; passRate: number; label: string }> = [];
    runs.forEach((run) => {
      const runIters = iterationsByRun.get(run._id);
      if (runIters && runIters.length > 0) {
        const passed = runIters.filter((iter) => iter.result === "passed").length;
        const total = runIters.length;
        const passRate = total > 0 ? Math.round((passed / total) * 100) : 0;

        data.push({
          runIndex: run.runNumber,
          passRate,
          label: formatTime(run.completedAt ?? run.createdAt),
        });
      }
    });

    return data.sort((a, b) => a.runIndex - b.runIndex);
  }, [selectedTestId, iterationsForSelectedTest, runs]);

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

  const isDeleting = deletingSuiteId === suite._id;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <Button variant="ghost" size="sm" onClick={onBack}>
          ← Back to suites
        </Button>
        <div className="flex items-center gap-2">
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
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="outline"
                size="sm"
                onClick={() => onDelete(suite)}
                disabled={isDeleting}
                className="gap-2"
              >
                <Trash2 className="h-4 w-4" />
                {isDeleting ? "Deleting..." : "Delete"}
              </Button>
            </TooltipTrigger>
            <TooltipContent>Delete this test suite</TooltipContent>
          </Tooltip>
        </div>
      </div>

      <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as "results" | "tests")}>
        <TabsList>
          <TabsTrigger value="results">Results</TabsTrigger>
          <TabsTrigger value="tests">Tests</TabsTrigger>
        </TabsList>

        <TabsContent value="results" className="mt-4 space-y-4">
      {(viewMode === "run-detail" || viewMode === "test-detail") && (
        <div className="mb-4">
          <Button variant="ghost" size="sm" onClick={() => {
            setViewMode("overview");
            setSelectedRunId(null);
            setSelectedTestId(null);
          }}>
            ← Back to overview
          </Button>
        </div>
      )}

      {viewMode === "overview" ? (
        <>
      {/* Section 1: General History */}
      <div className="rounded-xl border bg-card text-card-foreground">
        <div className="border-b px-4 py-3">
          <div className="text-sm font-semibold">General overview</div>
          <p className="text-xs text-muted-foreground">
            Overall performance across all runs and test cases.
          </p>
        </div>
        <div className="grid gap-4 px-4 py-4 lg:grid-cols-[1.5fr_2fr]">
          <div className="grid gap-3 rounded-lg border bg-background/80 p-4">
            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <span>{allIterations.length} iteration{allIterations.length === 1 ? "" : "s"}</span>
              <span className="font-medium text-foreground">All runs</span>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <RunMetric label="Pass rate" value={`${generalSummary.passRate}%`} />
              <RunMetric label="Passed" value={generalSummary.passed.toLocaleString()} />
              <RunMetric label="Failed" value={generalSummary.failed.toLocaleString()} />
              <RunMetric label="Cancelled" value={generalSummary.cancelled.toLocaleString()} />
              <RunMetric label="Pending" value={generalSummary.pending.toLocaleString()} />
              <RunMetric label="Total" value={generalSummary.total.toLocaleString()} />
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
                  <XAxis
                    dataKey="runIndex"
                    tickLine={false}
                    axisLine={false}
                    tickMargin={8}
                    tick={{ fontSize: 12 }}
                    label={{ value: "Run", position: "insideBottom", offset: -5, fontSize: 12 }}
                  />
                  <YAxis
                    domain={[0, 100]}
                    tickLine={false}
                    axisLine={false}
                    tickMargin={8}
                    tick={{ fontSize: 12 }}
                    tickFormatter={(value) => `${value}%`}
                  />
                  <ChartTooltip cursor={false} content={<ChartTooltipContent />} />
                  <Area
                    type="monotone"
                    dataKey="passRate"
                    stroke="var(--color-passRate)"
                    fill="var(--color-passRate)"
                    fillOpacity={0.15}
                    strokeWidth={2}
                    isAnimationActive={false}
                    dot={runTrendData.length > 1}
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

      {/* Sections 2 & 3: Runs and Test Cases Side by Side */}
      <div className="grid gap-4 lg:grid-cols-2">
        {/* Section 2: Runs */}
        <div className="rounded-xl border bg-card text-card-foreground">
          <div className="border-b px-4 py-3">
            <div className="text-sm font-semibold">Runs</div>
            <p className="text-xs text-muted-foreground">
              Click on a run to view its test breakdown and results.
            </p>
          </div>
          <div className="divide-y">
            {runs.length === 0 ? (
              <div className="px-4 py-12 text-center text-sm text-muted-foreground">
                No runs found.
              </div>
            ) : (
              runs.map((run) => {
                const passRate = run.summary
                  ? Math.round(run.summary.passRate * 100)
                  : null;
                const timestamp = formatTime(run.completedAt ?? run.createdAt);
                const duration = run.completedAt && run.createdAt
                  ? formatDuration(run.completedAt - run.createdAt)
                  : "—";
                const passed = run.summary?.passed ?? 0;
                const failed = run.summary?.failed ?? 0;

                return (
                  <button
                    key={run._id}
                    onClick={() => {
                      setSelectedRunId(run._id);
                      setViewMode("run-detail");
                    }}
                    className="flex w-full flex-col gap-2 px-4 py-3 text-left transition-colors hover:bg-muted/50 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
                  >
                    <div className="flex items-center justify-between">
                      <div className="flex flex-col gap-0.5">
                        <span className="text-sm font-medium">Run #{run.runNumber}</span>
                        <span className="text-xs text-muted-foreground">{timestamp}</span>
                      </div>
                      {passRate !== null && (
                        <span className="text-sm font-semibold tabular-nums">
                          {passRate}%
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-4 text-xs text-muted-foreground">
                      <div className="flex items-center gap-1">
                        <span className="font-medium">Duration:</span>
                        <span className="font-mono">{duration}</span>
                      </div>
                      <div className="flex items-center gap-1">
                        <span className="font-medium">Passed:</span>
                        <span className="font-mono text-emerald-600">{passed}</span>
                      </div>
                      <div className="flex items-center gap-1">
                        <span className="font-medium">Failed:</span>
                        <span className="font-mono text-red-600">{failed}</span>
                      </div>
                    </div>
                  </button>
                );
              })
            )}
          </div>
        </div>

        {/* Section 3: Test Cases */}
        <div className="rounded-xl border bg-card text-card-foreground">
          <div className="border-b px-4 py-3">
            <div className="text-sm font-semibold">Test cases</div>
            <p className="text-xs text-muted-foreground">
              Click on a test to view iterations across all runs.
            </p>
          </div>
          <div className="divide-y">
            {caseGroups.filter((g) => g.testCase !== null).length === 0 ? (
              <div className="px-4 py-12 text-center text-sm text-muted-foreground">
                No test cases found.
              </div>
            ) : (
              caseGroups
                .filter((g) => g.testCase !== null)
                .map((group) => {
                  const testCase = group.testCase!;
                  const passedCount = group.summary.passed;
                  const totalCount = group.summary.runs;
                  const passRate = totalCount > 0
                    ? Math.round((passedCount / totalCount) * 100)
                    : 0;

                  return (
                    <button
                      key={testCase._id}
                      onClick={() => {
                        setSelectedTestId(testCase._id);
                        setViewMode("test-detail");
                      }}
                      className="flex w-full items-center justify-between px-4 py-3 text-left transition-colors hover:bg-muted/50 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
                    >
                      <div className="flex items-center gap-3">
                        <div className="flex flex-col gap-1">
                          <span className="text-sm font-medium">{testCase.title}</span>
                          <span className="text-xs text-muted-foreground">
                            {testCase.provider} • {testCase.model}
                          </span>
                        </div>
                      </div>
                      <div className="flex items-center gap-4">
                        <span className="text-xs text-muted-foreground">
                          {totalCount} iteration{totalCount === 1 ? "" : "s"}
                        </span>
                        <span className="text-sm font-medium">
                          {passRate}%
                        </span>
                      </div>
                    </button>
                  );
                })
            )}
          </div>
        </div>
      </div>
        </>
      ) : viewMode === "run-detail" && selectedRunDetails ? (
        <>
          {/* Run Detail View */}
          <div className="rounded-xl border bg-card text-card-foreground">
            <div className="border-b px-4 py-3">
              <div className="text-sm font-semibold">Run #{selectedRunDetails.runNumber}</div>
              <p className="text-xs text-muted-foreground">
                {formatTime(selectedRunDetails.completedAt ?? selectedRunDetails.createdAt)}
              </p>
            </div>
            {(selectedRunChartData.donutData.length > 0 || selectedRunChartData.durationData.length > 0) && (
              <div className="border-b px-4 py-4">
                <div className="grid gap-4 lg:grid-cols-2">
                  {/* Pass/Fail Donut Chart */}
                  {selectedRunChartData.donutData.length > 0 && (
                    <div className="rounded-lg border bg-background/50 p-4">
                      <div className="text-xs font-medium text-muted-foreground mb-3">Test Results</div>
                      <ChartContainer
                        config={{
                          passed: { label: "Passed", color: "hsl(142.1 76.2% 36.3%)" },
                          failed: { label: "Failed", color: "hsl(0 84.2% 60.2%)" },
                          pending: { label: "Pending", color: "hsl(45.4 93.4% 47.5%)" },
                          cancelled: { label: "Cancelled", color: "hsl(240 3.7% 15.9%)" },
                        }}
                        className="aspect-square h-48 w-full"
                      >
                        <PieChart>
                          <ChartTooltip content={<ChartTooltipContent hideLabel />} />
                          <Pie
                            data={selectedRunChartData.donutData}
                            dataKey="value"
                            nameKey="name"
                            innerRadius={60}
                            strokeWidth={5}
                          >
                            <Label
                              content={({ viewBox }) => {
                                if (viewBox && "cx" in viewBox && "cy" in viewBox) {
                                  const total = selectedRunChartData.donutData.reduce((sum, item) => sum + item.value, 0);
                                  return (
                                    <text
                                      x={viewBox.cx}
                                      y={viewBox.cy}
                                      textAnchor="middle"
                                      dominantBaseline="middle"
                                    >
                                      <tspan
                                        x={viewBox.cx}
                                        y={viewBox.cy}
                                        className="fill-foreground text-2xl font-bold"
                                      >
                                        {total}
                                      </tspan>
                                      <tspan
                                        x={viewBox.cx}
                                        y={(viewBox.cy || 0) + 20}
                                        className="fill-muted-foreground text-xs"
                                      >
                                        Total
                                      </tspan>
                                    </text>
                                  );
                                }
                              }}
                            />
                          </Pie>
                        </PieChart>
                      </ChartContainer>
                    </div>
                  )}

                  {/* Duration per Test Bar Chart */}
                  {selectedRunChartData.durationData.length > 0 && (
                    <div className="rounded-lg border bg-background/50 p-4">
                      <div className="text-xs font-medium text-muted-foreground mb-3">Duration per Test</div>
                      <ChartContainer
                        config={{
                          duration: { label: "Duration", color: "hsl(var(--chart-1))" },
                        }}
                        className="aspect-auto h-64 w-full"
                      >
                        <BarChart
                          accessibilityLayer
                          data={selectedRunChartData.durationData}
                          margin={{ top: 5, right: 10, left: 10, bottom: 100 }}
                        >
                          <CartesianGrid strokeDasharray="3 3" vertical={false} />
                          <XAxis
                            dataKey="name"
                            tickLine={false}
                            axisLine={false}
                            tickMargin={10}
                            tick={{ fontSize: 10 }}
                            angle={-45}
                            textAnchor="end"
                            height={100}
                            interval={0}
                          />
                          <YAxis
                            tickLine={false}
                            axisLine={false}
                            tickMargin={8}
                            tick={{ fontSize: 11 }}
                            tickFormatter={(value) => `${value.toFixed(1)}s`}
                          />
                          <ChartTooltip
                            content={
                              <ChartTooltipContent
                                labelFormatter={(value) => value}
                                formatter={(value) => [`${(value as number).toFixed(2)}s`, "Duration"]}
                              />
                            }
                          />
                          <Bar
                            dataKey="durationSeconds"
                            fill="var(--color-duration)"
                            radius={[4, 4, 0, 0]}
                          />
                        </BarChart>
                      </ChartContainer>
                    </div>
                  )}
                </div>
              </div>
            )}
            <div className="px-4 py-4">
              <div className="grid gap-3 rounded-lg border bg-background/80 p-4">
                <div className="flex items-center justify-between text-xs text-muted-foreground">
                  <span>Run #{selectedRunDetails.runNumber}</span>
                  <span className="font-medium text-foreground capitalize">{selectedRunDetails.status}</span>
                </div>
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                  <RunMetric
                    label="Pass rate"
                    value={selectedRunDetails.summary ? `${Math.round(selectedRunDetails.summary.passRate * 100)}%` : "—"}
                  />
                  <RunMetric
                    label="Passed"
                    value={selectedRunDetails.summary?.passed.toLocaleString() ?? "—"}
                  />
                  <RunMetric
                    label="Failed"
                    value={selectedRunDetails.summary?.failed.toLocaleString() ?? "—"}
                  />
                  <RunMetric
                    label="Total"
                    value={selectedRunDetails.summary?.total.toLocaleString() ?? "—"}
                  />
                  <RunMetric
                    label="Duration"
                    value={
                      selectedRunDetails.completedAt && selectedRunDetails.createdAt
                        ? formatDuration(selectedRunDetails.completedAt - selectedRunDetails.createdAt)
                        : "—"
                    }
                  />
                </div>
              </div>
            </div>
          </div>

          {/* Test Cases for this Run */}
          <div className="space-y-4">
            {caseGroupsForSelectedRun.length === 0 ? (
              <div className="rounded-xl border bg-card text-card-foreground px-4 py-12 text-center text-sm text-muted-foreground">
                No test cases found for this run.
              </div>
            ) : (
              caseGroupsForSelectedRun.map((group, index) => (
                <TestCaseGroup
                  key={group.testCase?._id ?? `unassigned-${index}`}
                  group={group}
                  index={index}
                  runs={runs}
                  openIterationId={openIterationId}
                  setOpenIterationId={setOpenIterationId}
                  expandedQueries={expandedQueries}
                  setExpandedQueries={setExpandedQueries}
                  getIterationBorderColor={getIterationBorderColor}
                  showRunLink={false}
                />
              ))
            )}
          </div>
        </>
      ) : viewMode === "test-detail" && selectedTestDetails ? (
        <>
          {/* Test Detail View */}
          <div className="rounded-xl border bg-card text-card-foreground">
            <div className="border-b px-4 py-3">
              <div className="text-sm font-semibold">{selectedTestDetails.testCase?.title}</div>
              <p className="text-xs text-muted-foreground">
                {selectedTestDetails.testCase?.provider} • {selectedTestDetails.testCase?.model}
              </p>
            </div>
            {selectedTestTrendData.length > 0 && (
              <div className="border-b px-4 py-3">
                <div className="text-xs text-muted-foreground mb-2">Performance across runs</div>
                <ChartContainer config={chartConfig} className="aspect-auto h-32 w-full">
                  <AreaChart data={selectedTestTrendData} width={undefined} height={undefined}>
                    <CartesianGrid
                      strokeDasharray="3 3"
                      vertical={false}
                      stroke="hsl(var(--muted-foreground) / 0.2)"
                    />
                    <XAxis
                      dataKey="runIndex"
                      tickLine={false}
                      axisLine={false}
                      tickMargin={8}
                      tick={{ fontSize: 11 }}
                      label={{ value: "Run", position: "insideBottom", offset: -5, fontSize: 11 }}
                    />
                    <YAxis
                      domain={[0, 100]}
                      tickLine={false}
                      axisLine={false}
                      tickMargin={8}
                      tick={{ fontSize: 11 }}
                      tickFormatter={(value) => `${value}%`}
                    />
                    <ChartTooltip cursor={false} content={<ChartTooltipContent />} />
                    <Area
                      type="monotone"
                      dataKey="passRate"
                      stroke="var(--color-passRate)"
                      fill="var(--color-passRate)"
                      fillOpacity={0.15}
                      strokeWidth={2}
                      isAnimationActive={false}
                      dot={selectedTestTrendData.length > 1}
                    />
                  </AreaChart>
                </ChartContainer>
              </div>
            )}
            <div className="px-4 py-4">
              {selectedTestDetails.testCase?.query && (
                <div className="mb-4 rounded-lg border bg-muted/30 p-3">
                  <div className="text-xs font-medium text-muted-foreground mb-1">Query</div>
                  <p className="text-sm italic">"{selectedTestDetails.testCase.query}"</p>
                </div>
              )}
              <div className="grid gap-3 rounded-lg border bg-background/80 p-4">
                <div className="flex items-center justify-between text-xs text-muted-foreground">
                  <span>Test Performance</span>
                  <span className="font-medium text-foreground">Across all runs</span>
                </div>
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                  <RunMetric
                    label="Pass rate"
                    value={`${selectedTestDetails.summary.runs > 0 ? Math.round((selectedTestDetails.summary.passed / selectedTestDetails.summary.runs) * 100) : 0}%`}
                  />
                  <RunMetric
                    label="Passed"
                    value={selectedTestDetails.summary.passed.toLocaleString()}
                  />
                  <RunMetric
                    label="Failed"
                    value={selectedTestDetails.summary.failed.toLocaleString()}
                  />
                  <RunMetric
                    label="Cancelled"
                    value={selectedTestDetails.summary.cancelled.toLocaleString()}
                  />
                  <RunMetric
                    label="Total iterations"
                    value={selectedTestDetails.summary.runs.toLocaleString()}
                  />
                  <RunMetric
                    label="Avg duration"
                    value={
                      selectedTestDetails.summary.avgDuration !== null
                        ? formatDuration(selectedTestDetails.summary.avgDuration)
                        : "—"
                    }
                  />
                </div>
              </div>
            </div>
          </div>

          {/* Iterations for this Test */}
          <div className="space-y-4">
            {iterationsForSelectedTest.length === 0 ? (
              <div className="rounded-xl border bg-card text-card-foreground px-4 py-12 text-center text-sm text-muted-foreground">
                No iterations found for this test.
              </div>
            ) : (
              iterationsForSelectedTest.map((iteration) => {
                const isOpen = openIterationId === iteration._id;
                const startedAt = iteration.startedAt ?? iteration.createdAt;
                const completedAt = iteration.updatedAt ?? iteration.createdAt;
                const durationMs =
                  startedAt && completedAt
                    ? Math.max(completedAt - startedAt, 0)
                    : null;
                const isPending = iteration.result === "pending";

                const iterationRun = iteration.suiteRunId
                  ? runs.find((r) => r._id === iteration.suiteRunId)
                  : null;

                const runNumber = iterationRun?.runNumber ?? null;
                const runTimestamp = iterationRun
                  ? new Date(iterationRun.createdAt).toLocaleString(undefined, {
                      month: "short",
                      day: "numeric",
                      hour: "2-digit",
                      minute: "2-digit",
                    })
                  : null;

                const actualToolCalls = iteration.actualToolCalls || [];

                return (
                  <div
                    key={iteration._id}
                    className={`relative overflow-hidden rounded-xl border ${isPending ? "opacity-60" : ""}`}
                  >
                    <div
                      className={`absolute left-0 top-0 h-full w-1 ${getIterationBorderColor(iteration.result)}`}
                    />
                    <button
                      onClick={() => {
                        if (!isPending) {
                          setOpenIterationId((current) =>
                            current === iteration._id ? null : iteration._id
                          );
                        }
                      }}
                      disabled={isPending}
                      className={`flex w-full items-center justify-between gap-4 px-4 py-3 text-left transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/60 ${
                        isPending
                          ? "cursor-not-allowed"
                          : "cursor-pointer hover:bg-muted/50"
                      }`}
                    >
                      <div className="flex min-w-0 flex-1 items-center gap-4 pl-3">
                        <div className="text-muted-foreground">
                          {isPending ? (
                            <ChevronRight className="h-4 w-4" />
                          ) : isOpen ? (
                            <ChevronDown className="h-4 w-4" />
                          ) : (
                            <ChevronRight className="h-4 w-4" />
                          )}
                        </div>
                        <div className="flex min-w-0 flex-1 flex-col gap-1">
                          <div className="flex items-center gap-2">
                            <Badge
                              variant={iteration.result === "passed" ? "default" : iteration.result === "failed" ? "destructive" : "secondary"}
                              className="text-xs font-mono uppercase"
                            >
                              {iteration.result}
                            </Badge>
                            {runTimestamp && (
                              <span className="text-xs text-muted-foreground">
                                {runTimestamp}
                              </span>
                            )}
                            {iterationRun && !isPending && (
                              <Button
                                variant="ghost"
                                size="sm"
                                className="h-6 text-xs px-2"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setSelectedRunId(iterationRun._id);
                                  setSelectedTestId(null);
                                  setViewMode("run-detail");
                                }}
                              >
                                View Run #{runNumber}
                              </Button>
                            )}
                          </div>
                          <div className="text-xs text-muted-foreground">
                            Iteration #{iteration.iterationNumber ?? "?"}
                          </div>
                        </div>
                      </div>
                      <div className="flex items-center gap-6 text-xs text-muted-foreground">
                        {!isPending && (
                          <>
                            <div className="flex items-center gap-1">
                              <span className="font-mono">{actualToolCalls.length}</span>
                              <span>tools</span>
                            </div>
                            <div className="flex items-center gap-1">
                              <span className="font-mono">{Number(iteration.tokensUsed || 0).toLocaleString()}</span>
                              <span>tokens</span>
                            </div>
                            <div className="font-mono">
                              {durationMs !== null ? formatDuration(durationMs) : "—"}
                            </div>
                          </>
                        )}
                        {isPending && (
                          <Loader2 className="h-4 w-4 animate-spin text-amber-600" />
                        )}
                      </div>
                    </button>
                    {isOpen && !isPending ? (
                      <div className="border-t bg-muted/20 px-4 pb-4 pt-3 pl-8">
                        <IterationDetails
                          iteration={iteration}
                          testCase={selectedTestDetails.testCase}
                        />
                      </div>
                    ) : null}
                  </div>
                );
              })
            )}
          </div>
        </>
      ) : null}
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

function TestCaseGroup({
  group,
  index,
  runs,
  openIterationId,
  setOpenIterationId,
  expandedQueries,
  setExpandedQueries,
  getIterationBorderColor,
  showRunLink = true,
}: {
  group: {
    testCase: EvalCase | null;
    iterations: EvalIteration[];
  };
  index: number;
  runs: EvalSuiteRun[];
  openIterationId: string | null;
  setOpenIterationId: (id: string | null) => void;
  expandedQueries: Set<string>;
  setExpandedQueries: (fn: (prev: Set<string>) => Set<string>) => void;
  getIterationBorderColor: (result: string) => string;
  showRunLink?: boolean;
}) {
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
    <div className="overflow-hidden rounded-xl border">
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
            const startedAt = iteration.startedAt ?? iteration.createdAt;
            const completedAt = iteration.updatedAt ?? iteration.createdAt;
            const durationMs =
              startedAt && completedAt
                ? Math.max(completedAt - startedAt, 0)
                : null;
            const isPending = iteration.result === "pending";

            const iterationRun = iteration.suiteRunId
              ? runs.find((r) => r._id === iteration.suiteRunId)
              : null;

            const runNumber = iterationRun?.runNumber ?? null;

            // Get test info from snapshot or testCase
            const testInfo = iteration.testCaseSnapshot || testCase;
            const expectedToolCalls = testInfo?.expectedToolCalls || [];
            const actualToolCalls = iteration.actualToolCalls || [];

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
                        current === iteration._id ? null : iteration._id
                      );
                    }
                  }}
                  disabled={isPending}
                  className={`flex w-full items-center justify-between gap-4 px-4 py-3 text-left transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/60 ${
                    isPending
                      ? "cursor-not-allowed"
                      : "cursor-pointer hover:bg-muted/50"
                  }`}
                >
                  <div className="flex min-w-0 flex-1 items-center gap-4 pl-3">
                    <div className="text-muted-foreground">
                      {isPending ? (
                        <ChevronRight className="h-4 w-4" />
                      ) : isOpen ? (
                        <ChevronDown className="h-4 w-4" />
                      ) : (
                        <ChevronRight className="h-4 w-4" />
                      )}
                    </div>
                    <div className="flex min-w-0 flex-1 flex-col gap-1">
                      <div className="flex items-center gap-2">
                        <Badge
                          variant={iteration.result === "passed" ? "default" : iteration.result === "failed" ? "destructive" : "secondary"}
                          className="text-xs font-mono uppercase"
                        >
                          {iteration.result}
                        </Badge>
                        <span className="text-sm font-medium">
                          {testInfo?.title || "Iteration"}
                        </span>
                      </div>
                      <div className="text-xs text-muted-foreground truncate">
                        {testInfo?.query && `"${testInfo.query.substring(0, 60)}${testInfo.query.length > 60 ? "..." : ""}"`}
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-6 text-xs text-muted-foreground">
                    {!isPending && (
                      <>
                        <div className="flex items-center gap-1">
                          <span className="font-mono">{actualToolCalls.length}</span>
                          <span>tools</span>
                        </div>
                        <div className="flex items-center gap-1">
                          <span className="font-mono">{Number(iteration.tokensUsed || 0).toLocaleString()}</span>
                          <span>tokens</span>
                        </div>
                        <div className="font-mono">
                          {durationMs !== null ? formatDuration(durationMs) : "—"}
                        </div>
                      </>
                    )}
                    {isPending && (
                      <Loader2 className="h-4 w-4 animate-spin text-amber-600" />
                    )}
                  </div>
                </button>
                {isOpen && !isPending ? (
                  <div className="border-t bg-muted/20 px-4 pb-4 pt-3 pl-8">
                    <IterationDetails iteration={iteration} testCase={testCase} />
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
}
