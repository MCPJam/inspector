import { useMemo } from "react";
import {
  formatTime,
  formatRunId,
  computeIterationSummary,
  getTemplateKey,
} from "./helpers";
import {
  computeIterationResult,
  computeIterationPassed,
} from "./pass-criteria";
import {
  EvalCase,
  EvalIteration,
  EvalSuite,
  EvalSuiteRun,
  SuiteAggregate,
} from "./types";

export function useSuiteData(
  suite: EvalSuite,
  cases: EvalCase[],
  iterations: EvalIteration[],
  allIterations: EvalIteration[],
  runs: EvalSuiteRun[],
  aggregate: SuiteAggregate | null,
) {
  // Calculate active run IDs once (memoized separately for better performance)
  const activeRunIds = useMemo(
    () =>
      new Set(
        runs.filter((run) => run.isActive !== false).map((run) => run._id),
      ),
    [runs],
  );

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
    const passRate = total > 0 ? Math.round((totals.passed / total) * 100) : 0;

    return {
      passRate,
      passed: totals.passed,
      failed: totals.failed,
      total,
      cancelled: totals.cancelled,
      pending: totals.pending,
    };
  }, [aggregate]);

  // Run trend data for accuracy chart
  const runTrendData = useMemo(() => {
    const activeRuns = runs.filter((run) => run.isActive !== false);

    const data = activeRuns
      .slice()
      .reverse()
      .map((run) => {
        const runIterations = allIterations.filter(
          (iter) => iter.suiteRunId === run._id,
        );
        // Only count completed iterations - exclude pending/cancelled
        const iterationResults = runIterations.map((i) =>
          computeIterationResult(i),
        );
        const realTimePassed = iterationResults.filter(
          (r) => r === "passed",
        ).length;
        const realTimeTotal = iterationResults.filter(
          (r) => r === "passed" || r === "failed",
        ).length;

        let passRate: number;
        if (realTimeTotal > 0) {
          passRate = Math.round((realTimePassed / realTimeTotal) * 100);
        } else if (run.summary) {
          passRate = Math.round(run.summary.passRate * 100);
        } else {
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
        (
          item,
        ): item is {
          runId: string;
          runIdDisplay: string;
          passRate: number;
          label: string;
        } => item !== null,
      );
    return data;
  }, [runs, allIterations]);

  // Calculate per-model statistics (only from active runs)
  const modelStats = useMemo(() => {
    const activeIterations = allIterations.filter(
      (iteration) =>
        !iteration.suiteRunId || activeRunIds.has(iteration.suiteRunId),
    );

    const modelMap = new Map<
      string,
      { passed: number; failed: number; total: number; modelName: string }
    >();

    activeIterations.forEach((iteration) => {
      const model = iteration.testCaseSnapshot?.model || "Unknown";
      const modelName = iteration.testCaseSnapshot?.model || "Unknown Model";

      // Only count completed iterations - exclude pending/cancelled
      const result = computeIterationResult(iteration);
      if (result !== "passed" && result !== "failed") {
        return; // Skip pending/cancelled iterations
      }

      if (!modelMap.has(model)) {
        modelMap.set(model, { passed: 0, failed: 0, total: 0, modelName });
      }

      const stats = modelMap.get(model)!;
      stats.total += 1;

      if (result === "passed") {
        stats.passed += 1;
      } else {
        stats.failed += 1;
      }
    });

    const data = Array.from(modelMap.entries()).map(([model, stats]) => ({
      model: stats.modelName,
      passRate:
        stats.total > 0 ? Math.round((stats.passed / stats.total) * 100) : 0,
      passed: stats.passed,
      failed: stats.failed,
      total: stats.total,
    }));

    // Sort alphabetically by model name for consistent, fixed ordering
    return data.sort((a, b) => a.model.localeCompare(b.model));
  }, [allIterations, activeRunIds]);

  // Case groups
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

    // Group iterations
    // Priority: testCaseId first, then fall back to snapshot grouping
    iterations.forEach((iteration) => {
      if (iteration.testCaseId) {
        // First, try to match by testCaseId (most reliable)
        const group = groups.get(iteration.testCaseId);
        if (group) {
          group.iterations.push(iteration);
        } else {
          unassigned.iterations.push(iteration);
        }
      } else if (iteration.testCaseSnapshot) {
        // Fall back to snapshot grouping for legacy iterations without testCaseId
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
      } else {
        unassigned.iterations.push(iteration);
      }
    });

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

    // First, add templates from suite config
    const configTests = suite.config?.tests || [];
    configTests.forEach((test: any) => {
      const templateTitle = test.title.replace(/\s*\[.*?\]\s*$/, "").trim();
      const templateKey = `template:${templateTitle}-${test.query}`;

      if (!groups.has(templateKey)) {
        groups.set(templateKey, {
          title: templateTitle,
          query: test.query,
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

      if (test.testCaseId) {
        const group = groups.get(templateKey)!;
        if (!group.testCaseIds.includes(test.testCaseId)) {
          group.testCaseIds.push(test.testCaseId);
        }
      }
    });

    // Then, group by testTemplateKey from schema
    caseGroups.forEach((group) => {
      if (!group.testCase) return;

      const templateKey = getTemplateKey(group.testCase);
      const templateTitle = group.testCase.title
        .replace(/\s*\[.*?\]\s*$/, "")
        .trim();
      const configTemplateKey = `template:${templateTitle}-${group.testCase.query}`;

      const keyToUse = groups.has(configTemplateKey)
        ? configTemplateKey
        : templateKey;

      if (!groups.has(keyToUse)) {
        groups.set(keyToUse, {
          title: templateTitle,
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

      const templateGroup = groups.get(keyToUse)!;
      if (!templateGroup.testCaseIds.includes(group.testCase._id)) {
        templateGroup.testCaseIds.push(group.testCase._id);
      }
      templateGroup.iterations.push(...group.iterations);
    });

    return Array.from(groups.values()).map((group) => ({
      ...group,
      summary: computeIterationSummary(group.iterations),
    }));
  }, [caseGroups, suite.config?.tests]);

  return {
    activeRunIds,
    generalSummary,
    runTrendData,
    modelStats,
    caseGroups,
    templateGroups,
  };
}

export function useRunDetailData(
  selectedRunId: string | null,
  allIterations: EvalIteration[],
  runDetailSortBy: "model" | "test" | "result",
) {
  // Iterations for selected run
  const iterationsForSelectedRun = useMemo(() => {
    if (!selectedRunId) return [];
    return allIterations.filter(
      (iteration) => iteration.suiteRunId === selectedRunId,
    );
  }, [selectedRunId, allIterations]);

  // Flat list of iterations for selected run with sorting
  const caseGroupsForSelectedRun = useMemo(() => {
    if (!selectedRunId) return [];

    const iterationsWithModel = iterationsForSelectedRun.map((iteration) => {
      const snapshot = iteration.testCaseSnapshot;
      return {
        iteration,
        model: snapshot?.model || "",
        provider: snapshot?.provider || "",
        title: snapshot?.title || "",
        query: snapshot?.query || "",
        result: iteration.result,
      };
    });

    const sorted = [...iterationsWithModel].sort((a, b) => {
      if (runDetailSortBy === "model") {
        const modelA = `${a.provider}/${a.model}`;
        const modelB = `${b.provider}/${b.model}`;
        if (modelA !== modelB) return modelA.localeCompare(modelB);
        if (a.title !== b.title) return a.title.localeCompare(b.title);
        const numA = a.iteration.iterationNumber ?? 0;
        const numB = b.iteration.iterationNumber ?? 0;
        return numA - numB;
      } else if (runDetailSortBy === "test") {
        if (a.title !== b.title) return a.title.localeCompare(b.title);
        const modelA = `${a.provider}/${a.model}`;
        const modelB = `${b.provider}/${b.model}`;
        if (modelA !== modelB) return modelA.localeCompare(modelB);
        const numA = a.iteration.iterationNumber ?? 0;
        const numB = b.iteration.iterationNumber ?? 0;
        return numA - numB;
      } else {
        const resultOrder = { passed: 0, failed: 1, cancelled: 2, pending: 3 };
        const orderA = resultOrder[a.result as keyof typeof resultOrder] ?? 4;
        const orderB = resultOrder[b.result as keyof typeof resultOrder] ?? 4;
        if (orderA !== orderB) return orderA - orderB;
        if (a.title !== b.title) return a.title.localeCompare(b.title);
        const modelA = `${a.provider}/${a.model}`;
        const modelB = `${b.provider}/${b.model}`;
        return modelA.localeCompare(modelB);
      }
    });

    return sorted.map((item) => item.iteration);
  }, [selectedRunId, iterationsForSelectedRun, runDetailSortBy]);

  // Data for run detail charts
  const selectedRunChartData = useMemo(() => {
    if (!selectedRunId || caseGroupsForSelectedRun.length === 0) {
      return { donutData: [], durationData: [], tokensData: [], modelData: [] };
    }

    let totalPassed = 0;
    let totalFailed = 0;
    let totalPending = 0;
    let totalCancelled = 0;

    const modelMap = new Map<
      string,
      { passed: number; failed: number; total: number; modelName: string }
    >();

    iterationsForSelectedRun.forEach((iteration) => {
      const model = iteration.testCaseSnapshot?.model || "Unknown";
      const modelName = iteration.testCaseSnapshot?.model || "Unknown Model";

      // Only count completed iterations - exclude pending/cancelled
      const result = computeIterationResult(iteration);
      if (result !== "passed" && result !== "failed") {
        return; // Skip pending/cancelled iterations
      }

      if (!modelMap.has(model)) {
        modelMap.set(model, { passed: 0, failed: 0, total: 0, modelName });
      }

      const stats = modelMap.get(model)!;
      stats.total += 1;

      if (result === "passed") {
        stats.passed += 1;
      } else {
        stats.failed += 1;
      }
    });

    // Sort alphabetically by model name for consistent, fixed ordering
    const modelData = Array.from(modelMap.entries())
      .map(([model, stats]) => ({
        model: stats.modelName,
        passRate:
          stats.total > 0 ? Math.round((stats.passed / stats.total) * 100) : 0,
        passed: stats.passed,
        failed: stats.failed,
        total: stats.total,
      }))
      .sort((a, b) => a.model.localeCompare(b.model));

    const testMap = new Map<
      string,
      {
        title: string;
        durations: number[];
        tokens: number[];
        passed: number;
        failed: number;
        pending: number;
        cancelled: number;
      }
    >();

    caseGroupsForSelectedRun.forEach((iteration) => {
      const testKey = iteration.testCaseSnapshot?.title || "Unknown";

      if (!testMap.has(testKey)) {
        testMap.set(testKey, {
          title: testKey,
          durations: [],
          tokens: [],
          passed: 0,
          failed: 0,
          pending: 0,
          cancelled: 0,
        });
      }

      const test = testMap.get(testKey)!;

      // Use computeIterationPassed for accurate pass/fail with negative test support
      if (iteration.result === "pending") test.pending++;
      else if (iteration.result === "cancelled") test.cancelled++;
      else if (computeIterationPassed(iteration)) test.passed++;
      else test.failed++;

      const startedAt = iteration.startedAt ?? iteration.createdAt;
      const completedAt = iteration.updatedAt ?? iteration.createdAt;
      if (startedAt && completedAt && iteration.result !== "pending") {
        test.durations.push(Math.max(completedAt - startedAt, 0));
      }

      // Track tokens used
      if (iteration.result !== "pending" && iteration.tokensUsed) {
        test.tokens.push(iteration.tokensUsed);
      }
    });

    testMap.forEach((test) => {
      totalPassed += test.passed;
      totalFailed += test.failed;
      totalPending += test.pending;
      totalCancelled += test.cancelled;
    });

    const durationData = Array.from(testMap.values()).map((test) => {
      const avgDuration =
        test.durations.length > 0
          ? test.durations.reduce((sum, d) => sum + d, 0) /
            test.durations.length
          : 0;

      return {
        name: test.title,
        duration: avgDuration,
        durationSeconds: avgDuration / 1000,
      };
    });

    const tokensData = Array.from(testMap.values()).map((test) => {
      const avgTokens =
        test.tokens.length > 0
          ? test.tokens.reduce((sum, t) => sum + t, 0) / test.tokens.length
          : 0;

      return {
        name: test.title,
        tokens: avgTokens,
      };
    });

    const donutData = [];
    if (totalPassed > 0) {
      donutData.push({
        name: "Passed",
        value: totalPassed,
        fill: "hsl(142.1 76.2% 36.3%)",
      });
    }
    if (totalFailed > 0) {
      donutData.push({
        name: "Failed",
        value: totalFailed,
        fill: "hsl(0 84.2% 60.2%)",
      });
    }
    if (totalPending > 0) {
      donutData.push({
        name: "Pending",
        value: totalPending,
        fill: "hsl(45.4 93.4% 47.5%)",
      });
    }
    if (totalCancelled > 0) {
      donutData.push({
        name: "Cancelled",
        value: totalCancelled,
        fill: "hsl(240 3.7% 15.9%)",
      });
    }

    return { donutData, durationData, tokensData, modelData };
  }, [selectedRunId, caseGroupsForSelectedRun, iterationsForSelectedRun]);

  return {
    iterationsForSelectedRun,
    caseGroupsForSelectedRun,
    selectedRunChartData,
  };
}
