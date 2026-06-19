import type { ReactNode } from "react";
import { Expand, Shrink } from "lucide-react";
import { Button } from "./ui";
import { cn } from "../cn";

export const TRACE_TIMELINE_FILTERS = ["all", "llm", "tool", "error"] as const;
export type TimelineFilter = (typeof TRACE_TIMELINE_FILTERS)[number];

export function timelineFilterLabel(entry: TimelineFilter): string {
  switch (entry) {
    case "all":
      return "All";
    case "llm":
      return "LLM";
    case "tool":
      return "Tool";
    case "error":
      return "Error";
    default:
      return entry;
  }
}

/**
 * Tier-A toolbar for the recorded trace timeline. The inspector original used a
 * `@mcpjam/design-system` DropdownMenu for the category filter; this package
 * keeps it dependency-free as an inline segmented row of buttons.
 */
export function RecordedTraceToolbar({
  filter,
  onFilterChange,
  isFullyExpanded,
  expandDisabled,
  onToggleExpandAll,
  zoomControls,
  showBottomBorder = true,
}: {
  filter: TimelineFilter;
  onFilterChange: (next: TimelineFilter) => void;
  isFullyExpanded: boolean;
  expandDisabled: boolean;
  onToggleExpandAll: () => void;
  /** Optional zoom cluster (+ / −) rendered after the expand control. */
  zoomControls?: ReactNode;
  /** Timeline embed hides this; an outer row can supply the divider instead. */
  showBottomBorder?: boolean;
}) {
  return (
    <div
      className={cn(
        "flex min-h-7 min-w-0 flex-1 flex-row flex-nowrap items-center gap-2 overflow-x-auto [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
        showBottomBorder && "border-b border-border/30 pb-2",
      )}
    >
      <div
        role="group"
        aria-label="Filter timeline rows"
        className="flex shrink-0 items-center gap-0.5 rounded-md border border-border/50 p-0.5"
      >
        {TRACE_TIMELINE_FILTERS.map((entry) => (
          <Button
            key={entry}
            type="button"
            variant={filter === entry ? "secondary" : "outline"}
            size="sm"
            aria-pressed={filter === entry}
            className={cn(
              "h-6 border-transparent px-2 text-[10px] font-medium",
              filter === entry
                ? "text-foreground"
                : "text-muted-foreground hover:text-foreground",
            )}
            onClick={() => onFilterChange(entry)}
          >
            {timelineFilterLabel(entry)}
          </Button>
        ))}
      </div>
      <Button
        type="button"
        variant="outline"
        size="icon"
        disabled={expandDisabled}
        className="h-7 w-7 shrink-0 border-border/50 text-muted-foreground hover:text-foreground disabled:opacity-40"
        title={isFullyExpanded ? "Collapse all" : "Expand all"}
        aria-label={isFullyExpanded ? "Collapse all" : "Expand all"}
        aria-pressed={isFullyExpanded}
        onClick={onToggleExpandAll}
      >
        {isFullyExpanded ? (
          <Shrink className="size-3.5" strokeWidth={2} aria-hidden />
        ) : (
          <Expand className="size-3.5" strokeWidth={2} aria-hidden />
        )}
      </Button>
      {zoomControls ? (
        <>
          <span
            className="hidden h-3 w-px shrink-0 bg-border md:block"
            aria-hidden
          />
          <div className="flex shrink-0 items-center gap-0.5">
            {zoomControls}
          </div>
        </>
      ) : null}
    </div>
  );
}
