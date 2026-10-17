import { createInspectorCommandClientError } from "@/lib/inspector-command-handlers";
import { isRunCancellable } from "./helpers";

/**
 * The in-app agent's `cancelEvalRun`, shared by the two eval surfaces that
 * register it. It goes through the Cancel button's own `handleCancelRun`, so
 * the agent can cancel exactly what the button can, `grading` included: the
 * trials are done but the gating judge is still billing.
 */
export async function cancelEvalRunForAgent(
  run: { _id: string; status: string },
  handlers: {
    cancellingRunId: string | null;
    handleCancelRun: (runId: string) => Promise<void>;
  },
) {
  if (!isRunCancellable(run)) {
    return {
      status: "already_finished" as const,
      runId: run._id,
      runStatus: run.status,
    };
  }
  if (handlers.cancellingRunId) {
    throw createInspectorCommandClientError(
      "execution_failed",
      "Another run cancellation is already in progress.",
    );
  }
  await handlers.handleCancelRun(run._id);
  return { status: "cancel_requested" as const, runId: run._id };
}
