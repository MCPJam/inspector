/**
 * How one iteration's outcome is named and tinted, in one place.
 *
 * The results matrix, the findings block and the execution-errors card all
 * show the same word for the same recorded result. They were three private
 * copies; a fourth reader (the affected-iterations list) is what made the
 * drift visible, so the helpers moved here rather than being copied again.
 *
 * `unknown` is not a result the runner writes — it is what a reader says when
 * the iteration is not on this page, and it must never read as "passed".
 */
export type IterationOutcome =
  | "passed"
  | "failed"
  | "pending"
  | "cancelled"
  | "timed_out"
  | "setup_failed"
  | "skipped"
  | "unknown";

const LABELS: Record<string, string> = {
  passed: "Passed",
  failed: "Failed",
  pending: "In progress",
  cancelled: "Cancelled",
  timed_out: "Timed out",
  setup_failed: "Setup failed",
  skipped: "Skipped",
  unknown: "Not loaded",
};

export const outcomeLabel = (result: string): string =>
  LABELS[result] ?? "Unknown";

export const outcomeTextTone = (result: string): string =>
  result === "passed"
    ? "text-success"
    : result === "failed" || result === "timed_out" || result === "setup_failed"
    ? "text-destructive"
    : result === "pending"
    ? "text-pending"
    : "text-muted-foreground";

export const outcomeDotTone = (result: string): string =>
  result === "passed"
    ? "bg-success"
    : result === "failed" || result === "timed_out" || result === "setup_failed"
    ? "bg-destructive"
    : result === "pending"
    ? "bg-pending"
    : "bg-muted-foreground";
