/**
 * The most conversations a new swarm can pay for, for the New Swarm flow.
 *
 * Combines the organization's balance, the user's free swarm conversations and
 * the backend's per-environment estimate through `swarm-credit-cap`. Anything
 * still loading, failed or missing gives `max: null`, which the flow reads as
 * "no cap": the backend admits every call on its own, so a missing cap only
 * brings back today's behavior.
 */
import { useCallback, useMemo } from "react";
import { useConvex } from "convex/react";
import { makeFunctionReference } from "convex/server";
import type { GoalJudgeConfig } from "@/components/shared/session-quality/judge-config";
import {
  maxConversations,
  usableCredits,
  type ConversationEstimate,
} from "@/components/swarms/swarm-credit-cap";
import {
  useCreditBalance,
  type CreditBalanceState,
} from "@/hooks/useCreditBalance";
import { useSoftQuery } from "@/hooks/use-soft-query";
import { SWARM_QUERIES } from "@/lib/swarm-api";
import {
  useSwarmSponsorshipAllowanceState,
  type SwarmSponsorshipAllowanceState,
} from "@/hooks/use-swarm-sponsorship-allowance";

const ESTIMATE_QUERY =
  "swarms/conversationEstimate:estimateSwarmConversationCredits";

type EstimateArgs = {
  projectId: string;
  environmentIds: string[];
  maxTurns: number;
  judgeConfig?: GoalJudgeConfig;
  reusedJourneyIds?: string[];
};

type EstimateResult = {
  environments: ConversationEstimate[];
  reused: Array<{
    journeyId: string;
    sessionsPerTarget: number | null;
    environments: ConversationEstimate[] | null;
  }>;
};

const estimateQuery = makeFunctionReference<
  "query",
  EstimateArgs,
  EstimateResult
>(ESTIMATE_QUERY);

/** A reused goal in this swarm, at the iterations it will launch with. */
export interface ReusedGoalRuns {
  journeyId: string;
  sessions: number;
}

export interface SwarmCreditCapTargets {
  environmentIds: readonly string[];
  reusedGoals?: readonly ReusedGoalRuns[];
}

/** The cap for targets the flow resolved at click time. */
export interface SwarmCreditCapAtClick {
  /** `null` means no cap. */
  max: number | null;
  /** Conversations the reused goals already take. */
  reusedConversations: number;
  /** The cheapest conversation, for the credits dialog. */
  conversationCredits: number | null;
}

const listJourneysQuery = makeFunctionReference<
  "query",
  { personaRefId: string },
  Array<{ _id: string; config?: { sessionsPerTarget?: number } | null }>
>(SWARM_QUERIES.listJourneysByPersona);

function cheapestConversation(
  estimate: EstimateResult | undefined,
): number | null {
  const costs = (estimate?.environments ?? []).flatMap((environment) =>
    environment.tokenCredits === null
      ? []
      : [environment.tokenCredits + environment.feeCredits],
  );
  return costs.length > 0 ? Math.min(...costs) : null;
}

function capOf(
  estimate: EstimateResult | undefined,
  balance: CreditBalanceState | undefined,
  allowance: SwarmSponsorshipAllowanceState,
  reusedGoals: readonly ReusedGoalRuns[],
): number | null {
  if (!estimate || !balance) return null;
  if (allowance.status === "loading" || allowance.status === "error") {
    return null;
  }
  const sessionsById = new Map(
    reusedGoals.map((goal) => [goal.journeyId, goal.sessions]),
  );
  return maxConversations({
    usable: usableCredits(balance),
    freeLeft: allowance.status === "ready" ? allowance.remaining : 0,
    perEnvironment: estimate.environments,
    reused: estimate.reused.map((goal) => ({
      sessions: sessionsById.get(goal.journeyId) ?? goal.sessionsPerTarget ?? 1,
      perEnvironment: goal.environments,
    })),
  });
}

export function useSwarmCreditCap({
  projectId,
  organizationId,
  environmentIds,
  reusedGoals = [],
  maxTurns,
  judgeConfig,
}: SwarmCreditCapTargets & {
  projectId: string | null | undefined;
  /** The swarm project's organization, whose balance pays for the run. */
  organizationId: string | null | undefined;
  maxTurns: number;
  judgeConfig?: GoalJudgeConfig;
}): {
  /** `null` means no cap. */
  max: number | null;
  /** The balance as the sidebar shows it, for the notice heading. */
  credits: number | null;
  /** The cheapest conversation, for the credits dialog. */
  conversationCredits: number | null;
  /**
   * The cap for targets the flow only knows at click time. Reused personas
   * are passed by id, since their goals are not loaded before Confirm.
   */
  capFor: (
    targets: SwarmCreditCapTargets & { reusedPersonaIds?: readonly string[] },
  ) => Promise<SwarmCreditCapAtClick>;
} {
  const convex = useConvex();
  const { balance } = useCreditBalance({ organizationId });
  const allowance = useSwarmSponsorshipAllowanceState();
  const argsFor = useCallback(
    (targets: SwarmCreditCapTargets): EstimateArgs | null =>
      projectId && targets.environmentIds.length > 0
        ? {
            projectId,
            environmentIds: [...targets.environmentIds],
            maxTurns,
            ...(judgeConfig ? { judgeConfig } : {}),
            ...(targets.reusedGoals && targets.reusedGoals.length > 0
              ? {
                  reusedJourneyIds: targets.reusedGoals.map(
                    (goal) => goal.journeyId,
                  ),
                }
              : {}),
          }
        : null,
    [judgeConfig, maxTurns, projectId],
  );
  const args = argsFor({ environmentIds, reusedGoals });
  const { data: estimate } = useSoftQuery<EstimateResult>(
    ESTIMATE_QUERY,
    args ?? "skip",
  );

  const capFor = useCallback(
    async ({
      reusedPersonaIds = [],
      ...targets
    }: SwarmCreditCapTargets & {
      reusedPersonaIds?: readonly string[];
    }): Promise<SwarmCreditCapAtClick> => {
      const uncapped = {
        max: null,
        reusedConversations: 0,
        conversationCredits: null,
      };
      try {
        const reusedGoals =
          targets.reusedGoals ??
          (
            await Promise.all(
              reusedPersonaIds.map((personaRefId) =>
                convex.query(listJourneysQuery, { personaRefId }),
              ),
            )
          )
            .flat()
            .map((journey) => ({
              journeyId: journey._id,
              sessions: journey.config?.sessionsPerTarget ?? 1,
            }));
        const request = argsFor({ ...targets, reusedGoals });
        if (!request) return uncapped;
        const fresh = await convex.query(estimateQuery, request);
        return {
          max: capOf(fresh, balance, allowance, reusedGoals),
          reusedConversations:
            reusedGoals.reduce((sum, goal) => sum + goal.sessions, 0) *
            targets.environmentIds.length,
          conversationCredits: cheapestConversation(fresh),
        };
      } catch {
        // The cap is optional: a failed read (an older backend without the
        // estimate, a dropped connection) leaves generation uncapped, as it
        // was before the cap existed. Per-call admission still guards spend.
        return uncapped;
      }
    },
    [allowance, argsFor, balance, convex],
  );

  const max = useMemo(
    () => capOf(estimate, balance, allowance, reusedGoals),
    [allowance, balance, estimate, reusedGoals],
  );
  const credits = balance
    ? (balance.billingModel === "daily"
        ? balance.freeDailyCreditsRemaining
        : (balance.monthlyAllowanceRemaining ?? 0)) +
      balance.paidCreditsRemaining
    : null;
  return {
    max,
    credits,
    conversationCredits: cheapestConversation(estimate),
    capFor,
  };
}
