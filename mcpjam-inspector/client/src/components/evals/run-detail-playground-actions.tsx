import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { Loader2, RotateCw, X } from "lucide-react";
import type { EvalSuite, EvalSuiteRun } from "./types";

/** Replay / rerun / cancel controls for a run detail view (SuiteHeader row or CI sidebar). */
export function RunDetailPlaygroundActions({
  suite,
  selectedRun,
  readOnlyConfig = false,
  onReplayRun,
  onRerun,
  onCancelRun,
  rerunningSuiteId,
  replayingRunId = null,
  cancellingRunId,
  canRerun,
  hasServersConfigured,
  missingServers,
  showCloseButton = false,
  onBackToOverview,
  className,
}: {
  suite: EvalSuite;
  selectedRun: EvalSuiteRun;
  readOnlyConfig?: boolean;
  onReplayRun?: (suite: EvalSuite, run: EvalSuiteRun) => void;
  onRerun: (suite: EvalSuite) => void;
  onCancelRun: (runId: string) => void;
  rerunningSuiteId: string | null;
  replayingRunId?: string | null;
  cancellingRunId: string | null;
  canRerun: boolean;
  hasServersConfigured: boolean;
  missingServers: string[];
  showCloseButton?: boolean;
  onBackToOverview?: () => void;
  className?: string;
}) {
  const isCancelling = cancellingRunId === selectedRun._id;
  const isRunInProgress =
    selectedRun.status === "running" || selectedRun.status === "pending";
  const showAsRunning =
    isRunInProgress ||
    rerunningSuiteId === suite._id ||
    replayingRunId === selectedRun._id;
  const replayableSelectedRun = selectedRun.hasServerReplayConfig
    ? selectedRun
    : null;
  const showRunAction = Boolean(replayableSelectedRun) || !readOnlyConfig;
  const isReplayAction = Boolean(replayableSelectedRun);
  const runActionDisabled = isReplayAction
    ? showAsRunning || !onReplayRun
    : !canRerun || showAsRunning;
  const runActionLabel = showAsRunning
    ? isReplayAction
      ? "Replaying..."
      : "Running..."
    : isReplayAction
      ? "Replay this run"
      : "Rerun";
  const runActionTooltip = isReplayAction
    ? "Replay this CI run in the playground"
    : !hasServersConfigured
      ? "No connected MCP servers are configured for this suite"
      : !canRerun
        ? `Connect the following servers: ${missingServers.join(", ")}`
        : "Run all cases";

  return (
    <div
      className={cn("flex items-center gap-2 shrink-0", className)}
      data-testid="run-detail-playground-actions"
    >
      {!readOnlyConfig &&
        (isRunInProgress ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="outline"
                size="sm"
                onClick={() => onCancelRun(selectedRun._id)}
                disabled={isCancelling}
                className="gap-2"
              >
                {isCancelling ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Cancelling...
                  </>
                ) : (
                  <>
                    <X className="h-4 w-4" />
                    Cancel run
                  </>
                )}
              </Button>
            </TooltipTrigger>
            <TooltipContent>Cancel the current evaluation run</TooltipContent>
          </Tooltip>
        ) : null)}
      {showRunAction && !isRunInProgress ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <span className={cn(showCloseButton ? "" : "w-full")}>
              <Button
                variant="outline"
                size="sm"
                onClick={() =>
                  isReplayAction && replayableSelectedRun
                    ? onReplayRun?.(suite, replayableSelectedRun)
                    : onRerun(suite)
                }
                disabled={runActionDisabled}
                className={cn("gap-2", !showCloseButton && "w-full")}
              >
                <RotateCw
                  className={`h-4 w-4 ${showAsRunning ? "animate-spin" : ""}`}
                />
                {runActionLabel}
              </Button>
            </span>
          </TooltipTrigger>
          <TooltipContent>{runActionTooltip}</TooltipContent>
        </Tooltip>
      ) : null}
      {showCloseButton && onBackToOverview ? (
        <Button
          variant="outline"
          size="icon"
          onClick={() => onBackToOverview()}
        >
          <X className="h-4 w-4" />
        </Button>
      ) : null}
    </div>
  );
}
