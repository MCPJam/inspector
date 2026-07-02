import { ArrowUpDown } from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@mcpjam/design-system/dropdown-menu";
import { cn } from "@/lib/utils";
import { caseRowSortLabel, type CaseRowSort } from "./case-row-metrics";

export const CASE_ROW_SORT_STORAGE_KEY = "evals:cross-host-case-sort";

export const CASE_ROW_SORT_OPTIONS: CaseRowSort[] = [
  "suite-order",
  "latency",
  "tokens",
  "tool-calls",
  "failures",
];

export function CaseRowSortControl({
  value,
  onChange,
  showLabel = false,
}: {
  value: CaseRowSort;
  onChange: (sort: CaseRowSort) => void;
  /** When true, show a "Sort" prefix and the active mode beside the trigger. */
  showLabel?: boolean;
}) {
  const activeLabel = caseRowSortLabel(value);

  return (
    <div
      className={cn("flex items-center", showLabel ? "gap-1.5" : undefined)}
      data-testid="case-row-sort-control"
    >
      {showLabel ? (
        <span className="text-xs text-muted-foreground">Sort</span>
      ) : null}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="outline"
            size={showLabel ? "sm" : "icon"}
            className={cn(
              "shrink-0 border-border/50 bg-background text-muted-foreground hover:text-foreground",
              showLabel
                ? "h-7 gap-1.5 px-2 text-xs font-medium text-foreground"
                : "h-7 w-7",
            )}
            aria-label={`Sort cases: ${activeLabel}`}
            title={`Sort cases: ${activeLabel}`}
            data-testid="case-row-sort-trigger"
          >
            <ArrowUpDown className="size-3.5 shrink-0" aria-hidden />
            {showLabel ? (
              <span data-testid="case-row-sort-active-label">{activeLabel}</span>
            ) : null}
          </Button>
        </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-[9rem]">
        <DropdownMenuRadioGroup
          value={value}
          onValueChange={(next) => onChange(next as CaseRowSort)}
        >
          {CASE_ROW_SORT_OPTIONS.map((option) => (
            <DropdownMenuRadioItem
              key={option}
              value={option}
              className="text-xs"
              data-testid={`case-row-sort-${option}`}
            >
              {caseRowSortLabel(option)}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
    </div>
  );
}
