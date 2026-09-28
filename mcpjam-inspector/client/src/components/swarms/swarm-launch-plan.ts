import type { SwarmQuotePlannedRun } from "@/hooks/use-swarm-launch-quote";

/**
 * What a launch from the create flow would run, reduced to what prices it:
 * the new goals by persona, and the reused personas' existing goals. Both
 * launch at one iteration count per persona, across every selected
 * environment.
 */
export interface LaunchPlanProposed {
  /** The proposed persona's local key. */
  key: string;
  /** Goals that would launch (blank drafts never do), in order. */
  goalKeys: string[];
  iterations: number;
}

export interface LaunchPlanReused {
  personaId: string;
  journeyIds: string[];
  iterations: number;
}

export interface LaunchPlan {
  proposed: LaunchPlanProposed[];
  reused: LaunchPlanReused[];
}

/** Conversations the plan launches: goals × iterations × environments. */
export function launchPlanSessions(
  plan: LaunchPlan,
  environmentCount: number,
): number {
  const goalIterations =
    plan.proposed.reduce(
      (sum, persona) => sum + persona.goalKeys.length * persona.iterations,
      0,
    ) +
    plan.reused.reduce(
      (sum, persona) => sum + persona.journeyIds.length * persona.iterations,
      0,
    );
  return goalIterations * Math.max(1, environmentCount);
}

/**
 * The runs the quote prices, with the settings the launch would send: one per
 * goal. A new goal has no id yet, so it is priced as a bare run over the
 * selected environments at its persona's iterations and the preset's turn
 * limit. A reused goal is priced by id, with this launch's iterations and
 * environment selection as the overrides the launch sends.
 *
 * `null` when there is nothing to price, or when a new goal has no
 * environment to price against yet.
 */
export function quotePlannedRuns(
  plan: LaunchPlan,
  { environmentIds, maxTurns }: { environmentIds: string[]; maxTurns: number },
): SwarmQuotePlannedRun[] | null {
  const runs: SwarmQuotePlannedRun[] = [];
  for (const persona of plan.proposed) {
    if (persona.goalKeys.length === 0) continue;
    if (environmentIds.length === 0) return null;
    for (const goalKey of persona.goalKeys) {
      runs.push({
        key: `new:${persona.key}:${goalKey}`,
        environmentIds: [...environmentIds],
        sessionsPerTarget: persona.iterations,
        maxTurns,
        setupWrites: true,
      });
    }
  }
  for (const persona of plan.reused) {
    for (const journeyId of persona.journeyIds) {
      runs.push({
        key: `reused:${journeyId}`,
        journeyId,
        sessionsPerTarget: persona.iterations,
        ...(environmentIds.length > 0
          ? { environmentIds: [...environmentIds] }
          : {}),
      });
    }
  }
  return runs.length > 0 ? runs : null;
}

/**
 * The largest smaller plan that launches at most `maxSessions` conversations,
 * or `null` when not even one goal fits.
 *
 * It is built up in the order the plan's parts matter: first the new goals,
 * round-robin across personas so every persona keeps a goal before any keeps
 * two; then their iterations, raised back toward what was chosen, again
 * round-robin; then the reused personas, each at the highest of its chosen
 * iterations that still fits. The caller quotes the result before applying
 * it, since the server's per-session prices are what decide.
 */
export function fitLaunchPlan(
  plan: LaunchPlan,
  {
    environmentCount,
    maxSessions,
  }: { environmentCount: number; maxSessions: number },
): LaunchPlan | null {
  // One goal at one iteration runs once per environment.
  let budget = Math.floor(maxSessions / Math.max(1, environmentCount));
  if (budget <= 0) return null;

  const kept = new Map<string, string[]>(
    plan.proposed.map((persona) => [persona.key, []]),
  );
  const queues = plan.proposed.map((persona) => ({
    key: persona.key,
    goals: [...persona.goalKeys],
  }));
  for (let added = true; budget > 0 && added;) {
    added = false;
    for (const queue of queues) {
      if (budget <= 0) break;
      const goal = queue.goals.shift();
      if (goal === undefined) continue;
      kept.get(queue.key)!.push(goal);
      budget -= 1;
      added = true;
    }
  }

  const iterations = new Map<string, number>(
    plan.proposed.map((persona) => [persona.key, 1]),
  );
  for (let raised = true; budget > 0 && raised;) {
    raised = false;
    for (const persona of plan.proposed) {
      const goals = kept.get(persona.key)!.length;
      const current = iterations.get(persona.key)!;
      if (goals === 0 || current >= persona.iterations || goals > budget) {
        continue;
      }
      iterations.set(persona.key, current + 1);
      budget -= goals;
      raised = true;
    }
  }

  const reused: LaunchPlanReused[] = [];
  for (const persona of plan.reused) {
    const goals = persona.journeyIds.length;
    if (goals === 0) continue;
    const fitting = Math.min(persona.iterations, Math.floor(budget / goals));
    if (fitting < 1) continue;
    reused.push({ ...persona, iterations: fitting });
    budget -= goals * fitting;
  }

  const proposed = plan.proposed.map((persona) => ({
    key: persona.key,
    goalKeys: kept.get(persona.key)!,
    iterations: iterations.get(persona.key)!,
  }));
  if (
    proposed.every((persona) => persona.goalKeys.length === 0) &&
    reused.length === 0
  ) {
    return null;
  }
  return { proposed, reused };
}
