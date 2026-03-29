import { useCallback, useMemo, useState } from "react";
import { useQuery } from "convex/react";
import { X, ChevronDown, ChevronRight, Footprints, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { computeIterationResult } from "./pass-criteria";
import {
  evalStatusLeftBorderClasses,
  formatRunId,
  pickLatestCompletedRun,
} from "./helpers";
import { useRunInsights } from "./use-run-insights";
import { IterationDetails } from "./iteration-details";
import { TraceRepairBanner } from "./trace-repair-banner";
import type { EvalCase, EvalIteration, EvalSuiteRun } from "./types";
import { pickTraceRepairCaseSourceIteration } from "@/lib/evals/pick-trace-repair-case-iteration";
import { startTraceRepair, stopTraceRepair } from "@/lib/apis/evals-api";

interface TestCaseDetailViewProps {
  testCase: EvalCase;
  iterations: EvalIteration[];
  onBack: () => void;
  onViewRun?: (runId: string) => void;
  serverNames?: string[];
  suiteName?: string;
  onNavigateToSuite?: () => void;
  /** Playground-only: enables per-case trace repair when set with `runs`. */
  suiteId?: string;
  runs?: EvalSuiteRun[];
  suiteSource?: "ui" | "sdk";
}

export function TestCaseDetailView({
  testCase,
  iterations,
  onBack,
  onViewRun,
  serverNames = [],
  suiteName,
  onNavigateToSuite,
  suiteId,
  runs = [],
  suiteSource = "ui",
}: TestCaseDetailViewProps) {
  const [openIterationId, setOpenIterationId] = useState<string | null>(null);
  const [traceRepairStarting, setTraceRepairStarting] = useState(false);

  const traceSourceIteration = useMemo(
    () =>
      suiteId && suiteSource === "ui"
        ? pickTraceRepairCaseSourceIteration(testCase._id, iterations, runs)
        : null,
    [suiteId, suiteSource, testCase._id, iterations, runs],
  );

  const traceRepairCaseJobView = useQuery(
    "traceRepair:getTraceRepairJobView" as any,
    suiteId && suiteSource === "ui"
      ? { testSuiteId: suiteId, testCaseId: testCase._id }
      : "skip",
  );

  const latestTraceRepairCaseOutcome = useQuery(
    "traceRepair:getLatestTraceRepairOutcome" as any,
    suiteId && suiteSource === "ui"
      ? { testSuiteId: suiteId, testCaseId: testCase._id }
      : "skip",
  );

  const traceRepairCaseJobActive =
    traceRepairCaseJobView != null &&
    typeof traceRepairCaseJobView === "object" &&
    traceRepairCaseJobView.scope === "case" &&
    ["queued", "running", "stopping"].includes(
      String(traceRepairCaseJobView.status),
    );

  const traceRepairCaseEligible =
    suiteId != null &&
    suiteSource === "ui" &&
    traceSourceIteration != null &&
    !traceRepairCaseJobActive;

  const handleStartTraceRepairCase = useCallback(async () => {
    if (!suiteId || !traceSourceIteration?.suiteRunId) {
      return;
    }
    setTraceRepairStarting(true);
    try {
      await startTraceRepair({
        scope: "case",
        suiteId,
        sourceRunId: traceSourceIteration.suiteRunId,
        sourceIterationId: traceSourceIteration._id,
        testCaseId: testCase._id,
      });
    } finally {
      setTraceRepairStarting(false);
    }
  }, [suiteId, traceSourceIteration, testCase._id]);

  const handleStopTraceRepairCase = useCallback(async () => {
    if (
      !traceRepairCaseJobView ||
      typeof traceRepairCaseJobView !== "object" ||
      !traceRepairCaseJobView.jobId
    ) {
      return;
    }
    await stopTraceRepair(String(traceRepairCaseJobView.jobId));
  }, [traceRepairCaseJobView]);

  const caseTitleByKey = useMemo(
    () => ({
      [testCase.caseKey ?? testCase._id]: testCase.title,
    }),
    [testCase.caseKey, testCase._id, testCase.title],
  );

  const traceRepairActiveBannerView =
    traceRepairCaseJobActive &&
    traceRepairCaseJobView &&
    typeof traceRepairCaseJobView === "object"
      ? {
          jobId: String(traceRepairCaseJobView.jobId),
          status: String(traceRepairCaseJobView.status),
          phase: String(traceRepairCaseJobView.phase),
          scope: "case" as const,
          currentCaseKey: traceRepairCaseJobView.currentCaseKey ?? undefined,
          activeCaseKeys: traceRepairCaseJobView.activeCaseKeys ?? [],
          attemptLimit: traceRepairCaseJobView.attemptLimit,
          provisionalAppliedCount: traceRepairCaseJobView.provisionalAppliedCount,
          durableFixCount: traceRepairCaseJobView.durableFixCount,
          regressedCount: traceRepairCaseJobView.regressedCount,
          serverLikelyCount: traceRepairCaseJobView.serverLikelyCount,
          exhaustedCount: traceRepairCaseJobView.exhaustedCount,
          promisingCount: traceRepairCaseJobView.promisingCount,
          accuracyBefore: traceRepairCaseJobView.accuracyBefore ?? null,
          accuracyAfter: traceRepairCaseJobView.accuracyAfter ?? null,
        }
      : null;

  const latestTraceCaseOutcomeBanner =
    latestTraceRepairCaseOutcome &&
    typeof latestTraceRepairCaseOutcome === "object" &&
    latestTraceRepairCaseOutcome.scope === "case"
      ? {
          ...latestTraceRepairCaseOutcome,
          jobId: String(latestTraceRepairCaseOutcome.jobId),
          status: String(latestTraceRepairCaseOutcome.status),
          phase: String(latestTraceRepairCaseOutcome.phase),
          scope: "case" as const,
          stopReason: latestTraceRepairCaseOutcome.stopReason,
          lastError: latestTraceRepairCaseOutcome.lastError,
          completedAt: latestTraceRepairCaseOutcome.completedAt,
          updatedAt: latestTraceRepairCaseOutcome.updatedAt,
        }
      : null;

  const traceRepairCopyJobId = useMemo(() => {
    if (traceRepairActiveBannerView?.jobId) {
      return traceRepairActiveBannerView.jobId;
    }
    if (latestTraceCaseOutcomeBanner?.jobId) {
      return latestTraceCaseOutcomeBanner.jobId;
    }
    return null;
  }, [traceRepairActiveBannerView, latestTraceCaseOutcomeBanner]);

  const traceRepairCopyDebug =
    suiteId != null && suiteSource === "ui" && traceRepairCopyJobId != null;

  const traceRepairDebugJson = useQuery(
    "traceRepair:getTraceRepairJobDebugJson" as any,
    traceRepairCopyDebug ? { jobId: traceRepairCopyJobId } : "skip",
  );

  const latestCompletedRun = useMemo(
    () => pickLatestCompletedRun(runs),
    [runs],
  );

  useRunInsights(latestCompletedRun, { autoRequest: true });

  const latestCaseInsight = useMemo(() => {
    const list = latestCompletedRun?.runInsights?.caseInsights;
    if (!list?.length) {
      return null;
    }
    return (
      list.find(
        (c) =>
          (testCase.caseKey != null && c.caseKey === testCase.caseKey) ||
          c.testCaseId === testCase._id,
      ) ?? null
    );
  }, [
    latestCompletedRun?.runInsights?.caseInsights,
    testCase.caseKey,
    testCase._id,
  ]);

  const activeIterations = useMemo(() => iterations, [iterations]);

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

      // Only count completed iterations - exclude pending/cancelled
      const result = computeIterationResult(iteration);
      if (result !== "passed" && result !== "failed") {
        return; // Skip pending/cancelled iterations
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
  }, [activeIterations]);

  // Compute overall stats
  const overallStats = useMemo(() => {
    const results = activeIterations.map((i) => computeIterationResult(i));
    const passed = results.filter((r) => r === "passed").length;
    const failed = results.filter((r) => r === "failed").length;
    const total = passed + failed;
    const passRate = total > 0 ? Math.round((passed / total) * 100) : 0;

    // Avg duration
    const completed = activeIterations.filter(
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
  }, [activeIterations]);

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
          {suiteId && suiteSource === "ui" ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <span>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="gap-1.5"
                    disabled={
                      !traceRepairCaseEligible ||
                      traceRepairStarting ||
                      traceRepairCaseJobActive
                    }
                    onClick={() => void handleStartTraceRepairCase()}
                  >
                    {traceRepairStarting ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Footprints className="h-3.5 w-3.5" />
                    )}
                    Trace repair case
                  </Button>
                </span>
              </TooltipTrigger>
              <TooltipContent>
                {traceSourceIteration
                  ? "Repair this case using its latest failed traced suite iteration."
                  : "Needs a failed traced run"}
              </TooltipContent>
            </Tooltip>
          ) : null}
          <Button variant="ghost" size="icon" onClick={onBack}>
            <X className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {suiteId && suiteSource === "ui" ? (
        <TraceRepairBanner
          scope="case"
          activeView={traceRepairActiveBannerView}
          caseTitleByKey={caseTitleByKey}
          onStop={handleStopTraceRepairCase}
          latestOutcome={latestTraceCaseOutcomeBanner}
          showTerminalOutcome
          traceRepairCopyDebug={traceRepairCopyDebug}
          traceRepairDebugJson={traceRepairDebugJson}
        />
      ) : null}

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
            <p className="text-sm leading-relaxed">{latestCaseInsight.summary}</p>
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
            {/* Column headers */}
            <div className="flex items-center justify-between gap-3 px-3 py-1.5 bg-muted/30 text-[10px] font-medium text-muted-foreground uppercase tracking-wide">
              <div className="flex min-w-0 flex-1 items-center gap-3 pl-2">
                <div className="w-3.5" />
                <span>Result</span>
              </div>
              <div className="flex items-center gap-4 shrink-0">
                <div className="min-w-[120px] text-left">Model</div>
                <div className="min-w-[50px] text-center">Calls</div>
                <div className="min-w-[60px] text-center">Tokens</div>
                <div className="min-w-[40px] text-right">Time</div>
                {onViewRun && <div className="min-w-[100px]">Run</div>}
              </div>
            </div>
            {/* Failing iterations first */}
            {(() => {
              const failing = activeIterations.filter(
                (i) => computeIterationResult(i) === "failed",
              );
              const passing = activeIterations.filter(
                (i) => computeIterationResult(i) === "passed",
              );
              const other = activeIterations.filter((i) => {
                const r = computeIterationResult(i);
                return r !== "failed" && r !== "passed";
              });
              return [...failing, ...passing, ...other];
            })().map((iteration) => {
              const snapshot = iteration.testCaseSnapshot;
              const startedAt = iteration.startedAt ?? iteration.createdAt;
              const completedAt = iteration.updatedAt ?? iteration.createdAt;
              const durationMs =
                startedAt && completedAt
                  ? Math.max(completedAt - startedAt, 0)
                  : null;
              const actualToolCalls = iteration.actualToolCalls || [];
              const computedResult = computeIterationResult(iteration);
              const isPending = iteration.result === "pending";
              const isLive =
                iteration.status === "pending" ||
                iteration.status === "running" ||
                computedResult === "pending";
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
                  className={cn(
                    "relative border-l-2",
                    evalStatusLeftBorderClasses(
                      isLive ? "running" : computedResult,
                    ),
                    isPending && "opacity-60",
                  )}
                >
                  <button
                    title={`Iteration ${computedResult}`}
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
                        <span className="text-xs font-medium truncate">
                          {snapshot?.title ?? "Iteration"}
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
                            {formatTimeAgo(iteration.createdAt)}
                          </Button>
                        </div>
                      )}
                      {isPending && (
                        <div className="w-3.5 flex items-center justify-center">
                          <Loader2 className="h-3.5 w-3.5 animate-spin text-warning" />
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

function formatTimeAgo(timestamp: number): string {
  const diff = Date.now() - timestamp;
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}
