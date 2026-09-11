import { cn } from "@/lib/utils";
import type { EvalStepStatus } from "@/shared/eval-stream-events";

/** Per-step verdicts of the selected trial, shown only while it matches the draft. */
export type SimpleCaseOverlay = {
  stepStatusById?: Map<string, EvalStepStatus>;
};

export function overlayStatus(
  overlay: SimpleCaseOverlay | null | undefined,
  stepId: string,
): EvalStepStatus | undefined {
  return overlay?.stepStatusById?.get(stepId);
}

export function StatusDot({ status }: { status: EvalStepStatus | undefined }) {
  if (!status || status === "running") return null;
  const label =
    status === "ok" ? "Passed" : status === "fail" ? "Failed" : "Skipped";
  return (
    <span
      className={cn(
        "inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase",
        status === "ok" && "bg-success/50 text-foreground",
        status === "fail" && "bg-destructive/50 text-destructive-foreground",
        status === "skipped" && "bg-muted text-muted-foreground",
      )}
      data-testid="simple-case-step-status"
    >
      {label}
    </span>
  );
}
