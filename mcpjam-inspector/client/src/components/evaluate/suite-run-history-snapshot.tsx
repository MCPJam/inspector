/**
 * Latest-run health inside Evaluate (New) Run History.
 *
 * Same numbers as the legacy suite MetricStrip (`buildSuiteMetricStripData`) —
 * pass rate, latency, tokens, tool calls for the newest measured run — but a
 * different component: a flat band that sits inside the history card, not a
 * second card with sparklines. The table under it is the trend.
 */
import { useMemo, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import {
  buildSuiteMetricStripData,
  formatCompactNumber,
  formatDurationMs,
} from "../evals/metric-strip-data";
import type { EvalIteration, EvalSuiteRun } from "../evals/types";

export function SuiteRunHistorySnapshot({
  runs,
  allIterations,
}: {
  runs: readonly EvalSuiteRun[];
  allIterations: readonly EvalIteration[];
}) {
  const data = useMemo(
    () => buildSuiteMetricStripData([...runs], [...allIterations]),
    [runs, allIterations],
  );
  if (!data) return null;

  const { latest, series } = data;
  const failing = latest.failed > 0;

  return (
    <div
      className="grid grid-cols-2 divide-x divide-border/30 border-b border-border/30 bg-card sm:grid-cols-4"
      data-testid="suite-run-history-snapshot"
    >
      <SnapshotCell>
        <div className="flex items-center gap-2">
          <span
            className={cn(
              "inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-semibold",
              failing
                ? "bg-destructive/10 text-destructive"
                : "bg-success/10 text-success",
            )}
          >
            <span
              className={cn(
                "h-1.5 w-1.5 rounded-full",
                failing ? "bg-destructive" : "bg-success",
              )}
            />
            {failing ? `${latest.failed} failing` : "All passing"}
          </span>
        </div>
        <div className="mt-2 flex items-baseline gap-2">
          <span className="text-[22px] font-semibold leading-none tabular-nums tracking-tight text-foreground">
            {latest.passRate}%
          </span>
          <span className="text-[11px] tabular-nums text-muted-foreground">
            {latest.passed}/{latest.total} passed
          </span>
        </div>
        <div className="mt-1.5 text-[10.5px] text-muted-foreground">
          {series.length === 1
            ? "latest run"
            : `latest of ${series.length} runs`}
        </div>
      </SnapshotCell>

      <SnapshotCell
        label="Latency"
        sub="per run"
        testId="suite-run-history-snapshot-latency"
      >
        <div className="mt-2 flex flex-wrap items-baseline gap-x-4 gap-y-1">
          <LatencyPair label="P50" value={latest.latencyP50} />
          <LatencyPair label="P95" value={latest.latencyP95} />
        </div>
      </SnapshotCell>

      <SnapshotCell label="Tokens" sub="per run">
        <div className="mt-2 text-[17px] font-semibold leading-none tabular-nums tracking-tight text-foreground">
          {formatCompactNumber(latest.tokens)}
        </div>
      </SnapshotCell>

      <SnapshotCell label="Tool calls" sub="per run">
        <div className="mt-2 text-[17px] font-semibold leading-none tabular-nums tracking-tight text-foreground">
          {formatCompactNumber(latest.toolCalls)}
        </div>
      </SnapshotCell>
    </div>
  );
}

function SnapshotCell({
  label,
  sub,
  testId,
  children,
}: {
  label?: string;
  sub?: string;
  testId?: string;
  children: ReactNode;
}) {
  return (
    <div className="min-w-0 px-5 py-3.5" data-testid={testId}>
      {label ? (
        <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          {label}
        </div>
      ) : null}
      {children}
      {sub ? (
        <div className="mt-1.5 text-[10.5px] text-muted-foreground">{sub}</div>
      ) : null}
    </div>
  );
}

function LatencyPair({
  label,
  value,
}: {
  label: string;
  value: number | null;
}) {
  return (
    <div className="flex items-baseline gap-1.5">
      <span className="text-[10px] font-medium tabular-nums text-muted-foreground">
        {label}
      </span>
      <span className="text-[17px] font-semibold leading-none tabular-nums tracking-tight text-foreground">
        {value != null ? formatDurationMs(value) : "—"}
      </span>
    </div>
  );
}
