/**
 * The runs of a climb's units, which the backend stores on each run group and
 * `describeClimb` does not return. The failed runs behind each "Climb for"
 * option start from them.
 *
 * `climbs:getClimbRunGroups` is the read this needs. Until a backend has it,
 * the climb reads without failed runs and says so, rather than failing:
 * everything the backend settled is still true without them.
 */
import type { ConvexHttpClient } from "convex/browser";
import { logger } from "../../utils/logger.js";
import { climbFns } from "./backend.js";

export type UnitRunGroup = {
  unitKey: string;
  role: string;
  runGroupId: string;
  status: string;
  environmentIds: string[];
  launchedRunIds: string[];
};

const MISSING_FUNCTION = /could not find public function/i;

/** The run groups of a climb, or null when this backend cannot say. */
export async function readRunGroups(
  convex: Pick<ConvexHttpClient, "query">,
  climbId: string,
): Promise<UnitRunGroup[] | null> {
  try {
    return await convex.query(climbFns.runGroups, { climbId });
  } catch (error) {
    if (MISSING_FUNCTION.test(error instanceof Error ? error.message : String(error))) {
      logger.warn("[climbs] this backend does not return a climb's run groups, so no failed runs are shown", { climbId });
      return null;
    }
    throw error;
  }
}
