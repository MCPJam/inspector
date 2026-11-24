/**
 * `continue_climb`: resume a paused climb, or run a failed baseline again.
 *
 * A baseline that lost too many iterations leaves the climb `baselining` with
 * no unit running (the backend reports `baselineFailure`), and nothing else
 * could ever move it on. Everything else is the backend's own continue, which
 * refuses a climb that is not paused, so a climb that has a baseline or one
 * running gets the backend's refusal.
 */
import type { PlatformClimb, PlatformClimbContinued } from "@mcpjam/sdk/platform";
import { climbFns } from "./backend.js";
import type { ClimbDeps } from "./deps.js";
import { launchBaseline } from "./start-climb.js";

/** The attempt after the one `baseline:N` names; 2 when the key says nothing. */
function nextAttempt(unitKey: string): number {
  const failed = Number(unitKey.split(":")[1]);
  return Number.isInteger(failed) && failed >= 1 ? failed + 1 : 2;
}

export function needsBaselineAgain(climb: PlatformClimb): boolean {
  return climb.state === "baselining" && climb.baselineFailure !== undefined && climb.activeUnitKey === undefined;
}

export async function continueClimb(
  deps: ClimbDeps,
  projectId: string,
  climb: PlatformClimb,
  /** Starts the picker job once a paused climb is resumed. */
  afterResume?: () => void,
): Promise<PlatformClimbContinued> {
  const base = { climbId: climb.climbId, suiteId: climb.suiteId };
  if (needsBaselineAgain(climb)) {
    const { launch } = await launchBaseline(deps, projectId, climb, nextAttempt(climb.baselineFailure!.unitKey));
    return { ...base, resumed: false, baselineStarted: true, launch };
  }
  const resumed: { resumed: true; stepDue: boolean } = await deps.convex.mutation(climbFns.continue, { climbId: climb.climbId });
  afterResume?.();
  return { ...base, ...resumed };
}
