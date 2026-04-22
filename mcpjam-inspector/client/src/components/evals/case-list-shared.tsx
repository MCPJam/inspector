import { cn } from "@/lib/utils";

/** Outer shell for a scrollable “cases” table (matches {@link TestCasesOverview}). */
export const caseListCardClassName =
  "flex flex-col rounded-xl border border-border/60 bg-card text-card-foreground";

/**
 * Column header row: “Case name” + status column, optional gutters for checkboxes or actions.
 * Shared with the suite “Cases” table and the run iteration sidebar.
 */
export function CaseListColumnHeaders({
  firstColumnLabel,
  secondColumnLabel,
  leadingGutter = false,
  trailingGutter = false,
  className,
}: {
  firstColumnLabel: string;
  secondColumnLabel: string;
  /** Reserve space to align with a leading checkbox column (batch mode). */
  leadingGutter?: boolean;
  /** Reserve space to align with a trailing icon control (e.g. Run or edit link). */
  trailingGutter?: boolean;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex w-full items-center gap-3 border-b bg-muted/30 px-4 py-1.5 text-xs font-medium text-muted-foreground",
        className,
      )}
    >
      {leadingGutter ? <div className="w-7 shrink-0" aria-hidden /> : null}
      <div className="min-w-0 flex-1 [min-width:120px]">{firstColumnLabel}</div>
      <div className="flex max-w-[min(100%,20rem)] min-w-0 flex-1 items-center justify-end gap-2">
        <span className="text-right">{secondColumnLabel}</span>
      </div>
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
    isSelected
      ? "bg-muted/50"
      : "bg-background hover:bg-muted/50",
  );
}
