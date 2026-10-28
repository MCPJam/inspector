/**
 * The most conversations a new swarm can pay for, from the credit balance, the
 * free conversations left and the backend's per-environment estimate
 * (`swarms/conversationEstimate:estimateSwarmConversationCredits`).
 *
 * The cap is a UX aid, not a guard: the backend admits every call against the
 * balance on its own. So every unknown input gives `null`, meaning no cap, and
 * the flow behaves as it did before the cap existed.
 */
import type { CreditBalanceState } from "@/hooks/useCreditBalance";
import { DEFAULT_SWARM_ITERATIONS } from "@/components/swarms/swarm-intensity";

/** One environment's line from the backend estimate. */
export interface ConversationEstimate {
  environmentId: string;
  /** `null` when the target is unresolved or a credit-paid model is unpriced. */
  tokenCredits: number | null;
  /** Per-turn platform fees, charged only on conversations that are not free. */
  feeCredits: number;
  /** Whether the launch would let the free allowance pay for it. */
  freeEligible: boolean;
}

/** A reused goal: how many runs it makes per environment, and their cost. */
export interface ReusedGoalEstimate {
  sessions: number;
  /** `null` when the backend could not read the goal. */
  perEnvironment: readonly ConversationEstimate[] | null;
}

/** "1 conversation", "7 conversations". */
export function countOf(count: number, noun: string): string {
  return `${count.toLocaleString("en-US")} ${noun}${count === 1 ? "" : "s"}`;
}

/**
 * The credits the plan includes before paid ones: the daily bucket, or the
 * monthly allowance (with rollover already inside it).
 */
export function includedCredits(balance: CreditBalanceState): number {
  return balance.billingModel === "daily"
    ? balance.freeDailyCreditsRemaining
    : (balance.monthlyAllowanceRemaining ?? 0);
}

/**
 * Credits a swarm can spend. Each pool loses the per-call floor, because a pool
 * below it cannot admit another call.
 */
export function usableCredits(balance: CreditBalanceState): number {
  const floor = balance.perCallMinimumCredits ?? 0;
  const pool = (credits: number) => Math.max(0, credits - floor);
  return pool(includedCredits(balance)) + pool(balance.paidCreditsRemaining);
}

function costsOf(
  perEnvironment: readonly ConversationEstimate[],
): Array<{ credits: number; freeEligible: boolean }> | null {
  const costs: Array<{ credits: number; freeEligible: boolean }> = [];
  for (const environment of perEnvironment) {
    if (environment.tokenCredits === null) return null;
    costs.push({
      credits: environment.tokenCredits + environment.feeCredits,
      freeEligible: environment.freeEligible,
    });
  }
  return costs;
}

/** What one goal at one iteration costs: a conversation in every environment. */
export function goalCredits(
  perEnvironment: readonly ConversationEstimate[],
): number | null {
  const costs = costsOf(perEnvironment);
  return costs === null
    ? null
    : costs.reduce((sum, cost) => sum + cost.credits, 0);
}

/**
 * The largest number of conversations that fits. Reused goals are paid first,
 * one conversation at a time, until the money runs out. Then a new slot (one
 * goal at one iteration) runs one conversation in every environment, so new
 * conversations come in whole slots. Free conversations go to environments the
 * launch would sponsor, and each saves that environment's whole cost.
 *
 * `null` when any environment or reused goal is unpriced or unreadable, or
 * when no new conversation costs credits at all.
 */
export function maxConversations({
  usable,
  freeLeft,
  perEnvironment,
  reused = [],
}: {
  usable: number;
  freeLeft: number;
  perEnvironment: readonly ConversationEstimate[];
  reused?: readonly ReusedGoalEstimate[];
}): number | null {
  if (perEnvironment.length === 0) return null;
  const costs = costsOf(perEnvironment);
  if (costs === null || costs.every((cost) => cost.credits === 0)) return null;

  let credits = usable;
  let free = freeLeft;
  let reusedThatFit = 0;
  let reusedAllFit = true;
  for (const goal of reused) {
    const goalCosts = goal.perEnvironment ? costsOf(goal.perEnvironment) : null;
    if (goalCosts === null) return null;
    for (let session = 0; session < goal.sessions; session += 1) {
      for (const cost of goalCosts) {
        if (cost.freeEligible && free > 0) {
          free -= 1;
        } else if (reusedAllFit && credits >= cost.credits) {
          credits -= cost.credits;
        } else {
          reusedAllFit = false;
          continue;
        }
        reusedThatFit += 1;
      }
    }
  }
  if (!reusedAllFit) return reusedThatFit;

  // New slots, in closed form so the cost does not grow with the balance:
  // slots whose eligible environments are all free, then at most one slot
  // where the free conversations run out partway, then full-price slots.
  const slotCredits = costs.reduce((sum, cost) => sum + cost.credits, 0);
  const eligible = costs.filter((cost) => cost.freeEligible);
  let slots = 0;
  if (eligible.length > 0 && free > 0) {
    const discounted =
      slotCredits - eligible.reduce((sum, cost) => sum + cost.credits, 0);
    const freeSlots = Math.floor(free / eligible.length);
    const paidFor =
      discounted > 0 ? Math.floor(credits / discounted) : freeSlots;
    slots = Math.min(freeSlots, paidFor);
    if (slots < freeSlots) return reusedThatFit + slots * costs.length;
    credits -= slots * discounted;
    free -= slots * eligible.length;
    if (free > 0) {
      let mixedCredits = 0;
      for (const cost of costs) {
        if (cost.freeEligible && free > 0) free -= 1;
        else mixedCredits += cost.credits;
      }
      if (credits < mixedCredits) return reusedThatFit + slots * costs.length;
      credits -= mixedCredits;
      slots += 1;
    }
  }
  slots += Math.floor(credits / slotCredits);
  return reusedThatFit + slots * costs.length;
}

/**
 * How many personas and goals each to generate under `max`. Persona variety
 * matters more than goals per persona, so a capped generation keeps the
 * preset's personas and shrinks their goals, dropping personas only when fewer
 * goals fit than there are personas. `null` when not one goal fits.
 */
export function generationSize({
  max,
  reusedConversations,
  environmentCount,
  iterations,
  personaCount,
  journeyCount,
}: {
  max: number | null;
  reusedConversations: number;
  environmentCount: number;
  iterations: number;
  personaCount: number;
  journeyCount: number;
}): { personaCount: number; journeyCount: number } | null {
  if (max === null) return { personaCount, journeyCount };
  const perGoal = Math.max(1, environmentCount) * Math.max(1, iterations);
  const goals = Math.floor(Math.max(0, max - reusedConversations) / perGoal);
  if (goals >= personaCount * journeyCount) {
    return { personaCount, journeyCount };
  }
  if (goals === 0) return null;
  const personas = Math.min(personaCount, goals);
  return {
    personaCount: personas,
    journeyCount: Math.min(journeyCount, Math.floor(goals / personas)),
  };
}

/**
 * The generation the New Swarm flow should ask for under `max`, at the
 * default iterations, and whether the cap changed it (the notice shows only
 * then). `size` is `null` when not one goal fits.
 */
export function capGeneration({
  max,
  reusedConversations = 0,
  environmentCount,
  preset,
}: {
  max: number | null;
  reusedConversations?: number;
  environmentCount: number;
  preset: { personaCount: number; journeyCount: number };
}): {
  size: { personaCount: number; journeyCount: number } | null;
  binds: boolean;
} {
  const size = generationSize({
    max,
    reusedConversations,
    environmentCount,
    iterations: DEFAULT_SWARM_ITERATIONS,
    personaCount: preset.personaCount,
    journeyCount: preset.journeyCount,
  });
  return {
    size,
    binds:
      size?.personaCount !== preset.personaCount ||
      size.journeyCount !== preset.journeyCount,
  };
}

/** Whether adding `added` conversations to `count` stays within `max`. */
export function nextStepFits({
  count,
  added,
  max,
}: {
  count: number;
  added: number;
  max: number | null;
}): boolean {
  return max === null || count + added <= max;
}

/**
 * The most iterations a persona's goals can run at without passing `max`,
 * given every other conversation in the swarm. Never below 1, the smallest
 * value the control allows.
 */
export function iterationsThatFit({
  max,
  otherConversations,
  conversationsPerIteration,
}: {
  max: number | null;
  otherConversations: number;
  conversationsPerIteration: number;
}): number {
  if (max === null || conversationsPerIteration <= 0) {
    return Number.POSITIVE_INFINITY;
  }
  return Math.max(
    1,
    Math.floor((max - otherConversations) / conversationsPerIteration),
  );
}
