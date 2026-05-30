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
      onBackToRun={onBackToRun}
      onOpenIteration={onOpenIteration}
    />
  );
}

function RunDiffLoaded({
  diff,
  onBackToRun,
  onOpenIteration,
}: {
  diff: EvalRunDiff;
  onBackToRun?: () => void;
  onOpenIteration?: (runId: string, iterationId: string) => void;
}) {
  const changedCount = useMemo(
    () => diff.cases.filter((row) => row.status !== "unchanged_passed").length,
    [diff.cases]
  );

  const metricLabel = diff.suite.source === "sdk" ? "Pass Rate" : "Accuracy";

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto p-4">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-lg font-semibold tracking-tight">
            Run {formatRunId(diff.baseRun.id)} {"->"} Run{" "}
            {formatRunId(diff.compareRun.id)}
          </h2>
          <p className="mt-1 text-xs text-muted-foreground">
            {diff.suite.name} - {changedCount} changed or failing case
            {changedCount === 1 ? "" : "s"} - {diff.cases.length} total
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

      <section className="rounded-xl border bg-card text-card-foreground">
        <div className="border-b px-4 py-3">
          <h3 className="text-sm font-semibold">Run Summary</h3>
          <p className="mt-1 text-xs text-muted-foreground">
            Base created {formatTime(diff.baseRun.createdAt)} - Compare created{" "}
            {formatTime(diff.compareRun.createdAt)}
          </p>
        </div>
        <div className="grid gap-px bg-border/50 sm:grid-cols-2 lg:grid-cols-4">
          <DiffMetricCard
            label={metricLabel}
            diff={diff.scores.passRatePercent}
            format="percent"
            higherIsBetter
          />
          <DiffMetricCard
            label="Passed"
            diff={diff.scores.passed}
            format="number"
            higherIsBetter
          />
          <DiffMetricCard
            label="Failed"
            diff={diff.scores.failed}
            format="number"
          />
          <DiffMetricCard
            label="Total"
            diff={diff.scores.total}
            format="number"
            neutral
          />
        </div>
      </section>

      <section className="mt-4 rounded-xl border bg-card text-card-foreground">
        <div className="border-b px-4 py-3">
          <h3 className="text-sm font-semibold">Metrics</h3>
        </div>
        <div className="grid gap-px bg-border/50 sm:grid-cols-2 lg:grid-cols-4">
          <DiffMetricCard
            label="Start offset"
            diff={diff.metrics.startOffsetMs}
            format="signedDuration"
            neutral
          />
          <DiffMetricCard
            label="Duration"
            diff={diff.metrics.wallDurationMs}
            format="duration"
          />
          <DiffMetricCard
            label="Total tokens"
            diff={diff.metrics.totalTokens}
            format="number"
          />
          <DiffMetricCard
            label="Input tokens"
            diff={diff.metrics.inputTokens}
            format="number"
          />
          <DiffMetricCard
            label="Output tokens"
            diff={diff.metrics.outputTokens}
            format="number"
          />
          <DiffMetricCard
            label="Cached tokens"
            diff={diff.metrics.cachedInputTokens}
            format="number"
          />
          <DiffMetricCard
            label="Reasoning tokens"
            diff={diff.metrics.reasoningTokens}
            format="number"
          />
          <DiffMetricCard
            label="Estimated cost"
            diff={diff.metrics.estimatedCostUsd}
            format="cost"
          />
        </div>
      </section>

      <section className="mt-4 min-h-0 rounded-xl border bg-card text-card-foreground">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3">
          <div>
            <h3 className="text-sm font-semibold">Cases</h3>
            <p className="mt-1 text-xs text-muted-foreground">
              Changed and failing rows are sorted first.
            </p>
          </div>
          <div className="text-xs text-muted-foreground tabular-nums">
            {diff.cases.length.toLocaleString()} rows
          </div>
        </div>
        <div className="divide-y">
          {diff.cases.length === 0 ? (
            <div className="px-4 py-8 text-center text-sm text-muted-foreground">
              No cases were found in either run.
            </div>
          ) : (
            diff.cases.map((row) => (
              <div key={row.caseKey} className="px-4 py-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex min-w-0 flex-wrap items-center gap-2">
                      <StatusBadge status={row.status} />
                      {row.configChanged ? (
                        <span className="rounded bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-700 dark:text-amber-300">
                          Config changed
                        </span>
                      ) : null}
                      <h4 className="min-w-0 truncate text-sm font-semibold">
                        {row.title}
                      </h4>
                    </div>
                    <p className="mt-1 font-mono text-[11px] text-muted-foreground">
                      {row.caseKey}
                    </p>
                  </div>
                  <div className="flex flex-wrap items-center justify-end gap-2">
                    <SmallMetric
                      label="Duration"
                      diff={row.metrics.durationMs}
                      format="duration"
                    />
                    <SmallMetric
                      label="Tokens"
                      diff={row.metrics.totalTokens}
                      format="number"
                    />
                  </div>
                </div>

                <div className="mt-3 grid gap-3 lg:grid-cols-2">
                  <CaseSide
                    label={`Base Run ${formatRunId(diff.baseRun.id)}`}
                    runId={diff.baseRun.id}
                    side={row.base}
                    onOpenIteration={onOpenIteration}
                  />
                  <CaseSide
                    label={`Compare Run ${formatRunId(diff.compareRun.id)}`}
                    runId={diff.compareRun.id}
                    side={row.compare}
                    onOpenIteration={onOpenIteration}
                  />
                </div>
              </div>
            ))
          )}
        </div>
      </section>
    </div>
  );
}

function DiffMetricCard({
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
  return (
    <div className="min-w-0 bg-card px-4 py-3">
      <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
        {label}
      </div>
      <div className="mt-2 flex min-w-0 flex-wrap items-center gap-2 text-sm tabular-nums">
        <span className="font-semibold text-foreground">
          {formatMetricValue(diff.base, format)}
        </span>
        <span className="text-muted-foreground">{"->"}</span>
        <span className="font-semibold text-foreground">
          {formatMetricValue(diff.compare, format)}
        </span>
        <DeltaPill
          diff={diff}
          format={format}
          higherIsBetter={higherIsBetter}
          neutral={neutral}
        />
      </div>
    </div>
  );
}

function SmallMetric({
  label,
  diff,
  format,
}: {
  label: string;
  diff: EvalRunNumericDiff;
  format: DiffMetricFormat;
}) {
  return (
    <div className="rounded-md border border-border/50 bg-muted/10 px-2 py-1 text-[11px]">
      <span className="text-muted-foreground">{label}: </span>
      <span className="font-mono text-foreground">
        {formatMetricValue(diff.base, format)} {"->"}{" "}
        {formatMetricValue(diff.compare, format)}
      </span>
    </div>
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

  const isPositive = diff.delta > 0;
  const isGood = higherIsBetter ? isPositive : !isPositive;
  const toneClass = neutral
    ? "bg-muted text-muted-foreground"
    : isGood
    ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
    : "bg-destructive/10 text-destructive";

  return (
    <span
      className={cn(
        "rounded px-1.5 py-0.5 text-[11px] font-semibold tabular-nums",
        toneClass
      )}
    >
      {formatSignedMetric(diff.delta, format)}
      {diff.percentDelta !== null
        ? ` ${formatSignedPercent(diff.percentDelta)}`
        : ""}
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
    <div className="flex min-w-0 items-center justify-between gap-3 rounded-lg border border-border/50 bg-muted/10 px-3 py-2.5">
      <div className="min-w-0">
        <div className="truncate text-xs font-medium">{label}</div>
        <div className="mt-0.5 text-[11px] text-muted-foreground">
          {formatOutcome(side.outcome)} · {side.iterationIds.length} iteration
          {side.iterationIds.length === 1 ? "" : "s"} ·{" "}
          {side.expectedToolCalls.length} expected / {side.actualToolCalls.length}{" "}
          actual tools
        </div>
        {side.error && !side.output ? (
          <p className="mt-1 truncate text-[11px] text-destructive">{side.error}</p>
        ) : null}
      </div>
      {canOpen ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-7 shrink-0 px-2 text-xs"
          onClick={() =>
            onOpenIteration?.(runId, side.representativeIterationId!)
          }
        >
          <ExternalLink className="mr-1.5 h-3.5 w-3.5" aria-hidden />
          View trace
        </Button>
      ) : (
        <span className="shrink-0 text-[11px] text-muted-foreground">No trace</span>
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
      return "bg-destructive/10 text-destructive";
    case "fixed":
      return "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300";
    case "new_case":
    case "removed_case":
    case "changed":
      return "bg-amber-500/10 text-amber-700 dark:text-amber-300";
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
