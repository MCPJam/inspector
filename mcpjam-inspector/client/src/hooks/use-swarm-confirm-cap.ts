/**
 * The credit cap as the Confirm step applies it: which add controls still
 * fit, how far each persona's iterations can go, whether Continue is blocked,
 * and the notice to show. `max: null` (no cap) turns every rule off.
 */
import type { ComponentProps } from "react";
import type { GoalJudgeConfig } from "@/components/shared/session-quality/judge-config";
import {
  countOf,
  iterationsThatFit,
  nextStepFits,
} from "@/components/swarms/swarm-credit-cap";
import type { SwarmCreditCapNotice } from "@/components/swarms/swarm-credit-cap-notice";
import {
  MAX_SWARM_ITERATIONS,
  MIN_SWARM_ITERATIONS,
} from "@/components/swarms/swarm-intensity";
import {
  useSwarmCreditCap,
  type ReusedGoalRuns,
} from "@/hooks/use-swarm-credit-cap";

type NoticeProps = Omit<
  ComponentProps<typeof SwarmCreditCapNotice>,
  "data-testid"
>;

export function useSwarmConfirmCap({
  projectId,
  organizationId,
  environmentIds,
  reusedGoals,
  maxTurns,
  judgeConfig,
  launchCount,
  environmentCount,
  proposed,
  reusedIterations,
  locked,
}: {
  projectId: string | null | undefined;
  organizationId: string | null | undefined;
  environmentIds: readonly string[];
  /** Goals that already exist, at the iterations they will launch with. */
  reusedGoals: readonly ReusedGoalRuns[];
  maxTurns: number;
  judgeConfig: GoalJudgeConfig | undefined;
  /** Conversations the launch will run. */
  launchCount: number;
  /** At least 1. */
  environmentCount: number;
  proposed: readonly {
    journeys: readonly { goal: string }[];
    iterations: number;
  }[];
  reusedIterations: readonly number[];
  /** Goals are already created, so only iterations can change. */
  locked: boolean;
}): {
  max: number | null;
  /** Whether one more step of this many conversations per environment fits. */
  fits: (conversationsPerEnvironment: number) => boolean;
  /** The tooltip on an add control the cap disabled. */
  capReason: string | null;
  /** The most iterations a new persona with `goals` goals can take. */
  iterationsCap: (goals: number, iterations: number) => number;
  /** The most iterations a reused persona's goals can take. */
  reusedIterationsCap: (
    journeyIds: readonly string[],
    iterations: number,
  ) => number;
  /** Why Continue is blocked, when the swarm is over the max. */
  blockedReason: string | null;
  notice: NoticeProps | null;
} {
  const cap = useSwarmCreditCap({
    projectId,
    organizationId,
    environmentIds,
    reusedGoals,
    maxTurns,
    judgeConfig,
  });
  const { max } = cap;
  // An empty draft goal counts against the cap: it launches once it has text.
  // Once the goals exist (locked), a draft can neither launch nor be removed.
  const draftRuns = locked
    ? 0
    : proposed.reduce(
        (sum, persona) =>
          sum +
          persona.journeys.filter((journey) => !journey.goal.trim()).length *
            persona.iterations,
        0,
      );
  const count = launchCount + draftRuns * environmentCount;
  const fits = (conversationsPerEnvironment: number) =>
    nextStepFits({
      count,
      added: conversationsPerEnvironment * environmentCount,
      max,
    });
  const over = max !== null && launchCount > max;
  return {
    max,
    fits,
    capReason:
      max === null
        ? null
        : `Your credits cover up to ${countOf(max, "conversation")}. Remove a goal or lower iterations to add more.`,
    iterationsCap: (goals, iterations) =>
      iterationsThatFit({
        max,
        otherConversations: count - goals * iterations * environmentCount,
        conversationsPerIteration: goals * environmentCount,
      }),
    reusedIterationsCap: (journeyIds, iterations) => {
      if (max === null) return Number.POSITIVE_INFINITY;
      // Each step re-prices the swarm: these goals cost what their own config
      // costs, so one shared per-conversation price would misjudge the fit.
      let fitting = iterations;
      while (fitting < MAX_SWARM_ITERATIONS) {
        const next = fitting + 1;
        const nextMax = cap.maxFor(
          reusedGoals.map((goal) =>
            journeyIds.includes(goal.journeyId)
              ? { ...goal, sessions: next }
              : goal,
          ),
        );
        const added =
          journeyIds.length * (next - iterations) * environmentCount;
        if (nextMax !== null && count + added > nextMax) break;
        fitting = next;
      }
      return Math.max(MIN_SWARM_ITERATIONS, fitting);
    },
    blockedReason: over
      ? `Your credits cover up to ${countOf(max, "conversation")}, and this swarm has ${launchCount}.`
      : null,
    notice:
      max !== null && (over || !fits(1)) && cap.credits !== null
        ? {
            credits: cap.credits,
            max,
            count: launchCount,
            locked,
            iterationsAtMinimum: [
              ...proposed.map((persona) => persona.iterations),
              ...reusedIterations,
            ].every((iterations) => iterations <= MIN_SWARM_ITERATIONS),
            goalCredits: cap.goalCredits,
            organizationId,
          }
        : null,
  };
}
