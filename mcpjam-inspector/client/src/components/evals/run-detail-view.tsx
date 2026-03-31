import { useMemo, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { motion, useReducedMotion, type Variants } from "framer-motion";
import { cn } from "@/lib/utils";
import { IterationDetails } from "./iteration-details";
import {
  evalStatusLeftBorderClasses,
  formatDuration,
  formatRunId,
} from "./helpers";
import { EVAL_OUTCOME_STATUS_TEXT_CLASS } from "./constants";
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
import { useServerQuality } from "./use-server-quality";
import { InsightPrimaryBlock } from "./insight-primary-block";
import { navigateToEvalsRoute } from "@/lib/evals-router";
import { ArrowUpDown, ChevronRight, ExternalLink } from "lucide-react";
import { getSidebarRunInsightsPassRateLabel } from "./run-header-compact-stats";
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
  onOpenRunInsights?: () => void;
  runInsightsSelected?: boolean;
  /** Overrides default navigation to test-edit for iteration row edit actions. */
  onEditTestCase?: (testCaseId: string) => void;
  /** When true, every iteration with testCaseId shows the external-edit icon. */
  alwaysShowEditIterationRows?: boolean;
}

function runDetailSortLabel(sortBy: "model" | "test" | "result"): string {
  switch (sortBy) {
    case "model":
      return "Model";
    case "test":
      return "Test";
    case "result":
      return "Result";
    default:
      return sortBy;
  }
}

function normalizeRunPassRatePercent(passRate: number): number {
  if (passRate > 0 && passRate <= 1) {
    return Math.round(passRate * 100);
  }
  return Math.round(passRate);
}

function IterationListItem({
  iteration,
  isSelected,
  onSelect,
  onEditTestCase,
  alwaysShowEditIterationRows = false,
}: {
  iteration: EvalIteration;
  isSelected: boolean;
  onSelect: () => void;
  /** When set, failed iterations with a testCaseId show an editor link. */
  onEditTestCase?: (testCaseId: string) => void;
  alwaysShowEditIterationRows?: boolean;
}) {
  const isPending =
    iteration.status === "pending" || iteration.status === "running";

  const testInfo = iteration.testCaseSnapshot;
  const modelName = testInfo?.model || "—";

  const computedResult = computeIterationResult(iteration);
  const isFailed = computedResult === "failed";
  const showEditLink =
    Boolean(onEditTestCase && iteration.testCaseId) &&
    (alwaysShowEditIterationRows || isFailed);

  const editLabel = isFailed ? "Edit in Playground" : "Edit";

  const caseTitle = testInfo?.title || "Iteration";
  const iterationAriaLabel = testInfo?.isNegativeTest
    ? `Negative test (expects the tool not to be called): ${caseTitle}, ${modelName}. View iteration details.`
    : `View iteration details: ${caseTitle}, ${modelName}`;

  return (
    <div
      className={cn(
        "relative border-l-2",
        evalStatusLeftBorderClasses(isPending ? "running" : computedResult),
        isPending && "opacity-60",
      )}
    >
      <div
        className={cn(
          "flex w-full min-w-0 items-center gap-0.5",
          isSelected
            ? "bg-primary/10 border-r-2 border-r-primary"
            : "hover:bg-muted/50",
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
          aria-label={iterationAriaLabel}
          className="flex min-w-0 flex-1 items-center gap-2 px-3 py-2.5 text-left transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/60 cursor-pointer"
        >
          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="text-xs font-medium leading-snug line-clamp-2">
              {caseTitle}
            </span>
            <span className="truncate text-[10px] font-mono text-muted-foreground">
              {modelName}
            </span>
          </span>
          <ChevronRight
            className="h-3.5 w-3.5 shrink-0 text-muted-foreground opacity-70"
            aria-hidden
          />
        </button>
        {showEditLink && iteration.testCaseId ? (
          <button
            type="button"
            className="mr-1.5 shrink-0 rounded-md p-1.5 text-primary transition-colors hover:bg-muted/80 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
            title={editLabel}
            aria-label={editLabel}
            onClick={(e) => {
              e.stopPropagation();
              onEditTestCase!(iteration.testCaseId!);
            }}
          >
            <ExternalLink className="h-3.5 w-3.5 opacity-90" aria-hidden />
          </button>
        ) : null}
      </div>
    </div>
  );
}

const ITERATION_STAGGER_CAP = 20;

const iterationListVariants: Variants = {
  hidden: {},
  visible: { transition: { staggerChildren: 0.03, delayChildren: 0.05 } },
};

const iterationItemVariants: Variants = {
  hidden: (i: number) =>
    i < ITERATION_STAGGER_CAP ? { opacity: 0, x: -6 } : { opacity: 1, x: 0 },
  visible: {
    opacity: 1,
    x: 0,
    transition: { duration: 0.15, ease: [0.16, 1, 0.3, 1] },
  },
};

function IterationListWithSections({
  iterations,
  sortBy,
  selectedIterationId,
  onSelectIteration,
  onEditTestCase,
  alwaysShowEditIterationRows = false,
}: {
  iterations: EvalIteration[];
  sortBy: "model" | "test" | "result";
  selectedIterationId: string | null;
  onSelectIteration: (id: string) => void;
  onEditTestCase?: (testCaseId: string) => void;
  alwaysShowEditIterationRows?: boolean;
}) {
  const shouldReduceMotion = useReducedMotion();

  const renderItems = (items: EvalIteration[]) => (
    <motion.div
      variants={shouldReduceMotion ? undefined : iterationListVariants}
      initial={shouldReduceMotion ? false : "hidden"}
      animate="visible"
    >
      {items.map((iteration, index) => (
        <motion.div
          key={iteration._id}
          custom={index}
          variants={shouldReduceMotion ? undefined : iterationItemVariants}
        >
          <IterationListItem
            iteration={iteration}
            isSelected={selectedIterationId === iteration._id}
            onSelect={() => onSelectIteration(iteration._id)}
            onEditTestCase={onEditTestCase}
            alwaysShowEditIterationRows={alwaysShowEditIterationRows}
          />
        </motion.div>
      ))}
    </motion.div>
  );

  if (sortBy !== "result") {
    return renderItems(iterations);
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

  return renderItems(ordered);
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
  onOpenRunInsights,
  runInsightsSelected = false,
  alwaysShowEditIterationRows = false,
}: {
  caseGroupsForSelectedRun: EvalIteration[];
  runDetailSortBy: "model" | "test" | "result";
  onSortChange: (sortBy: "model" | "test" | "result") => void;
  selectedIterationId: string | null;
  onSelectIteration: (id: string) => void;
  onEditTestCase?: (testCaseId: string) => void;
  /** When set, shows Run Insights summary above the iteration list (CI sidebar + inline run detail). */
  runForOverview?: EvalSuiteRun | null;
  /** Optional row below Run Insights (e.g. link to full runs table). */
  runOverviewExtra?: ReactNode;
  /** Opens run-level insights in the main pane (no iteration). */
  onOpenRunInsights?: () => void;
  runInsightsSelected?: boolean;
  alwaysShowEditIterationRows?: boolean;
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

  const overviewPassRateLabel = useMemo(() => {
    if (!runForOverview) return null;
    return getSidebarRunInsightsPassRateLabel(
      runForOverview,
      overviewStatsOverride,
    );
  }, [runForOverview, overviewStatsOverride]);

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col overflow-hidden">
      {runForOverview ? (
        <div className="shrink-0 border-b bg-muted/25">
          <RunInsightsSidebarSummary
            onClick={onOpenRunInsights}
            selected={runInsightsSelected}
            trailing={overviewPassRateLabel}
          />
          {runOverviewExtra ? (
            <div className="border-t px-4 pb-2 pt-2">{runOverviewExtra}</div>
          ) : null}
        </div>
      ) : null}
      <div className="flex shrink-0 items-center justify-between border-b px-3 py-2">
        <div className="text-xs font-semibold">Iterations</div>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="outline"
              size="icon"
              className="h-7 w-7 border-border/50 text-muted-foreground hover:text-foreground"
              aria-label={`Sort iterations: ${runDetailSortLabel(runDetailSortBy)}`}
              title={`Sort iterations: ${runDetailSortLabel(runDetailSortBy)}`}
            >
              <ArrowUpDown className="size-3.5" aria-hidden />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-[8rem]">
            <DropdownMenuRadioGroup
              value={runDetailSortBy}
              onValueChange={(value) =>
                onSortChange(value as "model" | "test" | "result")
              }
            >
              <DropdownMenuRadioItem value="model" className="text-xs">
                {runDetailSortLabel("model")}
              </DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="test" className="text-xs">
                {runDetailSortLabel("test")}
              </DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="result" className="text-xs">
                {runDetailSortLabel("result")}
              </DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
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
              alwaysShowEditIterationRows={alwaysShowEditIterationRows}
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
  onOpenRunInsights,
  runInsightsSelected = false,
  onEditTestCase: onEditTestCaseProp,
  alwaysShowEditIterationRows = false,
}: RunDetailViewProps) {
  const handleEditTestCase =
    onEditTestCaseProp ??
    ((testCaseId: string) =>
      navigateToEvalsRoute({
        type: "test-edit",
        suiteId: selectedRunDetails.suiteId,
        testId: testCaseId,
      }));
  const {
    summary: runInsightsSummary,
    pending: runInsightsPending,
    requested: runInsightsRequested,
    failedGeneration: runInsightsFailedGeneration,
    error: runInsightsError,
    requestRunInsights,
    unavailable: runInsightsUnavailable,
  } = useRunInsights(selectedRunDetails, { autoRequest: true });

  const {
    summary: serverQualitySummary,
    pending: serverQualityPending,
    requested: serverQualityRequested,
    failedGeneration: serverQualityFailedGeneration,
    error: serverQualityError,
    requestServerQuality,
    unavailable: serverQualityUnavailable,
  } = useServerQuality(selectedRunDetails, { autoRequest: true });

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

  const metricLabel = source === "sdk" ? "Pass Rate" : "Accuracy";
  const shouldReduceMotion = useReducedMotion();
  const passRatePercent =
    computedStats.total > 0
      ? normalizeRunPassRatePercent(computedStats.passRate)
      : null;
  const durationText =
    selectedRunDetails.completedAt && selectedRunDetails.createdAt
      ? formatDuration(
          selectedRunDetails.completedAt - selectedRunDetails.createdAt,
        )
      : "—";
  const totalDisplay =
    expected && isRunning
      ? `${computedStats.total.toLocaleString()} / ${expected.toLocaleString()}`
      : computedStats.total.toLocaleString();
  const runOutcomeSummary =
    computedStats.total === 0
      ? "No cases recorded yet."
      : isRunning && expected
        ? `${computedStats.total.toLocaleString()} of ${expected.toLocaleString()} cases completed`
        : `${computedStats.passed.toLocaleString()} of ${computedStats.total.toLocaleString()} tests passed`;
  const runDashboardKpis = [
    {
      label: metricLabel,
      value: passRatePercent !== null ? `${passRatePercent}%` : "—",
      detail: runOutcomeSummary,
      valueClass: undefined as string | undefined,
    },
    {
      label: "Passed",
      value: computedStats.passed.toLocaleString(),
      detail:
        computedStats.passed > 0 ? "successful cases" : "no passing cases yet",
      valueClass:
        computedStats.passed > 0
          ? EVAL_OUTCOME_STATUS_TEXT_CLASS.passed
          : undefined,
    },
    {
      label: "Failed",
      value: computedStats.failed.toLocaleString(),
      detail: computedStats.failed > 0 ? "needs review" : "nothing failed",
      valueClass:
        computedStats.failed > 0
          ? EVAL_OUTCOME_STATUS_TEXT_CLASS.failed
          : undefined,
    },
    {
      label: "Total",
      value: totalDisplay,
      detail: expected && isRunning ? "completed / expected" : "cases in run",
      valueClass: undefined,
    },
    {
      label: "Duration",
      value: durationText,
      detail: durationText === "—" ? "available when complete" : "wall-clock",
      valueClass: undefined,
    },
  ];

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
  const hasSecondaryBreakdown =
    selectedRunChartData.modelData.length >= 2 || hasRunBarCharts;

  const runInsightsNarrative =
    selectedRunDetails.status === "completed" && !runInsightsUnavailable ? (
      <RunInsightsPrimaryBlock
        embedded
        className={hasSecondaryBreakdown ? undefined : "border-b-0 pb-0"}
        summary={runInsightsSummary}
        pending={runInsightsPending}
        requested={runInsightsRequested}
        failedGeneration={runInsightsFailedGeneration}
        error={runInsightsError}
        onRetry={() => requestRunInsights(true)}
      />
    ) : null;

  const serverQualityNarrative =
    selectedRunDetails.status === "completed" && !serverQualityUnavailable ? (
      <InsightPrimaryBlock
        embedded
        title="Server quality"
        summary={serverQualitySummary}
        pending={serverQualityPending}
        requested={serverQualityRequested}
        failedGeneration={serverQualityFailedGeneration}
        error={serverQualityError}
        onRetry={() => requestServerQuality(true)}
        pendingLabel="Analyzing server quality…"
        requestingLabel="Requesting server quality analysis…"
        emptyLabel="We will analyze your MCP server's tool quality and workflow efficiency here."
      />
    ) : null;

  const runInsightsBody = (
    <div className="space-y-6">
      <div className="flex w-full min-w-0 flex-nowrap gap-3 sm:gap-4">
        {runDashboardKpis.map((stat, index) => (
          <motion.div
            key={`${stat.label}-${index}`}
            initial={shouldReduceMotion ? false : { opacity: 0, y: 8 }}
            animate={shouldReduceMotion ? undefined : { opacity: 1, y: 0 }}
            transition={
              shouldReduceMotion
                ? undefined
                : {
                    duration: 0.2,
                    delay: 0.04 * index,
                    ease: [0.16, 1, 0.3, 1],
                  }
            }
            className="flex min-w-0 flex-1 basis-0 flex-col rounded-xl border border-border/30 bg-gradient-to-b from-background/80 to-background/50 p-3 sm:p-4"
          >
            <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground/80">
              {stat.label}
            </div>
            <div
              className={cn(
                "mt-2 text-2xl font-semibold leading-none tracking-tight tabular-nums sm:mt-3 sm:text-3xl md:text-4xl",
                stat.valueClass,
              )}
            >
              {stat.value}
            </div>
            <div className="mt-1 line-clamp-2 text-[11px] text-muted-foreground/70">
              {stat.detail}
            </div>
          </motion.div>
        ))}
      </div>

      {runInsightsNarrative}
      {serverQualityNarrative}

      {hasSecondaryBreakdown ? (
        <div className="space-y-3">
          <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground/80">
            Breakdown
          </div>

          {selectedRunChartData.modelData.length >= 2 ? (
            <div className="flex flex-wrap items-center gap-2.5 rounded-xl border border-border/30 bg-background/60 px-3 py-3">
              {selectedRunChartData.modelData.map((model) => (
                <div
                  key={model.model}
                  className="inline-flex items-center gap-2 rounded-full border border-border/30 bg-background/80 px-2 py-1"
                >
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
                  <span className="text-[11px] text-foreground">
                    {model.model}
                  </span>
                  <span className="text-[11px] font-mono font-medium text-foreground">
                    {model.passRate}%
                  </span>
                  <span className="text-[10px] text-muted-foreground">
                    ({model.passed}/{model.total})
                  </span>
                </div>
              ))}
            </div>
          ) : null}

          {hasRunBarCharts ? (
            <RunMetricsBarCharts
              durationData={selectedRunChartData.durationData}
              tokensData={selectedRunChartData.tokensData}
              hasTokenData={hasTokenData}
            />
          ) : null}
        </div>
      ) : null}
    </div>
  );

  /** Sidebar layout: only grow the detail stack when an iteration is open (needs scroll). */
  const detailPaneFillsRemainingSpace =
    !omitIterationList || selectedIterationId !== null;

  return (
    <div
      className={cn(
        "relative flex flex-col",
        omitIterationList
          ? cn(
              "min-h-0 overflow-hidden px-3 py-3",
              detailPaneFillsRemainingSpace && "flex-1",
            )
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
          <div className="rounded-xl border border-border/40 bg-background/80 shadow-xs">
            <div className="flex w-full flex-wrap items-center gap-2 border-b border-border/80 px-4 py-2.5">
              <span className="text-xs font-semibold tracking-wide text-foreground">
                Run insights
              </span>
            </div>
            <div className="px-4 py-4">{runInsightsBody}</div>
          </div>
        ) : null}
      </div>

      {/* Iteration list + detail (list may live in a parent sidebar when omitIterationList). */}
      <div
        className={cn(
          "flex gap-0 overflow-hidden",
          omitIterationList
            ? cn(
                "mt-3 min-h-0 flex-col",
                detailPaneFillsRemainingSpace && "flex-1",
              )
            : "mt-4",
          !omitIterationList &&
            "rounded-xl border bg-card text-card-foreground min-h-[400px] h-[calc(100vh-200px)] max-h-[calc(100vh-200px)]",
        )}
        style={
          omitIterationList && detailPaneFillsRemainingSpace
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
              onEditTestCase={handleEditTestCase}
              onOpenRunInsights={onOpenRunInsights}
              runInsightsSelected={runInsightsSelected}
              alwaysShowEditIterationRows={alwaysShowEditIterationRows}
            />
          </div>
        ) : null}

        <div
          className={cn(
            "flex min-h-0 min-w-0 flex-col",
            detailPaneFillsRemainingSpace ? "flex-1" : "shrink-0",
          )}
        >
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
            <div className="flex min-h-[11rem] w-full shrink-0 items-center justify-center px-4 py-8 text-center text-sm text-muted-foreground">
              {caseGroupsForSelectedRun.length === 0
                ? "No iterations in this run yet."
                : "Select an iteration to view details"}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
