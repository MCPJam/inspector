import { useMemo } from "react";
import { cn } from "@/lib/utils";
import { formatRunCaseLatencyMs } from "../run-case-groups";
import type { CellTrendPoint } from "./use-cross-host-data";

const MAX_SEGMENTS = 12;

const RESULT_LABEL: Record<CellTrendPoint["result"], string> = {
  passed: "Pass",
  failed: "Fail",
  pending: "Pending",
  partial: "Partial",
};

/** Plain-English history summary for a (case, host) trend series. */
export function buildTrendSummary(series: CellTrendPoint[]): string {
  if (series.length === 0) return "No runs yet";

  let passed = 0;
  let failed = 0;
  for (const point of series) {
    if (point.result === "passed") passed++;
    else if (point.result === "failed") failed++;
  }

  const total = series.length;
  const runWord = total === 1 ? "run" : "runs";

  if (passed === total) return `All ${total} ${runWord} passed`;
  if (failed === total) return `All ${total} ${runWord} failed`;
  return `${passed}/${total} ${runWord} passed`;
}

function segmentTitle(point: CellTrendPoint): string {
  const outcome = RESULT_LABEL[point.result];
  const latency =
    point.latencyMs != null
      ? formatRunCaseLatencyMs(point.latencyMs)
      : null;
  return latency
    ? `Run ${point.runLabel} · ${outcome} · ${latency}`
    : `Run ${point.runLabel} · ${outcome}`;
}

/** Matches the Monitoring tab uptime strip — thin segments, not dots. */
function segmentClass(result: CellTrendPoint["result"]): string {
  switch (result) {
    case "passed":
      return "bg-success/70";
    case "failed":
      return "bg-destructive/70";
    case "partial":
      return "bg-amber-500/70 dark:bg-amber-400/70";
    case "pending":
      return "bg-warning/50";
  }
}

export function RunTrendStrip({ series }: { series: CellTrendPoint[] }) {
  const overflow = Math.max(0, series.length - MAX_SEGMENTS);
  const shown = series.slice(-MAX_SEGMENTS);

  const ariaLabel = useMemo(() => {
    if (series.length === 0) return "No runs";
    let passed = 0;
    let failed = 0;
    let other = 0;
    for (const point of series) {
      if (point.result === "passed") passed++;
      else if (point.result === "failed") failed++;
      else other++;
    }
    const base = `${passed} passed, ${failed} failed${
      other > 0 ? `, ${other} pending or partial` : ""
    } out of ${series.length} runs`;
    return overflow > 0 ? `${base} (${overflow} older not shown)` : base;
  }, [series, overflow]);

  return (
    <div
      role="img"
      aria-label={ariaLabel}
      className="flex h-4 w-full items-stretch gap-[2px]"
      data-testid="run-trend-strip"
    >
      {shown.map((point) => (
        <span
          key={point.runId}
          title={segmentTitle(point)}
          aria-hidden
          className={cn(
            "min-w-[4px] flex-1 rounded-[2px]",
            segmentClass(point.result),
          )}
        />
      ))}
    </div>
  );
}

/** @deprecated Use RunTrendStrip */
export const RunTrendDotRow = RunTrendStrip;
