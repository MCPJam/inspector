import {
  formatCreditRecovery,
  type CreditRecovery,
} from "@mcpjam/sdk/contract";

const SKIPPED =
  "Completed results are saved; remaining iterations were skipped.";

/** What stopped the run, in the backend's words for the same refusal. */
function stopCause(recovery: CreditRecovery | undefined): string {
  if (recovery?.action === "raise_budget") {
    return "This organization's spend budget is reached.";
  }
  if (recovery?.reason === "wallet_locked") {
    return "This organization's MCPJam wallet is locked.";
  }
  return "Out of MCPJam credits.";
}

/**
 * The run notes and the skipped trials' error once a refusal stops a run. The
 * refusal's step leads, so a reader who relays one sentence relays the fix.
 *
 * Only a step the backend chose is named: it alone knows the plan, and a Free
 * plan can only upgrade while a paid one buys credits. Without one (an older
 * backend), or when its step is `wait` (it could not read the plan), the note
 * states the stop and names no step.
 */
export function creditStopNote(recovery: CreditRecovery | undefined): string {
  const cause = `${stopCause(recovery)} ${SKIPPED}`;
  return recovery && recovery.action !== "wait"
    ? `${formatCreditRecovery(recovery)} ${cause}`
    : cause;
}
