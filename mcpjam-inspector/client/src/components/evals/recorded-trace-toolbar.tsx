import type { ReactNode } from "react";
import { Expand, ListFilter, RotateCcw, Shrink } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
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

function formatDuration(ms: number): string {
  if (ms >= 1000) return `${(ms / 1000).toFixed(ms >= 10_000 ? 1 : 2)}s`;
  return `${Math.round(ms)}ms`;
}

export function RecordedTraceToolbar({
  promptCount,
  maxEndMs,
  filter,
  onFilterChange,
  isFullyExpanded,
  expandDisabled,
  onToggleExpandAll,
  onReset,
  zoomControls,
  showBottomBorder = true,
}: {
  promptCount: number;
  maxEndMs: number;
  filter: TimelineFilter;
  onFilterChange: (next: TimelineFilter) => void;
  isFullyExpanded: boolean;
  expandDisabled: boolean;
  onToggleExpandAll: () => void;
  /** Reset filter, expansion, timeline zoom, and row selection to defaults. */
  onReset?: () => void;
  /** Optional zoom cluster (+ / fit / −) rendered after expand control. */
  zoomControls?: ReactNode;
  /** Timeline embed hides this; TraceViewer outer row supplies the divider. */
  showBottomBorder?: boolean;
}) {
  return (
    <div
      className={cn(
        "flex min-h-8 min-w-0 flex-1 items-center gap-2 overflow-x-auto [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
        showBottomBorder && "border-b border-border/30 pb-2",
      )}
    >
      <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground">
        <span className="font-medium text-foreground/90">Recorded</span>
        <span className="mx-1.5 text-muted-foreground/50">·</span>
        {promptCount} prompt{promptCount === 1 ? "" : "s"}
        <span className="mx-1.5 text-muted-foreground/50">·</span>
        {formatDuration(maxEndMs)}
      </span>
      <span
        className="bg-border hidden h-3 w-px shrink-0 sm:block"
        aria-hidden
      />
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
            onValueChange={(value) =>
              onFilterChange(value as TimelineFilter)
            }
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
      <span
        className="bg-border hidden h-3 w-px shrink-0 md:block"
        aria-hidden
      />
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
          <div className="flex shrink-0 items-center gap-0.5">{zoomControls}</div>
        </>
      ) : null}
      {onReset ? (
        <>
          <span
            className="bg-border hidden h-3 w-px shrink-0 md:block"
            aria-hidden
          />
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-7 shrink-0 gap-1 border-border/50 px-2 text-[10px] font-medium text-foreground"
            title="Reset filter, expansion, zoom, and selection"
            aria-label="Reset trace view"
            onClick={onReset}
          >
            <RotateCcw className="size-3.5 shrink-0 opacity-80" aria-hidden />
            Reset
          </Button>
        </>
      ) : null}
    </div>
  );
}
