import { cn } from "@/lib/utils";
import { computeIterationResult } from "./pass-criteria";
import type { EvalIteration } from "./types";

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
  return cn(
    "inline-flex shrink-0 items-center rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase",
    getIterationResultBadgeClass(iteration),
  );
}
