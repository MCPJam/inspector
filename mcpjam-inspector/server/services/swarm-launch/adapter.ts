/**
 * The swarm adopter of the launch engine: each item is a goal, launched as one
 * journey run of the swarm run, and the record reads back in swarm names.
 *
 * A goal launches through `launchJourneyRun` with inputs the request resolved
 * while it was live: the local-harness inputs (resolving them verifies a
 * session token, which the background bearer is not) and admission (the
 * launch was admitted once; a drain that began since waits for it).
 */
import type { ManagerCallerContext } from "../../routes/web/auth.js";
import {
  launchJourneyRun,
  requireConvexHttpUrl,
  type LaunchJourneyRunDeps,
  type LaunchJourneyRunInput,
  type LaunchJourneyRunResult,
} from "../sessionSimulation/launch-journey-run.js";
import {
  resolveLaunchLocalHarness,
  type LaunchLocalHarness,
} from "../sessionSimulation/launch-local-harness.js";
import {
  previewSwarmFunding,
  type SwarmFundingPreview,
  type SwarmFundingPreviewRunInput,
} from "../swarm-agent.js";
import {
  defaultRunGroupLaunchPorts,
  type RunGroupLaunchPorts,
} from "../run-group-launch/ports.js";
import type {
  PlannedItem,
  RunGroupLaunchAdapter,
  RunGroupLaunchDeps,
  RunGroupLaunchItem,
  RunGroupLaunchRecord,
} from "../run-group-launch/types.js";
import type {
  LaunchRecordGoal,
  LaunchRecordView,
  PlanSwarmLaunchResult,
} from "../../../shared/swarm-launch.js";
import {
  classifySwarmLaunchError,
  describeSwarmLaunchError,
} from "./errors.js";
import type { FundedGoal } from "./funding.js";
import { planSwarmLaunch, type PlanSwarmLaunchArgs } from "./plan.js";

/** What the record stores for each goal: the backend's `swarm` item params. */
export type SwarmItemParams = FundedGoal & { kind: "swarm" };

export interface SwarmLaunchDeps extends RunGroupLaunchDeps {
  /** Resolved from the live request; the runs' XAA servers fail closed without it. */
  xaaIssuer: string;
  callerContext: ManagerCallerContext;
}

/** The engine's ports and the swarm services a launch uses, replaced in tests. */
export interface SwarmLaunchPorts extends RunGroupLaunchPorts<SwarmItemParams> {
  plan: (
    bearer: string,
    args: PlanSwarmLaunchArgs,
  ) => Promise<PlanSwarmLaunchResult>;
  previewFunding: (
    bearer: string,
    args: { projectId: string; runs: SwarmFundingPreviewRunInput[] },
  ) => Promise<SwarmFundingPreview>;
  resolveLocalHarness: (
    bearer: string,
    projectId: string,
  ) => Promise<LaunchLocalHarness>;
  launchGoal: (
    deps: LaunchJourneyRunDeps,
    input: LaunchJourneyRunInput,
  ) => Promise<LaunchJourneyRunResult>;
}

export function defaultSwarmLaunchPorts(): SwarmLaunchPorts {
  return {
    ...defaultRunGroupLaunchPorts<SwarmItemParams>(),
    plan: planSwarmLaunch,
    previewFunding: (bearer, args) =>
      previewSwarmFunding(requireConvexHttpUrl(), bearer, args),
    resolveLocalHarness: resolveLaunchLocalHarness,
    launchGoal: launchJourneyRun,
  };
}

/** Goals started at once when nothing is sponsored, as New Swarm did. */
export const PARALLEL_GOALS = 4;

export function swarmLaunchAdapter(args: {
  projectId: string;
  deps: SwarmLaunchDeps;
  ports: SwarmLaunchPorts;
  localHarness: LaunchLocalHarness;
  /**
   * A new launch's preview: whether any conversation is sponsored. A replay
   * or resume has none and reads the counts its goals were stored with.
   */
  sponsoredInPreview?: () => boolean | undefined;
}): RunGroupLaunchAdapter<SwarmItemParams> {
  const { projectId, deps, ports, localHarness } = args;
  return {
    kind: "swarm",
    // The backend allocates sponsorship in creation order, so with any
    // sponsored conversation goals start one at a time.
    concurrency: (items) =>
      (args.sponsoredInPreview?.() ??
      items.some((item) => (item.params.expectedSponsored ?? 0) > 0))
        ? 1
        : PARALLEL_GOALS,
    launchItem: (item, { bearer, runGroupId }) =>
      ports.launchGoal(
        {
          bearerToken: bearer,
          getRunBearer: deps.getRunBearer,
          xaaIssuer: deps.xaaIssuer,
          callerContext: deps.callerContext,
          localHarness,
          admitted: true,
        },
        launchInput(projectId, item, runGroupId),
      ),
    classifyError: classifySwarmLaunchError,
    describeError: describeSwarmLaunchError,
  };
}

/** One goal's run: its stored key, the swarm run as its wave, its values. */
function launchInput(
  projectId: string,
  item: RunGroupLaunchItem<SwarmItemParams>,
  runGroupId: string,
): LaunchJourneyRunInput {
  const { goalId, sessionsPerTarget, environmentIds, expectedSponsored } =
    item.params;
  return {
    projectId,
    journeyRefId: goalId,
    launchKey: item.launchKey,
    waveId: runGroupId,
    ...(environmentIds?.length ? { environmentIds } : {}),
    ...(sessionsPerTarget !== undefined ? { sessionsPerTarget } : {}),
    ...(expectedSponsored !== undefined ? { expectedSponsored } : {}),
  };
}

/** A goal as the item a new launch begins with. */
export function swarmItemOf(goal: FundedGoal): PlannedItem<SwarmItemParams> {
  return { itemKey: goal.goalId, params: { ...goal, kind: "swarm" } };
}

function goalOf(item: RunGroupLaunchItem<SwarmItemParams>): LaunchRecordGoal {
  const { goalId, sessionsPerTarget, environmentIds, expectedSponsored } =
    item.params;
  return {
    goalId,
    ...(sessionsPerTarget !== undefined ? { sessionsPerTarget } : {}),
    ...(environmentIds ? { environmentIds } : {}),
    ...(expectedSponsored !== undefined ? { expectedSponsored } : {}),
    launchKey: item.launchKey,
    status: item.status,
    ...(item.runId !== undefined ? { runId: item.runId } : {}),
    ...(item.deduped ? { deduped: true } : {}),
    ...(item.error ? { error: item.error } : {}),
    ...(item.reason !== undefined ? { reason: item.reason } : {}),
  };
}

/** The record in swarm names: its run group is the swarm run, its items goals. */
export function swarmLaunchView(
  record: RunGroupLaunchRecord<SwarmItemParams>,
): LaunchRecordView {
  return {
    swarmRunId: record.runGroupId,
    swarmId: record.swarmId ?? null,
    sourceSwarmRunId: record.sourceRunGroupId ?? null,
    state: record.state,
    createdAt: record.createdAt,
    ...(record.finishedAt !== undefined
      ? { finishedAt: record.finishedAt }
      : {}),
    ...(record.stopReason ? { stopReason: record.stopReason } : {}),
    ...(record.retryAfterAt !== undefined
      ? { retryAfterAt: record.retryAfterAt }
      : {}),
    goals: record.items.map(goalOf),
  };
}
