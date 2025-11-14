import { useMemo, useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { ChevronDown, ChevronRight, Loader2, RotateCw, Trash2, X } from "lucide-react";
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
import { formatTime, formatRunId, computeIterationSummary, getTemplateKey } from "./helpers";
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
import { PassCriteriaBadge } from "./pass-criteria-badge";
import { PassCriteriaSelector } from "./pass-criteria-selector";
import { computeIterationPassed } from "./pass-criteria";

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
  connectedServerNames,
  rerunningSuiteId,
  cancellingRunId,
  deletingSuiteId,
  availableModels,
  selectedTestId,
  onTestIdChange,
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
  connectedServerNames: Set<string>;
  rerunningSuiteId: string | null;
  cancellingRunId: string | null;
  deletingSuiteId: string | null;
  availableModels: any[];
  selectedTestId: string | null;
  onTestIdChange: (testId: string | null) => void;
}) {
  const [openIterationId, setOpenIterationId] = useState<string | null>(null);
  const [expandedQueries, setExpandedQueries] = useState<Set<string>>(
    new Set(),
  );
  const [activeTab, setActiveTab] = useState<"runs" | "edit">("runs");
  const [viewMode, setViewMode] = useState<"overview" | "run-detail" | "test-detail">("overview");
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [isEditingName, setIsEditingName] = useState(false);
  const [editedName, setEditedName] = useState(suite.name);

  // Default pass criteria for new runs (stored in localStorage per suite)
  const [defaultMinimumPassRate, setDefaultMinimumPassRate] = useState(100);

  const updateSuite = useMutation("evals:updateSuite" as any);

  useEffect(() => {
    setEditedName(suite.name);
  }, [suite.name]);

  // Load default pass criteria from localStorage
  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const rate = localStorage.getItem(`suite-${suite._id}-criteria-rate`);

      if (rate) setDefaultMinimumPassRate(Number(rate));
    } catch (error) {
      console.warn("Failed to load default pass criteria", error);
    }
  }, [suite._id]);

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

  const handleNameClick = () => {
    setIsEditingName(true);
    setEditedName(suite.name);
  };

  const handleNameBlur = async () => {
    setIsEditingName(false);
    if (editedName && editedName.trim() && editedName !== suite.name) {
      try {
        await updateSuite({
          suiteId: suite._id,
          name: editedName.trim(),
        });
        toast.success("Suite name updated");
      } catch (error) {
        toast.error("Failed to update suite name");
        console.error("Failed to update suite name:", error);
        setEditedName(suite.name);
      }
    } else {
      setEditedName(suite.name);
    }
  };

  const handleNameKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      handleNameBlur();
    } else if (e.key === "Escape") {
      setIsEditingName(false);
      setEditedName(suite.name);
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
    // Filter to only active runs for the trend chart
    const activeRuns = runs.filter((run) => run.isActive !== false);

    const data = activeRuns
      .slice()
      .reverse()
      .map((run) => {
        // Calculate real-time stats from iterations for this run
        const runIterations = allIterations.filter((iter) => iter.suiteRunId === run._id);
        const realTimePassed = runIterations.filter((i) => computeIterationPassed(i)).length;
        const realTimeTotal = runIterations.length;

        // Use real-time data if available, otherwise fall back to summary
        let passRate: number;
        if (realTimeTotal > 0) {
          passRate = Math.round((realTimePassed / realTimeTotal) * 100);
        } else if (run.summary) {
          passRate = Math.round(run.summary.passRate * 100);
        } else {
          // Skip runs with no data yet
          return null;
        }

        return {
          runId: run._id,
          runIdDisplay: formatRunId(run._id),
          passRate,
          label: formatTime(run.completedAt ?? run.createdAt),
        };
      })
      .filter(
        (item): item is { runId: string; runIdDisplay: string; passRate: number; label: string } =>
          item !== null,
      );
    console.log('[Evals] Run trend data:', data);
    return data;
  }, [runs, allIterations]);

  const chartConfig = {
    passRate: {
      label: "Pass rate",
      color: "var(--chart-1)",
    },
  };

  // Calculate per-model statistics
  const modelStats = useMemo(() => {
    const modelMap = new Map<string, { passed: number; failed: number; total: number; modelName: string }>();

    allIterations.forEach((iteration) => {
      const model = iteration.testCaseSnapshot?.model || 'Unknown';
      const modelName = iteration.testCaseSnapshot?.model || 'Unknown Model';

      if (!modelMap.has(model)) {
        modelMap.set(model, { passed: 0, failed: 0, total: 0, modelName });
      }

      const stats = modelMap.get(model)!;
      stats.total += 1;

      // Compute pass/fail using our evaluation logic
      const passed = computeIterationPassed(iteration);
      if (passed) {
        stats.passed += 1;
      } else {
        stats.failed += 1;
      }
    });

    const data = Array.from(modelMap.entries()).map(([model, stats]) => ({
      model: stats.modelName,
      passRate: stats.total > 0 ? Math.round((stats.passed / stats.total) * 100) : 0,
      passed: stats.passed,
      failed: stats.failed,
      total: stats.total,
    }));

    return data.sort((a, b) => b.passRate - a.passRate);
  }, [allIterations]);

  const modelChartConfig = {
    passRate: {
      label: "Pass Rate",
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
          summary: computeIterationSummary(sortedIterations),
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
        summary: computeIterationSummary(sortedUnassigned),
      });
    }

    return orderedGroups;
  }, [cases, iterations, suite._id]);

  // Template groups - group test cases by testTemplateKey
  const templateGroups = useMemo(() => {
    const groups = new Map<
      string,
      {
        title: string;
        query: string;
        testCaseIds: string[];
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

    // Group by testTemplateKey from schema
    caseGroups.forEach((group) => {
      if (!group.testCase) return;

      const templateKey = getTemplateKey(group.testCase);

      if (!groups.has(templateKey)) {
        groups.set(templateKey, {
          title: group.testCase.title,
          query: group.testCase.query,
          testCaseIds: [],
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

      const templateGroup = groups.get(templateKey)!;
      templateGroup.testCaseIds.push(group.testCase._id);
      templateGroup.iterations.push(...group.iterations);
    });

    // Compute summaries and return as array
    return Array.from(groups.values()).map((group) => ({
      ...group,
      summary: computeIterationSummary(group.iterations),
    }));
  }, [caseGroups]);

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
      return { donutData: [], durationData: [], modelData: [] };
    }

    // Calculate overall pass/fail for donut chart
    let totalPassed = 0;
    let totalFailed = 0;
    let totalPending = 0;
    let totalCancelled = 0;

    // Calculate per-model stats for this run
    const modelMap = new Map<string, { passed: number; failed: number; total: number; modelName: string }>();

    iterationsForSelectedRun.forEach((iteration) => {
      const model = iteration.testCaseSnapshot?.model || 'Unknown';
      const modelName = iteration.testCaseSnapshot?.model || 'Unknown Model';

      if (!modelMap.has(model)) {
        modelMap.set(model, { passed: 0, failed: 0, total: 0, modelName });
      }

      const stats = modelMap.get(model)!;
      stats.total += 1;

      if (iteration.result === 'passed') {
        stats.passed += 1;
      } else if (iteration.result === 'failed') {
        stats.failed += 1;
      }
    });

    const modelData = Array.from(modelMap.entries()).map(([model, stats]) => ({
      model: stats.modelName,
      passRate: stats.total > 0 ? Math.round((stats.passed / stats.total) * 100) : 0,
      passed: stats.passed,
      failed: stats.failed,
      total: stats.total,
    })).sort((a, b) => b.passRate - a.passRate);

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

    return { donutData, durationData, modelData };
  }, [selectedRunId, caseGroupsForSelectedRun, iterationsForSelectedRun]);

  // Iterations for selected test (across all runs) - aggregate across all models
  const iterationsForSelectedTest = useMemo(() => {
    if (!selectedTestId) return [];

    // Find the template group that contains this test case
    const templateGroup = templateGroups.find((tg) =>
      tg.testCaseIds.includes(selectedTestId)
    );

    if (templateGroup) {
      return templateGroup.iterations;
    }

    // Fallback to single test case
    const group = caseGroups.find((g) => g.testCase?._id === selectedTestId);
    return group ? group.iterations : [];
  }, [selectedTestId, caseGroups, templateGroups]);

  // Selected test details - aggregate across all models for the template
  const selectedTestDetails = useMemo(() => {
    if (!selectedTestId) return null;
    
    // Find the template group that contains this test case
    const templateGroup = templateGroups.find((tg) =>
      tg.testCaseIds.includes(selectedTestId)
    );

    if (!templateGroup) return null;

    // Find a caseGroup that matches any of the test case IDs in the template group
    // This handles cases where caseGroups might be grouped by snapshot
    const group = caseGroups.find((g) => 
      g.testCase && templateGroup.testCaseIds.includes(g.testCase._id)
    );

    if (!group || !group.testCase) {
      // If no caseGroup found, create a minimal one from the template group
      const firstTestCase = cases.find(c => templateGroup.testCaseIds.includes(c._id));
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

    // Return aggregated data for the template
    return {
      testCase: {
        ...group.testCase,
        // Remove model from the display
        model: '',
        provider: '',
      },
      iterations: templateGroup.iterations,
      summary: templateGroup.summary,
      templateInfo: {
        title: templateGroup.title,
        query: templateGroup.query,
        modelCount: templateGroup.testCaseIds.length,
      },
    };
  }, [selectedTestId, caseGroups, templateGroups, cases]);

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
    const data: Array<{ runId: string; runIdDisplay: string; passRate: number; label: string }> = [];
    runs.forEach((run) => {
      const runIters = iterationsByRun.get(run._id);
      if (runIters && runIters.length > 0) {
        const passed = runIters.filter((iter) => iter.result === "passed").length;
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

    // Sort by creation time (most recent first, then reverse for display)
    return data.sort((a, b) => {
      const runA = runs.find(r => r._id === a.runId);
      const runB = runs.find(r => r._id === b.runId);
      const timeA = runA?.createdAt ?? 0;
      const timeB = runB?.createdAt ?? 0;
      return timeA - timeB;
    });
  }, [selectedTestId, iterationsForSelectedTest, runs]);

  // Per-model breakdown for selected test
  const selectedTestModelBreakdown = useMemo(() => {
    if (!selectedTestId || !selectedTestDetails?.templateInfo) return [];

    const templateGroup = templateGroups.find((tg) =>
      tg.testCaseIds.includes(selectedTestId)
    );

    if (!templateGroup) return [];

    // Group iterations by model and compute stats
    const modelMap = new Map<string, {
      provider: string;
      model: string;
      passed: number;
      failed: number;
      cancelled: number;
      pending: number;
      total: number;
      passRate: number;
    }>();

    // Get model info from test cases
    const testCaseMap = new Map<string, { provider: string; model: string }>();
    caseGroups.forEach((group) => {
      if (group.testCase && templateGroup.testCaseIds.includes(group.testCase._id)) {
        testCaseMap.set(group.testCase._id, {
          provider: group.testCase.provider,
          model: group.testCase.model,
        });
      }
    });

    // Group iterations by model
    templateGroup.iterations.forEach((iteration) => {
      const testCaseInfo = iteration.testCaseId ? testCaseMap.get(iteration.testCaseId) : null;
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

    // Compute pass rates
    return Array.from(modelMap.values())
      .map((stats) => ({
        ...stats,
        passRate: stats.total > 0 ? Math.round((stats.passed / stats.total) * 100) : 0,
      }))
      .sort((a, b) => b.passRate - a.passRate);
  }, [selectedTestId, selectedTestDetails, templateGroups, caseGroups]);

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

  // Find the latest run that's in progress
  const latestRun = runs && runs.length > 0 ? runs[0] : null;
  const isRunInProgress =
    latestRun?.status === "running" || latestRun?.status === "pending";
  const isCancelling = cancellingRunId === latestRun?._id;

  // Update view mode when selectedTestId changes
  useEffect(() => {
    if (selectedTestId) {
      setViewMode("test-detail");
      // Use functional update to avoid stale closure issues
      setActiveTab((current) => current !== "runs" ? "runs" : current);
    } else {
      // Use functional update to check current viewMode
      setViewMode((current) => current === "test-detail" ? "overview" : current);
    }
  }, [selectedTestId]);

  return (
    <div className="space-y-4">
        <Tabs value={activeTab} onValueChange={(v) => {
        const newTab = v as "runs" | "edit";

        // If clicking the same tab, reset to list view
        if (newTab === activeTab) {
          if (newTab === "runs" && (viewMode === "run-detail" || viewMode === "test-detail")) {
            setViewMode("overview");
            setSelectedRunId(null);
            onTestIdChange(null);
          }
          return;
        }

        setActiveTab(newTab);

        // Reset view mode when switching tabs
        if (newTab === "edit") {
          setViewMode("overview");
          setSelectedRunId(null);
          onTestIdChange(null);
        } else if (newTab === "runs") {
          // When switching to runs, clear test detail but keep run detail if applicable
          if (viewMode === "test-detail") {
            setViewMode("overview");
            onTestIdChange(null);
          } else if (viewMode === "run-detail") {
            // Keep run detail view
          } else {
            setViewMode("overview");
            setSelectedRunId(null);
          }
        } else if (newTab === "general") {
          // When switching to general, only reset if we're not showing test detail
          if (viewMode === "test-detail") {
            // Keep test detail view - don't reset
          } else {
            setViewMode("overview");
            setSelectedRunId(null);
            onTestIdChange(null);
          }
        }
      }}>
        {/* Header with tabs and actions */}
        <div className="flex items-center justify-between gap-4 mb-4">
          <div className="flex items-center gap-3 flex-1 min-w-0 overflow-visible">
            {/* Tabs */}
            <TabsList>
          <TabsTrigger value="runs" onClick={() => {
            if (activeTab === "runs" && viewMode === "run-detail") {
              setViewMode("overview");
              setSelectedRunId(null);
            }
          }}>Runs</TabsTrigger>
          <TabsTrigger value="edit" onClick={() => {
            if (activeTab === "edit") {
              setViewMode("overview");
              setSelectedRunId(null);
              onTestIdChange(null);
            }
          }}>Edit</TabsTrigger>
            </TabsList>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {isRunInProgress && latestRun ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => onCancelRun(latestRun._id)}
                    disabled={isCancelling}
                    className="gap-2"
                  >
                    {isCancelling ? (
                      <>
                        <Loader2 className="h-4 w-4 animate-spin" />
                        Cancelling...
                      </>
                    ) : (
                      <>
                        <X className="h-4 w-4" />
                        Cancel run
                      </>
                    )}
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Cancel the current evaluation run</TooltipContent>
              </Tooltip>
            ) : (
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
            )}
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


        <TabsContent value="runs" className="space-y-4">
          {viewMode === "test-detail" && selectedTestDetails ? (
            <>
          {/* Test Detail View - shown when a test is selected from sidebar */}
          <div className="rounded-xl border bg-card text-card-foreground">
            <div className="border-b px-4 py-3">
              <div className="text-sm font-semibold">{selectedTestDetails.templateInfo?.title || selectedTestDetails.testCase?.title}</div>
              <p className="text-xs text-muted-foreground">
                {selectedTestDetails.templateInfo
                  ? `${selectedTestDetails.templateInfo.modelCount} model${selectedTestDetails.templateInfo.modelCount === 1 ? "" : "s"}`
                  : `${selectedTestDetails.testCase?.provider} • ${selectedTestDetails.testCase?.model}`
                }
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
                      dataKey="runIdDisplay"
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
            </div>
          </div>

          {/* Per-Model Breakdown */}
          {selectedTestModelBreakdown.length > 1 && (
            <div className="rounded-xl border bg-card text-card-foreground">
              <div className="border-b px-4 py-3">
                <div className="text-sm font-semibold">Performance by model</div>
                <p className="text-xs text-muted-foreground">
                  Pass rate comparison across {selectedTestModelBreakdown.length} model{selectedTestModelBreakdown.length === 1 ? "" : "s"}.
                </p>
              </div>
              <div className="px-4 py-4">
                <ChartContainer config={chartConfig} className="aspect-auto h-48 w-full">
                  <BarChart
                    data={selectedTestModelBreakdown}
                    layout="vertical"
                    margin={{ left: 0, right: 40 }}
                  >
                    <CartesianGrid
                      strokeDasharray="3 3"
                      horizontal={false}
                      stroke="hsl(var(--muted-foreground) / 0.2)"
                    />
                    <XAxis
                      type="number"
                      domain={[0, 100]}
                      tickLine={false}
                      axisLine={false}
                      tickMargin={8}
                      tick={{ fontSize: 11 }}
                      tickFormatter={(value) => `${value}%`}
                    />
                    <YAxis
                      type="category"
                      dataKey="model"
                      tickLine={false}
                      axisLine={false}
                      tickMargin={8}
                      tick={{ fontSize: 11 }}
                      width={120}
                    />
                    <ChartTooltip
                      cursor={false}
                      content={({ active, payload }) => {
                        if (!active || !payload || !payload.length) return null;
                        const data = payload[0].payload;
                        return (
                          <div className="rounded-lg border bg-background p-2 shadow-sm">
                            <div className="text-xs font-medium">{data.model}</div>
                            <div className="text-xs text-muted-foreground">{data.provider}</div>
                            <div className="mt-1 text-xs">
                              Pass rate: <span className="font-medium">{data.passRate}%</span>
                            </div>
                            <div className="text-xs text-muted-foreground">
                              {data.passed}/{data.total} passed
                            </div>
                          </div>
                        );
                      }}
                    />
                    <Bar
                      dataKey="passRate"
                      fill="hsl(var(--chart-1))"
                      radius={[0, 4, 4, 0]}
                      isAnimationActive={false}
                    />
                  </BarChart>
                </ChartContainer>
              </div>
            </div>
          )}

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

                const runTimestamp = iterationRun
                  ? new Date(iterationRun.createdAt).toLocaleString(undefined, {
                      month: "short",
                      day: "numeric",
                      hour: "2-digit",
                      minute: "2-digit",
                    })
                  : null;

                const actualToolCalls = iteration.actualToolCalls || [];

                // Get model info for this iteration
                const iterationTestCase = iteration.testCaseId
                  ? caseGroups.find((g) => g.testCase?._id === iteration.testCaseId)?.testCase
                  : null;

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
                              variant={
                                iteration.result === "passed"
                                  ? "default"
                                  : iteration.result === "failed"
                                    ? "destructive"
                                    : iteration.result === "cancelled"
                                      ? "outline"
                                      : "secondary"
                              }
                              className="text-xs font-mono uppercase"
                            >
                              {iteration.result}
                            </Badge>
                            {iterationTestCase && (
                              <span className="text-xs font-medium">
                                {iterationTestCase.model}
                              </span>
                            )}
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
                                  onTestIdChange(null);
                                  setViewMode("run-detail");
                                  setActiveTab("runs");
                                }}
                              >
                                View Run {formatRunId(iterationRun._id)}
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
                            {durationMs !== null && (
                              <div className="flex items-center gap-1">
                                <span className="font-mono">{(durationMs / 1000).toFixed(1)}s</span>
                              </div>
                            )}
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
          ) : viewMode === "overview" ? (
            <>
              {/* Pass/Fail Criteria Badge for Latest Run */}
              {runs.length > 0 && runs[0] && (
                <PassCriteriaBadge
                  run={runs[0]}
                  variant="detailed"
                />
              )}

              {/* Charts Side by Side */}
              <div className="grid gap-4 lg:grid-cols-2">
                {/* Pass Rate Trend */}
                <div className="rounded-xl border bg-card text-card-foreground">
                  <div className="px-4 pt-3 pb-2">
                    <div className="text-xs font-medium text-muted-foreground">Pass rate trend</div>
                  </div>
                  <div className="px-4 pb-4">
                    {runsLoading ? (
                      <Skeleton className="h-32 w-full" />
                    ) : runTrendData.length > 0 ? (
                      <ChartContainer config={chartConfig} className="aspect-auto h-32 w-full">
                        <AreaChart data={runTrendData} width={undefined} height={undefined}>
                          <CartesianGrid
                            strokeDasharray="3 3"
                            vertical={false}
                            stroke="hsl(var(--muted-foreground) / 0.2)"
                          />
                          <XAxis
                            dataKey="runIdDisplay"
                            tickLine={false}
                            axisLine={false}
                            tickMargin={8}
                            tick={{ fontSize: 12 }}
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
                      <p className="text-xs text-muted-foreground">
                        No completed runs yet.
                      </p>
                    )}
                  </div>
                </div>

                {/* Per-Model Performance */}
                <div className="rounded-xl border bg-card text-card-foreground">
                  <div className="px-4 pt-3 pb-2">
                    <div className="text-xs font-medium text-muted-foreground">Performance by model</div>
                  </div>
                  <div className="px-4 pb-4">
                    {modelStats.length > 0 ? (
                      <ChartContainer config={modelChartConfig} className="aspect-auto h-32 w-full">
                        <BarChart data={modelStats} width={undefined} height={undefined}>
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
                            tick={{ fontSize: 12 }}
                            interval={0}
                            angle={-45}
                            textAnchor="end"
                            height={80}
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
                              if (!active || !payload || payload.length === 0) return null;
                              const data = payload[0].payload;
                              return (
                                <div className="rounded-lg border bg-background p-2 shadow-sm">
                                  <div className="grid gap-2">
                                    <div className="flex flex-col">
                                      <span className="text-xs font-semibold">{data.model}</span>
                                      <span className="text-xs text-muted-foreground mt-0.5">
                                        {data.passed} passed · {data.failed} failed
                                      </span>
                                    </div>
                                    <div className="flex items-center gap-2">
                                      <div className="h-2 w-2 rounded-full" style={{ backgroundColor: 'var(--color-passRate)' }} />
                                      <span className="text-sm font-semibold">{data.passRate}%</span>
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

              {/* Runs List */}
            <div className="rounded-xl border bg-card text-card-foreground flex flex-col max-h-[600px]">
              <div className="border-b px-4 py-3 shrink-0">
                <div className="text-sm font-semibold">Runs</div>
                <p className="text-xs text-muted-foreground">
                  Click on a run to view its test breakdown and results.
                </p>
              </div>
              <div className="divide-y overflow-y-auto">
            {runs.length === 0 ? (
              <div className="px-4 py-12 text-center text-sm text-muted-foreground">
                No runs found.
              </div>
            ) : (
              runs.map((run) => {
                // Calculate real-time stats from iterations for this run
                const runIterations = allIterations.filter((iter) => iter.suiteRunId === run._id);
                const realTimePassed = runIterations.filter((i) => i.result === "passed").length;
                const realTimeFailed = runIterations.filter((i) => i.result === "failed").length;
                const realTimeTotal = runIterations.length;

                // Use real-time data if available, otherwise fall back to summary
                const passed = realTimePassed > 0 ? realTimePassed : (run.summary?.passed ?? 0);
                const failed = realTimeFailed > 0 ? realTimeFailed : (run.summary?.failed ?? 0);
                const total = realTimeTotal > 0 ? realTimeTotal : (run.summary?.total ?? 0);
                const passRate = total > 0 ? Math.round((passed / total) * 100) : null;

                const timestamp = formatTime(run.completedAt ?? run.createdAt);

                // Calculate duration - use current time for in-progress runs
                const duration = run.completedAt && run.createdAt
                  ? formatDuration(run.completedAt - run.createdAt)
                  : run.createdAt && run.status === "running"
                    ? formatDuration(Date.now() - run.createdAt)
                    : "—";

                const isRunning = run.status === "running";

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
                      <div className="flex items-center gap-2">
                        <div className="flex flex-col gap-0.5">
                          <span className="text-sm font-medium">Run {formatRunId(run._id)}</span>
                          <span className="text-xs text-muted-foreground">{timestamp}</span>
                        </div>
                        {isRunning && (
                          <div className="flex items-center gap-1.5 rounded-full bg-amber-100 dark:bg-amber-950 px-2 py-0.5">
                            <div className="h-1.5 w-1.5 rounded-full bg-amber-500 animate-pulse" />
                            <span className="text-xs font-medium text-amber-700 dark:text-amber-400">Running</span>
                          </div>
                        )}
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
            </>
          ) : viewMode === "run-detail" && selectedRunDetails ? (
            <>
          {/* Run Detail View */}
          <div className="rounded-xl border bg-card text-card-foreground">
            <div className="border-b px-4 py-3">
              <div className="text-sm font-semibold">Run {formatRunId(selectedRunDetails._id)}</div>
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

            {/* Per-Model Performance for this run */}
            {selectedRunChartData.modelData.length > 1 && (
              <div className="border-b px-4 py-4">
                <div className="rounded-lg border bg-background/50 p-4">
                  <div className="text-xs font-medium text-muted-foreground mb-3">
                    Performance by model
                  </div>
                  <ChartContainer
                    config={{
                      passRate: { label: "Pass Rate", color: "var(--chart-1)" },
                    }}
                    className="aspect-auto h-48 w-full"
                  >
                    <BarChart data={selectedRunChartData.modelData} width={undefined} height={undefined}>
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
                        angle={-45}
                        textAnchor="end"
                        height={60}
                      />
                      <YAxis
                        domain={[0, 100]}
                        tickLine={false}
                        axisLine={false}
                        tickMargin={8}
                        tick={{ fontSize: 11 }}
                        tickFormatter={(value) => `${value}%`}
                      />
                      <ChartTooltip
                        cursor={false}
                        content={({ active, payload }) => {
                          if (!active || !payload || payload.length === 0) return null;
                          const data = payload[0].payload;
                          return (
                            <div className="rounded-lg border bg-background p-2 shadow-sm">
                              <div className="grid gap-2">
                                <div className="flex flex-col">
                                  <span className="text-xs font-semibold">{data.model}</span>
                                  <span className="text-xs text-muted-foreground mt-0.5">
                                    {data.passed} passed · {data.failed} failed
                                  </span>
                                </div>
                                <div className="flex items-center gap-2">
                                  <div className="h-2 w-2 rounded-full" style={{ backgroundColor: 'var(--color-passRate)' }} />
                                  <span className="text-sm font-semibold">{data.passRate}%</span>
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
                      />
                    </BarChart>
                  </ChartContainer>
                </div>
              </div>
            )}

            <div className="px-4 py-4">
              <div className="grid gap-3 rounded-lg border bg-background/80 p-4">
                <div className="flex items-center justify-between text-xs text-muted-foreground">
                  <div className="flex items-center gap-3">
                    <span>Run {formatRunId(selectedRunDetails._id)}</span>
                    <PassCriteriaBadge
                      run={selectedRunDetails}
                      variant="compact"
                    />
                  </div>
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
          ) : null}
        </TabsContent>

        <TabsContent value="edit" className="space-y-4">
          {/* Default Pass/Fail Criteria for New Runs */}
          <div className="space-y-3">
            <div>
              <h3 className="text-base font-semibold">Default Pass/Fail Criteria</h3>
              <p className="text-sm text-muted-foreground mt-1">
                Set the default criteria for <strong>new</strong> evaluation runs of this suite. These settings will be pre-selected when you click "Rerun". Existing runs keep their original criteria.
              </p>
            </div>
            <PassCriteriaSelector
              minimumPassRate={defaultMinimumPassRate}
              onMinimumPassRateChange={(rate) => {
                setDefaultMinimumPassRate(rate);
                localStorage.setItem(`suite-${suite._id}-criteria-rate`, String(rate));
              }}
            />
          </div>

          {/* Tests Config */}
          <SuiteTestsConfig suite={suite} onUpdate={handleUpdateTests} availableModels={availableModels} />
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
                      setOpenIterationId(openIterationId === iteration._id ? null : iteration._id);
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
                          variant={
                            iteration.result === "passed"
                              ? "default"
                              : iteration.result === "failed"
                                ? "destructive"
                                : iteration.result === "cancelled"
                                  ? "outline"
                                  : "secondary"
                          }
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
