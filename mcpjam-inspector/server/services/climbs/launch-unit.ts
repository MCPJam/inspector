/**
 * Launches the run groups a unit registered: a baseline, a round, a
 * confirmation or a verification.
 *
 * The backend registers each group, and the id it will accept, BEFORE any run
 * starts. This module launches exactly what was registered, with the grouped
 * launch (one run per environment, `caseIds` as returned, the group's own
 * idempotency key) and each run replacing the climbed server by name. When any
 * group does not fully start it cancels every run that did, marks the unit
 * failed so the climb is free again, and says so.
 */
import type { ConvexHttpClient } from "convex/browser";
import type { PlatformApiClient, PlatformClimbLaunchedGroup } from "@mcpjam/sdk/platform";
import { ErrorCode, WebRouteError } from "../../routes/web/errors.js";
import { logger } from "../../utils/logger.js";
import { climbFns } from "./backend.js";
import { runGroupIdFor } from "./run-group-id.js";

/** A group as the backend registered it. */
export type RegisteredGroup = {
  role: string;
  runGroupId: string;
  idempotencyKey: string;
  deadlineAt: number;
  serverId: string;
  serverVersion?: string;
  environmentIds: string[];
  caseIds: string[];
  status: string;
};

export type LaunchUnitArgs = {
  client: Pick<PlatformApiClient, "createEvalRunGroup" | "cancelEvalRun">;
  convex: Pick<ConvexHttpClient, "mutation">;
  projectId: string;
  suiteId: string;
  climbId: string;
  unitKey: string;
  groups: RegisteredGroup[];
  /** The climbed server's name in the environments: the name each run keeps. */
  serverName: string;
  /** Hash of the real server's listing, taken before this launch. */
  realListingHash: string;
};

/** A refusal's words are the cause the caller needs; a runaway one must not fill the unit's failure line. */
const FAILURE_MESSAGE_MAX_CHARS = 400;

const capped = (text: string) =>
  text.length > FAILURE_MESSAGE_MAX_CHARS ? `${text.slice(0, FAILURE_MESSAGE_MAX_CHARS - 1)}…` : text;

type Failure = { role: string; environmentId?: string; code: string; message: string };

async function launchGroup(args: LaunchUnitArgs, group: RegisteredGroup) {
  return args.client.createEvalRunGroup({
    projectId: args.projectId,
    body: {
      suiteId: args.suiteId,
      targets: group.environmentIds.map((environmentId) => ({ environmentId })),
      caseIds: group.caseIds,
      idempotencyKey: group.idempotencyKey,
      climbId: args.climbId,
      serverReplacements: [
        {
          serverName: args.serverName,
          replacementServerId: group.serverId,
          ...(group.serverVersion ? { replacementVersion: group.serverVersion } : {}),
          realListingHash: args.realListingHash,
        },
      ],
    },
  });
}

/** Says what a launch failure was, in the words a caller can act on. */
function describeFailure(error: unknown): { code: string; message: string } {
  const code = (error as { code?: unknown })?.code;
  return {
    code: typeof code === "string" ? code : "LAUNCH_FAILED",
    message: error instanceof Error ? error.message : String(error),
  };
}

export async function launchUnit(args: LaunchUnitArgs): Promise<PlatformClimbLaunchedGroup[]> {
  const { suiteId, unitKey } = args;
  const mismatched = args.groups.find((group) => runGroupIdFor(suiteId, group.idempotencyKey) !== group.runGroupId);
  if (mismatched) {
    // Launching it would derive another id, and the backend would refuse every run.
    await failUnit(args, `The ${mismatched.role} run group's id does not follow from its key.`);
    throw new WebRouteError(
      500,
      ErrorCode.INTERNAL_ERROR,
      "The climb registered a run group this server cannot launch. The unit was marked failed; try the step again.",
      { code: "CLIMB_RUN_GROUP_ID_MISMATCH", role: mismatched.role },
    );
  }

  const settled = await Promise.allSettled(args.groups.map((group) => launchGroup(args, group)));
  const launched: PlatformClimbLaunchedGroup[] = [];
  const failures: Failure[] = [];
  const startedRunIds: string[] = [];
  settled.forEach((result, index) => {
    const group = args.groups[index]!;
    if (result.status === "rejected") {
      failures.push({ role: group.role, ...describeFailure(result.reason) });
      return;
    }
    const runs: Array<{ environmentId: string; runId: string }> = [];
    for (const entry of result.value.targets) {
      if (entry.status === "started") {
        startedRunIds.push(entry.runId);
        runs.push({ environmentId: entry.target.environmentId ?? "", runId: entry.runId });
      } else {
        failures.push({
          role: group.role,
          environmentId: entry.target.environmentId,
          code: entry.error.code,
          message: entry.error.message,
        });
      }
    }
    launched.push({
      role: group.role,
      runGroupId: result.value.runGroupId,
      serverId: group.serverId,
      ...(group.serverVersion ? { serverVersion: group.serverVersion } : {}),
      runs,
    });
  });

  if (failures.length > 0) {
    const cancelled = await cancelRuns(args, startedRunIds);
    const first = { ...failures[0]!, message: capped(failures[0]!.message) };
    const where = first.environmentId ? ` in environment ${first.environmentId}` : "";
    await failUnit(args, `Launch failed for the ${first.role} run group${where}: ${first.message}`);
    throw new WebRouteError(
      409,
      ErrorCode.CONFLICT,
      `The ${first.role} run group did not start${where}: ${first.message} ` +
        (startedRunIds.length > 0
          ? `The ${cancelled} run${cancelled === 1 ? "" : "s"} that had started ${cancelled === 1 ? "was" : "were"} cancelled. `
          : "") +
        `The ${unitKey} step was marked failed and the climb is free again: fix that, then submit it again.`,
      { code: "CLIMB_LAUNCH_FAILED", unitKey, failures, cancelledRunIds: startedRunIds },
    );
  }

  await Promise.all(
    launched.flatMap((group) =>
      group.runs.map((run) => recordLaunch(args, group.role, run.runId)),
    ),
  );
  return launched;
}

/** Cancels runs that started in a unit that will not finish. Returns how many it cancelled. */
async function cancelRuns(args: LaunchUnitArgs, runIds: string[]): Promise<number> {
  const results = await Promise.allSettled(
    runIds.map((runId) => args.client.cancelEvalRun({ projectId: args.projectId, runId })),
  );
  results.forEach((result, index) => {
    if (result.status === "rejected") {
      // The unit is failed either way, so the backend's sweep cancels what is left.
      logger.warn("[climbs] a run of a failed unit was not cancelled", {
        climbId: args.climbId,
        runId: runIds[index],
        error: describeFailure(result.reason).message,
      });
    }
  });
  return results.filter((result) => result.status === "fulfilled").length;
}

/** Tells the backend the unit will not finish, which also cancels what is left of it. */
async function failUnit(args: LaunchUnitArgs, reason: string): Promise<void> {
  try {
    await args.convex.mutation(climbFns.failUnit, { climbId: args.climbId, unitKey: args.unitKey, reason });
  } catch (error) {
    // The unit's deadline frees the climb if this does not.
    logger.warn("[climbs] a failed unit was not marked failed", {
      climbId: args.climbId,
      unitKey: args.unitKey,
      error: describeFailure(error).message,
    });
  }
}

/** Optional for settling, which the terminal hook does by itself; it makes the group read as launched. */
async function recordLaunch(args: LaunchUnitArgs, role: string, runId: string): Promise<void> {
  try {
    await args.convex.mutation(climbFns.recordRunLaunch, {
      climbId: args.climbId,
      unitKey: args.unitKey,
      role,
      runId,
    });
  } catch (error) {
    logger.warn("[climbs] a launched run was not recorded on its group", {
      climbId: args.climbId,
      runId,
      error: describeFailure(error).message,
    });
  }
}
