import { useMemo, type ReactNode } from "react";
import { Badge } from "@mcpjam/design-system/badge";
import { cn } from "@/lib/utils";
import { formatRelativeTime, formatRunId } from "./helpers";
import {
  computeRunPassFailStats,
  normalizeRunPassRatePercent,
} from "./ai-triage-helpers";
import { HostChip } from "@/components/hosts/host-chip";
import { PassCriteriaBadge } from "./pass-criteria-badge";
import { RunHeaderCompactStats } from "./run-header-compact-stats";
import { RunMetricsBarCharts } from "./run-metrics-bar-charts";
import type { DurationChartDatum, TokensChartDatum } from "./run-chart-data";
import {
  runDetailHeroStatClass,
  runDetailSectionLabelClass,
  runDetailSupportingClass,
} from "./run-detail-typography";
import type { EvalIteration, EvalSuiteRun } from "./types";
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

  /*
   * Compact recent-run chip. Previously these were ~11rem-wide cards with
   * an explicit segment bar and two-line meta — visually heavy for what is
   * essentially "run id + accuracy + is-this-the-current-run." Color and
   * the ring/dot now do the comparative lifting; full context is in the
   * hover title + the row that this navigates into.
   */
  const cardClassName = cn(
    "flex min-w-[5.5rem] flex-col gap-0.5 rounded-md border border-border/60 bg-muted/20 px-2 py-1.5 shadow-none transition-colors",
    isCurrent &&
      "border-primary/50 bg-primary/[0.07] ring-1 ring-inset ring-primary/30",
    canNavigate && "hover:border-border hover:bg-muted/40",
  );

  const cardBody = (
    <>
      <div className="flex items-baseline justify-between gap-1">
        <span
          className="truncate font-mono text-[10px] tabular-nums text-muted-foreground"
          title={point.runId}
        >
          {point.runIdDisplay}
        </span>
      </div>
      <span className="text-base font-semibold tabular-nums leading-tight tracking-tight text-foreground">
        {point.passRate}%
      </span>
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
  runTrendData,
  metricLabel,
  badgeMetricLabel = metricLabel,
  onSelectRun,
  includeRunIdentity = false,
  hideReplayLineage = false,
  runClient = null,
  className,
}: {
  run: EvalSuiteRun;
  iterations: EvalIteration[];
  /**
   * Previous completed run for deterministic diff context. Plumbed for
   * future re-surfacing (matrix wiring is separate); no UI consumes it
   * here today.
   */
  compareBaseRun?: EvalSuiteRun | null;
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

  const runServers = run.configSnapshot?.environment?.servers ?? [];
  const visibleServers = runServers.slice(0, 3);
  const hiddenServerCount = runServers.length - visibleServers.length;

  const runIdentityBlock = includeRunIdentity ? (
    <div className="flex shrink-0 flex-col gap-1.5 sm:max-w-[16rem]">
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
      <div className="flex flex-wrap items-baseline gap-x-1.5 text-xs text-muted-foreground">
        <RunHeaderCompactStats
          run={run}
          variant="operational"
          statsOverride={statsOverride}
        />
        {run.createdAt ? (
          <>
            <span aria-hidden>·</span>
            <span
              className="tabular-nums"
              title={new Date(run.createdAt).toLocaleString()}
            >
              {formatRelativeTime(run.createdAt)}
            </span>
          </>
        ) : null}
      </div>
      {runClient || runServers.length > 0 ? (
        <div className="flex flex-wrap items-center gap-1.5">
          {runClient ? (
            <HostChip
              name={runClient.displayName}
              hostId={runClient.hostId}
            />
          ) : null}
          {visibleServers.map((name) => (
            <Badge
              key={name}
              variant="outline"
              className="font-mono text-[10px] font-normal text-muted-foreground"
            >
              {name}
            </Badge>
          ))}
          {hiddenServerCount > 0 ? (
            <span
              className={runDetailSupportingClass}
              title={runServers.slice(visibleServers.length).join(", ")}
            >
              +{hiddenServerCount}
            </span>
          ) : null}
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
      <p className={runDetailHeroStatClass}>
        {passRatePercent}
        <span className="text-xl font-medium text-muted-foreground sm:text-2xl">
          %
        </span>
      </p>
    </div>
  );

  const recentRunsBlock = hasRecentRuns ? (
    <div className="flex min-w-0 flex-1 flex-col gap-2">
      <div className="flex min-w-0 items-baseline gap-2">
        <p className={runDetailSectionLabelClass}>Recent runs</p>
        {trendChips.hiddenCount > 0 ? (
          <p className={runDetailSupportingClass}>
            Last {RUN_TREND_CHIP_LIMIT} of {runTrendData.length}
          </p>
        ) : null}
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
            {recentRunsBlock}
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
