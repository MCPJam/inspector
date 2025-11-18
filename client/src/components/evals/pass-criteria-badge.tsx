import { Badge } from "@/components/ui/badge";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { CheckCircle2, XCircle } from "lucide-react";
import { EvalSuiteRun } from "./types";

interface PassCriteriaBadgeProps {
  run: EvalSuiteRun;
  variant?: "compact" | "detailed";
}

export function PassCriteriaBadge({
  run,
  variant = "compact",
}: PassCriteriaBadgeProps) {
  // Get criteria and result from DB fields
  const minimumPassRate = run.passCriteria?.minimumPassRate ?? 100;
  const result = run.result ?? "pending";
  const status = run.status ?? "pending";
  // passRate is stored as decimal (0-1), convert to percentage (0-100)
  const passRateDecimal = run.summary?.passRate ?? 0;
  const passRate = passRateDecimal * 100;

  const passed = result === "passed";
  const isRunning = status === "running" || status === "pending";

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
              passed
                ? "gap-1 bg-emerald-500/50 text-white border-emerald-500/50 hover:bg-emerald-500/70"
                : "gap-1 bg-red-500/50 text-white border-red-500/50 hover:bg-red-500/70"
            }
          >
            {passed ? (
              <CheckCircle2 className="h-3 w-3" />
            ) : (
              <XCircle className="h-3 w-3" />
            )}
            {passed ? "Passed" : "Failed"}
          </Badge>
        </TooltipTrigger>
        <TooltipContent className="max-w-xs">
          <div className="space-y-1 text-xs">
            <div className="font-medium">
              {passed ? "✓ Suite Passed" : "✗ Suite Failed"}
            </div>
            <div className="text-muted-foreground">
              Required: {minimumPassRate}% Accuracy
            </div>
            <div className="text-muted-foreground">
              Actual: {passRate.toFixed(1)}%
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
          <CheckCircle2 className="h-5 w-5 text-emerald-500" />
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
            Min {minimumPassRate}% Accuracy
          </Badge>
        </div>

        <div className="flex items-center gap-2">
          <span className="text-muted-foreground">Accuracy:</span>
          <span className="font-mono">{passRate.toFixed(1)}%</span>
          <span className="text-muted-foreground">
            (threshold: {minimumPassRate}%)
          </span>
        </div>

        {!passed && passRate < minimumPassRate && (
          <div className="mt-2 rounded border-l-2 border-destructive bg-destructive/10 p-2 text-xs">
            Pass rate {passRate.toFixed(1)}% below threshold {minimumPassRate}%
          </div>
        )}
      </div>
    </div>
  );
}
