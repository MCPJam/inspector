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
 * error: the boundary still reports to telemetry, because the two shapes
 * `isConvexQueryUnavailable` forgives do NOT cover this one. A backend that
 * lost the `clusterId` argument is a rollback, and it should page someone.
 */

import { useEffect } from "react";
import { useQuery } from "convex/react";
import { ErrorBoundary } from "@/components/ui/error-boundary";
import type { ChatSessionStageFunnel } from "@/components/shared/user-value-chain/user-value-chain-types";
import {
  mapGoalStageFunnel,
  type ScenarioGoalStages,
} from "./scenario-findings-stages";

/**
 * Answers name the goal they are ABOUT, not just the answer.
 *
 * The tab reuses one probe across goals, so an answer that did not name its
 * goal could not be told apart from the previously expanded one — and a stale
 * chain would paint the goal you just opened with the last goal's failures.
 */
export type ScenarioGoalChainHandler = (
  goalId: string,
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
  sentiment?: string;
  onResolved: ScenarioGoalChainHandler;
}) {
  return (
    // KEYED by the goal. A boundary that has caught stays in its fallback for
    // the life of the element, so an unkeyed one would swallow the chain for
    // every LATER goal too: one transient failure and the rest of the study
    // reads as unmeasured until the whole tab remounts.
    <ErrorBoundary
      key={`${scenarioId}:${goalId}:${sentiment ?? "all"}`}
      name="scenario-goal-stage-chain"
      fallback={null}
      onError={() => onResolved(goalId, null)}
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
  sentiment?: string;
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
    onResolved(goalId, mapGoalStageFunnel(funnel));
  }, [funnel, goalId, onResolved]);

  return null;
}
