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
  const passRate = run.summary?.passRate ?? 0;

  const passed = result === "passed";

  if (variant === "compact") {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <Badge
            variant={passed ? "default" : "destructive"}
            className="gap-1"
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
              Criteria: Min {minimumPassRate}% pass rate
            </div>
            <div className="text-muted-foreground">
              Pass Rate: {passRate.toFixed(1)}% (threshold: {minimumPassRate}%)
            </div>
            {!passed && passRate < minimumPassRate && (
              <div className="text-muted-foreground">
                Pass rate {passRate.toFixed(1)}% below threshold {minimumPassRate}%
              </div>
            )}
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
          <CheckCircle2 className="h-5 w-5 text-green-600" />
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
            Min {minimumPassRate}% pass rate
          </Badge>
        </div>

        <div className="flex items-center gap-2">
          <span className="text-muted-foreground">Pass Rate:</span>
          <span className="font-mono">
            {passRate.toFixed(1)}%
          </span>
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
