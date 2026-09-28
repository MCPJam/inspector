import type { ReactNode } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";
import { cn } from "@/lib/utils";
import { evalSurfaceCardClass } from "@/components/evals/eval-surface-chrome";
import { formatCompactNumber } from "@/components/evals/metric-strip-data";
import { formatDurationMs } from "@/components/evals/metric-strip-data";
import type { SessionMetricsAggregate } from "@/components/shared/session-metric-strip";

const STORAGE_KEY = "mcpjam.sessions-metric-strip-expanded";

function formatPercent(rate: number): string {
  const pct = rate * 100;
  return `${pct >= 10 || pct === 0 ? Math.round(pct) : pct.toFixed(1)}%`;
}

function CollapsedMetricChip({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: "default" | "warn";
}) {
  return (
    <span
      className={cn(
        "inline-flex items-baseline gap-1 rounded-md px-1.5 py-0.5",
        "bg-muted/50 dark:bg-muted/30",
        tone === "warn" && "text-destructive",
      )}
    >
      <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </span>
      <span className="text-xs font-semibold tabular-nums tracking-tight text-foreground">
        {value}
      </span>
    </span>
  );
}

function CollapsedMetricsSummary({
  metrics,
}: {
  metrics: SessionMetricsAggregate;
}) {
  const {
    toolErrorRate,
    latencyP50Ms,
    avgToolCallsPerSession,
    avgTokensPerSession,
  } = metrics;

  return (
    <div
      className="hidden min-w-0 flex-1 flex-wrap items-center justify-start gap-1.5 sm:flex"
      aria-hidden={false}
    >
      <CollapsedMetricChip
        label="Errors"
        value={
          toolErrorRate != null ? formatPercent(toolErrorRate) : "—"
        }
        tone={
          toolErrorRate != null && toolErrorRate >= 0.1 ? "warn" : "default"
        }
      />
      <CollapsedMetricChip
        label="P50"
        value={
          latencyP50Ms != null ? formatDurationMs(latencyP50Ms) : "—"
        }
      />
      <CollapsedMetricChip
        label="Calls"
        value={
          avgToolCallsPerSession != null
            ? formatCompactNumber(avgToolCallsPerSession)
            : "—"
        }
      />
      <CollapsedMetricChip
        label="Tokens"
        value={
          avgTokensPerSession != null
            ? formatCompactNumber(avgTokensPerSession)
            : "—"
        }
      />
    </div>
  );
}

export function collapsibleSessionMetricsStorageKey(): string {
  return STORAGE_KEY;
}

export function CollapsibleSessionMetricsShell({
  expanded,
  onExpandedChange,
  metrics,
  testIdPrefix,
  children,
}: {
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
  metrics: SessionMetricsAggregate;
  testIdPrefix: string;
  children: ReactNode;
}) {
  const toggleLabel = expanded ? "Hide session metrics" : "Show session metrics";

  return (
    <div
      className={cn(evalSurfaceCardClass, "overflow-hidden")}
      data-testid={`${testIdPrefix}-sessions-metric-shell`}
      data-expanded={expanded ? "true" : "false"}
    >
      <button
        type="button"
        className={cn(
          "flex w-full items-center gap-2 px-3 py-2 text-left outline-none",
          "transition-colors hover:bg-muted/40 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
          expanded && "border-b border-border/40 dark:border-border/30",
        )}
        aria-expanded={expanded}
        aria-controls={`${testIdPrefix}-sessions-metric-panel`}
        data-testid={`${testIdPrefix}-sessions-metric-toggle`}
        onClick={() => onExpandedChange(!expanded)}
      >
        <span className="flex shrink-0 items-center text-muted-foreground">
          <span className="sr-only">{toggleLabel}</span>
          {expanded ? (
            <ChevronUp className="size-3.5" aria-hidden />
          ) : (
            <ChevronDown className="size-3.5" aria-hidden />
          )}
        </span>
        <span className="shrink-0 text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
          Session metrics
        </span>
        {!expanded ? (
          <CollapsedMetricsSummary metrics={metrics} />
        ) : (
          <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
            {metrics.sessionCount} session
            {metrics.sessionCount === 1 ? "" : "s"} in scope
          </span>
        )}
      </button>

      <div
        id={`${testIdPrefix}-sessions-metric-panel`}
        // Collapsed content is only visually clipped, so it stays reachable by
        // screen readers unless it is taken out of the accessibility tree.
        aria-hidden={!expanded}
        className={cn(
          "grid transition-[grid-template-rows] duration-200 ease-out motion-reduce:transition-none",
          expanded ? "grid-rows-[1fr]" : "grid-rows-[0fr]",
        )}
      >
        <div className="overflow-hidden">{children}</div>
      </div>
    </div>
  );
}
