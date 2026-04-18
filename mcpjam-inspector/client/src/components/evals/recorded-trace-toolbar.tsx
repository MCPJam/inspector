import type { ReactNode } from "react";
import { Expand, ListFilter, Shrink } from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@mcpjam/design-system/dropdown-menu";
import { cn } from "@/lib/utils";

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
  /** Optional zoom cluster (+ / fit / −) rendered after expand control. */
  zoomControls?: ReactNode;
  /** Timeline embed hides this; TraceViewer outer row supplies the divider. */
  showBottomBorder?: boolean;
}) {
  return (
    <div
      className={cn(
        "flex min-h-7 min-w-0 flex-1 flex-row flex-nowrap items-center gap-2 overflow-x-auto [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
        showBottomBorder && "border-b border-border/30 pb-2",
      )}
    >
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-7 shrink-0 gap-1.5 border-border/50 px-2 text-[10px] font-medium text-foreground"
            aria-label={`Filter timeline rows: ${timelineFilterLabel(filter)}`}
          >
            <ListFilter className="size-3.5 shrink-0 opacity-80" aria-hidden />
            {timelineFilterLabel(filter)}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="min-w-[8rem]">
          <DropdownMenuRadioGroup
            value={filter}
            onValueChange={(value) => onFilterChange(value as TimelineFilter)}
          >
            {TRACE_TIMELINE_FILTERS.map((entry) => (
              <DropdownMenuRadioItem
                key={entry}
                value={entry}
                className="text-xs"
              >
                {timelineFilterLabel(entry)}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
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
            className="bg-border hidden h-3 w-px shrink-0 md:block"
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
