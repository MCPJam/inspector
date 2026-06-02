import { useMemo, type ReactNode } from "react";
import { ArrowLeftRight } from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import { cn } from "@/lib/utils";
import { formatRunId } from "./helpers";
import {
  computeRunPassFailStats,
  normalizeRunPassRatePercent,
} from "./ai-triage-helpers";
import { ClientChip } from "@/components/clients/client-chip";
import { PassCriteriaBadge } from "./pass-criteria-badge";
import { RunHeaderCompactStats } from "./run-header-compact-stats";
import { RunMetricsBarCharts } from "./run-metrics-bar-charts";
import type { DurationChartDatum, TokensChartDatum } from "./run-chart-data";
import {
  runDetailHeroStatClass,
  runDetailMetaLabelClass,
  runDetailSectionLabelClass,
  runDetailSupportingClass,
} from "./run-detail-typography";
import type { EvalIteration, EvalSuiteRun } from "./types";
import {
  passRateColorClass,
  passRateSegmentColorClass,
} from "./suite-overview-presentation";
import { EVAL_LOW_PASS_RATE_TEXT_CLASS } from "./constants";
import { evalSurfaceCardClass } from "./eval-surface-chrome";

export type RunTrendPoint = {
  runId: string;
  runIdDisplay: string;
  passRate: number;
  passed?: number;
  total?: number;
  label: string;
  runNumber?: number;
};

const RUN_TREND_CHIP_LIMIT = 6;

function RunAccuracySegmentBar({
  passRate,
  className,
}: {
  passRate: number;
  className?: string;
}) {
  const filled = Math.min(10, Math.max(0, Math.round(passRate / 10)));
  const fillClass = passRateSegmentColorClass(passRate);

  return (
    <div
      className={cn("grid h-2 w-full grid-cols-10 gap-px", className)}
      aria-hidden
    >
      {Array.from({ length: 10 }, (_, index) => (
        <span
          key={index}
          className={cn(
            "min-h-full rounded-[1px]",
            index < filled ? fillClass : "bg-muted-foreground/15",
          )}
        />
      ))}
    </div>
  );
}

function runAccuracyCardContextLabel(
  point: RunTrendPoint & { runIndexLabel: string },
  isCurrent: boolean,
): string {
  if (isCurrent) return "Current run";
  if (point.runNumber !== undefined) return `Suite run #${point.runNumber}`;
  return `Recent ${point.runIndexLabel}`;
}

function RunAccuracyRunCard({
  point,
  isCurrent,
  onSelectRun,
}: {
  point: RunTrendPoint & { runIndexLabel: string };
  isCurrent: boolean;
  onSelectRun?: (runId: string) => void;
}) {
  const contextLabel = runAccuracyCardContextLabel(point, isCurrent);
  const canNavigate = Boolean(onSelectRun) && !isCurrent;
  const cardSummary = `Run ${point.runIdDisplay}, ${point.passRate}% accuracy, ${contextLabel}`;

  const cardClassName = cn(
    "flex min-w-[10rem] flex-1 basis-[10rem] flex-col gap-2 rounded-lg border border-border/80 bg-muted/30 p-3 shadow-sm transition-colors sm:min-w-[11rem] sm:basis-[11rem] sm:p-3.5",
    isCurrent &&
      "border-primary/50 bg-muted/45 ring-1 ring-inset ring-primary/35 shadow-sm",
    canNavigate && "hover:border-border hover:bg-muted/45",
  );

  const cardBody = (
    <>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <p
            className="truncate text-sm font-medium leading-tight text-foreground"
            title={point.runId}
          >
            Run{" "}
            <span className="font-mono font-normal tabular-nums">
              {point.runIdDisplay}
            </span>
          </p>
          <p
            className={cn(
              "mt-0.5 truncate text-[11px] leading-tight",
              isCurrent
                ? "font-medium text-primary"
                : "text-muted-foreground",
            )}
          >
            {contextLabel}
          </p>
        </div>
        <span
          className={cn(
            "shrink-0 font-metric text-xl font-semibold tabular-nums leading-none tracking-tight",
            passRateColorClass(point.passRate),
          )}
        >
          {point.passRate}%
        </span>
      </div>
      <RunAccuracySegmentBar passRate={point.passRate} />
    </>
  );

  if (canNavigate) {
    return (
      <button
        type="button"
        onClick={() => onSelectRun?.(point.runId)}
        aria-label={`Open ${cardSummary}`}
        className={cn(
          cardClassName,
          "text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        )}
        title={cardSummary}
      >
        {cardBody}
      </button>
    );
  }

  return (
    <div
      className={cardClassName}
      title={cardSummary}
      aria-current={isCurrent ? "true" : undefined}
    >
      {cardBody}
    </div>
  );
}

function RunInsightRailCard({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={cn(evalSurfaceCardClass, className)}>
      {children}
    </section>
  );
}

/** Full-width band: run identity, accuracy hero, and recent-run cards. */
export function RunAccuracyHeroBand({
  run,
  iterations,
  compareBaseRun,
  runTrendData,
  metricLabel,
  badgeMetricLabel = metricLabel,
  onSelectRun,
  onCompareWithRun,
  includeRunIdentity = false,
  hideReplayLineage = false,
  runClient = null,
  className,
}: {
  run: EvalSuiteRun;
  iterations: EvalIteration[];
  compareBaseRun: EvalSuiteRun | null;
  runTrendData: RunTrendPoint[];
  metricLabel: string;
  /** Pass/fail badge copy (e.g. "Accuracy" vs "Pass Rate"). */
  badgeMetricLabel?: string;
  onSelectRun?: (runId: string) => void;
  /** Opens the deterministic diff against {@link compareBaseRun}. */
  onCompareWithRun?: (baseRunId: string) => void;
  /** Title, outcome badge, and operational stats (playground run detail). */
  includeRunIdentity?: boolean;
  hideReplayLineage?: boolean;
  /** Attached client this run was executed against (multi-client fan-out). */
  runClient?: { hostId: string; displayName: string } | null;
  className?: string;
}) {
  const stats = useMemo(
    () =>
      computeRunPassFailStats({
        selectedRunDetails: run,
        caseGroupsForSelectedRun: iterations,
      }),
    [run, iterations],
  );

  const passRatePercent =
    stats.total > 0
      ? normalizeRunPassRatePercent(stats.passRate)
      : run.summary
        ? normalizeRunPassRatePercent(run.summary.passRate)
        : null;

  const basePassRate = compareBaseRun?.summary
    ? normalizeRunPassRatePercent(compareBaseRun.summary.passRate)
    : null;

  const deltaPp =
    passRatePercent !== null && basePassRate !== null
      ? passRatePercent - basePassRate
      : null;

  const trendChips = useMemo(() => {
    if (runTrendData.length < 2) return { points: [], hiddenCount: 0 };
    const visible =
      runTrendData.length > RUN_TREND_CHIP_LIMIT
        ? runTrendData.slice(-RUN_TREND_CHIP_LIMIT)
        : runTrendData;
    const offset = runTrendData.length - visible.length;
    return {
      points: visible.map((point, index) => ({
        ...point,
        runIndexLabel: `#${offset + index + 1}`,
        isCurrent: point.runId === run._id,
      })),
      hiddenCount: runTrendData.length - visible.length,
    };
  }, [runTrendData, run._id]);

  if (passRatePercent === null) return null;

  const hasRecentRuns = trendChips.points.length >= 2;

  const statsOverride =
    stats.total > 0
      ? {
          passed: stats.passed,
          failed: stats.failed,
          total: stats.total,
          passRate: stats.passRate,
        }
      : undefined;

  const runIdentityBlock = includeRunIdentity ? (
    <div className="flex shrink-0 flex-col gap-1 sm:max-w-[11rem]">
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        <h2 className="text-lg font-semibold tracking-tight">
          Run {formatRunId(run._id)}
        </h2>
        <PassCriteriaBadge
          run={run}
          variant="compact"
          metricLabel={badgeMetricLabel}
        />
      </div>
      <RunHeaderCompactStats
        run={run}
        variant="operational"
        statsOverride={statsOverride}
      />
      {runClient ? (
        <div className="flex flex-wrap items-center gap-2">
          <span className={runDetailMetaLabelClass}>Client</span>
          <ClientChip
            name={runClient.displayName}
            hostId={runClient.hostId}
          />
        </div>
      ) : null}
      {!hideReplayLineage && run.replayedFromRunId ? (
        <p
          className="text-xs text-muted-foreground"
          title={run.replayedFromRunId}
        >
          Replay of{" "}
          <span className="font-mono text-foreground/80">
            Run {formatRunId(run.replayedFromRunId)}
          </span>
        </p>
      ) : null}
    </div>
  ) : null;

  const accuracyBlock = (
    <div
      className={cn(
        "flex shrink-0 flex-col gap-1 sm:min-w-[9rem]",
        includeRunIdentity && "sm:items-end sm:text-right",
      )}
    >
      <p className={runDetailSectionLabelClass}>{metricLabel}</p>
      <p className={cn(runDetailHeroStatClass, passRateColorClass(passRatePercent))}>
        {passRatePercent}
        <span className="text-2xl font-medium text-muted-foreground sm:text-3xl">
          %
        </span>
      </p>
      {deltaPp !== null && compareBaseRun ? (
        <p
          className={cn(
            "font-metric text-sm font-medium tabular-nums",
            deltaPp > 0 && "text-success",
            deltaPp < 0 && EVAL_LOW_PASS_RATE_TEXT_CLASS,
            deltaPp === 0 && "text-muted-foreground",
          )}
        >
          {deltaPp > 0 ? "+" : ""}
          {deltaPp}pp vs run #
          {compareBaseRun.runNumber ?? formatRunId(compareBaseRun._id)}
        </p>
      ) : null}
    </div>
  );

  const compareButton =
    compareBaseRun && onCompareWithRun ? (
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => onCompareWithRun(compareBaseRun._id)}
        className="h-7 shrink-0 gap-1.5 text-xs"
      >
        <ArrowLeftRight className="h-3.5 w-3.5" aria-hidden />
        Compare to previous run
      </Button>
    ) : null;

  const recentRunsBlock = hasRecentRuns ? (
    <div className="flex min-w-0 flex-1 flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-baseline gap-2">
          <p className={runDetailSectionLabelClass}>Recent runs</p>
          {trendChips.hiddenCount > 0 ? (
            <p className={runDetailSupportingClass}>
              Last {RUN_TREND_CHIP_LIMIT} of {runTrendData.length}
            </p>
          ) : null}
        </div>
        {compareButton}
      </div>
      <div
        className="flex w-full min-w-0 gap-3 overflow-x-auto pb-0.5 [scrollbar-width:thin]"
        aria-label={`${metricLabel} across recent suite runs`}
      >
        {trendChips.points.map((point) => (
          <RunAccuracyRunCard
            key={point.runId}
            point={point}
            isCurrent={point.isCurrent}
            onSelectRun={onSelectRun}
          />
        ))}
      </div>
    </div>
  ) : null;

  // With run identity: title/stats and recent runs share one row; accuracy on the right.
  if (includeRunIdentity) {
    return (
      <RunInsightRailCard className={cn("shrink-0 p-4 sm:p-5", className)}>
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between sm:gap-6">
          <div className="flex min-w-0 flex-1 flex-col gap-4 sm:flex-row sm:items-start sm:gap-4">
            {runIdentityBlock}
            {recentRunsBlock ?? (
              compareButton ? (
                <div className="flex min-w-0 flex-1 items-start justify-end sm:justify-start">
                  {compareButton}
                </div>
              ) : null
            )}
          </div>
          {accuracyBlock}
        </div>
      </RunInsightRailCard>
    );
  }

  return (
    <RunInsightRailCard className={cn("shrink-0 p-4 sm:p-5", className)}>
      <div
        className={cn(
          "flex gap-4 sm:gap-6",
          hasRecentRuns ? "flex-col sm:flex-row sm:items-end" : "flex-col",
        )}
      >
        {accuracyBlock}
        {recentRunsBlock}
      </div>
    </RunInsightRailCard>
  );
}

export function shouldShowRunAccuracyHero({
  run,
  iterations,
}: {
  run: EvalSuiteRun;
  iterations: EvalIteration[];
  runTrendData: RunTrendPoint[];
}): boolean {
  const stats = computeRunPassFailStats({
    selectedRunDetails: run,
    caseGroupsForSelectedRun: iterations,
  });
  const passRatePercent =
    stats.total > 0
      ? normalizeRunPassRatePercent(stats.passRate)
      : run.summary
        ? normalizeRunPassRatePercent(run.summary.passRate)
        : null;
  return passRatePercent !== null;
}

/** Full-width duration / token bars below the run hero band. */
export function RunDetailMetricsCharts({
  durationData,
  tokensData,
  hasTokenData,
  className,
}: {
  durationData: DurationChartDatum[];
  tokensData: TokensChartDatum[];
  hasTokenData: boolean;
  className?: string;
}) {
  const hasBarCharts = durationData.length > 0 || hasTokenData;
  if (!hasBarCharts) return null;

  return (
    <RunInsightRailCard className={cn("shrink-0 p-2 sm:p-3", className)}>
      <RunMetricsBarCharts
        durationData={durationData}
        tokensData={tokensData}
        hasTokenData={hasTokenData}
      />
    </RunInsightRailCard>
  );
}

/** Right column: AI insights only. */
export function RunInsightRail({
  triageCard,
  goalCompletionCard,
  className,
}: {
  triageCard: ReactNode;
  /** Advisory LLM-as-judge panel rendered below the triage card. */
  goalCompletionCard?: ReactNode;
  className?: string;
}) {
  if (!triageCard && !goalCompletionCard) return null;

  return (
    <aside
      className={cn(
        "flex h-full min-h-0 w-full flex-1 flex-col gap-3 overflow-y-auto overscroll-y-contain",
        className,
      )}
    >
      {triageCard}
      {goalCompletionCard}
    </aside>
  );
}
