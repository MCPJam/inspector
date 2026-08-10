import { Button } from "@mcpjam/design-system/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@mcpjam/design-system/tooltip";
import { cn } from "@/lib/utils";
import { Loader2, RotateCw, X } from "lucide-react";
import { EVAL_REPLAY_SNAPSHOT_CLOUD_UNREACHABLE_MESSAGE } from "@/components/computer/CloudUnreachableNotice";
import { useEphemeralCloudAvailable } from "@/hooks/useProjectComputer";
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
  hasServersConfigured,
  missingServers,
  showCloseButton = false,
  onBackToOverview,
  runsDisabledReason = null,
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
  hasServersConfigured: boolean;
  missingServers: string[];
  showCloseButton?: boolean;
  onBackToOverview?: () => void;
  /**
   * Externally-derived reason no run may start (billing gate, unreachable
   * cloud sandboxes for a pinned-image suite). Blocks BOTH rerun and replay —
   * a replay provisions from the run's frozen image pin just like a rerun.
   */
  runsDisabledReason?: string | null;
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
  const canUseLiveRun = hasServersConfigured;
  // A replay provisions from the RUN's frozen snapshot pin — the live suite
  // pin may have been cleared or changed since, so the externally-derived
  // reason (live suite/environment state) can't cover this case.
  const ephemeralCloudAvailable = useEphemeralCloudAvailable();
  const replaySnapshotBlockedReason =
    isReplayAction &&
    ephemeralCloudAvailable === false &&
    Boolean(selectedRun.configSnapshot?.environment?.computerEnvironmentId)
      ? EVAL_REPLAY_SNAPSHOT_CLOUD_UNREACHABLE_MESSAGE
      : null;
  const effectiveDisabledReason =
    runsDisabledReason ?? replaySnapshotBlockedReason;
  const runActionDisabled = Boolean(
    effectiveDisabledReason ||
      (isReplayAction
        ? showAsRunning || !onReplayRun
        : !canUseLiveRun || showAsRunning)
  );
  const runActionLabel = showAsRunning
    ? isReplayAction
      ? "Replaying..."
      : "Running..."
    : isReplayAction
      ? "Replay this run"
      : "Rerun";
  const runActionTooltip = effectiveDisabledReason
    ? effectiveDisabledReason
    : isReplayAction
      ? "Replay this CI run in the playground"
      : !hasServersConfigured
        ? "No MCP servers are configured for this suite"
        : missingServers.length > 0
          ? "Connect and run."
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
