import { Badge } from "@/components/ui/badge";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { Check, X, AlertTriangle, CheckCircle2, XCircle } from "lucide-react";
import { EVAL_OUTCOME_STATUS_TEXT_CLASS } from "./constants";
import { EvalSuiteRun } from "./types";

interface PassCriteriaBadgeProps {
  run: EvalSuiteRun;
  variant?: "compact" | "detailed";
  metricLabel?: string;
}

export function PassCriteriaBadge({
  run,
  variant = "compact",
  metricLabel = "Accuracy",
}: PassCriteriaBadgeProps) {
  // Get criteria and result from DB fields
  const minimumPassRate = run.passCriteria?.minimumPassRate ?? 100;
  const result = run.result ?? "pending";
  const status = run.status ?? "pending";
  // passRate may be stored as decimal (0-1) or percentage (0-100); normalize to 0-100
  const rawPassRate = run.summary?.passRate ?? 0;
  const passRate =
    rawPassRate <= 1 && rawPassRate > 0 ? rawPassRate * 100 : rawPassRate;

  const passed = result === "passed";
  const isRunning = status === "running" || status === "pending";
  const failedCount = run.summary?.failed ?? 0;
  const passedWithFailures = passed && failedCount > 0;

  // Don't show pass/fail badge while run is in progress
  if (isRunning) {
    return null;
  }

  if (variant === "compact") {
    const surface = passedWithFailures
      ? "border-amber-200/90 bg-amber-500/[0.07] text-amber-950 hover:bg-amber-500/[0.11] dark:border-amber-500/22 dark:bg-amber-400/[0.06] dark:text-amber-50 dark:hover:bg-amber-400/[0.1]"
      : passed
        ? cn(
            "border-green-500/25 bg-green-500/[0.07] hover:bg-green-500/[0.11] dark:border-green-400/25 dark:bg-green-400/[0.08] dark:hover:bg-green-400/[0.12]",
            EVAL_OUTCOME_STATUS_TEXT_CLASS.passed,
          )
        : cn(
            "border-red-500/25 bg-red-500/[0.07] hover:bg-red-500/[0.11] dark:border-red-400/25 dark:bg-red-400/[0.08] dark:hover:bg-red-400/[0.12]",
            EVAL_OUTCOME_STATUS_TEXT_CLASS.failed,
          );

    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            className={cn(
              "inline-flex cursor-default items-center gap-1.5 rounded-full border px-2.5 py-1",
              "text-[11px] font-medium leading-none tracking-tight",
              "shadow-[0_1px_2px_rgba(0,0,0,0.045)] transition-[background-color,border-color,box-shadow] duration-150 dark:shadow-none",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-foreground/[0.08] focus-visible:ring-offset-2 focus-visible:ring-offset-background",
              surface,
            )}
          >
            {passedWithFailures ? (
              <AlertTriangle
                className="size-3 shrink-0 opacity-[0.88]"
                strokeWidth={1.5}
                aria-hidden
              />
            ) : passed ? (
              <Check
                className="size-3 shrink-0 opacity-[0.88]"
                strokeWidth={1.5}
                aria-hidden
              />
            ) : (
              <X
                className="size-3 shrink-0 opacity-[0.88]"
                strokeWidth={1.5}
                aria-hidden
              />
            )}
            {passedWithFailures
              ? `Passed (${failedCount} failed)`
              : passed
                ? "Passed"
                : "Failed"}
          </button>
        </TooltipTrigger>
        <TooltipContent className="max-w-xs">
          <div className="space-y-1 text-xs">
            <div className="font-medium text-primary-foreground">
              {passedWithFailures
                ? `Passed with ${failedCount} failure${failedCount !== 1 ? "s" : ""}`
                : passed
                  ? "Suite passed"
                  : "Suite failed"}
            </div>
            <div className="text-primary-foreground/90">
              Required {minimumPassRate}% {metricLabel}. Actual{" "}
              {passRate.toFixed(0)}%.
            </div>
          </div>
        </TooltipContent>
      </Tooltip>
    );
  }

  // Detailed variant
  return (
    <div className="space-y-3 rounded-lg border bg-muted/30 p-4">
      <div className="flex items-center gap-2">
        {passed ? (
          <CheckCircle2 className="h-5 w-5 text-success" />
        ) : (
          <XCircle className="h-5 w-5 text-destructive" />
        )}
        <h3 className="text-sm font-medium">
          {passed ? "Suite Passed" : "Suite Failed"}
        </h3>
      </div>

      <div className="space-y-2 text-xs">
        <div className="flex items-center gap-2">
          <span className="text-muted-foreground">Criteria:</span>
          <Badge variant="outline" className="text-xs">
            Min {minimumPassRate}% {metricLabel}
          </Badge>
        </div>

        <div className="flex items-center gap-2">
          <span className="text-muted-foreground">{metricLabel}:</span>
          <span className="font-mono">{passRate.toFixed(1)}%</span>
          <span className="text-muted-foreground">
            (threshold: {minimumPassRate}%)
          </span>
        </div>

        {!passed && passRate < minimumPassRate && (
          <div className="mt-2 rounded border-l-2 border-destructive bg-destructive/10 p-2 text-xs text-destructive">
            {metricLabel} {passRate.toFixed(1)}% below threshold{" "}
            {minimumPassRate}%
          </div>
        )}
      </div>
    </div>
  );
}
