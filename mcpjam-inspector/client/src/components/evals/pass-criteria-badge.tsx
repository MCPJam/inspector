import { Badge } from "@/components/ui/badge";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { CheckCircle2, XCircle, AlertTriangle } from "lucide-react";
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
  const passRate = rawPassRate <= 1 && rawPassRate > 0 ? rawPassRate * 100 : rawPassRate;

  const passed = result === "passed";
  const isRunning = status === "running" || status === "pending";
  const failedCount = run.summary?.failed ?? 0;
  const passedWithFailures = passed && failedCount > 0;

  // Don't show pass/fail badge while run is in progress
  if (isRunning) {
    return null;
  }

  if (variant === "compact") {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <Badge
            variant="outline"
            className={
              passedWithFailures
                ? "gap-1 bg-amber-500/20 text-amber-600 border-amber-500/40 hover:bg-amber-500/30 dark:text-amber-400"
                : passed
                  ? "gap-1 bg-success/50 text-success-foreground border-success/50 hover:bg-success/70"
                  : "gap-1 bg-destructive/50 text-destructive-foreground border-destructive/50 hover:bg-destructive/70"
            }
          >
            {passedWithFailures ? (
              <AlertTriangle className="h-3 w-3" />
            ) : passed ? (
              <CheckCircle2 className="h-3 w-3" />
            ) : (
              <XCircle className="h-3 w-3" />
            )}
            {passedWithFailures ? `Passed (${failedCount} failed)` : passed ? "Passed" : "Failed"}
          </Badge>
        </TooltipTrigger>
        <TooltipContent className="max-w-xs">
          <div className="space-y-1 text-xs">
            <div className="font-medium text-white">
              {passedWithFailures
                ? `⚠ Suite Passed with ${failedCount} failure${failedCount !== 1 ? "s" : ""}`
                : passed ? "✓ Suite Passed" : "✗ Suite Failed"}
            </div>
            <div className="text-white">
              Required: {minimumPassRate}% {metricLabel} · Actual: {passRate.toFixed(0)}%
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
          <div className="mt-2 rounded border-l-2 border-destructive bg-destructive/10 p-2 text-xs">
            {metricLabel} {passRate.toFixed(1)}% below threshold{" "}
            {minimumPassRate}%
          </div>
        )}
      </div>
    </div>
  );
}
