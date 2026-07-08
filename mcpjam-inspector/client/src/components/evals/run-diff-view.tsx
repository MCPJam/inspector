import { useEffect, useMemo, useState } from "react";
import { useAction } from "convex/react";
import { Button } from "@mcpjam/design-system/button";
import { AlertCircle, ArrowLeft, ExternalLink, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { formatDuration, formatRunId, formatTime } from "./helpers";
import type {
  EvalRunDiff,
  EvalRunDiffCaseStatus,
  EvalRunDiffSide,
  EvalRunNumericDiff,
} from "./types";

type RunDiffViewProps = {
  baseRunId: string;
  compareRunId: string;
  previewChars?: number;
  /** Hide the title block when a parent (e.g. group compare pickers) already shows context. */
  hideHeader?: boolean;
  onBackToRun?: () => void;
  onOpenIteration?: (runId: string, iterationId: string) => void;
};

type DiffState =
  | { status: "loading"; data: null; error: null }
  | { status: "loaded"; data: EvalRunDiff; error: null }
  | { status: "error"; data: null; error: string };

type DiffMetricFormat =
  | "duration"
  | "signedDuration"
  | "number"
  | "percent"
  | "cost";

export function RunDiffView({
  baseRunId,
  compareRunId,
  previewChars = 0,
  hideHeader = false,
  onBackToRun,
  onOpenIteration,
}: RunDiffViewProps) {
  const getRunDiff = useAction(
    "testSuites:getTestSuiteRunDiff" as any
  ) as unknown as (args: {
    baseRunId: string;
    compareRunId: string;
    previewChars?: number;
  }) => Promise<EvalRunDiff>;

  const [state, setState] = useState<DiffState>({
    status: "loading",
    data: null,
    error: null,
  });

  useEffect(() => {
    let cancelled = false;
    setState({ status: "loading", data: null, error: null });

    getRunDiff({ baseRunId, compareRunId, previewChars })
      .then((data) => {
        if (!cancelled) {
          setState({ status: "loaded", data, error: null });
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setState({
            status: "error",
            data: null,
            error:
              error instanceof Error
                ? error.message
                : "Failed to load run diff.",
          });
        }
      });

    return () => {
      cancelled = true;
    };
  }, [baseRunId, compareRunId, getRunDiff, previewChars]);

  if (state.status === "loading") {
    return (
      <div className="flex min-h-[240px] flex-1 items-center justify-center rounded-lg border border-dashed border-border/60 bg-muted/10 p-8">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
          Loading run diff...
        </div>
      </div>
    );
  }

  if (state.status === "error") {
    return (
      <div className="flex min-h-[240px] flex-1 items-center justify-center rounded-lg border border-destructive/30 bg-destructive/5 p-8">
        <div className="max-w-lg text-center">
          <AlertCircle
            className="mx-auto h-5 w-5 text-destructive"
            aria-hidden
          />
          <h2 className="mt-3 text-sm font-semibold text-foreground">
            Could not load run diff
          </h2>
          <p className="mt-1 text-xs text-muted-foreground">{state.error}</p>
          {onBackToRun ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="mt-4"
              onClick={onBackToRun}
            >
              <ArrowLeft className="mr-2 h-3.5 w-3.5" aria-hidden />
              Back to run
            </Button>
          ) : null}
        </div>
      </div>
    );
  }

  return (
    <RunDiffLoaded
      diff={state.data}
      hideHeader={hideHeader}
      onBackToRun={onBackToRun}
      onOpenIteration={onOpenIteration}
    />
  );
}

function RunDiffLoaded({
  diff,
  hideHeader = false,
  onBackToRun,
  onOpenIteration,
}: {
  diff: EvalRunDiff;
  hideHeader?: boolean;
  onBackToRun?: () => void;
  onOpenIteration?: (runId: string, iterationId: string) => void;
}) {
  const changedCount = useMemo(
    () => diff.cases.filter((row) => row.status !== "unchanged_passed").length,
    [diff.cases]
  );

  const metricLabel = diff.suite.source === "sdk" ? "Pass rate" : "Accuracy";

  const summaryMetrics = useMemo(
    () =>
      [
        { label: metricLabel, diff: diff.scores.passRatePercent, format: "percent" as const, higherIsBetter: true },
        { label: "Passed", diff: diff.scores.passed, format: "number" as const, higherIsBetter: true },
        { label: "Failed", diff: diff.scores.failed, format: "number" as const },
        { label: "Total", diff: diff.scores.total, format: "number" as const, neutral: true },
      ],
    [diff.scores, metricLabel]
  );

  const performanceMetrics = useMemo(
    () =>
      (
        [
          { label: "Duration", diff: diff.metrics.wallDurationMs, format: "duration" as const },
          { label: "Tokens", diff: diff.metrics.totalTokens, format: "number" as const },
          { label: "Input tokens", diff: diff.metrics.inputTokens, format: "number" as const },
          { label: "Output tokens", diff: diff.metrics.outputTokens, format: "number" as const },
          { label: "Cached tokens", diff: diff.metrics.cachedInputTokens, format: "number" as const },
          { label: "Reasoning tokens", diff: diff.metrics.reasoningTokens, format: "number" as const },
          { label: "Cost", diff: diff.metrics.estimatedCostUsd, format: "cost" as const },
        ] satisfies Array<{
          label: string;
          diff: EvalRunNumericDiff;
          format: DiffMetricFormat;
        }>
      ).filter((metric) => metricHasData(metric.diff)),
    [diff.metrics]
  );

  const changedPerformanceMetrics = performanceMetrics.filter((metric) =>
    metricChanged(metric.diff)
  );

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-4">
      {!hideHeader ? (
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="text-lg font-semibold tracking-tight">
              Run {formatRunId(diff.baseRun.id)} vs Run{" "}
              {formatRunId(diff.compareRun.id)}
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              {diff.suite.name}
              {" · "}
              {changedCount === 0
                ? "No case changes"
                : `${changedCount} changed case${changedCount === 1 ? "" : "s"}`}
              {" · "}
              {diff.cases.length} total
            </p>
          </div>
          {onBackToRun ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={onBackToRun}
            >
              <ArrowLeft className="mr-2 h-3.5 w-3.5" aria-hidden />
              Back to run
            </Button>
          ) : null}
        </div>
      ) : (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-sm text-muted-foreground">
            <span className="font-medium text-foreground">{diff.suite.name}</span>
            {" · "}
            {changedCount === 0
              ? "No case changes"
              : `${changedCount} changed case${changedCount === 1 ? "" : "s"}`}
            {" · "}
            {diff.cases.length} case{diff.cases.length === 1 ? "" : "s"}
          </p>
          <p className="text-xs text-muted-foreground">
            {formatTime(diff.baseRun.createdAt)} → {formatTime(diff.compareRun.createdAt)}
          </p>
        </div>
      )}

      <section className="rounded-lg border border-border/60 bg-card px-4 py-3">
        <div className="flex flex-wrap gap-x-6 gap-y-3">
          {summaryMetrics.map((metric) => (
            <SummaryMetric
              key={metric.label}
              label={metric.label}
              diff={metric.diff}
              format={metric.format}
              higherIsBetter={metric.higherIsBetter}
              neutral={metric.neutral}
            />
          ))}
        </div>
        {changedPerformanceMetrics.length > 0 ? (
          <div className="mt-3 flex flex-wrap gap-x-6 gap-y-2 border-t border-border/40 pt-3">
            {changedPerformanceMetrics.map((metric) => (
              <SummaryMetric
                key={metric.label}
                label={metric.label}
                diff={metric.diff}
                format={metric.format}
              />
            ))}
          </div>
        ) : null}
      </section>

      <section className="min-h-0 rounded-lg border border-border/60 bg-card">
        <div className="flex items-center justify-between border-b border-border/40 px-4 py-2.5">
          <h3 className="text-sm font-medium">Cases</h3>
          <span className="text-xs text-muted-foreground tabular-nums">
            {diff.cases.length}
          </span>
        </div>
        <div className="divide-y divide-border/40">
          {diff.cases.length === 0 ? (
            <div className="px-4 py-8 text-center text-sm text-muted-foreground">
              No cases were found in either run.
            </div>
          ) : (
            diff.cases.map((row) => (
              <CaseRow
                key={row.caseKey}
                row={row}
                baseRunId={diff.baseRun.id}
                compareRunId={diff.compareRun.id}
                onOpenIteration={onOpenIteration}
              />
            ))
          )}
        </div>
      </section>
    </div>
  );
}

function SummaryMetric({
  label,
  diff,
  format,
  higherIsBetter = false,
  neutral = false,
}: {
  label: string;
  diff: EvalRunNumericDiff;
  format: DiffMetricFormat;
  higherIsBetter?: boolean;
  neutral?: boolean;
}) {
  const changed = metricChanged(diff);

  return (
    <div className="min-w-0">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-0.5 flex min-w-0 flex-wrap items-center gap-1.5 text-sm tabular-nums">
        {changed ? (
          <>
            <span className="text-muted-foreground">
              {formatMetricValue(diff.base, format)}
            </span>
            <span className="text-muted-foreground">→</span>
            <span className="font-medium text-foreground">
              {formatMetricValue(diff.compare, format)}
            </span>
            <DeltaPill
              diff={diff}
              format={format}
              higherIsBetter={higherIsBetter}
              neutral={neutral}
            />
          </>
        ) : (
          <span className="font-medium text-foreground">
            {formatMetricValue(diff.compare ?? diff.base, format)}
          </span>
        )}
      </div>
    </div>
  );
}

function CaseRow({
  row,
  baseRunId,
  compareRunId,
  onOpenIteration,
}: {
  row: EvalRunDiff["cases"][number];
  baseRunId: string;
  compareRunId: string;
  onOpenIteration?: (runId: string, iterationId: string) => void;
}) {
  const isCompact = row.status === "unchanged_passed" && !row.configChanged;

  const durationChanged = metricChanged(row.metrics.durationMs);
  const tokensChanged = metricChanged(row.metrics.totalTokens);

  return (
    <div className="px-4 py-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <StatusBadge status={row.status} />
            {row.configChanged ? (
              <span className="rounded bg-warning/50 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-foreground">
                Config changed
              </span>
            ) : null}
            <h4 className="min-w-0 truncate text-sm font-medium">{row.title}</h4>
          </div>
          {!isCompact ? (
            <p className="mt-0.5 font-mono text-[11px] text-muted-foreground">
              {row.caseKey}
            </p>
          ) : null}
        </div>
        {(durationChanged || tokensChanged) ? (
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            {durationChanged ? (
              <CaseMetricDelta label="Duration" diff={row.metrics.durationMs} format="duration" />
            ) : null}
            {tokensChanged ? (
              <CaseMetricDelta label="Tokens" diff={row.metrics.totalTokens} format="number" />
            ) : null}
          </div>
        ) : isCompact ? (
          <span className="text-xs text-muted-foreground">Unchanged</span>
        ) : null}
      </div>

      {!isCompact ? (
        <div className="mt-2.5 grid gap-2 sm:grid-cols-2">
          <CaseSide
            label="Base"
            runId={baseRunId}
            side={row.base}
            onOpenIteration={onOpenIteration}
          />
          <CaseSide
            label="Compare"
            runId={compareRunId}
            side={row.compare}
            onOpenIteration={onOpenIteration}
          />
        </div>
      ) : null}
    </div>
  );
}

function CaseMetricDelta({
  label,
  diff,
  format,
}: {
  label: string;
  diff: EvalRunNumericDiff;
  format: DiffMetricFormat;
}) {
  return (
    <span className="tabular-nums">
      {label}{" "}
      <DeltaPill diff={diff} format={format} higherIsBetter={false} neutral={false} />
    </span>
  );
}

function DeltaPill({
  diff,
  format,
  higherIsBetter,
  neutral,
}: {
  diff: EvalRunNumericDiff;
  format: DiffMetricFormat;
  higherIsBetter: boolean;
  neutral: boolean;
}) {
  if (diff.delta === null || diff.delta === 0) {
    return null;
  }

  // Progressive disclosure: a change that rounds to <0.5% is noise. Keep the
  // raw delta visible but render it quietly (neutral, no "-0%" suffix) so it
  // doesn't compete with meaningful movement like a +33% accuracy swing.
  const negligible =
    format !== "percent" &&
    diff.percentDelta !== null &&
    Math.abs(diff.percentDelta) < 0.5;

  const isPositive = diff.delta > 0;
  const isGood = higherIsBetter ? isPositive : !isPositive;
  const toneClass =
    neutral || negligible
      ? "bg-muted text-muted-foreground"
      : isGood
      ? "bg-success/50 text-foreground"
      : "bg-destructive/50 text-foreground";

  const showPercent =
    format !== "percent" && diff.percentDelta !== null && !negligible;

  return (
    <span
      className={cn(
        "rounded px-1.5 py-0.5 text-[11px] font-semibold tabular-nums",
        toneClass
      )}
    >
      {formatSignedMetric(diff.delta, format)}
      {showPercent ? ` ${formatSignedPercent(diff.percentDelta!)}` : ""}
    </span>
  );
}

function CaseSide({
  label,
  runId,
  side,
  onOpenIteration,
}: {
  label: string;
  runId: string;
  side: EvalRunDiffSide;
  onOpenIteration?: (runId: string, iterationId: string) => void;
}) {
  const canOpen = Boolean(side.representativeIterationId && onOpenIteration);

  return (
    <div className="flex min-w-0 items-center justify-between gap-2 rounded-md border border-border/40 bg-muted/5 px-3 py-2">
      <div className="min-w-0">
        <div className="text-xs font-medium">{label}</div>
        <div className="mt-0.5 text-[11px] text-muted-foreground">
          {formatOutcome(side.outcome)}
          {side.error && !side.output ? (
            <span className="text-destructive"> · {side.error}</span>
          ) : null}
        </div>
      </div>
      {canOpen ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 shrink-0 px-2 text-xs"
          onClick={() =>
            onOpenIteration?.(runId, side.representativeIterationId!)
          }
        >
          <ExternalLink className="mr-1.5 h-3.5 w-3.5" aria-hidden />
          Trace
        </Button>
      ) : (
        <span className="shrink-0 text-[11px] text-muted-foreground">—</span>
      )}
    </div>
  );
}

function StatusBadge({ status }: { status: EvalRunDiffCaseStatus }) {
  return (
    <span
      className={cn(
        "rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide",
        statusBadgeClass(status)
      )}
    >
      {statusLabel(status)}
    </span>
  );
}

function statusLabel(status: EvalRunDiffCaseStatus): string {
  switch (status) {
    case "unchanged_passed":
      return "Passed";
    case "unchanged_failed":
      return "Still failing";
    case "regressed":
      return "Regressed";
    case "fixed":
      return "Fixed";
    case "new_case":
      return "New";
    case "removed_case":
      return "Removed";
    case "changed":
      return "Changed";
  }
}

function statusBadgeClass(status: EvalRunDiffCaseStatus): string {
  switch (status) {
    case "regressed":
    case "unchanged_failed":
      return "bg-destructive/50 text-foreground";
    case "fixed":
      return "bg-success/50 text-foreground";
    case "new_case":
    case "removed_case":
    case "changed":
      return "bg-warning/50 text-foreground";
    case "unchanged_passed":
      return "bg-muted text-muted-foreground";
  }
}

function formatOutcome(outcome: EvalRunDiffSide["outcome"]): string {
  switch (outcome) {
    case "passed":
      return "Passed";
    case "failed":
      return "Failed";
    case "absent":
      return "Absent";
  }
}

function metricHasData(diff: EvalRunNumericDiff): boolean {
  return diff.base !== null || diff.compare !== null;
}

function metricChanged(diff: EvalRunNumericDiff): boolean {
  return diff.delta !== null && diff.delta !== 0;
}

function formatMetricValue(
  value: number | null,
  format: DiffMetricFormat
): string {
  if (value === null || Number.isNaN(value)) {
    return "-";
  }
  switch (format) {
    case "duration":
      return formatDuration(value);
    case "signedDuration":
      return formatSignedDuration(value);
    case "percent":
      return `${formatCompactNumber(value)}%`;
    case "cost":
      return formatCost(value);
    case "number":
      return formatCompactNumber(value);
  }
}

function formatSignedMetric(value: number, format: DiffMetricFormat): string {
  if (format === "duration" || format === "signedDuration") {
    return formatSignedDuration(value);
  }
  if (format === "percent") {
    return formatSignedPercent(value);
  }
  if (format === "cost") {
    return `${value > 0 ? "+" : ""}${formatCost(value)}`;
  }
  return `${value > 0 ? "+" : ""}${formatCompactNumber(value)}`;
}

function formatSignedDuration(ms: number): string {
  if (ms === 0) return "0s";
  return `${ms > 0 ? "+" : "-"}${formatDuration(Math.abs(ms))}`;
}

function formatSignedPercent(value: number): string {
  const formatted = `${formatCompactNumber(value)}%`;
  return value > 0 ? `+${formatted}` : formatted;
}

function formatCompactNumber(value: number): string {
  const abs = Math.abs(value);
  const fractionDigits =
    abs > 0 && abs < 10 && !Number.isInteger(value) ? 1 : 0;
  return value.toLocaleString(undefined, {
    maximumFractionDigits: fractionDigits,
  });
}

function formatCost(value: number): string {
  const sign = value < 0 ? "-" : "";
  const abs = Math.abs(value);
  if (abs > 0 && abs < 0.01) {
    return `${sign}$${abs.toFixed(4)}`;
  }
  return `${sign}$${abs.toFixed(2)}`;
}
