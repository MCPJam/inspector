import { cn } from "@/lib/utils";
import { computeIterationResult } from "./pass-criteria";
import type { EvalIteration } from "./types";

/** Shared layout for suite / iteration result pills (see {@link IterationListItem}). */
export const ITERATION_RESULT_BADGE_BASE =
  "inline-flex shrink-0 items-center rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase";

export type SuitePassCriteriaCompactOutcome =
  | "passed"
  | "failed"
  | "passed_with_failures";

/** Compact suite pass-criterion badge colors (aligned with iteration row badges). */
export function suitePassCriteriaCompactBadgeClassNames(
  outcome: SuitePassCriteriaCompactOutcome,
) {
  const colorClass =
    outcome === "passed"
      ? "bg-emerald-500/15 text-emerald-700 dark:bg-emerald-400/20 dark:text-emerald-300"
      : outcome === "failed"
        ? // Use semantic destructive tokens + border so suite outcome reads at a glance next to KPIs.
          "border border-destructive/35 bg-destructive/10 font-bold text-destructive shadow-sm dark:border-destructive/45 dark:bg-destructive/20"
        : "bg-amber-500/15 text-amber-700 dark:bg-amber-400/20 dark:text-amber-300";

  return cn(ITERATION_RESULT_BADGE_BASE, colorClass);
}

/** Human-readable result for badges (aligned with {@link SuiteExecutionsOverview} rows). */
export function getIterationResultDisplayLabel(iteration: EvalIteration) {
  const result = computeIterationResult(iteration);
  if (result === "pending") {
    return iteration.status === "running" ? "Running" : "Pending";
  }
  return result.charAt(0).toUpperCase() + result.slice(1);
}

/** Badge colors for suite-style iteration rows. */
export function getIterationResultBadgeClass(iteration: EvalIteration) {
  const result = computeIterationResult(iteration);
  if (result === "passed") {
    return "bg-emerald-500/15 text-emerald-700 dark:bg-emerald-400/20 dark:text-emerald-300";
  }
  if (result === "failed") {
    return "bg-rose-500/15 text-rose-700 dark:bg-rose-400/20 dark:text-rose-300";
  }
  if (result === "cancelled") {
    return "bg-muted text-muted-foreground";
  }
  return "bg-amber-500/15 text-amber-700 dark:bg-amber-400/20 dark:text-amber-300";
}

export function iterationResultBadgeClassNames(iteration: EvalIteration) {
  return cn(ITERATION_RESULT_BADGE_BASE, getIterationResultBadgeClass(iteration));
}
