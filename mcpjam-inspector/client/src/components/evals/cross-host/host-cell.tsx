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
  return String(n);
}

function formatLatencyPair(p50Ms: number | null, p95Ms: number | null): string | null {
  const parts: string[] = [];
  if (p50Ms !== null) {
    parts.push(`p50 ${formatRunCaseLatencyMs(p50Ms)}`);
  }
  if (p95Ms !== null) {
    parts.push(`p95 ${formatRunCaseLatencyMs(p95Ms)}`);
  }
  return parts.length > 0 ? parts.join(" · ") : null;
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

  const accuracy =
    data.passRate !== null ? `${Math.round(data.passRate)}%` : null;
  const latencyLine = formatLatencyPair(data.p50LatencyMs, data.p95LatencyMs);
  const tokenLine = data.totalTokens > 0 ? `${formatTokens(data.totalTokens)} tok` : null;
  const detailParts = [latencyLine, tokenLine].filter(
    (part): part is string => part != null,
  );

  return (
    <div className="flex min-h-[4.5rem] flex-col gap-2 px-3 py-2.5">
      <RunCaseIterationBar
        results={iterationResults}
        passed={data.passCount}
        total={data.totalCount}
        maxVisible={8}
      />
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        {accuracy ? (
          <span
            className={cn(
              "font-mono text-xs font-semibold tabular-nums",
              passRateColorClass(data.passRate),
            )}
          >
            {accuracy}
          </span>
        ) : null}
        {detailParts.length > 0 ? (
          <span className="font-mono text-[11px] tabular-nums text-muted-foreground">
            {detailParts.join(" · ")}
          </span>
        ) : null}
      </div>
    </div>
  );
}
