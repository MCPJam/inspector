import { useMemo } from "react";
import { cn } from "@/lib/utils";
import { computeIterationResult } from "../pass-criteria";
import { RunCaseIterationBar } from "../run-case-list-shared";
import type { RunCaseIterationOutcome } from "../run-case-groups";
import { formatRunCaseLatencyMs } from "../run-case-groups";
import { passRateColorClass } from "../suite-overview-presentation";
import type { CellData } from "./use-cross-host-data";
import type { EvalIteration } from "../types";

interface HostCellProps {
  data: CellData | undefined;
}

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

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(Math.round(n));
}

function HostCellMetric({
  label,
  value,
  valueClassName,
}: {
  label: string;
  value: string;
  valueClassName?: string;
}) {
  return (
    <div className="flex min-w-0 flex-col items-center gap-0.5 text-center">
      <span className="font-mono text-[9px] font-medium uppercase tracking-[0.12em] text-muted-foreground/90">
        {label}
      </span>
      <span
        className={cn(
          "font-mono text-[11px] font-medium tabular-nums leading-none text-foreground/90",
          valueClassName,
        )}
      >
        {value}
      </span>
    </div>
  );
}

export function HostCell({ data }: HostCellProps) {
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
      <span
        className={cn(
          "font-mono text-xs font-semibold tabular-nums leading-none",
          passRateColorClass(data.passRate),
        )}
      >
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
            value={p50Value ?? "—"}
            valueClassName={!p50Value ? "text-muted-foreground/50" : undefined}
          />
          <HostCellMetric
            label="p95"
            value={p95Value ?? "—"}
            valueClassName={!p95Value ? "text-muted-foreground/50" : undefined}
          />
          <HostCellMetric
            label="avg"
            value={avgTokensValue ?? "—"}
            valueClassName={
              !avgTokensValue ? "text-muted-foreground/50" : undefined
            }
          />
        </div>
      ) : null}
    </div>
  );
}
