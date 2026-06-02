import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import {
  evalSurfaceCardClass,
  evalSurfaceHeaderClass,
  evalSurfaceRowHoverClass,
} from "./eval-surface-chrome";

/** Outer shell for a scrollable “cases” table (matches {@link TestCasesOverview}). */
export const caseListCardClassName = cn("flex flex-col", evalSurfaceCardClass);

/**
 * Column header row: “Case name” + status column, optional gutters for checkboxes or actions.
 * Shared with the suite “Cases” table and the run iteration sidebar.
 */
export function CaseListColumnHeaders({
  firstColumnLabel,
  secondColumnLabel,
  leadingGutter = false,
  trailingGutter = false,
  /** e.g. sort control for run iteration list — sits after the “Last run” label, before row action gutter. */
  headerEnd = null,
  className,
}: {
  firstColumnLabel: string;
  secondColumnLabel: string;
  /** Reserve space to align with a leading checkbox column (batch mode). */
  leadingGutter?: boolean;
  /** Reserve space to align with a trailing icon control (e.g. Run or edit link). */
  trailingGutter?: boolean;
  headerEnd?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex w-full items-center gap-3 px-4 py-2 text-xs font-medium text-muted-foreground",
        evalSurfaceHeaderClass,
        className,
      )}
    >
      {leadingGutter ? <div className="w-7 shrink-0" aria-hidden /> : null}
      <div className="min-w-0 flex-1 [min-width:120px]">{firstColumnLabel}</div>
      <div className="flex max-w-[min(100%,20rem)] min-w-0 flex-1 items-center justify-end gap-2">
        <span className="text-right">{secondColumnLabel}</span>
      </div>
      {headerEnd ? (
        <div className="flex shrink-0 items-center justify-end">{headerEnd}</div>
      ) : null}
      {trailingGutter ? <div className="w-7 shrink-0" aria-hidden /> : null}
    </div>
  );
}

/**
 * One data row: same padding and hover/selected behavior as
 * `test-cases-overview` case rows.
 */
export function caseListDataRowClassName(options: {
  isSelected: boolean;
  isDimmed?: boolean;
}) {
  const { isSelected, isDimmed } = options;
  return cn(
    "flex w-full min-w-0 items-center gap-2 px-4 py-2.5 transition-colors",
    isDimmed && "opacity-60",
    isSelected ? "bg-muted/65" : cn("bg-background", evalSurfaceRowHoverClass),
  );
}
