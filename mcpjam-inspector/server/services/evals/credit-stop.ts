import {
  formatCreditRecovery,
  type CreditRecovery,
} from "@mcpjam/sdk/contract";

/** The note for a credit stop whose refusal carries no `recovery` (an older backend). */
const CREDIT_STOP_FALLBACK_NOTE =
  "Out of MCPJam credits. Completed results are saved; remaining iterations were skipped. Upgrade the plan to keep going: https://app.mcpjam.com/billing";

/**
 * The run notes and the skipped trials' error once credits stop a run. The
 * refusal's step leads, so a reader who relays one sentence relays the fix;
 * without one (an older backend) the generic text stands.
 */
export function creditStopNote(recovery: CreditRecovery | undefined): string {
  return recovery
    ? `${formatCreditRecovery(recovery)} Out of MCPJam credits. Completed results are saved; remaining iterations were skipped.`
    : CREDIT_STOP_FALLBACK_NOTE;
}
