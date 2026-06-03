import { cn } from "@/lib/utils";
import { EVAL_FAILED_BADGE_CLASS } from "./constants";
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
      ? "bg-success/50 text-foreground"
      : outcome === "failed"
        ? EVAL_FAILED_BADGE_CLASS
        : "bg-warning/50 text-foreground";

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
    return "bg-success/50 text-foreground";
  }
  if (result === "failed") {
    return EVAL_FAILED_BADGE_CLASS;
  }
  if (result === "cancelled") {
    return "bg-muted text-muted-foreground";
  }
  return "bg-warning/50 text-foreground";
}

export function iterationResultBadgeClassNames(iteration: EvalIteration) {
  return cn(ITERATION_RESULT_BADGE_BASE, getIterationResultBadgeClass(iteration));
}
