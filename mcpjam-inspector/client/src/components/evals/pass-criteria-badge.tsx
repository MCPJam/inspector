import { Badge } from "@mcpjam/design-system/badge";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@mcpjam/design-system/tooltip";
import { cn } from "@/lib/utils";
import { CheckCircle2, CircleSlash, Clock3, XCircle } from "lucide-react";
import { EVAL_LOW_PASS_RATE_TEXT_CLASS } from "./constants";
import { suitePassCriteriaCompactBadgeClassNames } from "./iteration-result-presentation";
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
  const cancelled = result === "cancelled" || status === "cancelled";
  const timedOut = result === "timed_out" || status === "timed_out";
  const isRunning = status === "running" || status === "pending";
  const failedCount = run.summary?.failed ?? 0;
  const passedWithFailures = passed && failedCount > 0;

  // Don't show pass/fail badge while run is in progress
  if (isRunning) {
    return null;
  }

  if (variant === "compact") {
    if (cancelled || timedOut) {
      const badgeLabel = timedOut ? "Timed out" : "Cancelled";
      const ariaOutcome = timedOut ? "Suite timed out" : "Suite cancelled";
      return (
        <span
          className={cn(
            "inline-flex items-center rounded px-1.5 py-0.5 text-[11px] font-medium",
            timedOut
              ? "bg-warning/50 text-foreground"
              : "bg-muted text-muted-foreground",
          )}
          aria-label={ariaOutcome}
        >
          {badgeLabel}
        </span>
      );
    }

    const outcome = passedWithFailures
      ? "passed_with_failures"
      : passed
        ? "passed"
        : "failed";
    const badgeLabel = passedWithFailures
      ? `Passed (${failedCount} failed)`
      : passed
        ? "Passed"
        : "Failed";
    const ariaOutcome = passedWithFailures
      ? `Passed with ${failedCount} failure${failedCount !== 1 ? "s" : ""}`
      : passed
        ? "Suite passed"
        : "Suite failed";

    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            tabIndex={0}
            className={cn(
              suitePassCriteriaCompactBadgeClassNames(outcome),
              "cursor-default outline-none",
              "focus-visible:ring-2 focus-visible:ring-foreground/[0.08] focus-visible:ring-offset-2 focus-visible:ring-offset-background",
            )}
            aria-label={`${ariaOutcome}. Required ${minimumPassRate}% ${metricLabel}, actual ${passRate.toFixed(0)}%.`}
          >
            {badgeLabel}
          </span>
        </TooltipTrigger>
        <TooltipContent className="max-w-xs">
          <div className="space-y-1 text-xs">
            <div className="font-medium text-primary-foreground">
              {ariaOutcome}
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
        {cancelled ? (
          <CircleSlash className="h-5 w-5 text-muted-foreground" />
        ) : timedOut ? (
          <Clock3 className="h-5 w-5 text-warning" />
        ) : passed ? (
          <CheckCircle2 className="h-5 w-5 text-success" />
        ) : (
          <XCircle className={cn("h-5 w-5", EVAL_LOW_PASS_RATE_TEXT_CLASS)} />
        )}
        <h3 className="text-sm font-medium">
          {cancelled
            ? "Suite Cancelled"
            : timedOut
              ? "Suite Timed Out"
              : passed
                ? "Suite Passed"
                : "Suite Failed"}
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
          <div
            className={cn(
              "mt-2 rounded border-l-2 border-destructive/50 bg-destructive/50 p-2 text-xs text-foreground",
            )}
          >
            {metricLabel} {passRate.toFixed(1)}% below threshold{" "}
            {minimumPassRate}%
          </div>
        )}
      </div>
    </div>
  );
}
