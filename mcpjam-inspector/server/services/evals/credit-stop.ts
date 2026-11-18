import {
  formatCreditRecovery,
  type CreditRecovery,
} from "@mcpjam/sdk/contract";

/** What a credit-stopped run said before refusals carried `recovery`. */
const CREDIT_STOP_FALLBACK_NOTE =
  "Out of MCPJam credits. Completed results are saved; remaining iterations were skipped. Add credits on an eligible paid plan, upgrade from Free, or retry after your allowance renews.";

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
