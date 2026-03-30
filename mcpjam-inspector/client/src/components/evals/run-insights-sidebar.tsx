import type { ReactNode } from "react";
import { BarChart3 } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  RunHeaderCompactStats,
  type RunHeaderCompactStatsOverride,
} from "./run-header-compact-stats";
import type { EvalSuiteRun } from "./types";

/** Shared label for the playground nav row and CI run-detail sidebar summary. */
export const RUN_INSIGHTS_SIDEBAR_LABEL = "Run Insights";

/**
 * Playground (Explore) sidebar: navigates to suite runs / charts view.
 * Same row pattern as historical “Runs”; label is Run Insights for parity with CI.
 */
export function RunInsightsNavRow({
  selected,
  onClick,
  className,
}: {
  selected?: boolean;
  onClick: () => void;
  className?: string;
}) {
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onClick();
        }
      }}
      className={cn(
        "flex items-center gap-2 border-b px-4 py-2.5 text-sm transition-colors",
        "cursor-pointer hover:bg-accent/50",
        selected && "bg-accent font-medium",
        className,
      )}
    >
      <BarChart3 className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
      <span>{RUN_INSIGHTS_SIDEBAR_LABEL}</span>
    </div>
  );
}

/**
 * CI (and inline) run-detail sidebar: compact stats for the current run, same
 * uppercase section label + {@link RunHeaderCompactStats} as the playground uses for metrics copy.
 */
export function RunInsightsSidebarSummary({
  run,
  statsOverride,
  footer,
  className,
}: {
  run: EvalSuiteRun;
  statsOverride?: RunHeaderCompactStatsOverride;
  footer?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "shrink-0 border-b bg-muted/25 px-4 py-2.5",
        className,
      )}
    >
      <div className="mb-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
        {RUN_INSIGHTS_SIDEBAR_LABEL}
      </div>
      <RunHeaderCompactStats
        run={run}
        statsOverride={statsOverride}
        className="text-[11px] leading-snug"
      />
      {footer ? (
        <div className="mt-2 border-t border-border/60 pt-2">{footer}</div>
      ) : null}
    </div>
  );
}
