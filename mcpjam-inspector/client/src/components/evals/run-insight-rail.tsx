import { useMemo, type ReactNode } from "react";
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
import {
  runDetailHeroStatClass,
  runDetailMetaLabelClass,
  runDetailMetricClass,
  runDetailSupportingClass,
} from "./run-detail-typography";
import type { EvalIteration, EvalSuiteRun } from "./types";

export type RunTrendPoint = {
  runId: string;
  runIdDisplay: string;
  passRate: number;
  label: string;
  runNumber?: number;
};

const RUN_TREND_CHIP_LIMIT = 6;

function passRateToneClass(
  passRate: number,
  variant: "text" | "segment",
): string {
  if (passRate >= 80) {
    return variant === "text" ? "text-success" : "bg-success";
  }
  if (passRate >= 50) {
    return variant === "text" ? "text-warning" : "bg-warning";
  }
  return variant === "text" ? "text-destructive" : "bg-destructive/70";
}

function RunAccuracySegmentBar({
  passRate,
  className,
}: {
  passRate: number;
  className?: string;
}) {
  const filled = Math.min(10, Math.max(0, Math.round(passRate / 10)));
  const fillClass = passRateToneClass(passRate, "segment");

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
    "flex min-w-[10rem] flex-1 basis-[10rem] flex-col gap-2 rounded-lg border border-border/50 bg-muted/10 p-3 transition-colors sm:min-w-[11rem] sm:basis-[11rem] sm:p-3.5",
    isCurrent && "border-primary/35 bg-muted/30 ring-1 ring-inset ring-primary/25",
    canNavigate && "hover:border-border hover:bg-muted/25",
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
            "shrink-0 font-mono text-xl font-semibold tabular-nums leading-none",
            passRateToneClass(point.passRate, "text"),
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
    <section
      className={cn(
        "rounded-xl border border-border/60 bg-card text-card-foreground",
        className,
      )}
    >
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

  return (
    <RunInsightRailCard
      className={cn("shrink-0 p-4 sm:p-5", className)}
    >
      {includeRunIdentity ? (
        <div className="mb-4 flex flex-col gap-1 border-b border-border/40 pb-4">
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
            <div className="mt-2 flex flex-wrap items-center gap-2">
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
      ) : null}

      <div
        className={cn(
          "flex gap-4 sm:gap-6",
          hasRecentRuns
            ? "flex-col sm:flex-row sm:items-end"
            : "flex-col",
        )}
      >
        <div className="shrink-0 sm:min-w-[9rem]">
          <p className={runDetailMetaLabelClass}>{metricLabel}</p>
          <p className={cn("mt-1", runDetailHeroStatClass)}>
            {passRatePercent}
            <span className="text-2xl font-medium text-muted-foreground sm:text-3xl">
              %
            </span>
          </p>
          {deltaPp !== null && compareBaseRun ? (
            <p
              className={cn(
                "mt-1.5 font-mono text-sm font-medium tabular-nums",
                deltaPp > 0 && "text-success",
                deltaPp < 0 && "text-destructive",
                deltaPp === 0 && "text-muted-foreground",
              )}
            >
              {deltaPp > 0 ? "+" : ""}
              {deltaPp}pp vs run #
              {compareBaseRun.runNumber ?? formatRunId(compareBaseRun._id)}
            </p>
          ) : null}
        </div>

        {hasRecentRuns ? (
          <div className="min-w-0 flex-1">
            <div className="mb-2 flex items-baseline justify-between gap-2 sm:mb-2.5">
              <p className={runDetailMetaLabelClass}>Recent runs</p>
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
        ) : null}
      </div>
    </RunInsightRailCard>
  );
}

export function shouldShowRunAccuracyHero({
  run,
  iterations,
  runTrendData,
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

/** Right column: triage on top, charts below. */
export function RunInsightRail({
  run: _run,
  iterations: _iterations,
  source: _source,
  compareBaseRun: _compareBaseRun,
  runTrendData: _runTrendData = [],
  durationData,
  tokensData,
  hasTokenData,
  triageCard,
  className,
  onSelectRun: _onSelectRun,
}: {
  run: EvalSuiteRun;
  iterations: EvalIteration[];
  source?: "ui" | "sdk";
  compareBaseRun?: EvalSuiteRun | null;
  runTrendData?: RunTrendPoint[];
  onSelectRun?: (runId: string) => void;
  durationData: Array<{
    name: string;
    duration: number;
    durationSeconds: number;
  }>;
  tokensData: Array<{ name: string; tokens: number }>;
  hasTokenData: boolean;
  triageCard: ReactNode;
  className?: string;
}) {
  const hasBarCharts = durationData.length > 0 || hasTokenData;
  const hasContent = Boolean(triageCard) || hasBarCharts;

  if (!hasContent) return null;

  return (
    <aside
      className={cn(
        "flex min-h-0 min-w-0 flex-1 flex-col gap-3 overflow-y-auto",
        className,
      )}
    >
      {triageCard}

      {hasBarCharts ? (
        <RunInsightRailCard className="shrink-0 p-3">
          <RunMetricsBarCharts
            durationData={durationData}
            tokensData={tokensData}
            hasTokenData={hasTokenData}
          />
        </RunInsightRailCard>
      ) : null}
    </aside>
  );
}
