/**
 * `start_climb`: the climb, the mock with no changes it measures first, and
 * the baseline's two run groups.
 *
 * The backend creates the climb and refuses what a climb cannot run (no
 * environments, an environment without the server, too few cases), all before
 * any run. Then this makes the mock with no changes in front of the real
 * server, quotes the baseline, registers it and launches it. If anything after
 * the climb exists fails, the climb is stopped, so a failed start leaves
 * nothing waiting.
 */
import type { PlatformClimb, PlatformClimbStarted } from "@mcpjam/sdk/platform";
import { logger } from "../../utils/logger.js";
import { climbFns } from "./backend.js";
import type { ClimbDeps } from "./deps.js";
import { estimateGroup } from "./estimate.js";
import { launchUnit, type RegisteredGroup } from "./launch-unit.js";

type StartArgs = Record<string, unknown> & { suiteId: string; serverId: string };

type BaselineRegistration = { unitKey: string; estimatedCredits: number; groups: RegisteredGroup[] };

export async function startClimb(deps: ClimbDeps, projectId: string, args: StartArgs): Promise<PlatformClimbStarted> {
  const { convex } = deps;
  const created: PlatformClimb = await convex.mutation(climbFns.start, args);
  const { climbId } = created;
  try {
    const mock: { mockId: string; version: number } = await convex.mutation(climbFns.createMock, {
      projectId,
      baseServerId: args.serverId,
      // Unique per climb, because server names are unique in a project.
      name: `${created.serverName} (climb ${climbId.slice(-6)} baseline)`,
      definitionJson: "{}",
    });
    const realListingHash = await deps.hashListing(projectId, args.serverId);
    const { steering, validation, confirmation } = created.groups;
    const estimate = await estimateGroup(
      convex,
      { suiteId: args.suiteId, environmentIds: created.environmentIds },
      2,
      // The cases are named once the baseline is registered, so the quote is the suite's, scaled.
      (steering + validation) / Math.max(1, steering + validation + confirmation),
    );
    const baseline: BaselineRegistration = await convex.mutation(climbFns.beginBaseline, {
      climbId,
      serverId: mock.mockId,
      serverVersion: String(mock.version),
      realListingHash,
      estimatedCreditsPerGroup: estimate.creditsPerGroup,
    });
    const groups = await launchUnit({
      client: deps.client,
      convex,
      projectId,
      suiteId: created.suiteId,
      climbId,
      unitKey: baseline.unitKey,
      groups: baseline.groups,
      serverName: created.serverName,
      realListingHash,
    });
    const current: PlatformClimb = await convex.query(climbFns.get, { climbId });
    return { ...current, launch: { unitKey: baseline.unitKey, estimate, groups } };
  } catch (error) {
    await stopQuietly(deps, climbId);
    throw error;
  }
}

/** A start that failed after the climb existed leaves it stopped, not waiting for a baseline. */
async function stopQuietly(deps: ClimbDeps, climbId: string): Promise<void> {
  try {
    await deps.convex.mutation(climbFns.stop, { climbId });
  } catch (error) {
    logger.warn("[climbs] a climb whose start failed was not stopped", {
      climbId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
