import { cn } from "@/lib/utils";
import type { RunCaseIterationOutcome } from "./run-case-groups";

/**
 * Run case table row: case title flexes on the left, fixed metric rail on the right.
 * Full row width is used (label ↔ numbers), with no trailing empty grid track.
 * @see evals_playground_design.html `.host-row` (name + auto metrics)
 */
export function runCaseListRowClassName() {
  return cn(
    "flex w-full min-w-0 items-center",
  );
}

/** Fixed-width metric columns — shared by header labels and row cells. */
export const runCaseMetricsRailClassName =
  "grid w-[16.25rem] shrink-0 grid-cols-[7.5rem_3.25rem_3.25rem_2.25rem] items-center";

/** Sort icon column width — aligns header control with row gutter. */
export const runCaseListSortGutterClassName = "flex w-7 shrink-0 items-center justify-end pr-2";

/** Header row — mirrors `.matrix-row.head` from evals_playground_design.html */
export const runCaseListHeadClassName =
  "min-h-9 border-b bg-muted/60 font-mono text-xs font-medium uppercase tracking-wide text-muted-foreground";

/** Data row minimum height — mirrors `.matrix-row` min-height */
export const runCaseListDataRowClassName = "min-h-11";

/** Case title — mirrors `.m-case .nm` */
export const runCaseTitleClassName =
  "min-w-0 flex-1 basis-0 truncate text-sm font-normal text-foreground";

/** Latency cells — mirrors `.host-row .lat` */
export const runCaseLatencyClassName =
  "text-right font-mono text-xs tabular-nums text-muted-foreground";

/**
 * Iteration pass/fail strip — mirrors `.pcell` bar segments from the playground mock.
 * @see evals_playground_design.html `.pcell .bar i.p` / `i.f`
 */
export function RunCaseIterationBar({
  results,
  passed,
  total,
  className,
  maxVisible = 10,
}: {
  results: RunCaseIterationOutcome[];
  passed: number;
  total: number;
  className?: string;
  maxVisible?: number;
}) {
  if (results.length === 0) return null;

  const segmentCount = Math.min(Math.max(total, results.length), maxVisible);
  const slots = Array.from({ length: segmentCount }, (_, index) => {
    return results[index] ?? "pending";
  });

  return (
    <div className={cn("flex w-full min-w-0 flex-col gap-1", className)}>
      <div className="flex w-full items-baseline">
        <span
          className={cn(
            "font-mono text-xs font-semibold tabular-nums text-foreground",
            total === 0 && "text-muted-foreground",
          )}
        >
          {passed}/{total}
        </span>
      </div>
      <div
        className="grid h-1 w-full gap-px"
        style={{
          gridTemplateColumns: `repeat(${slots.length}, minmax(0, 1fr))`,
        }}
        aria-hidden
      >
        {slots.map((result, index) => (
          <span
            key={index}
            className={cn(
              "min-h-1 min-w-0 rounded-[1px]",
              result === "pass" && "bg-success",
              result === "fail" && "bg-destructive",
              result === "pending" && "bg-muted-foreground/25",
              result === "cancelled" && "bg-muted-foreground/20",
            )}
          />
        ))}
      </div>
    </div>
  );
}

/** @deprecated Use RunCaseIterationBar — kept as alias for imports. */
export const RunCaseIterationDots = RunCaseIterationBar;

export const runCasePassCheckClass = "text-success";

export const runCaseFailCountClass =
  "font-mono text-xs font-semibold tabular-nums text-destructive";
