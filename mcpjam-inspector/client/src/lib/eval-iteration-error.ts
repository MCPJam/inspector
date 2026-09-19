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
      title: "Run timed out",
      severity: "warning",
      oneLine:
        "The run stopped before it could finish. Retry the run; if it happens again, check the execution limits and server response times.",
      likelyCauses: [
        "The worker stopped responding or the run exceeded its time limit.",
      ],
      nextSteps: [
        "Retry the run.",
        "Check the run's timing and connected servers if it times out again.",
      ],
      rawMessage,
    };
  if (setup)
    return {
      ...base,
      slug: "eval/setup_failed",
      title: "Run setup failed",
      severity: "error",
      oneLine:
        "The execution environment could not start. Check the host's servers and configuration, then retry.",
      likelyCauses: [],
      nextSteps: [
        "Check the host's server connections and environment configuration.",
      ],
      rawMessage,
    };
  if (cancelled)
    return {
      ...base,
      slug: "eval/cancelled",
      title: "Run cancelled",
      severity: "info",
      oneLine: "The run was cancelled before it finished.",
      likelyCauses: [],
      nextSteps: ["Start another run when you are ready."],
      rawMessage,
    };
  return { ...base, rawMessage };
}
