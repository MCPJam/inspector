/**
 * One sentence per refusal, so a disabled row can say why.
 *
 * The backend's reasons are a CLOSED vocabulary and these are their only
 * rendering. Two rules shape the copy:
 *
 *   - it names the SHAPE of the problem, never a remedy the reader may not
 *     have. "Not enabled for this organization" tells an admin what to do and
 *     tells everyone else who to ask; "Enable it in settings" is wrong for the
 *     second reader and patronizing to the first.
 *   - a flag service that could not be reached is NOT the same sentence as a
 *     flag that said no. Collapsing them is how a temporary outage teaches
 *     somebody their organization does not have a feature it has.
 */

import type { SuiteFeatureDenialReason } from "@/hooks/use-suite-capabilities";

export const CAPABILITY_REASON_COPY: Record<SuiteFeatureDenialReason, string> =
  {
    flag_false: "Not enabled for this organization",
    missing_email: "Not available for this account",
    missing_external_id: "Not available for this account",
    missing_organization: "Not available for this account",
    // Distinct on purpose: nothing said no, we could not ask.
    flag_unavailable: "Could not check availability right now",
  };

/** A feature the deployment itself does not run. Not an organization matter. */
export const DEPLOYMENT_REASON_COPY = "Not available on this deployment";

/** The caller may see this row but may not change it. */
export const PERMISSION_REASON_COPY =
  "You don't have permission to change this";

/**
 * The disabled reason for a feature gate, or `undefined` when it is usable.
 *
 * A gate that is off with NO reason still produces a sentence: an unexplained
 * refusal rendered as an enabled control is worse than a vague one, because the
 * only way to discover it is to try and be refused.
 */
export function featureDisabledReason(
  gate: { enabled: boolean; reason?: SuiteFeatureDenialReason } | undefined,
): string | undefined {
  if (!gate || gate.enabled) return undefined;
  return gate.reason
    ? CAPABILITY_REASON_COPY[gate.reason]
    : "Not available for this suite";
}
