import { computeIterationResult } from "../../evals/pass-criteria";

/**
 * What a result page calls one iteration. Setup failed wins over a reported
 * result: the agent never ran, so that result is no verdict.
 */
export const iterationOutcome = (
  iteration: Parameters<typeof computeIterationResult>[0],
) =>
  iteration.status === "setup_failed"
    ? "setup_failed"
    : computeIterationResult(iteration);

export const outcomeLabel = (result: string) =>
  ({
    passed: "Passed",
    failed: "Failed",
    pending: "In progress",
    cancelled: "Cancelled",
    timed_out: "Timed out",
    setup_failed: "Setup failed",
    skipped: "Skipped",
  })[result] ?? "Unknown";
export const outcomeTextTone = (result: string) =>
  result === "passed"
    ? "text-success"
    : result === "failed" || result === "timed_out"
      ? "text-destructive"
      : result === "pending"
        ? "text-pending"
        : "text-muted-foreground";

export const outcomeDotTone = (result: string) =>
  result === "passed"
    ? "bg-success"
    : result === "failed" || result === "timed_out"
      ? "bg-destructive"
      : result === "pending"
        ? "bg-pending"
        : "bg-muted-foreground";
