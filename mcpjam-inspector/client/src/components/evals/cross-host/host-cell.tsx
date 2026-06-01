import { useMemo } from "react";
import { cn } from "@/lib/utils";
import { computeIterationResult } from "../pass-criteria";
import {
  RunCaseIterationBar,
  runCaseFailCountClass,
  runCaseLatencyClassName,
} from "../run-case-list-shared";
import type { RunCaseIterationOutcome } from "../run-case-groups";
import { formatRunCaseLatencyMs } from "../run-case-groups";
import type { CellChips, CellData } from "./use-cross-host-data";
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

function Chip({
  label,
  variant = "default",
  title,
}: {
  label: string;
  variant?: "default" | "warn" | "info";
  title?: string;
}) {
  return (
    <span
      title={title}
      className={cn(
        "inline-flex items-center rounded px-1 py-0.5 text-[9px] font-medium leading-none",
        variant === "warn" &&
          "bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-400",
        variant === "info" &&
          "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400",
        variant === "default" &&
          "bg-muted text-muted-foreground",
      )}
    >
      {label}
    </span>
  );
}

function ChipRow({ chips }: { chips: CellChips }) {
  const hasToolData =
    chips.toolsTotalBefore !== null && chips.toolsExposed !== null;

  return (
    <div className="flex flex-wrap gap-1 mt-0.5">
      {hasToolData && (
        <Chip
          label={`tools ${chips.toolsExposed}/${chips.toolsTotalBefore}`}
          title={`${chips.toolsExposed} tools exposed to model out of ${chips.toolsTotalBefore} total`}
        />
      )}
      {chips.toolsDroppedVisibility !== null &&
        chips.toolsDroppedVisibility > 0 && (
          <Chip
            label={`visibility -${chips.toolsDroppedVisibility}`}
            variant="warn"
            title={`${chips.toolsDroppedVisibility} app-only tool(s) filtered by visibility policy`}
          />
        )}
      {chips.approvalsWouldRequire !== null &&
        chips.approvalsWouldRequire > 0 && (
          <Chip
            label={`gated tool calls ×${chips.approvalsWouldRequire}`}
            variant="warn"
            title={
              `Under this host's requireToolApproval policy, ${chips.approvalsWouldRequire} tool ` +
              `call(s) would be subject to user approval. Real hosts may suppress some prompts ` +
              `via per-tool allow-lists or session memory; this is an upper-bound estimate.`
            }
          />
        )}
      {chips.progressiveDiscoveryEnabled && (
        <Chip
          label="progressive discovery"
          variant="info"
          title="Progressive tool discovery enabled for this host"
        />
      )}
      {chips.openaiCompatInjected && (
        <Chip
          label="OpenAI compat"
          variant="info"
          title="OpenAI Apps SDK compat runtime was injected for this host"
        />
      )}
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

  const passRateStr =
    data.passRate !== null ? `${Math.round(data.passRate)}%` : null;

  const hasAnyChip =
    data.chips.toolsTotalBefore !== null ||
    (data.chips.toolsDroppedVisibility ?? 0) > 0 ||
    (data.chips.approvalsWouldRequire ?? 0) > 0 ||
    data.chips.progressiveDiscoveryEnabled ||
    data.chips.openaiCompatInjected;

  return (
    <div className="flex min-h-[4.5rem] flex-col gap-2 px-3 py-2.5">
      <RunCaseIterationBar
        results={iterationResults}
        passed={data.passCount}
        total={data.totalCount}
        maxVisible={8}
      />
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        {passRateStr !== null ? (
          <span
            className={cn(
              "font-mono text-xs font-semibold tabular-nums",
              data.passRate === 100 && "text-success",
              data.passRate === 0 && "text-destructive",
              data.passRate !== null &&
                data.passRate > 0 &&
                data.passRate < 100 &&
                "text-amber-600 dark:text-amber-400",
            )}
          >
            {passRateStr}
          </span>
        ) : null}
        {data.medianLatencyMs !== null ? (
          <span
            className={runCaseLatencyClassName}
            title="Median (p50) latency across completed iterations"
          >
            {formatRunCaseLatencyMs(data.medianLatencyMs)}
          </span>
        ) : null}
        {data.failCount > 0 ? (
          <span className={runCaseFailCountClass}>{data.failCount} fail</span>
        ) : null}
        {data.totalTokens > 0 ? (
          <span className={runCaseLatencyClassName}>
            {formatTokens(data.totalTokens)} tok
          </span>
        ) : null}
      </div>
      {hasAnyChip ? <ChipRow chips={data.chips} /> : null}
    </div>
  );
}
