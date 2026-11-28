/**
 * What one swarm launch answers: the reply of `POST /api/web/swarm/swarm-runs`,
 * shared by the server module that launches (`server/services/swarm-launch/`)
 * and the clients that read the answer.
 *
 * The plan mirrors the backend's `swarmRuns:planSwarmLaunch` by hand
 * (two-repo layout). The launch record is the backend's generic run-group
 * launch record of kind `swarm`, in swarm names: its run group is the swarm
 * run, its items are goals. Ids are plain strings here: nothing on this side
 * can check a Convex id.
 */
import type {
  LaunchError,
  LaunchItemStatus,
  LaunchState,
} from "./run-group-launch.js";

export type { LaunchError, LaunchState };

/** One goal's progress through a launch. */
export type LaunchGoalStatus = LaunchItemStatus;

export interface LaunchRecordGoal {
  goalId: string;
  sessionsPerTarget?: number;
  environmentIds?: string[];
  /** Sponsored conversations the funding preview gave this goal's run. */
  expectedSponsored?: number;
  /** The run's idempotency key, derived by the backend from the swarm run and goal. */
  launchKey: string;
  status: LaunchGoalStatus;
  runId?: string;
  deduped?: boolean;
  error?: LaunchError;
  reason?: string;
}

/** A swarm launch's record: the run group is the swarm run, its items goals. */
export interface LaunchRecordView {
  swarmRunId: string;
  swarmId: string | null;
  sourceSwarmRunId: string | null;
  state: LaunchState;
  createdAt: number;
  finishedAt?: number;
  stopReason?: LaunchError;
  retryAfterAt?: number;
  goals: LaunchRecordGoal[];
}

/** Why a planned launch cannot go ahead; an empty list means it can. */
export interface LaunchProblem {
  goalId?: string;
  code:
    | "not_in_set"
    | "archived"
    | "not_found"
    | "environment"
    | "model_policy"
    | "bounds"
    | "empty";
  message: string;
}

/** One goal the plan would launch, with what the repair dialog shows. */
export interface PlannedGoal {
  /** What launches: the repaired copy when one replaced the goal. */
  goalId: string;
  originalGoalId: string;
  sourceRunId: string | null;
  name: string;
  updatedAt: number;
  hostIds: string[];
  serverAttachmentId?: string;
  environmentIds: string[];
  config: Record<string, unknown>;
  judgeConfig?: unknown;
  sessionsPerTarget: number;
  targetCount: number;
  sessionCount: number;
  modelProblems: Array<{ dependency: string; label: string; reason: string }>;
}

export interface PlanSwarmLaunchResult {
  swarmId: string | null;
  sourceSwarmRunId: string | null;
  goals: PlannedGoal[];
  problems: LaunchProblem[];
  sessionTotal: number;
}

/** How the launch's conversations are funded, when the preview could say. */
export interface SwarmLaunchFunding {
  /** False when sponsorship cannot price this launch: every conversation uses credits. */
  supported: boolean;
  sponsored: number;
  credits: number;
}

/** The 202 a launch answers once its first goal started, or a replay. */
export interface SwarmLaunchReply {
  swarmRunId: string;
  launch: LaunchRecordView;
  /**
   * What was planned, and its funding. Absent on a replay of a recorded
   * launch, which is not planned again: its goals are in `launch`.
   */
  plan?: {
    sessionTotal: number;
    goals: Array<{ goalId: string; name: string; sessionCount: number }>;
  };
  funding?: SwarmLaunchFunding;
}

/** A launch's plan and funding, worked out with nothing written. */
export interface SwarmLaunchPlanReply {
  dryRun: true;
  plan: PlanSwarmLaunchResult;
  funding?: SwarmLaunchFunding;
}
