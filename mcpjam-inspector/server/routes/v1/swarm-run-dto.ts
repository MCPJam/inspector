/**
 * The public shape of one swarm run, from the backend's swarm run view
 * (`convex/swarmRuns.ts`) and the launch failures of its goal runs.
 *
 * Top-level fields are named one by one, so a field the backend adds later
 * is not published unread. The nested count and error objects are the
 * contract's fixed shapes and pass through, as a goal run's `summary` does.
 * An absent optional field stays absent on the wire: JSON drops `undefined`.
 */
import type {
  PlatformRunLaunchFailures,
  PlatformSwarmOverviewSwarmRun,
  PlatformSwarmRun,
  PlatformSwarmRunGoalRun,
  PlatformSwarmRunLaunch,
  PlatformSwarmRunLaunchGoal,
} from "@mcpjam/sdk/platform";

// ── Backend shapes ──────────────────────────────────────────────────────────
//
// The public shapes with storage's `sessionsPerTarget` put back where the API
// says `iterations`, the name the launch request takes for the same number.

type RunViewRow = Omit<PlatformSwarmRunGoalRun, "iterations"> & {
  sessionsPerTarget: number;
};

type LaunchGoalRow = Omit<PlatformSwarmRunLaunchGoal, "iterations"> & {
  sessionsPerTarget?: number;
};

/** `LaunchRecordView`: the launch record the swarm run view carries. */
export type LaunchRecordRow = Omit<PlatformSwarmRunLaunch, "goals"> & {
  goals: LaunchGoalRow[];
};

/** `SwarmRunView`, what `swarmRuns:getSwarmRun` answers. */
export type SwarmRunViewRow = Omit<
  PlatformSwarmRun,
  "runs" | "launch" | "launchFailures"
> & {
  /** Empty while a launch has started no goal run. */
  runs: RunViewRow[];
  launch: LaunchRecordRow | null;
};

/** What `journeyRuns:listRunLaunchFailures` answers, per goal run. */
export type RunLaunchFailuresRow = PlatformRunLaunchFailures;

/** One group of `journeyRuns:getSwarmOverview`'s `swarmRuns`. */
export type OverviewSwarmRunRow = PlatformSwarmOverviewSwarmRun;

// ── Public DTOs ─────────────────────────────────────────────────────────────

function toGoalRunDto(row: RunViewRow) {
  return {
    runId: row.runId,
    goalId: row.goalId,
    goalName: row.goalName,
    status: row.status,
    cancelRequested: row.cancelRequested,
    cleanupPending: row.cleanupPending,
    iterations: row.sessionsPerTarget,
    environmentIds: row.environmentIds,
    createdAt: row.createdAt,
    /** Execution: `errored` broke. A session graded as failing is in `grading`. */
    sessions: row.sessions,
    grading: row.grading,
    goalScore: row.goalScore,
  };
}

function toLaunchGoalDto(row: LaunchGoalRow) {
  return {
    goalId: row.goalId,
    iterations: row.sessionsPerTarget,
    environmentIds: row.environmentIds,
    expectedSponsored: row.expectedSponsored,
    launchKey: row.launchKey,
    status: row.status,
    runId: row.runId,
    deduped: row.deduped,
    error: row.error,
    reason: row.reason,
  };
}

/** The launch record, as `get_swarm_run` returns it. */
export function toSwarmRunLaunchDto(row: LaunchRecordRow) {
  return {
    swarmRunId: row.swarmRunId,
    swarmId: row.swarmId,
    sourceSwarmRunId: row.sourceSwarmRunId,
    state: row.state,
    createdAt: row.createdAt,
    finishedAt: row.finishedAt,
    stopReason: row.stopReason,
    retryAfterAt: row.retryAfterAt,
    goals: row.goals.map(toLaunchGoalDto),
  };
}

function toLaunchFailuresDto(row: RunLaunchFailuresRow) {
  return {
    runId: row.runId,
    sessionsNotRun: row.sessionsNotRun,
    sessionsTotal: row.sessionsTotal,
    sessionsUnread: row.sessionsUnread,
    reasons: row.reasons,
  };
}

/** `launchFailures` is present only when the caller asked for it. */
export function toSwarmRunDto(
  view: SwarmRunViewRow,
  launchFailures?: readonly RunLaunchFailuresRow[],
) {
  return {
    swarmRunId: view.swarmRunId,
    swarmId: view.swarmId,
    swarmName: view.swarmName,
    createdAt: view.createdAt,
    state: view.state,
    /**
     * The state is final, the launch is not launching, and no goal run is
     * waiting for grading. A final `state` alone can still see counts change.
     */
    settled: view.settled,
    totals: view.totals,
    runs: view.runs.map(toGoalRunDto),
    launch: view.launch ? toSwarmRunLaunchDto(view.launch) : null,
    launchFailures: launchFailures?.map(toLaunchFailuresDto),
  };
}

export function toOverviewSwarmRunDto(row: OverviewSwarmRunRow) {
  return {
    swarmRunId: row.swarmRunId,
    state: row.state,
    settled: row.settled,
    runIds: row.runIds,
    createdAt: row.createdAt,
  };
}
