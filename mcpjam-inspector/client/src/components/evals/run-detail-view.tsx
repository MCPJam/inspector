import { useMemo, type ReactNode } from "react";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from "@/components/ui/chart";
import { PieChart, Pie, Label } from "recharts";
import { cn } from "@/lib/utils";
import { IterationDetails } from "./iteration-details";
import {
  evalStatusLeftBorderClasses,
  formatDuration,
  formatRunId,
} from "./helpers";
import { RunMetricsBarCharts } from "./run-metrics-bar-charts";
import {
  computeIterationResult,
  computeIterationPassed,
} from "./pass-criteria";
import { EvalIteration, EvalSuiteRun } from "./types";
import { CiMetadataDisplay } from "./ci-metadata-display";
import { RunInsightsPrimaryBlock } from "./run-insights-primary-block";
import {
  RunCaseInsightTraceCaption,
  shouldOmitRunCaseInsightCaption,
} from "./run-case-insight-block";
import { findRunInsightForCase } from "./run-insight-helpers";
import { useRunInsights } from "./use-run-insights";
import { navigateToEvalsRoute } from "@/lib/evals-router";
import { ExternalLink } from "lucide-react";
import { RunHeaderCompactStats } from "./run-header-compact-stats";
import { RunInsightsSidebarSummary } from "./run-insights-sidebar";

interface RunDetailViewProps {
  selectedRunDetails: EvalSuiteRun;
  caseGroupsForSelectedRun: EvalIteration[];
  source?: "ui" | "sdk";
  selectedRunChartData: {
    donutData: Array<{ name: string; value: number; fill: string }>;
    durationData: Array<{
      name: string;
      duration: number;
      durationSeconds: number;
    }>;
    tokensData: Array<{
      name: string;
      tokens: number;
    }>;
    modelData: Array<{
      model: string;
      passRate: number;
      passed: number;
      failed: number;
      total: number;
    }>;
  };
  runDetailSortBy: "model" | "test" | "result";
  onSortChange: (sortBy: "model" | "test" | "result") => void;
  serverNames?: string[];
  selectedIterationId: string | null;
  onSelectIteration: (id: string) => void;
  hideCiMetadata?: boolean;
  /** When true, omit replay source line (shown in SuiteHeader instead). */
  hideReplayLineage?: boolean;
  /** When true, only the iteration detail pane is shown (list lives in a parent sidebar). */
  omitIterationList?: boolean;
}

function IterationListItem({
  iteration,
  isSelected,
  onSelect,
  onEditTestCase,
}: {
  iteration: EvalIteration;
  isSelected: boolean;
  onSelect: () => void;
  /** When set, failed iterations with a testCaseId show an editor link. */
  onEditTestCase?: (testCaseId: string) => void;
}) {
  const isPending =
    iteration.status === "pending" || iteration.status === "running";

  const testInfo = iteration.testCaseSnapshot;
  const modelName = testInfo?.model || "—";

  const computedResult = computeIterationResult(iteration);
  const canEditInPlayground =
    Boolean(onEditTestCase && iteration.testCaseId) &&
    computedResult === "failed";

  return (
    <div
      className={cn(
        "relative border-l-2",
        evalStatusLeftBorderClasses(isPending ? "running" : computedResult),
        isPending && "opacity-60",
      )}
    >
      <button
        type="button"
        onClick={onSelect}
        title={
          testInfo?.isNegativeTest
            ? "Negative test — expects the tool NOT to be called"
            : undefined
        }
        aria-label={
          testInfo?.isNegativeTest
            ? `Negative test (expects the tool not to be called): ${testInfo?.title || "Iteration"}, ${modelName}`
            : undefined
        }
        className={`flex w-full flex-col gap-0.5 px-3 py-2 text-left transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/60 cursor-pointer ${
          isSelected
            ? "bg-primary/10 border-r-2 border-r-primary"
            : "hover:bg-muted/50"
        }`}
      >
        <span className="text-xs font-medium leading-snug line-clamp-2">
          {testInfo?.title || "Iteration"}
        </span>
        <span className="truncate text-[10px] font-mono text-muted-foreground">
          {modelName}
        </span>
      </button>
      {canEditInPlayground && iteration.testCaseId ? (
        <div className="px-3 pb-2 -mt-0.5">
          <button
            type="button"
            className="text-[10px] text-primary hover:underline inline-flex items-center gap-0.5"
            onClick={(e) => {
              e.stopPropagation();
              onEditTestCase!(iteration.testCaseId!);
            }}
          >
            Edit in Playground
            <ExternalLink className="h-2.5 w-2.5 shrink-0 opacity-80" />
          </button>
        </div>
      ) : null}
    </div>
  );
}

function IterationListWithSections({
  iterations,
  sortBy,
  selectedIterationId,
  onSelectIteration,
  onEditTestCase,
}: {
  iterations: EvalIteration[];
  sortBy: "model" | "test" | "result";
  selectedIterationId: string | null;
  onSelectIteration: (id: string) => void;
  onEditTestCase?: (testCaseId: string) => void;
}) {
  if (sortBy !== "result") {
    return (
      <>
        {iterations.map((iteration) => (
          <IterationListItem
            key={iteration._id}
            iteration={iteration}
            isSelected={selectedIterationId === iteration._id}
            onSelect={() => onSelectIteration(iteration._id)}
            onEditTestCase={onEditTestCase}
          />
        ))}
      </>
    );
  }

  const failing = iterations.filter(
    (i) => computeIterationResult(i) === "failed",
  );
  const passing = iterations.filter(
    (i) => computeIterationResult(i) === "passed",
  );
  const other = iterations.filter((i) => {
    const r = computeIterationResult(i);
    return r !== "failed" && r !== "passed";
  });

  const ordered = [...failing, ...passing, ...other];

  return (
    <>
      {ordered.map((iteration) => (
        <IterationListItem
          key={iteration._id}
          iteration={iteration}
          isSelected={selectedIterationId === iteration._id}
          onSelect={() => onSelectIteration(iteration._id)}
          onEditTestCase={onEditTestCase}
        />
      ))}
    </>
  );
}

/** Iteration list + sort (composed inside run detail when the list is not inlined). */
export function RunIterationsSidebar({
  caseGroupsForSelectedRun,
  runDetailSortBy,
  onSortChange,
  selectedIterationId,
  onSelectIteration,
  onEditTestCase,
  runForOverview = null,
  runOverviewExtra = null,
}: {
  caseGroupsForSelectedRun: EvalIteration[];
  runDetailSortBy: "model" | "test" | "result";
  onSortChange: (sortBy: "model" | "test" | "result") => void;
  selectedIterationId: string | null;
  onSelectIteration: (id: string) => void;
  onEditTestCase?: (testCaseId: string) => void;
  /** When set, shows Run Insights summary above the iteration list (CI sidebar + inline run detail). */
  runForOverview?: EvalSuiteRun | null;
  /** Optional row below compact stats (e.g. link to full runs table). */
  runOverviewExtra?: ReactNode;
}) {
  const overviewStatsOverride = useMemo(() => {
    if (!runForOverview) return undefined;
    if (caseGroupsForSelectedRun.length === 0) {
      return (
        runForOverview.summary ?? {
          passed: 0,
          failed: 0,
          total: 0,
          passRate: 0,
        }
      );
    }
    const passed = caseGroupsForSelectedRun.filter((i) =>
      computeIterationPassed(i),
    ).length;
    const failed = caseGroupsForSelectedRun.filter(
      (i) => !computeIterationPassed(i),
    ).length;
    const total = caseGroupsForSelectedRun.length;
    const passRate = total > 0 ? passed / total : 0;
    return { passed, failed, total, passRate };
  }, [runForOverview, caseGroupsForSelectedRun]);

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col overflow-hidden">
      {runForOverview ? (
        <RunInsightsSidebarSummary
          run={runForOverview}
          statsOverride={overviewStatsOverride}
          footer={runOverviewExtra}
        />
      ) : null}
      <div className="flex shrink-0 items-center justify-between border-b px-3 py-2">
        <div className="text-xs font-semibold">Iterations</div>
        <select
          value={runDetailSortBy}
          onChange={(e) =>
            onSortChange(e.target.value as "model" | "test" | "result")
          }
          className="rounded border bg-background px-1.5 py-0.5 text-[10px]"
          aria-label="Sort iterations"
        >
          <option value="model">Model</option>
          <option value="test">Test</option>
          <option value="result">Result</option>
        </select>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="divide-y">
          {caseGroupsForSelectedRun.length === 0 ? (
            <div className="px-3 py-8 text-center text-xs text-muted-foreground">
              No iterations found.
            </div>
          ) : (
            <IterationListWithSections
              iterations={caseGroupsForSelectedRun}
              sortBy={runDetailSortBy}
              selectedIterationId={selectedIterationId}
              onSelectIteration={onSelectIteration}
              onEditTestCase={onEditTestCase}
            />
          )}
        </div>
      </div>
    </div>
  );
}

export function RunDetailView({
  selectedRunDetails,
  caseGroupsForSelectedRun,
  source,
  selectedRunChartData,
  runDetailSortBy,
  onSortChange,
  serverNames = [],
  selectedIterationId,
  onSelectIteration,
  hideCiMetadata,
  hideReplayLineage,
  omitIterationList = false,
}: RunDetailViewProps) {
  const {
    summary: runInsightsSummary,
    pending: runInsightsPending,
    requested: runInsightsRequested,
    failedGeneration: runInsightsFailedGeneration,
    error: runInsightsError,
    requestRunInsights,
    unavailable: runInsightsUnavailable,
  } = useRunInsights(selectedRunDetails, { autoRequest: true });

  // Compute accurate pass/fail stats using the same logic as suite-header
  const computedStats = useMemo(() => {
    if (caseGroupsForSelectedRun.length === 0) {
      return (
        selectedRunDetails.summary ?? {
          passed: 0,
          failed: 0,
          total: 0,
          passRate: 0,
        }
      );
    }
    const passed = caseGroupsForSelectedRun.filter((i) =>
      computeIterationPassed(i),
    ).length;
    const failed = caseGroupsForSelectedRun.filter(
      (i) => !computeIterationPassed(i),
    ).length;
    const total = caseGroupsForSelectedRun.length;
    const passRate = total > 0 ? passed / total : 0;
    return { passed, failed, total, passRate };
  }, [caseGroupsForSelectedRun, selectedRunDetails.summary]);

  const isRunning = selectedRunDetails.status === "running";
  const expected = selectedRunDetails.expectedIterations;
  const donutTotal = selectedRunChartData.donutData.reduce(
    (sum, item) => sum + item.value,
    0,
  );
  const remaining = useMemo(() => {
    if (expected && isRunning && expected > donutTotal) {
      return expected - donutTotal;
    }
    return 0;
  }, [expected, isRunning, donutTotal]);

  const progressDonutData = useMemo(() => {
    if (remaining > 0) {
      return [
        ...selectedRunChartData.donutData,
        {
          name: "remaining",
          value: remaining,
          fill: "hsl(240 3.7% 15.9% / 0.3)",
        },
      ];
    }
    return selectedRunChartData.donutData;
  }, [selectedRunChartData.donutData, remaining]);

  const progressPercent =
    expected && expected > 0 ? Math.round((donutTotal / expected) * 100) : null;

  const metricLabel = source === "sdk" ? "Pass Rate" : "Accuracy";

  const selectedIteration = useMemo(
    () =>
      selectedIterationId
        ? (caseGroupsForSelectedRun.find(
            (i) => i._id === selectedIterationId,
          ) ?? null)
        : null,
    [selectedIterationId, caseGroupsForSelectedRun],
  );

  const caseInsightForSelectedIteration = useMemo(() => {
    if (!selectedIteration) {
      return null;
    }
    return findRunInsightForCase(selectedRunDetails, {
      caseKey: selectedIteration.testCaseSnapshot?.caseKey,
      testCaseId: selectedIteration.testCaseId,
    });
  }, [selectedIteration, selectedRunDetails]);

  const selectedIterationCaseInsightSlot = useMemo(() => {
    if (!selectedIteration) {
      return null;
    }
    if (
      shouldOmitRunCaseInsightCaption({
        runStatus: selectedRunDetails.status,
        caseInsight: caseInsightForSelectedIteration,
        pending: runInsightsPending,
        requested: runInsightsRequested,
        failedGeneration: runInsightsFailedGeneration,
        error: runInsightsError,
      })
    ) {
      return null;
    }
    return (
      <RunCaseInsightTraceCaption
        runStatus={selectedRunDetails.status}
        caseInsight={caseInsightForSelectedIteration}
        pending={runInsightsPending}
        requested={runInsightsRequested}
        failedGeneration={runInsightsFailedGeneration}
        error={runInsightsError}
      />
    );
  }, [
    selectedIteration,
    selectedRunDetails.status,
    caseInsightForSelectedIteration,
    runInsightsPending,
    runInsightsRequested,
    runInsightsFailedGeneration,
    runInsightsError,
  ]);

  const hasTokenData = useMemo(
    () =>
      selectedRunChartData.tokensData.length > 0 &&
      selectedRunChartData.tokensData.some((d) => d.tokens > 0),
    [selectedRunChartData.tokensData],
  );

  const hasRunBarCharts =
    selectedRunChartData.durationData.length > 0 || hasTokenData;

  const statsOverrideForHeader = {
    passed: computedStats.passed,
    failed: computedStats.failed,
    total: computedStats.total,
    passRate: computedStats.passRate,
  };

  const runMetricsDetail = (
    <>
      <div className="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-center sm:gap-4 lg:gap-6">
        {/* Metrics — wrap into multiple lines instead of colliding with the chart row */}
        <div className="flex min-w-0 flex-1 flex-wrap gap-x-4 gap-y-2 sm:gap-x-6">
          <div className="min-w-0 space-y-0.5">
            <div className="text-xs text-muted-foreground">{metricLabel}</div>
            <div className="text-sm font-semibold tabular-nums">
              {computedStats.total > 0
                ? `${Math.round(computedStats.passRate * 100)}%`
                : "—"}
            </div>
          </div>
          <div className="min-w-0 space-y-0.5">
            <div className="text-xs text-muted-foreground">Passed</div>
            <div className="text-sm font-semibold tabular-nums">
              {computedStats.passed.toLocaleString()}
            </div>
          </div>
          <div className="min-w-0 space-y-0.5">
            <div className="text-xs text-muted-foreground">Failed</div>
            <div className="text-sm font-semibold tabular-nums">
              {computedStats.failed.toLocaleString()}
            </div>
          </div>
          <div className="min-w-0 space-y-0.5">
            <div className="text-xs text-muted-foreground">Total</div>
            <div className="text-sm font-semibold tabular-nums">
              {expected && isRunning
                ? `${computedStats.total.toLocaleString()} / ${expected.toLocaleString()}`
                : computedStats.total.toLocaleString()}
            </div>
          </div>
          <div className="min-w-0 space-y-0.5">
            <div className="text-xs text-muted-foreground">Duration</div>
            <div className="text-sm font-semibold tabular-nums break-words">
              {selectedRunDetails.completedAt && selectedRunDetails.createdAt
                ? formatDuration(
                    selectedRunDetails.completedAt -
                      selectedRunDetails.createdAt,
                  )
                : "—"}
            </div>
          </div>
        </div>

        {/* Chart + run status — own row on narrow viewports */}
        <div className="flex min-w-0 w-full shrink-0 flex-wrap items-center gap-2 sm:w-auto sm:justify-end sm:gap-3">
          {selectedRunChartData.donutData.length > 0 && (
            <div className="flex shrink-0 items-center gap-2">
              <ChartContainer
                config={{
                  passed: {
                    label: "Passed",
                    color: "hsl(142.1 76.2% 36.3%)",
                  },
                  failed: { label: "Failed", color: "hsl(0 84.2% 60.2%)" },
                  pending: {
                    label: "Pending",
                    color: "hsl(45.4 93.4% 47.5%)",
                  },
                  cancelled: {
                    label: "Cancelled",
                    color: "hsl(240 3.7% 15.9%)",
                  },
                  remaining: {
                    label: "Remaining",
                    color: "hsl(240 3.7% 15.9% / 0.3)",
                  },
                }}
                className="h-11 w-11 shrink-0 sm:h-12 sm:w-12"
              >
                <PieChart>
                  <ChartTooltip content={<ChartTooltipContent hideLabel />} />
                  <Pie
                    data={progressDonutData}
                    dataKey="value"
                    nameKey="name"
                    innerRadius={14}
                    outerRadius={20}
                    strokeWidth={1}
                  >
                    <Label
                      content={({ viewBox }) => {
                        if (viewBox && "cx" in viewBox && "cy" in viewBox) {
                          const cy = viewBox.cy ?? 0;
                          return (
                            <text
                              x={viewBox.cx}
                              y={viewBox.cy}
                              textAnchor="middle"
                              dominantBaseline="middle"
                            >
                              <tspan
                                x={viewBox.cx}
                                y={cy}
                                className="fill-foreground text-[11px] font-bold sm:text-xs"
                              >
                                {expected && isRunning
                                  ? `${donutTotal}/${expected}`
                                  : donutTotal}
                              </tspan>
                              <tspan
                                x={viewBox.cx}
                                y={cy + 10}
                                className="hidden fill-muted-foreground text-[8px] sm:inline"
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

          <span className="text-xs font-medium capitalize text-foreground sm:shrink-0">
            {isRunning && progressPercent !== null
              ? `Running (${progressPercent}%)`
              : selectedRunDetails.status}
          </span>
        </div>
      </div>

      {selectedRunChartData.modelData.length >= 2 && (
        <div className="flex flex-wrap items-center gap-4 mt-2 pt-2 border-t border-border/50">
          <span className="text-[10px] text-muted-foreground">By Model:</span>
          {selectedRunChartData.modelData.map((model) => (
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
                ({model.passed}/{model.total})
              </span>
            </div>
          ))}
        </div>
      )}

      {hasRunBarCharts && (
        <RunMetricsBarCharts
          durationData={selectedRunChartData.durationData}
          tokensData={selectedRunChartData.tokensData}
          hasTokenData={hasTokenData}
        />
      )}
    </>
  );

  const runInsightsNarrative =
    selectedRunDetails.status === "completed" && !runInsightsUnavailable ? (
      <RunInsightsPrimaryBlock
        embedded
        summary={runInsightsSummary}
        pending={runInsightsPending}
        requested={runInsightsRequested}
        failedGeneration={runInsightsFailedGeneration}
        error={runInsightsError}
        onRetry={() => requestRunInsights(true)}
      />
    ) : null;

  const runInsightsBody = (
    <>
      {runInsightsNarrative}
      {runMetricsDetail}
    </>
  );

  return (
    <div
      className={cn(
        "relative flex flex-col",
        omitIterationList
          ? "min-h-0 flex-1 overflow-hidden px-3 py-3"
          : "p-4",
      )}
    >
      {/* Run Header */}
      <div className="shrink-0">
        {!hideCiMetadata &&
          (selectedRunDetails.ciMetadata?.branch ||
            selectedRunDetails.ciMetadata?.commitSha ||
            selectedRunDetails.ciMetadata?.runUrl) && (
            <div className="mb-4">
              <CiMetadataDisplay ciMetadata={selectedRunDetails.ciMetadata} />
            </div>
          )}

        {!hideReplayLineage && selectedRunDetails.replayedFromRunId ? (
          <p
            className="mb-4 text-xs text-muted-foreground"
            title={selectedRunDetails.replayedFromRunId}
          >
            Replay of{" "}
            <span className="font-mono text-foreground/90">
              Run {formatRunId(selectedRunDetails.replayedFromRunId)}
            </span>
          </p>
        ) : null}

        {/* Run-level metrics + narrative: only when no case is selected (dedicated ?insights=1 or choose a case). */}
        {!selectedIterationId ? (
          <div className="rounded-lg border bg-background/80">
            <div className="flex w-full flex-wrap items-start gap-2 border-b border-border/80 px-3 py-2">
              <span className="text-xs font-medium text-foreground">
                Run insights
              </span>
              <RunHeaderCompactStats
                run={selectedRunDetails}
                statsOverride={statsOverrideForHeader}
                className="min-w-0 flex-1 pt-0.5 text-right sm:pl-2"
              />
            </div>
            <div className="px-3 py-2">{runInsightsBody}</div>
          </div>
        ) : null}
      </div>

      {/* Iteration list + detail (list may live in a parent sidebar when omitIterationList). */}
      <div
        className={cn(
          "flex gap-0 overflow-hidden",
          omitIterationList ? "mt-3 min-h-0 flex-1 flex-col" : "mt-4",
          !omitIterationList &&
            "rounded-xl border bg-card text-card-foreground min-h-[400px] h-[calc(100vh-200px)] max-h-[calc(100vh-200px)]",
        )}
        style={
          omitIterationList
            ? { minHeight: 400 }
            : undefined
        }
      >
        {!omitIterationList ? (
          <div className="flex w-[280px] shrink-0 flex-col border-r">
            <RunIterationsSidebar
              caseGroupsForSelectedRun={caseGroupsForSelectedRun}
              runDetailSortBy={runDetailSortBy}
              onSortChange={onSortChange}
              selectedIterationId={selectedIterationId}
              onSelectIteration={onSelectIteration}
              runForOverview={selectedRunDetails}
              onEditTestCase={(testCaseId) =>
                navigateToEvalsRoute({
                  type: "test-edit",
                  suiteId: selectedRunDetails.suiteId,
                  testId: testCaseId,
                })
              }
            />
          </div>
        ) : null}

        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          {selectedIteration ? (
            <div
              key={selectedIterationId}
              className={cn(
                "flex min-h-0 flex-1 flex-col overflow-y-auto",
                omitIterationList ? "space-y-3" : "space-y-4",
                !omitIterationList && "px-4",
              )}
            >
              <IterationDetails
                iteration={selectedIteration}
                testCase={null}
                serverNames={serverNames}
                layoutMode="full"
                caseInsightSlot={selectedIterationCaseInsightSlot}
              />
            </div>
          ) : (
            <div className="flex-1 flex items-center justify-center">
              <div className="text-sm text-muted-foreground">
                {caseGroupsForSelectedRun.length === 0
                  ? "No iterations in this run yet."
                  : "Select an iteration to view details"}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
