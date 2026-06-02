import { useMemo } from "react";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@mcpjam/design-system/tooltip";
import { cn } from "@/lib/utils";
import { computeIterationResult } from "../pass-criteria";
import { RunCaseIterationBar } from "../run-case-list-shared";
import type { RunCaseIterationOutcome } from "../run-case-groups";
import { formatRunCaseLatencyMs } from "../run-case-groups";
import type { CellData } from "./use-cross-host-data";
import type { EvalIteration } from "../types";

interface HostCellProps {
  data: CellData | undefined;
  metricComparisons?: HostCellMetricComparisons;
}

export type HostCellMetricKey = "p50" | "p95" | "avgTokens";

export type HostCellMetricComparison = {
  hostId: string;
  hostName: string;
  value: number;
  formattedValue: string;
  isCurrent: boolean;
};

export type HostCellMetricComparisons = Partial<
  Record<HostCellMetricKey, HostCellMetricComparison[]>
>;

function stableOrder(iterations: EvalIteration[]): EvalIteration[] {
  return [...iterations].sort((a, b) => {
    const an = a.iterationNumber ?? Number.MAX_SAFE_INTEGER;
    const bn = b.iterationNumber ?? Number.MAX_SAFE_INTEGER;
    if (an !== bn) return an - bn;
    return (a.createdAt ?? 0) - (b.createdAt ?? 0);
  });
}

function iterationOutcome(iteration: EvalIteration): RunCaseIterationOutcome {
  const result = computeIterationResult(iteration);
  if (result === "passed") return "pass";
  if (result === "failed") return "fail";
  if (result === "cancelled") return "cancelled";
  return "pending";
}

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(Math.round(n));
}

const METRIC_COPY: Record<
  HostCellMetricKey,
  { title: string; description: string; missing: string }
> = {
  p50: {
    title: "P50 latency",
    description: "Median completed-run latency for this test case.",
    missing: "No completed latency sample for this client.",
  },
  p95: {
    title: "P95 latency",
    description: "Tail latency for the slowest completed runs in this case.",
    missing: "No completed tail-latency sample for this client.",
  },
  avgTokens: {
    title: "Average tokens",
    description: "Mean token usage per iteration in the latest run.",
    missing: "No token usage sample for this client.",
  },
};

function formatDeltaFromBest(
  metricKey: HostCellMetricKey,
  value: number,
  bestValue: number
): string {
  const delta = value - bestValue;
  if (delta <= 0) return "best";
  if (metricKey === "avgTokens") return `+${formatTokens(delta)} tok`;
  return `+${formatRunCaseLatencyMs(delta)}`;
}

function HostMetricComparisonTooltip({
  metricKey,
  entries,
}: {
  metricKey: HostCellMetricKey;
  entries: HostCellMetricComparison[];
}) {
  const copy = METRIC_COPY[metricKey];
  const current = entries.find((entry) => entry.isCurrent);
  const best = entries[0];
  const maxValue = entries.reduce(
    (max, entry) => Math.max(max, entry.value),
    0
  );

  return (
    <div className="w-[18rem] overflow-hidden rounded-xl border border-border/70 bg-popover/95 p-0 text-popover-foreground shadow-2xl shadow-black/10 backdrop-blur supports-[backdrop-filter]:bg-popover/90">
      <div className="border-b border-border/60 bg-gradient-to-br from-muted/80 via-background to-background px-3 py-2.5">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-xs font-semibold text-foreground">
              {copy.title}
            </p>
            <p className="mt-0.5 text-[11px] leading-snug text-muted-foreground">
              {copy.description}
            </p>
          </div>
          {current ? (
            <span className="rounded-full border border-border/70 bg-background px-2 py-0.5 font-mono text-[10px] tabular-nums text-muted-foreground">
              #{entries.findIndex((entry) => entry.isCurrent) + 1}
            </span>
          ) : null}
        </div>
      </div>

      {entries.length > 0 && best ? (
        <div className="space-y-1.5 p-2">
          {entries.map((entry, index) => {
            const width =
              maxValue > 0 ? Math.max(10, (entry.value / maxValue) * 100) : 0;
            const delta = formatDeltaFromBest(
              metricKey,
              entry.value,
              best.value
            );

            return (
              <div
                key={entry.hostId}
                className={cn(
                  "rounded-lg border border-transparent px-2 py-1.5",
                  entry.isCurrent &&
                    "border-primary/25 bg-primary/[0.07] ring-1 ring-primary/10"
                )}
              >
                <div className="flex items-center gap-2">
                  <span className="w-5 shrink-0 font-mono text-[10px] text-muted-foreground">
                    #{index + 1}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-xs font-medium">
                    {entry.hostName}
                  </span>
                  <span className="font-mono text-[11px] tabular-nums text-foreground">
                    {entry.formattedValue}
                  </span>
                </div>
                <div className="mt-1.5 flex items-center gap-2">
                  <div className="h-1 flex-1 overflow-hidden rounded-full bg-muted">
                    <div
                      className={cn(
                        "h-full rounded-full",
                        entry.isCurrent
                          ? "bg-primary"
                          : "bg-muted-foreground/35"
                      )}
                      style={{ width: `${width}%` }}
                    />
                  </div>
                  <span
                    className={cn(
                      "w-14 text-right font-mono text-[10px] tabular-nums",
                      delta === "best"
                        ? "text-success"
                        : "text-muted-foreground"
                    )}
                  >
                    {delta}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <p className="px-3 py-2.5 text-xs text-muted-foreground">
          No peer data yet for this metric.
        </p>
      )}

      {!current ? (
        <p className="border-t border-border/60 px-3 py-2 text-[11px] text-muted-foreground">
          {copy.missing}
        </p>
      ) : null}
    </div>
  );
}

function HostCellMetric({
  label,
  value,
  metricKey,
  comparisonEntries,
  valueClassName,
}: {
  label: string;
  value: string;
  metricKey: HostCellMetricKey;
  comparisonEntries?: HostCellMetricComparison[];
  valueClassName?: string;
}) {
  const trigger = (
    <button
      type="button"
      className="group/metric flex min-w-0 flex-col items-center gap-0.5 rounded-lg px-1 py-0.5 text-center transition duration-150 hover:-translate-y-px hover:bg-background/80 hover:shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
      aria-label={`${METRIC_COPY[metricKey].title}: ${value}`}
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => event.stopPropagation()}
    >
      <span className="font-mono text-[9px] font-medium uppercase tracking-[0.12em] text-muted-foreground/90 transition-colors group-hover/metric:text-foreground/70">
        {label}
      </span>
      <span
        className={cn(
          "font-mono text-[11px] font-medium tabular-nums leading-none text-foreground/90",
          valueClassName
        )}
      >
        {value}
      </span>
    </button>
  );

  if (!comparisonEntries) return trigger;

  return (
    <Tooltip>
      <TooltipTrigger asChild>{trigger}</TooltipTrigger>
      <TooltipContent
        side="top"
        align="center"
        sideOffset={8}
        className="border-0 bg-transparent p-0 shadow-none"
      >
        <HostMetricComparisonTooltip
          metricKey={metricKey}
          entries={comparisonEntries}
        />
      </TooltipContent>
    </Tooltip>
  );
}

export function HostCell({ data, metricComparisons }: HostCellProps) {
  const iterationResults = useMemo(() => {
    if (!data?.iterations.length) return [];
    return stableOrder(data.iterations).map(iterationOutcome);
  }, [data?.iterations]);

  if (!data || data.totalCount === 0) {
    return (
      <div className="flex h-full min-h-[4.5rem] items-center justify-center px-3">
        <span className="font-mono text-xs text-muted-foreground/50">—</span>
      </div>
    );
  }

  const accuracyLabel =
    data.passRate !== null ? `${Math.round(data.passRate)}%` : null;
  const accuracyBadge =
    accuracyLabel != null ? (
      <span className="font-mono text-xs tabular-nums leading-none text-muted-foreground">
        {accuracyLabel}
      </span>
    ) : null;

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
      ? `${formatTokens(data.avgTokensPerIteration)} tok`
      : null;

  const hasMetrics = p50Value || p95Value || avgTokensValue;

  return (
    <div className="flex min-h-[4.5rem] flex-col gap-2 px-3 py-2.5">
      <RunCaseIterationBar
        results={iterationResults}
        passed={data.passCount}
        total={data.totalCount}
        maxVisible={8}
        headerEnd={accuracyBadge}
      />
      {hasMetrics ? (
        <div
          className="grid w-full grid-cols-3 gap-1 border-t border-border/50 pt-2"
          aria-label="Latency and token metrics"
        >
          <HostCellMetric
            label="p50"
            metricKey="p50"
            value={p50Value ?? "—"}
            comparisonEntries={metricComparisons?.p50}
            valueClassName={!p50Value ? "text-muted-foreground/50" : undefined}
          />
          <HostCellMetric
            label="p95"
            metricKey="p95"
            value={p95Value ?? "—"}
            comparisonEntries={metricComparisons?.p95}
            valueClassName={!p95Value ? "text-muted-foreground/50" : undefined}
          />
          <HostCellMetric
            label="avg"
            metricKey="avgTokens"
            value={avgTokensValue ?? "—"}
            comparisonEntries={metricComparisons?.avgTokens}
            valueClassName={
              !avgTokensValue ? "text-muted-foreground/50" : undefined
            }
          />
        </div>
      ) : null}
    </div>
  );
}
