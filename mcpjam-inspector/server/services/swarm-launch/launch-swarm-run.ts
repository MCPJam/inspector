/**
 * Launching a whole swarm from the server: Run again (and, next, New Swarm and
 * agents) call these instead of starting each goal from the browser. The
 * launch engine (`run-group-launch/`) does the launching; this is the swarm's
 * half of it.
 *
 *   1. Check the request's bounds.
 *   2. The engine replays a key seen before from its record, without
 *      planning or pricing it again: a fresh preview would refuse a fair retry
 *      once the sponsored allowance it used was spent.
 *   3. Otherwise plan with the request bearer (`swarmRuns:planSwarmLaunch`);
 *      any problem refuses the launch with the per-goal list.
 *   4. Preview the funding once and apply New Swarm's launch-level rule.
 *   5. The engine begins the record, starts the first goal inside the
 *      request, replies 202 and launches the rest in the background.
 *
 * `planSwarmRun` is steps 1, 3 and 4 alone, writing nothing. `resumeSwarmRun`
 * finishes the caller's own stopped or interrupted launch by its swarm run id,
 * for a caller that no longer has the key.
 */
import { ErrorCode, WebRouteError } from "../../routes/web/errors.js";
import type {
  LaunchRecordView,
  PlanSwarmLaunchResult,
  SwarmLaunchPlanReply,
  SwarmLaunchReply,
} from "../../../shared/swarm-launch.js";
import {
  isRunGroupRefusal,
  launchRunGroup,
  refusalOf,
  resumeRunGroup,
} from "../run-group-launch/engine.js";
import type {
  RunGroupLaunchOutcome,
  RunGroupRefusal,
} from "../run-group-launch/types.js";
import {
  defaultSwarmLaunchPorts,
  swarmItemOf,
  swarmLaunchAdapter,
  swarmLaunchView,
  type SwarmItemParams,
  type SwarmLaunchDeps,
  type SwarmLaunchPorts,
} from "./adapter.js";
import {
  fundingRefusal,
  fundingSummary,
  priceLaunch,
  withExpectedSponsored,
  type FundedGoal,
} from "./funding.js";
import { planRefusal, problemsRefusal } from "./plan.js";
import {
  goalOverridesOf,
  launchIdentityOf,
  planSourceOf,
  swarmLaunchRequestProblem,
  type LaunchIdentity,
  type SwarmLaunchRequest,
} from "./request.js";

export type { SwarmLaunchDeps, SwarmLaunchPorts } from "./adapter.js";

export interface SwarmLaunchInput {
  projectId: string;
  request: SwarmLaunchRequest;
}

export interface SwarmLaunchRefusal {
  status: number;
  body: {
    error: RunGroupRefusal<SwarmItemParams>["error"];
    /** The launch record, when the refusal came after it was written. */
    launch?: LaunchRecordView;
  };
  /** Wire headers the refusal owns: `Retry-After` on a 429. */
  headers?: Record<string, string>;
}

export type SwarmLaunchResult =
  { status: 202; body: SwarmLaunchReply } | SwarmLaunchRefusal;

export type SwarmPlanResult =
  { status: 200; body: SwarmLaunchPlanReply } | SwarmLaunchRefusal;

export function isSwarmLaunchRefusal(
  result: SwarmLaunchResult | SwarmPlanResult,
): result is SwarmLaunchRefusal {
  return "error" in result.body;
}

const refuse = (error: WebRouteError) => refusalOf<SwarmItemParams>(error);

function toSwarmRefusal(
  refused: RunGroupRefusal<SwarmItemParams>,
): SwarmLaunchRefusal {
  return {
    status: refused.status,
    body: {
      error: refused.error,
      ...(refused.record ? { launch: swarmLaunchView(refused.record) } : {}),
    },
    ...(refused.headers ? { headers: refused.headers } : {}),
  };
}

/** The engine's answer in swarm names, with what planning added. */
function swarmResult(
  outcome: RunGroupLaunchOutcome<SwarmItemParams>,
  planned: Pick<SwarmLaunchReply, "plan" | "funding">,
): SwarmLaunchResult {
  if (isRunGroupRefusal(outcome)) return toSwarmRefusal(outcome);
  const launch = swarmLaunchView(outcome.record);
  return {
    status: 202,
    body: { swarmRunId: launch.swarmRunId, launch, ...planned },
  };
}

/** Step 1: what the request launches, or why it cannot launch. */
function checkRequest(
  request: SwarmLaunchRequest,
): { identity: LaunchIdentity } | WebRouteError {
  const problem = swarmLaunchRequestProblem(request);
  const source = planSourceOf(request);
  if (problem || !source) {
    return new WebRouteError(
      400,
      ErrorCode.VALIDATION_ERROR,
      problem ?? "Name what to launch: swarmRun, swarm, or goals.",
    );
  }
  return { identity: launchIdentityOf(request, source) };
}

type Planning = { plan: PlanSwarmLaunchResult; goals: FundedGoal[] };

/** Step 3: the backend's plan, and each planned goal with its overrides. */
async function planGoals(
  input: SwarmLaunchInput,
  identity: LaunchIdentity,
  bearer: string,
  ports: SwarmLaunchPorts,
): Promise<Planning | WebRouteError> {
  let plan: PlanSwarmLaunchResult;
  try {
    plan = await ports.plan(bearer, {
      projectId: input.projectId,
      ...identity,
    });
  } catch (error) {
    const refused = planRefusal(error);
    if (refused) return refused;
    throw error;
  }
  const goals = plan.goals.map((goal) => ({
    goalId: goal.goalId,
    ...goalOverridesOf(input.request, goal.goalId),
  }));
  return { plan, goals };
}

function price(
  projectId: string,
  goals: FundedGoal[],
  bearer: string,
  ports: SwarmLaunchPorts,
) {
  return priceLaunch(goals, (runs) =>
    ports.previewFunding(bearer, { projectId, runs }),
  );
}

/** The plan and the funding preview for a launch request, writing nothing. */
export async function planSwarmRun(
  input: SwarmLaunchInput,
  deps: Pick<SwarmLaunchDeps, "bearerToken">,
  ports: SwarmLaunchPorts = defaultSwarmLaunchPorts(),
): Promise<SwarmPlanResult> {
  const checked = checkRequest(input.request);
  if (checked instanceof WebRouteError) return toSwarmRefusal(refuse(checked));
  const planning = await planGoals(
    input,
    checked.identity,
    deps.bearerToken,
    ports,
  );
  if (planning instanceof WebRouteError) {
    return toSwarmRefusal(refuse(planning));
  }
  const { plan, goals } = planning;
  const pricing = await price(input.projectId, goals, deps.bearerToken, ports);
  const funding = fundingSummary(pricing, plan.sessionTotal);
  return {
    status: 200,
    body: { dryRun: true, plan, ...(funding ? { funding } : {}) },
  };
}

export async function launchSwarmRun(
  input: SwarmLaunchInput,
  deps: SwarmLaunchDeps,
  ports: SwarmLaunchPorts = defaultSwarmLaunchPorts(),
): Promise<SwarmLaunchResult> {
  const { projectId, request } = input;
  const checked = checkRequest(request);
  if (checked instanceof WebRouteError) return toSwarmRefusal(refuse(checked));
  const localHarness = await ports.resolveLocalHarness(
    deps.bearerToken,
    projectId,
  );
  // Filled in only when this call plans the launch, not on a replay.
  let sponsoredInPreview: boolean | undefined;
  let planReply: Pick<SwarmLaunchReply, "plan" | "funding"> = {};
  const outcome = await launchRunGroup({
    adapter: swarmLaunchAdapter({
      projectId,
      deps,
      ports,
      localHarness,
      sponsoredInPreview: () => sponsoredInPreview,
    }),
    projectId,
    deps,
    ports,
    ...(request.idempotencyKey
      ? { idempotencyKey: request.idempotencyKey }
      : {}),
    request: checked.identity,
    plan: async () => {
      const planning = await planGoals(
        input,
        checked.identity,
        deps.bearerToken,
        ports,
      );
      if (planning instanceof WebRouteError) return refuse(planning);
      const { plan, goals } = planning;
      if (plan.problems.length > 0 || goals.length === 0) {
        return refuse(problemsRefusal(plan.problems));
      }
      const pricing = await price(projectId, goals, deps.bearerToken, ports);
      const refused = fundingRefusal(request.expectedSponsored, pricing);
      if (refused) return refuse(refused);
      sponsoredInPreview = pricing.kind === "priced" && pricing.sponsored > 0;
      const funding = fundingSummary(pricing, plan.sessionTotal);
      planReply = {
        plan: {
          sessionTotal: plan.sessionTotal,
          goals: plan.goals.map(({ goalId, name, sessionCount }) => ({
            goalId,
            name,
            sessionCount,
          })),
        },
        ...(funding ? { funding } : {}),
      };
      return {
        items: withExpectedSponsored(
          goals,
          pricing,
          request.expectedSponsored,
        ).map(swarmItemOf),
        ...(plan.swarmId ? { swarmId: plan.swarmId } : {}),
        ...(plan.sourceSwarmRunId
          ? { sourceRunGroupId: plan.sourceSwarmRunId }
          : {}),
      };
    },
  });
  return swarmResult(outcome, planReply);
}

/**
 * Finish the caller's own stopped or interrupted launch by its swarm run id:
 * its unstarted goals launch with their stored keys and values, so a goal
 * that did start is not started twice.
 */
export async function resumeSwarmRun(
  input: { projectId: string; swarmRunId: string },
  deps: SwarmLaunchDeps,
  ports: SwarmLaunchPorts = defaultSwarmLaunchPorts(),
): Promise<SwarmLaunchResult> {
  const { projectId, swarmRunId } = input;
  const localHarness = await ports.resolveLocalHarness(
    deps.bearerToken,
    projectId,
  );
  const outcome = await resumeRunGroup({
    adapter: swarmLaunchAdapter({ projectId, deps, ports, localHarness }),
    projectId,
    runGroupId: swarmRunId,
    deps,
    ports,
  });
  return swarmResult(outcome, {});
}
