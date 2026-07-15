import { useMemo, useState } from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";
import { MetricStrip } from "../metric-strip";
import {
  buildCellMetricStripData,
} from "../metric-strip-data";
import { formatRunCaseLatencyMs } from "../run-case-groups";
import {
  CellInsightPanel,
  InlineJudgeBadge,
  type JudgeCase,
  type WorkflowInsight,
} from "../goal-completion-presentation";
import { cellAvgToolCalls } from "./case-row-metrics";
import { cellOutcome, type CellData, type CellOutcome, type CellTrendPoint } from "./use-cross-host-data";

interface HostCellProps {
  data: CellData | undefined;
  /** Taller footprint when the matrix uses All-runs metric strips. */
  trendsLayout?: boolean;
  /** Advisory judge verdict for this (case, host) cell, when graded. */
  judgeCase?: JudgeCase;
  /** Whether the judge verdict disagrees with the cell's deterministic outcome. */
  judgeDisagrees?: boolean;
  /** Server-quality workflow finding for this (case, host) cell, when present. */
  workflowInsight?: WorkflowInsight;
  /** Open this cell's trajectory (drill-in); shown as a link in the expansion. */
  onOpenTrace?: () => void;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(Math.round(n));
}

function HostCellMetric({
  label,
  value,
}: {
  label: string;
  value: string;
}) {
  return (
    <span
      className="inline-flex min-w-0 items-center gap-1"
      aria-label={`${label}: ${value}`}
    >
      <span className="text-[9.5px] font-medium uppercase tracking-[0.04em] text-muted-foreground/80">
        {label}
      </span>
      <span className="text-[11px] font-semibold tabular-nums leading-none text-muted-foreground">
        {value}
      </span>
    </span>
  );
}

const STATUS_META: Record<
  CellOutcome,
  { label: string; dot: string; text: string }
> = {
  pass: {
    label: "Pass",
    dot: "bg-success",
    text: "text-success",
  },
  fail: {
    label: "Fail",
    dot: "bg-destructive",
    text: "text-destructive",
  },
  part: {
    label: "Partial",
    dot: "bg-amber-500",
    text: "text-amber-600 dark:text-amber-400",
  },
  running: {
    label: "Running",
    dot: "bg-muted-foreground animate-pulse",
    text: "text-muted-foreground",
  },
};

function HostCellEmpty({ trendsLayout = false }: { trendsLayout?: boolean }) {
  return (
    <div
      className={cn(
        "flex items-center justify-center px-3 py-3",
        trendsLayout ? "min-h-[9rem]" : "min-h-[3.25rem]",
      )}
      data-testid="host-cell-empty"
    >
      <div
        className={cn(
          "flex w-full flex-col items-center justify-center gap-1.5 rounded-lg border border-dashed border-border/50 bg-muted/5 px-3 text-center",
          trendsLayout ? "py-5" : "py-4",
        )}
        role="status"
        aria-label="Not run — this client has not run this case yet"
      >
        <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/75">
          Not run
        </span>
        <p className="max-w-[14rem] text-[10.5px] leading-snug text-muted-foreground/50">
          This client has not run this case yet
        </p>
      </div>
    </div>
  );
}

/** All-runs view: always use labeled metric strip (sparklines when history ≥ 2). */
function HostCellMetricStrip({
  data,
  judgeCase,
  judgeDisagrees = false,
}: {
  data: CellData;
  judgeCase?: JudgeCase;
  judgeDisagrees?: boolean;
}) {
  const stripData = useMemo(() => buildStripDataForCell(data), [data]);

  if (!stripData) return null;

  return (
    <div className="flex flex-col gap-1.5">
      <MetricStrip
        data={stripData}
        density="compact"
        layout="vertical"
        surface="embedded"
        testId="cell-metric-strip"
      />
      {judgeCase ? (
        <div className="flex px-1">
          <InlineJudgeBadge judgeCase={judgeCase} disagrees={judgeDisagrees} />
        </div>
      ) : null}
    </div>
  );
}

function outcomeToTrendResult(
  outcome: CellOutcome,
): CellTrendPoint["result"] {
  if (outcome === "pass") return "passed";
  if (outcome === "fail") return "failed";
  if (outcome === "part") return "partial";
  return "pending";
}

function buildStripDataForCell(data: CellData) {
  if (data.trendSeries && data.trendSeries.length > 0) {
    return buildCellMetricStripData(data.trendSeries);
  }

  const avgToolCalls = cellAvgToolCalls(data) ?? 0;

  return buildCellMetricStripData([
    {
      runLabel: "latest",
      result: outcomeToTrendResult(cellOutcome(data)),
      latencyMs: data.p50LatencyMs,
      latencyP95Ms: data.p95LatencyMs,
      tokens: data.avgTokensPerIteration,
      toolCalls: avgToolCalls,
    },
  ]);
}

/** Run-group / single-run view: snapshot metrics only. */
function HostCellSnapshot({
  data,
  meta,
  judgeCase,
  judgeDisagrees = false,
}: {
  data: CellData;
  meta: (typeof STATUS_META)["pass"];
  judgeCase?: JudgeCase;
  judgeDisagrees?: boolean;
}) {
  const p50Value =
    data.p50LatencyMs !== null
      ? formatRunCaseLatencyMs(data.p50LatencyMs)
      : null;
  const p95Value =
    data.p95LatencyMs !== null
      ? formatRunCaseLatencyMs(data.p95LatencyMs)
      : null;
  const avgTokensValue =
    data.avgTokensPerIteration !== null
      ? formatTokens(data.avgTokensPerIteration)
      : null;
  const hasMetrics = p50Value || p95Value || avgTokensValue;

  return (
    <div className="flex min-h-[3.25rem] w-full flex-col justify-center gap-1 px-3 py-2">
      <div className="flex w-full items-center gap-2">
        <span
          className={cn("size-1.5 flex-none rounded-full", meta.dot)}
          aria-hidden
        />
        <span className={cn("shrink-0 text-[12.5px] font-semibold", meta.text)}>
          {meta.label}
        </span>
        <span className="shrink-0 text-[11px] font-semibold tabular-nums text-muted-foreground">
          {data.passCount}/{data.totalCount}
        </span>
        {hasMetrics ? (
          <div
            className="ml-auto flex min-w-0 shrink items-center gap-1.5"
            aria-label="Latency and token metrics"
          >
            {p50Value ? <HostCellMetric label="p50" value={p50Value} /> : null}
            {p95Value ? <HostCellMetric label="p95" value={p95Value} /> : null}
            {avgTokensValue ? (
              <HostCellMetric label="tok" value={avgTokensValue} />
            ) : null}
          </div>
        ) : null}
      </div>
      {judgeCase ? (
        <div className="flex">
          <InlineJudgeBadge judgeCase={judgeCase} disagrees={judgeDisagrees} />
        </div>
      ) : null}
    </div>
  );
}

export function HostCell({
  data,
  trendsLayout = false,
  judgeCase,
  judgeDisagrees = false,
  workflowInsight,
  onOpenTrace,
}: HostCellProps) {
  const [expanded, setExpanded] = useState(false);

  if (!data || data.totalCount === 0) {
    return <HostCellEmpty trendsLayout={trendsLayout} />;
  }

  const content = trendsLayout ? (
    <HostCellMetricStrip
      data={data}
      judgeCase={judgeCase}
      judgeDisagrees={judgeDisagrees}
    />
  ) : (
    <HostCellSnapshot
      data={data}
      meta={STATUS_META[cellOutcome(data)]}
      judgeCase={judgeCase}
      judgeDisagrees={judgeDisagrees}
    />
  );

  // No per-cell insight to expand → render the plain cell (no toggle).
  const hasInsight = Boolean(judgeCase || workflowInsight);
  if (!hasInsight) {
    return content;
  }

  return (
    <div className="flex flex-col">
      {content}
      <button
        type="button"
        // Stop propagation so toggling the insight doesn't also trigger the
        // cell's drill-in click.
        onClick={(event) => {
          event.stopPropagation();
          setExpanded((value) => !value);
        }}
        aria-expanded={expanded}
        aria-label={expanded ? "Hide cell insight" : "Show cell insight"}
        className="flex items-center justify-center gap-1 border-t border-border/40 px-3 py-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground transition-colors hover:bg-muted/30"
      >
        {expanded ? "Hide insight" : "Insight"}
        <ChevronDown
          className={cn("size-3 transition-transform", expanded && "rotate-180")}
          aria-hidden
        />
      </button>
      {expanded ? (
        <CellInsightPanel
          judgeCase={judgeCase}
          workflowInsight={workflowInsight}
          onOpenTrace={onOpenTrace}
        />
      ) : null}
    </div>
  );
}
