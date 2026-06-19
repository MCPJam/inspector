import { useMemo } from "react";
import { Code2, Loader2, X } from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import { computeIterationResult } from "./pass-criteria";
import { pickLatestCompletedRun } from "./helpers";
import { useRunInsights } from "./use-run-insights";
import { findRunInsightForCase } from "./run-insight-helpers";
import { TestCaseIterationsTable } from "./test-case-iterations-table";
import type { EvalCase, EvalIteration, EvalSuiteRun } from "./types";

interface TestCaseDetailViewProps {
  testCase: EvalCase;
  iterations: EvalIteration[];
  onBack: () => void;
  onViewRun?: (runId: string) => void;
  serverNames?: string[];
  suiteName?: string;
  onNavigateToSuite?: () => void;
  runs?: EvalSuiteRun[];
  onOpenExportCase?: () => void;
}

export function TestCaseDetailView({
  testCase,
  iterations,
  onBack,
  onViewRun,
  serverNames = [],
  suiteName,
  onNavigateToSuite,
  runs = [],
  onOpenExportCase,
}: TestCaseDetailViewProps) {
  const latestCompletedRun = useMemo(
    () => pickLatestCompletedRun(runs),
    [runs],
  );

  useRunInsights(latestCompletedRun, { autoRequest: true });

  const latestCaseInsight = useMemo(
    () =>
      findRunInsightForCase(latestCompletedRun, {
        caseKey: testCase.caseKey,
        testCaseId: testCase._id,
      }),
    [latestCompletedRun, testCase.caseKey, testCase._id],
  );

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

    iterations.forEach((iteration) => {
      const snapshot = iteration.testCaseSnapshot;
      if (!snapshot) return;

      // Only count terminal pass/fail iterations - exclude pending/cancelled.
      const result = computeIterationResult(iteration);
      if (
        result !== "passed" &&
        result !== "failed" &&
        result !== "timed_out"
      ) {
        return;
      }

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

      if (result === "passed") {
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
  }, [iterations]);

  // Compute overall stats
  const overallStats = useMemo(() => {
    const results = iterations.map((i) => computeIterationResult(i));
    const passed = results.filter((r) => r === "passed").length;
    const failed = results.filter(
      (r) => r === "failed" || r === "timed_out",
    ).length;
    const total = passed + failed;
    const passRate = total > 0 ? Math.round((passed / total) * 100) : 0;

    // Avg duration
    const completed = iterations.filter(
      (i) => i.startedAt && i.updatedAt && i.result !== "pending",
    );
    const avgDuration =
      completed.length > 0
        ? completed.reduce(
            (sum, i) => sum + ((i.updatedAt ?? 0) - (i.startedAt ?? 0)),
            0,
          ) / completed.length
        : 0;

    return { passed, failed, total, passRate, avgDuration };
  }, [iterations]);

  const formatDurationHelper = (ms: number) => {
    if (ms < 1000) return `${Math.round(ms)}ms`;
    const s = Math.round(ms / 1000);
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    const sec = s % 60;
    return sec ? `${m}m ${sec}s` : `${m}m`;
  };

  return (
    <div className="space-y-4 overflow-y-auto h-full p-0.5">
      {/* Breadcrumb + Header */}
      <div className="flex items-start justify-between gap-2">
        <div>
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground mb-1">
            {suiteName && onNavigateToSuite && (
              <>
                <button
                  onClick={onNavigateToSuite}
                  className="hover:text-foreground hover:underline transition-colors cursor-pointer"
                >
                  {suiteName}
                </button>
                <span className="text-muted-foreground/50">/</span>
              </>
            )}
            <span className="text-primary font-medium">Test Case</span>
          </div>
          <h2 className="text-lg font-semibold">
            {testCase.title || "Untitled test case"}
          </h2>
          {testCase.query && (
            <p className="text-sm text-muted-foreground mt-0.5">
              {testCase.query}
            </p>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {onOpenExportCase ? (
            <Button variant="outline" size="sm" onClick={onOpenExportCase}>
              <Code2 className="mr-2 h-4 w-4" />
              Export
            </Button>
          ) : null}
          <Button variant="ghost" size="icon" onClick={onBack}>
            <X className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {latestCompletedRun ? (
        <div className="rounded-lg border bg-card text-card-foreground p-3">
          <h3 className="text-xs font-semibold text-muted-foreground mb-1.5">
            Latest run insight
          </h3>
          {latestCompletedRun.runInsightsStatus === "pending" ? (
            <span className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin shrink-0" />
              Generating suite run insights…
            </span>
          ) : latestCompletedRun.runInsightsStatus === "failed" ? (
            <p className="text-sm text-muted-foreground leading-relaxed">
              Run insights did not complete. Open the latest completed run from
              this suite to retry generation.
            </p>
          ) : latestCaseInsight ? (
            <p className="text-sm leading-relaxed">
              {latestCaseInsight.summary}
            </p>
          ) : (
            <p className="text-sm text-muted-foreground leading-relaxed">
              No notable change in the last two runs.
            </p>
          )}
        </div>
      ) : null}

      {/* Hero Stats */}
      {overallStats.total > 0 && (
        <div className="rounded-xl border bg-card text-card-foreground p-4">
          <div className="flex items-center gap-4">
            <span className="text-2xl font-bold">{overallStats.passRate}%</span>
            <span className="text-sm text-muted-foreground">Pass Rate</span>
            <span className="text-muted-foreground/40">|</span>
            <span className="text-xs text-muted-foreground">
              {overallStats.total} iterations
            </span>
            <span className="text-muted-foreground/40">|</span>
            <span className="text-xs text-muted-foreground">
              Avg {formatDurationHelper(overallStats.avgDuration)}
            </span>
          </div>
          {/* Progress bar */}
          <div className="mt-2 flex items-center gap-3">
            <div className="flex-1 h-2 rounded-full bg-muted overflow-hidden flex">
              <div
                className="h-full rounded-l-full transition-all"
                style={{
                  width: `${(overallStats.passed / overallStats.total) * 100}%`,
                  backgroundColor: "hsl(142.1 76.2% 36.3%)",
                }}
              />
              <div
                className="h-full rounded-r-full transition-all"
                style={{
                  width: `${(overallStats.failed / overallStats.total) * 100}%`,
                  backgroundColor: "hsl(0 84.2% 60.2%)",
                }}
              />
            </div>
            <span className="text-xs text-muted-foreground shrink-0">
              {overallStats.passed} passed · {overallStats.failed} failed
            </span>
          </div>
          {/* Inline model breakdown */}
          {modelBreakdown.length >= 1 && (
            <div className="flex flex-wrap items-center gap-4 mt-2 pt-2 border-t border-border/50">
              <span className="text-[10px] text-muted-foreground">
                By Model:
              </span>
              {modelBreakdown.map((model) => (
                <div key={model.model} className="flex items-center gap-1.5">
                  <div
                    className="h-1.5 w-1.5 rounded-full"
                    style={{
                      backgroundColor:
                        model.passRate >= 80
                          ? "hsl(142.1 76.2% 36.3%)"
                          : model.passRate >= 50
                            ? "hsl(45.4 93.4% 47.5%)"
                            : "hsl(0 84.2% 60.2%)",
                    }}
                  />
                  <span className="text-[11px]">{model.model}</span>
                  <span className="text-[11px] font-mono font-medium">
                    {model.passRate}%
                  </span>
                  <span className="text-[10px] text-muted-foreground">
                    ({model.passed}/{model.passed + model.failed})
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Iterations List */}
      <TestCaseIterationsTable
        testCase={testCase}
        iterations={iterations}
        onViewRun={onViewRun}
        serverNames={serverNames}
      />
    </div>
  );
}
