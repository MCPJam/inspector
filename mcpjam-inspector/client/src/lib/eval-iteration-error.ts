import { ERROR_MESSAGES } from "@/lib/error-messages";
import { describeError, type NormalizedError } from "@mcpjam/sdk/browser";
import type { EvalIteration } from "@/components/evals/types";

/** Preserve diagnostics without making worker internals the run's headline. */
export function describeEvalIterationError(
  iteration: Pick<
    EvalIteration,
    "status" | "result" | "error" | "errorDetails"
  >,
): NormalizedError | null {
  const timeout =
    iteration.status === "timed_out" ||
    iteration.result === "timed_out" ||
    /worker heartbeat lost/i.test(iteration.error ?? "");
  const setup = iteration.status === "setup_failed";
  const cancelled = iteration.status === "cancelled";
  if (!timeout && !setup && !cancelled && !iteration.error) return null;

  const base = describeError(iteration.error ?? "");
  let details = iteration.errorDetails;
  if (details) {
    try {
      details = JSON.stringify(JSON.parse(details), null, 2);
    } catch {
      /* Keep non-JSON diagnostics verbatim. */
    }
  }
  const rawMessage = [iteration.error, details].filter(Boolean).join("\n\n");
  if (timeout)
    return {
      ...base,
      slug: "eval/timed_out",
      title: ERROR_MESSAGES.runTimedOut,
      severity: "warning",
      oneLine: ERROR_MESSAGES.theRunStoppedBeforeItCouldFinishRetryTheRun,
      likelyCauses: [
        ERROR_MESSAGES.theWorkerStoppedRespondingOrTheRunExceededItsTime,
      ],
      nextSteps: [
        ERROR_MESSAGES.retryTheRun,
        ERROR_MESSAGES.checkTheRunSTimingAndConnectedServersIfIt,
      ],
      rawMessage,
    };
  if (setup)
    return {
      ...base,
      slug: "eval/setup_failed",
      title: ERROR_MESSAGES.runSetupFailed,
      severity: "error",
      oneLine: ERROR_MESSAGES.theExecutionEnvironmentCouldNotStartCheckTheHostS,
      likelyCauses: [],
      nextSteps: [
        ERROR_MESSAGES.checkTheHostSServerConnectionsAndEnvironmentConfiguration,
      ],
      rawMessage,
    };
  if (cancelled)
    return {
      ...base,
      slug: "eval/cancelled",
      title: ERROR_MESSAGES.runCancelled,
      severity: "info",
      oneLine: ERROR_MESSAGES.theRunWasCancelledBeforeItFinished,
      likelyCauses: [],
      nextSteps: [ERROR_MESSAGES.startAnotherRunWhenYouAreReady],
      rawMessage,
    };
  return { ...base, rawMessage };
}
