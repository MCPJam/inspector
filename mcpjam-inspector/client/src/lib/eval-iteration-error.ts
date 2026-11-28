import { describeError, type NormalizedError } from "@mcpjam/sdk/browser";
import type { EvalIteration } from "@/components/evals/types";
import {
  describeOrgKeysRefusal,
  runRefusal,
  orgKeysRefusalNextStep,
} from "@/lib/org-keys-refusal";

/** What the backend stores on every iteration a launch never started. */
const NEVER_STARTED_ERROR = "Failed to prepare eval test attempts.";

/**
 * The reason a launch never started this iteration, when the launch stored a
 * sentence a member can read (`markSetupPendingIterationsFailed` keeps it in
 * `errorDetails`). Other callers store raw causes, which keep the generic card.
 */
export function neverStartedReason(
  iteration: Pick<EvalIteration, "status" | "error" | "errorDetails">,
): string | null {
  if (iteration.status !== "failed" || iteration.error !== NEVER_STARTED_ERROR)
    return null;
  const details = iteration.errorDetails?.trim() ?? "";
  // Not a sentence for a member: JSON, a stack, a request id, an error class,
  // or a leading machine code such as "TOOL_POLICY_UNSUPPORTED: …".
  if (details.length > 400 || /[\n{}[\]]|\[Request ID|\bCONVEX\b|\w+Error:|^[A-Z][A-Z0-9_]{2,}:/.test(details))
    return null;
  return /^[A-Z][^]*[.!?]$/.test(details) ? details : null;
}

/** Preserve diagnostics without making worker internals the run's headline. */
export function describeEvalIterationError(
  iteration: Pick<
    EvalIteration,
    "status" | "result" | "error" | "errorDetails" | "infraError"
  >,
): NormalizedError | null {
  const timeout =
    iteration.status === "timed_out" ||
    iteration.result === "timed_out" ||
    /worker heartbeat lost/i.test(iteration.error ?? "");
  const setup = iteration.status === "setup_failed";
  const cancelled = iteration.status === "cancelled";
  // The organization's AI key policy refused the run's model (or its own
  // provider did): configuration, not the host or the server. A failed
  // iteration may carry the code only in its diagnostics. A completed one
  // that failed its assertions counts only a code MCPJam recorded in its
  // diagnostics or infra error: its own text may be the MCP server's.
  const readText = setup || iteration.status === "failed";
  const refusal =
    readText || iteration.result === "failed"
      ? runRefusal(
          {
            error: iteration.error,
            errorDetails: iteration.errorDetails,
            infraErrorCode: iteration.infraError?.code,
          },
          readText,
        )
      : undefined;
  if (!timeout && !setup && !cancelled && !iteration.error && !refusal)
    return null;

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
  if (refusal && !timeout) {
    const described = describeOrgKeysRefusal(refusal.code, "member");
    return {
      ...base,
      slug: "eval/ai_refused",
      title: described.title,
      severity: "warning",
      oneLine: described.body,
      likelyCauses: [],
      nextSteps: [orgKeysRefusalNextStep(described.remediation)],
      rawMessage,
      rawCode: refusal.stated,
    };
  }
  const notStarted = timeout ? null : neverStartedReason(iteration);
  if (notStarted)
    return {
      ...base,
      slug: "eval/not_started",
      title: "Run didn't start",
      severity: "error",
      oneLine: notStarted,
      likelyCauses: [],
      nextSteps: [],
      rawMessage,
    };
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
