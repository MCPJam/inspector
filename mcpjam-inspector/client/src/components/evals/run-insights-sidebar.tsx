import { type ReactNode } from "react";
import { BarChart3 } from "lucide-react";
import { cn } from "@/lib/utils";

/** Shared label for the suite sidebar nav row (opens latest run / charts). */
export const RUN_INSIGHTS_SIDEBAR_LABEL = "Run Insights";

/** Run-detail sidebar: returns to the main-panel metrics + narrative (avoids repeating “Run insights”). */
export const RUN_DETAIL_OVERVIEW_SIDEBAR_LABEL = "Overview";

/**
 * Playground (Explore) sidebar: navigates to suite runs / charts view.
 * Same row pattern as historical “Runs”; label is Run Insights for parity with CI.
 */
export function RunInsightsNavRow({
  selected,
  onClick,
  className,
  label = RUN_INSIGHTS_SIDEBAR_LABEL,
}: {
  selected?: boolean;
  onClick: () => void;
  className?: string;
  /** Defaults to {@link RUN_INSIGHTS_SIDEBAR_LABEL}; playground may pass e.g. "Runs". */
  label?: string;
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
      <BarChart3
        className="h-4 w-4 shrink-0 text-muted-foreground"
        aria-hidden
      />
      <span>{label}</span>
    </div>
  );
}

/** Run-detail sidebar: switch back to run-level overview in the main pane (vs. per-iteration detail). */
export function RunInsightsSidebarSummary({
  className,
  onClick,
  selected,
  trailing,
}: {
  className?: string;
  onClick?: () => void;
  /** True when the main pane shows run-level metrics (no iteration selected). */
  selected?: boolean;
  /** Right-aligned metadata (e.g. pass rate %). */
  trailing?: ReactNode;
}) {
  const interactive = Boolean(onClick);
  const trailingText =
    typeof trailing === "string" || typeof trailing === "number"
      ? String(trailing)
      : null;
  const ariaLabel = interactive
    ? trailingText
      ? `${RUN_DETAIL_OVERVIEW_SIDEBAR_LABEL} — show in main panel — ${trailingText}`
      : `${RUN_DETAIL_OVERVIEW_SIDEBAR_LABEL} — show in main panel`
    : undefined;
  return (
    <div
      role={interactive ? "button" : undefined}
      tabIndex={interactive ? 0 : undefined}
      onClick={interactive ? onClick : undefined}
      onKeyDown={
        interactive
          ? (e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onClick?.();
              }
            }
          : undefined
      }
      className={cn(
        "flex shrink-0 items-center gap-2 bg-muted/25 px-4 py-2.5 text-sm transition-colors",
        interactive && "cursor-pointer hover:bg-accent/50",
        selected && "bg-accent font-medium",
        className,
      )}
      aria-label={ariaLabel}
    >
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <BarChart3
          className="h-4 w-4 shrink-0 text-muted-foreground"
          aria-hidden
        />
        <span className="font-medium text-foreground">
          {RUN_DETAIL_OVERVIEW_SIDEBAR_LABEL}
        </span>
      </div>
      {trailing != null && trailing !== "" ? (
        <span className="shrink-0 text-xs font-normal tabular-nums text-muted-foreground">
          {trailing}
        </span>
      ) : null}
    </div>
  );
}
