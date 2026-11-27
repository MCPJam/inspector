/**
 * Where an eval with this harness would run for this member and project,
 * asked before anything is launched: on this machine, in the cloud, or
 * nowhere, with the reason and the one fix.
 *
 * The run sheet asks this so it can offer setup before Start instead of
 * refusing after it. It asks the launch's own rule (`decideLocalHarnessVenue`,
 * unattended scope), so the sheet and the launch can't disagree, and a launch
 * still refuses on its own if anything changed after the check.
 */
import { harnessDisplayName } from "../../../../shared/harness-model-support.js";
import { logger } from "../../logger.js";
import { canProvisionHarnessBoxes } from "../harness-box.js";
import { decideLocalHarnessVenue, type LocalVenueDecision } from "./run-resources.js";
import {
  localVenueStatus,
  narrowLocalVenueRefusal,
  type ExplainedLocalVenueRefusal,
  type LocalVenueFix,
} from "./venue-refusal.js";
import type { SupportedLocalHarnessId } from "./targets.js";

export type LocalEvalVenue =
  | { venue: "local" }
  | { venue: "cloud" }
  | {
      venue: "refused";
      /** `unavailable`: no more specific reason, such as no member identity. */
      refusal: ExplainedLocalVenueRefusal | "unavailable";
      message: string;
      fix: LocalVenueFix;
    };

function refused(refusal: ExplainedLocalVenueRefusal, harnessId: SupportedLocalHarnessId): LocalEvalVenue {
  return { venue: "refused", refusal, ...localVenueStatus(refusal, harnessId) };
}

export async function localEvalVenue(args: {
  harnessId: SupportedLocalHarnessId;
  bearer: string;
  projectId: string;
}): Promise<LocalEvalVenue> {
  const { harnessId, bearer, projectId } = args;
  let decision: LocalVenueDecision;
  let refusal: ExplainedLocalVenueRefusal | null;
  try {
    decision = await decideLocalHarnessVenue(harnessId, bearer, projectId, { scope: "unattended" });
    if (decision.venue === "local") return { venue: "local" };
    // A harness the machine can't run falls back to a cloud computer, which
    // is a venue only where this Inspector can start one.
    if (canProvisionHarnessBoxes()) return { venue: "cloud" };
    refusal = await narrowLocalVenueRefusal(decision, { bearer, projectId });
  } catch (error) {
    // The account check throws when an authorization exists but the rollout
    // can't confirm it; a failed read is the same answer to the member.
    logger.warn("[local-harness] could not decide an eval's venue", {
      harnessId,
      message: error instanceof Error ? error.message : String(error),
    });
    return refused("rollout-unknown", harnessId);
  }
  if (refusal !== null) return refused(refusal, harnessId);
  return {
    venue: "refused",
    refusal: "unavailable",
    message: `${harnessDisplayName(harnessId)} can't run evals on this machine for your account.`,
    fix: "choose-another",
  };
}
