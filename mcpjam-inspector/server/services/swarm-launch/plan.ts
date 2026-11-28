/**
 * The backend's plan for a swarm launch (`swarmRuns:planSwarmLaunch`): which
 * goals launch, in what order, with what iterations and environments, and any
 * problem that stops the launch before anything is written.
 */
import { makeFunctionReference } from "convex/server";
import { ErrorCode, WebRouteError } from "../../routes/web/errors.js";
import { createConvexClient } from "../evals/route-helpers.js";
import { backendRefusal } from "../run-group-launch/backend.js";
import { showableReason } from "../sessionSimulation/launch-journey-run.js";
import { convexErrorData } from "../../routes/v1/convex-errors.js";
import type {
  LaunchProblem,
  PlanSwarmLaunchResult,
} from "../../../shared/swarm-launch.js";

/** A goal's iterations and environments for this launch only. */
export type GoalOverrides = {
  sessionsPerTarget?: number;
  environmentIds?: string[];
};

export type PlanSwarmLaunchSource =
  | { kind: "swarmRun"; swarmRunId: string }
  | { kind: "swarm"; swarmId: string }
  | {
      kind: "goals";
      swarmId?: string;
      goals: Array<{ goalId: string } & GoalOverrides>;
    };

export type PlanSwarmLaunchArgs = GoalOverrides & {
  projectId: string;
  source: PlanSwarmLaunchSource;
  goalIds?: string[];
};

const PLAN = makeFunctionReference<
  "query",
  PlanSwarmLaunchArgs,
  PlanSwarmLaunchResult
>("swarmRuns:planSwarmLaunch");

export function planSwarmLaunch(
  bearer: string,
  args: PlanSwarmLaunchArgs,
): Promise<PlanSwarmLaunchResult> {
  return createConvexClient(bearer).query(PLAN, args);
}

/**
 * The answer for a plan the backend refused outright, or null to rethrow. A
 * swarm run or swarm the project does not have is a 404 in its own words.
 */
export function planRefusal(error: unknown): WebRouteError | null {
  if (convexErrorData(error)?.code === "not_found") {
    return new WebRouteError(
      404,
      ErrorCode.NOT_FOUND,
      showableReason(convexErrorData(error)?.message) ??
        "That swarm run or swarm was not found in this project. Check the id and launch again.",
      { code: "not_found" },
    );
  }
  return backendRefusal(error);
}

/** The plan's problems as one refusal: the first in words, all in details. */
export function problemsRefusal(problems: LaunchProblem[]): WebRouteError {
  const [first] = problems;
  const others = problems.length - 1;
  const message = !first
    ? "This launch has no goals. Choose a swarm run, a swarm or goals that have some."
    : others === 0
      ? first.message
      : `${first.message} ${others} more ${others === 1 ? "problem blocks" : "problems block"} this launch.`;
  return new WebRouteError(400, ErrorCode.VALIDATION_ERROR, message, {
    problems,
  });
}
