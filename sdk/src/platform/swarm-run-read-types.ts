/**
 * One swarm run as the API returns it: the goal runs launched together, their
 * counts, and the launch that started them. Interfaces, so the Inspector's
 * OpenAPI parity test can compare them with the published schemas.
 */
import type { PlatformGoalRunSession } from "./types.js";

/**
 * `launching`, `running` and `stopping` are not final. A final state can
 * still see grading change the counts; `settled` says when it is all over.
 */
export type PlatformSwarmRunState =
  "launching" | "running" | "stopping" | "stopped" | "issues" | "complete";

/** How the sessions ran, summed from each goal run's stored summary. */
export interface PlatformSwarmRunSessionCounts {
  total: number;
  succeeded: number;
  /** Sessions whose execution broke. A graded failure is counted in grading. */
  errored: number;
  rateLimited: number;
  pending: number;
}

/** How the sessions were graded, summed over the goal runs. */
export interface PlatformSwarmRunGradingCounts {
  /** Sessions still waiting for a grade. */
  pendingSessions: number;
  passedTrials: number;
  failedTrials: number;
  runsDecided: number;
  runsPending: number;
  runsNotEstablished: number;
  runsIntegrityFailed: number;
}

/** The advisory goal judge's counts. */
export interface PlatformSwarmRunGoalScoreCounts {
  graded: number;
  passed: number;
  failed: number;
  pending: number;
}

export interface PlatformSwarmRunTotals {
  runs: number;
  sessions: PlatformSwarmRunSessionCounts;
  grading: PlatformSwarmRunGradingCounts;
  goalScore: PlatformSwarmRunGoalScoreCounts;
}

/** One goal run's grading. The counts are present once grading has them. */
export interface PlatformSwarmRunGoalRunGrading {
  status: "pending" | "decided" | "notEstablished" | "integrityFailed" | "none";
  pendingSessions?: number;
  passedTrials?: number;
  failedTrials?: number;
  verdict?: string;
}

/** One goal run in the swarm run. */
export interface PlatformSwarmRunGoalRun {
  runId: string;
  goalId: string;
  goalName: string;
  status: string;
  cancelRequested: boolean;
  cleanupPending: boolean;
  /** Sessions per target. */
  iterations: number;
  environmentIds: string[];
  createdAt: number;
  sessions: PlatformSwarmRunSessionCounts;
  grading: PlatformSwarmRunGoalRunGrading;
  goalScore: PlatformSwarmRunGoalScoreCounts | null;
}

/** Why a launch, or one goal of it, stopped. */
export interface PlatformSwarmRunLaunchError {
  status?: number;
  code?: string;
  message: string;
}

/** One goal of the launch, and how far it got. */
export interface PlatformSwarmRunLaunchGoal {
  goalId: string;
  /** Sessions per target, when the launch set it for this goal. */
  iterations?: number;
  environmentIds?: string[];
  expectedSponsored?: number;
  launchKey: string;
  status: "pending" | "starting" | "started" | "failed" | "not_started";
  /** The goal run, once it started. */
  runId?: string;
  /** True when a retried launch found the goal run already started. */
  deduped?: boolean;
  error?: PlatformSwarmRunLaunchError;
  /** Why the goal did not start, for `not_started`. */
  reason?: string;
}

/** The launch that started the swarm run. */
export interface PlatformSwarmRunLaunch {
  swarmRunId: string;
  swarmId: string | null;
  sourceSwarmRunId: string | null;
  state:
    "launching" | "launched" | "partial" | "stopped" | "interrupted" | "failed";
  createdAt: number;
  finishedAt?: number;
  stopReason?: PlatformSwarmRunLaunchError;
  retryAfterAt?: number;
  goals: PlatformSwarmRunLaunchGoal[];
}

export interface PlatformRunLaunchFailureReason {
  errorCode: string | null;
  errorMessage: string | null;
  count: number;
}

/** Why some of one goal run's sessions never ran. */
export interface PlatformRunLaunchFailures {
  runId: string;
  /** Sessions whose attempt ended without recording a single message. */
  sessionsNotRun: number;
  /** Every attempt the run planned. */
  sessionsTotal: number;
  /** Attempts left unclassified when the read's budget ran out. */
  sessionsUnread?: number;
  /** Most common first, at most three. */
  reasons: PlatformRunLaunchFailureReason[];
}

export interface PlatformSwarmRun {
  swarmRunId: string;
  swarmId: string | null;
  swarmName: string | null;
  createdAt: number;
  state: PlatformSwarmRunState;
  /**
   * True once the state is final, the launch is no longer launching and no
   * goal run is waiting for grading. Grading continues after the sessions end.
   */
  settled: boolean;
  totals: PlatformSwarmRunTotals;
  runs: PlatformSwarmRunGoalRun[];
  /** Null for a swarm run that was not started as one launch. */
  launch: PlatformSwarmRunLaunch | null;
  /**
   * Only goal runs with sessions that never ran. Present only when the read
   * asked for it (`includeLaunchFailures`).
   */
  launchFailures?: PlatformRunLaunchFailures[];
}

/** A session of the swarm run, with the goal run it belongs to. */
export interface PlatformSwarmRunSession extends PlatformGoalRunSession {
  goalId: string;
  runId: string;
  outcome: string | null;
}

/** One swarm run in `get_swarms_overview`, grouped by the backend. */
export interface PlatformSwarmOverviewSwarmRun {
  swarmRunId: string;
  state: PlatformSwarmRunState;
  settled: boolean;
  runIds: string[];
  createdAt: number;
}
