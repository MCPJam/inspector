/** Words and tones for one iteration's result, shared by the run views. */
export const outcomeLabel = (result: string) =>
  ({
    passed: "Passed",
    failed: "Failed",
    pending: "In progress",
    cancelled: "Cancelled",
    timed_out: "Timed out",
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
