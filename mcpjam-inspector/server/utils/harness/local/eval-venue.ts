/**
 * Where an eval with this harness would run for this member and project,
 * asked before anything is launched: on this machine, in the cloud, or
 * nowhere, with the reason and the one fix.
 *
 * The run sheet asks this so it can offer setup before Start instead of
 * refusing after it. It asks the launch's own rule (`decideLocalHarnessVenue`,
 * unattended scope) and whether the runtime is installed. Git is still checked
 * per iteration at launch: probing it from a sheet can open macOS's Command
 * Line Tools installer. A launch also refuses on its own if anything changed
 * after the check.
 */
import type { LocalEvalVenue } from "../../../../shared/local-eval-venue.js";
import { logger } from "../../logger.js";
import { canProvisionHarnessBoxes } from "../harness-box.js";
import { decideLocalHarnessVenue } from "./run-resources.js";
import { localHarnessMemberRefusal } from "./readiness.js";
import { readRuntimeInstallStatus } from "./runtime-install.js";
import {
  localRuntimeNotReadyStatus,
  localVenueStatus,
  localVenueUnavailableStatus,
  narrowLocalVenueRefusal,
  type ExplainedLocalVenueRefusal,
} from "./venue-refusal.js";
import type { SupportedLocalHarnessId } from "./targets.js";

function refused(refusal: ExplainedLocalVenueRefusal, harnessId: SupportedLocalHarnessId): LocalEvalVenue {
  return { venue: "refused", refusal, ...localVenueStatus(refusal, harnessId) };
}

/**
 * The account check throws when this machine holds an authorization but the
 * rollout says no: a failed read, or a deterministic no (DO_NOT_TRACK, or the
 * member left the rollout). Only the first is worth a retry, so ask again.
 */
async function explainThrownCheck(
  harnessId: SupportedLocalHarnessId,
  bearer: string,
  projectId: string,
): Promise<ExplainedLocalVenueRefusal> {
  try {
    const member = await localHarnessMemberRefusal(bearer, projectId, harnessId);
    return member === null || member === "actor-refused" ? "rollout-unknown" : member;
  } catch {
    return "rollout-unknown";
  }
}

/** Authorized isn't enough: the runtime it runs must be installed here. */
async function runtimeNotReady(harnessId: SupportedLocalHarnessId): Promise<LocalEvalVenue | null> {
  const status = await readRuntimeInstallStatus({ harnessId });
  if (status.state === "ready") return null;
  const installing = status.state === "downloading" || status.state === "verifying";
  return { venue: "refused", refusal: installing ? "installing" : "not-installed", ...localRuntimeNotReadyStatus(harnessId, installing) };
}

export async function localEvalVenue(args: {
  harnessId: SupportedLocalHarnessId;
  bearer: string;
  projectId: string;
}): Promise<LocalEvalVenue> {
  const { harnessId, bearer, projectId } = args;
  let refusal: ExplainedLocalVenueRefusal | null;
  try {
    const decision = await decideLocalHarnessVenue(harnessId, bearer, projectId, { scope: "unattended" });
    if (decision.venue === "local") return (await runtimeNotReady(harnessId)) ?? { venue: "local" };
    // A harness the machine can't run falls back to a cloud computer, which
    // is a venue only where this Inspector can start one.
    if (canProvisionHarnessBoxes()) return { venue: "cloud" };
    refusal = await narrowLocalVenueRefusal(decision, { bearer, projectId });
  } catch (error) {
    logger.warn("[local-harness] could not decide an eval's venue", {
      harnessId,
      message: error instanceof Error ? error.message : String(error),
    });
    refusal = await explainThrownCheck(harnessId, bearer, projectId);
  }
  return refusal === null
    ? { venue: "refused", refusal: "unavailable", ...localVenueUnavailableStatus(harnessId) }
    : refused(refusal, harnessId);
}
