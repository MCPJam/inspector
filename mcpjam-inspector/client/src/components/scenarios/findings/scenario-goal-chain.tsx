/**
 * The per-goal user value chain, fetched for the ONE goal that is open.
 *
 * Renders nothing. It exists to own a subscription whose answer the tab needs
 * ABOVE it — the same shape as `SuiteRunStageFunnelAvailability`, and for the
 * same reason: `useQuery` throws, an `ErrorBoundary` only catches what its
 * DESCENDANTS throw, and a query that took the Findings tab down with it would
 * be worse than the unmeasured chain it exists to replace.
 *
 * ── Why one goal and not all of them ────────────────────────────────────────
 *
 * Each funnel is an indexed scan of up to `STAGE_SUMMARY_SCAN_LIMIT` rows.
 * Subscribing every goal in the study on tab open would buy a scan per cluster
 * to paint rows the reader has not asked about — the collapsed row shows a
 * session count and an outcome pill, neither of which comes from the chain. So
 * the cost is paid on expand, by the person who asked.
 *
 * ── What a failure means here ───────────────────────────────────────────────
 *
 * Any throw reports `null`, and `null` leaves the chain unmeasured, which is
 * what the tab already shows today. That is a real fallback, not a swallowed
 * error: this boundary passes NO `isExpectedError`, so it reports every throw
 * unconditionally — including the shapes that predicate would forgive. A
 * backend that lost an argument is a rollback, and it should page someone.
 *
 * Do not reach for `isExpectedError={isConvexQueryUnavailable}` to quieten
 * this during a dark-ship window. It would not match: an argument-validation
 * rejection is neither string that predicate looks for, and the next move —
 * widening the predicate — is the one `StageFunnelPanels` warns against by
 * name.
 */

import { useEffect } from "react";
import { useQuery } from "convex/react";
import { ErrorBoundary } from "@/components/ui/error-boundary";
import type { ChatSessionStageFunnel } from "@/components/shared/user-value-chain/user-value-chain-types";
import type { SessionSentiment } from "@/hooks/scenario-usage-filters";
import {
  mapGoalStageFunnel,
  type ScenarioGoalStages,
} from "./scenario-findings-stages";

/**
 * Answers name the POPULATION they are about, not just the answer.
 *
 * The tab reuses one probe across goals AND personas, so an answer that did
 * not say what it described could not be told apart from the last one — and a
 * stale chain would paint the goal you just opened with the previous goal's
 * failures. The sentiment is in here for the same reason the goal is: the same
 * cluster read under two personas is two different populations, so an answer
 * for one of them is not an answer for the other.
 */
export type ScenarioGoalChainAnswerFor = {
  goalId: string;
  /**
   * Typed to the union, not `string`.
   *
   * "No persona" is spelled three ways in this flow — truthiness at the query
   * spread, nullish at the boundary key, strict equality at the tab's guard.
   * They agree on `undefined` and disagree on `""`: an empty string would
   * query the whole cluster, stamp the answer with it, pass the guard, and
   * paint whole-population evidence under a one-persona heading. That is the
   * bug this file exists to prevent, arriving through the guard built to
   * prevent it. The union makes it unrepresentable rather than merely
   * unreachable.
   */
  sentiment: SessionSentiment | undefined;
};

export type ScenarioGoalChainHandler = (
  about: ScenarioGoalChainAnswerFor,
  stages: ScenarioGoalStages | null,
) => void;

export function ScenarioGoalChain({
  scenarioId,
  goalId,
  sentiment,
  onResolved,
}: {
  scenarioId: string;
  /** The goal-axis cluster id. A User Testing goal IS its cluster. */
  goalId: string;
  /**
   * The persona this goal is being read inside. A User Testing persona IS the
   * session's sentiment, and the panel is a card ABOUT that persona: its count,
   * its session list, its goal row.
   *
   * Without it the funnel answers for the whole cluster, and the card prints a
   * number about everyone who tried the goal between two numbers about one
   * persona — "2 sessions" above, "failed in 3 of 6 graded" in the middle.
   */
  sentiment?: SessionSentiment;
  onResolved: ScenarioGoalChainHandler;
}) {
  return (
    // KEYED by the goal AND the persona. A boundary that has caught stays in
    // its fallback for the life of the element, so an unkeyed one would
    // swallow the chain for every later goal — and, since this diff, for every
    // later persona on the same goal: one transient failure and the rest of
    // the study reads as unmeasured until the whole tab remounts.
    <ErrorBoundary
      key={`${scenarioId}:${goalId}:${sentiment ?? "all"}`}
      name="scenario-goal-stage-chain"
      fallback={null}
      onError={() => onResolved({ goalId, sentiment }, null)}
    >
      <ScenarioGoalChainQuery
        scenarioId={scenarioId}
        goalId={goalId}
        sentiment={sentiment}
        onResolved={onResolved}
      />
    </ErrorBoundary>
  );
}

function ScenarioGoalChainQuery({
  scenarioId,
  goalId,
  sentiment,
  onResolved,
}: {
  scenarioId: string;
  goalId: string;
  sentiment?: SessionSentiment;
  onResolved: ScenarioGoalChainHandler;
}) {
  // Named rather than generated: the inspector holds no Convex codegen, so
  // every call site in this tree addresses functions this way.
  //
  // `sentiment` is omitted rather than sent as undefined when the tab has no
  // persona to name: the server validates arguments, and an explicit
  // `undefined` is not the same thing as an absent optional.
  const funnel = useQuery(
    "chatSessionStageDerivation:getScenarioStageFunnel" as never,
    {
      scenarioId,
      clusterId: goalId,
      ...(sentiment ? { sentiment } : {}),
    } as never,
  ) as ChatSessionStageFunnel | null | undefined;

  // Keyed on the RESULT'S IDENTITY, which `useQuery` keeps stable while the
  // data is unchanged (it hands back the watch's cached value). That stability
  // is what stops report → setState → render → report from running away, so a
  // test double for this query has to return the same object across renders or
  // it will spin.
  useEffect(() => {
    // `undefined` is still loading, and reporting it would blank a chain the
    // reader is already looking at. `null` is the backend saying it cannot
    // answer for this goal, which IS an answer and must be passed on.
    if (funnel === undefined) return;
    onResolved({ goalId, sentiment }, mapGoalStageFunnel(funnel));
  }, [funnel, goalId, sentiment, onResolved]);

  return null;
}
