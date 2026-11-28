/**
 * The request a swarm launch takes, shared by the web route (New Swarm, Run
 * again) and the v1 route (agents), and how it maps onto the backend's plan.
 *
 * A launch names what to launch in exactly one way: a swarm run to launch
 * again (`swarmRun`), a swarm (`swarm`), or an explicit list of goals
 * (`goals`, optionally naming the swarm they launch for). `goalIds` narrows a
 * swarm run's or a swarm's goals. `iterations` and `environmentIds` apply to
 * every goal that does not set its own.
 */
import { z } from "zod";
import type {
  GoalOverrides,
  PlanSwarmLaunchArgs,
  PlanSwarmLaunchSource,
} from "./plan.js";

/** The backend's bounds, repeated so a malformed request never reaches it. */
const MAX_GOALS = 100;
const MAX_ITERATIONS = 5;
const MAX_ENVIRONMENTS = 10;
const MAX_IDEMPOTENCY_KEY_LENGTH = 200;

const iterations = z.number().int().min(1).max(MAX_ITERATIONS);
const environmentIds = z.array(z.string().min(1)).max(MAX_ENVIRONMENTS);

/** The launch fields, for a route that adds its own (the web route's `projectId`). */
export const swarmLaunchRequestFields = {
  swarmRun: z.string().min(1).optional(),
  swarm: z.string().min(1).optional(),
  goals: z
    .array(
      z.strictObject({
        goalId: z.string().min(1),
        iterations: iterations.optional(),
        environmentIds: environmentIds.optional(),
      }),
    )
    .min(1)
    .max(MAX_GOALS)
    .optional(),
  goalIds: z.array(z.string().min(1)).min(1).max(MAX_GOALS).optional(),
  iterations: iterations.optional(),
  environmentIds: environmentIds.optional(),
  expectedSponsored: z.number().int().min(0).optional(),
  idempotencyKey: z.string().min(1).max(MAX_IDEMPOTENCY_KEY_LENGTH).optional(),
};

interface LaunchSource {
  swarmRun?: string;
  swarm?: string;
  goals?: ReadonlyArray<{ goalId: string }>;
  goalIds?: readonly string[];
}

/** Why a request does not name exactly one thing to launch, or null. */
export function launchSourceProblem(request: LaunchSource): string | null {
  const { swarmRun, swarm, goals, goalIds } = request;
  if (goals) {
    if (swarmRun) return "Send goals or swarmRun, not both.";
    if (goalIds) {
      return "goalIds narrows a swarm run or a swarm. With goals, list only the goals to launch.";
    }
    const ids = goals.map((goal) => goal.goalId);
    if (new Set(ids).size !== ids.length) {
      return "Each goal can appear once in goals.";
    }
    return null;
  }
  if (swarmRun && swarm) return "Send swarmRun or swarm, not both.";
  if (!swarmRun && !swarm) {
    return "Name what to launch: swarmRun, swarm, or goals.";
  }
  return null;
}

/** Adds the source rule to a schema of launch fields. */
export function refineLaunchSource(value: LaunchSource, ctx: z.RefinementCtx) {
  const problem = launchSourceProblem(value);
  if (problem) ctx.addIssue({ code: "custom", message: problem });
}

export const swarmLaunchRequestSchema = z
  .strictObject(swarmLaunchRequestFields)
  .superRefine(refineLaunchSource);

export type SwarmLaunchRequest = z.infer<typeof swarmLaunchRequestSchema>;

/**
 * The first reason a request cannot launch, worded as the route's 400 words a
 * schema failure, or null. The module checks this itself, so a caller that
 * built its request by hand meets the same bounds as one that parsed a body.
 */
export function swarmLaunchRequestProblem(request: unknown): string | null {
  const parsed = swarmLaunchRequestSchema.safeParse(request);
  if (parsed.success) return null;
  const issue = parsed.error.issues[0];
  if (!issue) return "The launch request is not valid.";
  return issue.path.length
    ? `${issue.path.join(".")}: ${issue.message}`
    : issue.message;
}

/** `iterations` is the backend's `sessionsPerTarget`; an empty list is no override. */
function overridesOf(
  iterationCount: number | undefined,
  environments: readonly string[] | undefined,
): GoalOverrides {
  return {
    ...(iterationCount !== undefined
      ? { sessionsPerTarget: iterationCount }
      : {}),
    ...(environments?.length ? { environmentIds: [...environments] } : {}),
  };
}

/** The plan's source for a request, or null for one that names none. */
export function planSourceOf(
  request: SwarmLaunchRequest,
): PlanSwarmLaunchSource | null {
  if (request.goals) {
    return {
      kind: "goals",
      ...(request.swarm ? { swarmId: request.swarm } : {}),
      goals: request.goals.map((goal) => ({
        goalId: goal.goalId,
        ...overridesOf(goal.iterations, goal.environmentIds),
      })),
    };
  }
  if (request.swarmRun) {
    return { kind: "swarmRun", swarmRunId: request.swarmRun };
  }
  if (request.swarm) return { kind: "swarm", swarmId: request.swarm };
  return null;
}

export type LaunchIdentity = Omit<PlanSwarmLaunchArgs, "projectId">;

/**
 * What a launch is, as the launch record fingerprints it: the source, its
 * narrowing and the overrides. Not `expectedSponsored`, a check the launch
 * makes rather than part of what it launches, nor the key. The plan query
 * takes the same fields plus the project.
 */
export function launchIdentityOf(
  request: SwarmLaunchRequest,
  source: PlanSwarmLaunchSource,
): LaunchIdentity {
  return {
    source,
    ...(request.goalIds ? { goalIds: [...request.goalIds] } : {}),
    ...overridesOf(request.iterations, request.environmentIds),
  };
}

/** What one goal launches with: its own overrides, else the launch-wide ones. */
export function goalOverridesOf(
  request: SwarmLaunchRequest,
  goalId: string,
): GoalOverrides {
  const own = request.goals?.find((goal) => goal.goalId === goalId);
  return {
    ...overridesOf(request.iterations, request.environmentIds),
    ...overridesOf(own?.iterations, own?.environmentIds),
  };
}
