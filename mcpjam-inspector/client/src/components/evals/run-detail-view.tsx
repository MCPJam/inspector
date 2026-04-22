import { useMemo, type ReactNode } from "react";
import { Button } from "@mcpjam/design-system/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@mcpjam/design-system/dropdown-menu";
import { motion, useReducedMotion, type Variants } from "framer-motion";
import { cn } from "@/lib/utils";
import {
  formatRelativeTime,
  formatRunId,
  getIterationRecencyTimestamp,
} from "./helpers";
import { RunMetricsBarCharts } from "./run-metrics-bar-charts";
import {
  computeIterationResult,
  computeIterationPassed,
} from "./pass-criteria";
import {
  getIterationResultDisplayLabel,
  iterationResultBadgeClassNames,
} from "./iteration-result-presentation";
import { EvalIteration, EvalSuiteRun } from "./types";
import { CiMetadataDisplay } from "./ci-metadata-display";
import { useRunInsights } from "./use-run-insights";
import { useServerQuality } from "./use-server-quality";
import { InsightPrimaryBlock } from "./insight-primary-block";
import { navigateToEvalsRoute } from "@/lib/evals-router";
import { ArrowUpDown, ExternalLink } from "lucide-react";
import { getSidebarRunInsightsPassRateLabel } from "./run-header-compact-stats";
import { RunInsightsSidebarSummary } from "./run-insights-sidebar";
import { computeRunDashboardKpis } from "./run-detail-kpis";
import { RunDetailInsightCollapsible } from "./run-detail-insight-collapsible";
import {
  caseListCardClassName,
  caseListDataRowClassName,
  CaseListColumnHeaders,
} from "./case-list-shared";

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
  /**
   * `header` = KPI cards are rendered in {@link SuiteHeader} (playground run detail).
   * `body` = KPI row stays in this view (CI / commit detail).
   */
  kpiPlacement?: "header" | "body";
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

/** Result column matching {@link TestCasesOverview} “Last run” (badge + relative time). */
function iterationSuiteStyleResultSummary(iteration: EvalIteration) {
  const computedResult = computeIterationResult(iteration);
  const resultLabel = getIterationResultDisplayLabel(iteration);
  const ts = getIterationRecencyTimestamp(iteration);
  const relative = ts > 0 ? formatRelativeTime(ts) : null;

  const status =
    computedResult === "passed" || computedResult === "failed" ? (
      <span
        className={iterationResultBadgeClassNames(iteration)}
        aria-label={`Result: ${resultLabel}`}
      >
        {resultLabel}
      </span>
    ) : (
      <span className="text-xs font-medium text-muted-foreground">
        {resultLabel}
      </span>
    );

  return (
    <>
      {status}
      {relative ? (
        <span className="font-normal text-xs text-muted-foreground tabular-nums">
          {" "}
          · {relative}
        </span>
      ) : null}
    </>
  );
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
  const resultLabel = getIterationResultDisplayLabel(iteration);
  const iterationAriaLabel = testInfo?.isNegativeTest
    ? `Negative test (expects the tool not to be called): ${caseTitle}, ${modelName}. View iteration details.`
    : `View iteration details: ${caseTitle}, ${resultLabel}, ${modelName}`;

  const rowTitle =
    testInfo?.isNegativeTest === true
      ? "Negative test — expects the tool NOT to be called"
      : modelName && modelName !== "—"
        ? `${caseTitle} — ${modelName}`
        : caseTitle;

  return (
    <div
      className={caseListDataRowClassName({
        isSelected,
        isDimmed: isPending,
      })}
    >
      <button
        type="button"
        onClick={onSelect}
        title={rowTitle}
        aria-label={iterationAriaLabel}
        className="flex min-w-0 flex-1 cursor-pointer items-center gap-3 rounded-sm text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
      >
        <span className="min-w-0 flex-1 truncate text-left text-xs font-semibold text-foreground">
          {caseTitle}
        </span>
        <div className="flex max-w-[min(100%,20rem)] min-w-0 flex-1 items-center justify-end gap-2 text-right text-xs tabular-nums">
          {iterationSuiteStyleResultSummary(iteration)}
        </div>
      </button>
      {showEditLink && iteration.testCaseId ? (
        <span className="inline-flex shrink-0">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 w-7 p-0 text-primary"
            title={editLabel}
            aria-label={editLabel}
            onClick={(e) => {
              e.stopPropagation();
              onEditTestCase!(iteration.testCaseId!);
            }}
          >
            <ExternalLink className="h-3.5 w-3.5" aria-hidden />
          </Button>
        </span>
      ) : null}
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
      <div className="divide-y divide-border/40">
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
      </div>
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
  /** When set, shows run overview row above the iteration list (CI sidebar + inline run detail). */
  runForOverview?: EvalSuiteRun | null;
  /** Optional row below overview (e.g. link to full runs table). */
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
      {/*
        Inset a rounded case list (same visual language as suite “Cases”, img2):
        top toolbar = sort, then column headers, then rows on bg-background.
      */}
      <div className="box-border flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden p-1.5 pt-1.5 sm:p-2">
        <div
          className={cn(
            caseListCardClassName,
            "min-h-0 min-w-0 flex-1 overflow-hidden shadow-sm",
          )}
        >
          <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border/50 bg-muted/30 px-3 py-2">
            <div className="min-w-0 text-[11px] font-medium text-muted-foreground">
              Sort: {runDetailSortLabel(runDetailSortBy)}
            </div>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  className="h-7 w-7 shrink-0 border-border/50 bg-background text-muted-foreground hover:text-foreground"
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
          {caseGroupsForSelectedRun.length > 0 ? (
            <CaseListColumnHeaders
              firstColumnLabel="Case name"
              secondColumnLabel="Last run"
              trailingGutter={Boolean(onEditTestCase)}
            />
          ) : null}
          <div className="min-h-0 flex-1 overflow-y-auto bg-background">
            {caseGroupsForSelectedRun.length === 0 ? (
              <div className="px-4 py-8 text-center text-sm text-muted-foreground">
                No test cases in this run yet.
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
  kpiPlacement = "body",
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
    pending: runInsightsPending,
    requested: runInsightsRequested,
    failedGeneration: runInsightsFailedGeneration,
    error: runInsightsError,
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

  const shouldReduceMotion = useReducedMotion();
  const runDashboardKpis = useMemo(
    () =>
      kpiPlacement === "body"
        ? computeRunDashboardKpis({
            selectedRunDetails,
            caseGroupsForSelectedRun,
            source,
          })
        : [],
    [kpiPlacement, selectedRunDetails, caseGroupsForSelectedRun, source],
  );

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

  const embeddedInsightCardClass =
    "rounded-none border-0 border-l-0 bg-transparent p-0 py-0 shadow-none ring-0";

  const serverQualityNarrative =
    selectedRunDetails.status === "completed" && !serverQualityUnavailable ? (
      <RunDetailInsightCollapsible title="Server quality">
        <InsightPrimaryBlock
          embedded
          title="Server quality"
          className={embeddedInsightCardClass}
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
      </RunDetailInsightCollapsible>
    ) : null;

  const runInsightsBody = (
    <div className="space-y-6">
      {kpiPlacement === "body" && runDashboardKpis.length > 0 ? (
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
              className="flex min-w-0 flex-1 basis-0 flex-col rounded-lg border border-border/25 bg-muted/10 p-3 sm:p-4"
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
              {stat.detail ? (
                <div className="mt-1 line-clamp-2 text-[11px] text-muted-foreground/70">
                  {stat.detail}
                </div>
              ) : null}
            </motion.div>
          ))}
        </div>
      ) : null}

      {serverQualityNarrative}

      {hasSecondaryBreakdown ? (
        <div className="space-y-3">
          {selectedRunChartData.modelData.length >= 2 ? (
            <div className="flex flex-wrap items-center gap-2.5 rounded-lg border border-border/25 bg-muted/10 px-3 py-3">
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

  return (
    <div
      className={cn(
        "relative flex min-h-0 w-full min-w-0 flex-1 flex-col overflow-hidden",
        omitIterationList ? "px-3 py-3" : "p-4",
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

        {/* Run-level KPIs, narrative, and charts stay visible while drilling into an iteration (graphs no longer disappear). */}
        <div className="shrink-0">
          {runInsightsBody}
        </div>
      </div>

      {/* Iteration list only (details open from row actions / navigation). List may live in a parent when omitIterationList. */}
      {!omitIterationList ? (
        <div
          className={cn(
            "mt-4 flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden",
            "min-h-[240px] rounded-xl border border-border/40 bg-card text-card-foreground",
          )}
        >
          <div className="flex h-full min-h-0 w-full min-w-0 flex-1 flex-col overflow-hidden">
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
        </div>
      ) : null}
    </div>
  );
}
