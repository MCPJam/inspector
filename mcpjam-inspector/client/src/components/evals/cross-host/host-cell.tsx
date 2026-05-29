import { cn } from "@/lib/utils";
import { PassDotRow } from "./pass-dot-row";
import type { CellChips, CellData } from "./use-cross-host-data";

interface HostCellProps {
  data: CellData | undefined;
}

function formatMs(ms: number): string {
  if (ms >= 60_000) return `${(ms / 60_000).toFixed(1)}m`;
  if (ms >= 1_000) return `${(ms / 1_000).toFixed(1)}s`;
  return `${Math.round(ms)}ms`;
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
  if (!data || data.totalCount === 0) {
    return (
      <div className="flex h-full min-h-[56px] items-center justify-center">
        <span className="text-xs text-muted-foreground/40">—</span>
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
    <div className="flex flex-col gap-1 p-2">
      <PassDotRow iterations={data.iterations} />
      <div className="flex items-center gap-2 flex-wrap">
        {passRateStr !== null && (
          <span
            className={cn(
              "text-[11px] font-medium tabular-nums",
              data.passRate === 100
                ? "text-green-600 dark:text-green-400"
                : data.passRate === 0
                  ? "text-red-600 dark:text-red-400"
                  : "text-yellow-600 dark:text-yellow-400",
            )}
          >
            {passRateStr}
          </span>
        )}
        {data.avgLatencyMs !== null && (
          <span className="text-[10px] text-muted-foreground tabular-nums">
            {formatMs(data.avgLatencyMs)}
          </span>
        )}
        {data.totalTokens > 0 && (
          <span className="text-[10px] text-muted-foreground tabular-nums">
            {formatTokens(data.totalTokens)}
          </span>
        )}
      </div>
      {hasAnyChip && <ChipRow chips={data.chips} />}
    </div>
  );
}
