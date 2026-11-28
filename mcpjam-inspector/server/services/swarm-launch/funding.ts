/**
 * The sponsored split of a swarm launch, checked once before anything is
 * written, with New Swarm's rule.
 *
 * Sponsored conversations are paid from MCPJam's per-user allowance; the rest
 * use the organization's credits. The backend allocates them in run-creation
 * order, so the preview asks about the goals in launch order, and a launch
 * with any sponsored conversation starts its goals one at a time.
 *
 * Only a caller that says what it expects (`expectedSponsored`, the split it
 * showed someone) is held to it. Its launch is refused before anything starts
 * when the preview now sponsors fewer, or cannot price the launch at all; more
 * sponsored than expected is fine. Each of its runs is then created with the
 * count the preview gave it, so a run whose split moved since is refused
 * (409) instead of moving conversations onto credits. A caller that expects
 * nothing (Run again) is not held to counts: one held to them would be
 * stopped by any other launch the same member started meanwhile.
 */
import { ErrorCode, WebRouteError } from "../../routes/web/errors.js";
import { logger } from "../../utils/logger.js";
import type {
  SwarmFundingPreview,
  SwarmFundingPreviewRunInput,
} from "../swarm-agent.js";
import { SWARM_FUNDING_CHANGED_CODE } from "../../../shared/swarm-sponsorship.js";
import type { SwarmLaunchFunding } from "../../../shared/swarm-launch.js";
import type { GoalOverrides } from "./plan.js";

/** One goal of a launch, with what it launches with. */
export type FundedGoal = GoalOverrides & {
  goalId: string;
  expectedSponsored?: number;
};

export type LaunchPricing =
  /** The preview priced every goal: `perGoal[i]` is goal i's sponsored count. */
  | { kind: "priced"; perGoal: number[]; sponsored: number; credits: number }
  /** Sponsorship does not apply here, or the preview answered for other runs. */
  | { kind: "unpriced" }
  /** The preview could not be read. */
  | { kind: "unavailable" };

/** The preview request for a launch's goals, in launch order, as the swarm runs they become. */
export function fundingPreviewRuns(
  goals: readonly FundedGoal[],
): SwarmFundingPreviewRunInput[] {
  return goals.map((goal) => ({
    journeyRefId: goal.goalId,
    kind: "swarm",
    ...(goal.environmentIds?.length
      ? { environmentIds: goal.environmentIds }
      : {}),
    ...(goal.sessionsPerTarget !== undefined
      ? { sessionsPerTarget: goal.sessionsPerTarget }
      : {}),
  }));
}

/**
 * Ask the preview about `goals`. A failed preview is a launch without
 * sponsorship, as it was before sponsorship existed, so it is logged rather
 * than thrown.
 */
export async function priceLaunch(
  goals: readonly FundedGoal[],
  preview: (
    runs: SwarmFundingPreviewRunInput[],
  ) => Promise<SwarmFundingPreview>,
): Promise<LaunchPricing> {
  if (goals.length === 0) return { kind: "unpriced" };
  let answer: SwarmFundingPreview;
  try {
    answer = await preview(fundingPreviewRuns(goals));
  } catch (error) {
    logger.warn("[swarm-launch] funding preview failed; launch is unpriced", {
      goals: goals.length,
      error: error instanceof Error ? error.message : String(error),
    });
    return { kind: "unavailable" };
  }
  if (!answer.supported || answer.runs.length !== goals.length) {
    return { kind: "unpriced" };
  }
  const perGoal = answer.runs.map((run) => run.sponsored);
  return {
    kind: "priced",
    perGoal,
    sponsored: perGoal.reduce((sum, count) => sum + count, 0),
    credits: answer.runs.reduce((sum, run) => sum + run.credits, 0),
  };
}

/** The 409 for a launch whose split is worse than the caller expected, or null. */
export function fundingRefusal(
  expectedSponsored: number | undefined,
  pricing: LaunchPricing,
): WebRouteError | null {
  if (!expectedSponsored) return null;
  if (pricing.kind !== "priced") {
    return new WebRouteError(
      409,
      ErrorCode.CONFLICT,
      "We couldn't confirm the sponsored conversations for this launch, so nothing was launched. Try again.",
      { code: SWARM_FUNDING_CHANGED_CODE, expectedSponsored },
    );
  }
  if (pricing.sponsored >= expectedSponsored) return null;
  const totalConversations = pricing.sponsored + pricing.credits;
  return new WebRouteError(
    409,
    ErrorCode.CONFLICT,
    `Sponsored conversations changed while you were reviewing this launch: ${expectedSponsored} were expected and ${pricing.sponsored} of ${totalConversations} would be sponsored now. Nothing was launched.`,
    {
      code: SWARM_FUNDING_CHANGED_CODE,
      expectedSponsored,
      actualSponsored: pricing.sponsored,
      totalConversations,
    },
  );
}

/** What a reply says about funding; nothing when the preview could not be read. */
export function fundingSummary(
  pricing: LaunchPricing,
  sessionTotal: number,
): SwarmLaunchFunding | undefined {
  if (pricing.kind === "priced") {
    return {
      supported: true,
      sponsored: pricing.sponsored,
      credits: pricing.credits,
    };
  }
  if (pricing.kind === "unpriced") {
    return { supported: false, sponsored: 0, credits: sessionTotal };
  }
  return undefined;
}

/**
 * Each goal with the sponsored count its run will be created with: only for a
 * caller that stated what it expects, and only when the preview priced it.
 */
export function withExpectedSponsored(
  goals: readonly FundedGoal[],
  pricing: LaunchPricing,
  expectedSponsored: number | undefined,
): FundedGoal[] {
  if (expectedSponsored === undefined || pricing.kind !== "priced") {
    return [...goals];
  }
  return goals.map((goal, index) => ({
    ...goal,
    expectedSponsored: pricing.perGoal[index] ?? 0,
  }));
}
