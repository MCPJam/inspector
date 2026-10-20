/**
 * What the scorecard may say about a run-backed trial's stage chain.
 *
 * The scorecard's no-chain fallback marks every stage "Not measured", which
 * is a claim about the RUN. It is only true once the chain read for this
 * trial's own run has finished and found nothing. Every other missing chain
 * is about the read — still coming, failed, or never reached — and says so.
 */

import type { EvalRunIterationChainsState } from "@/hooks/use-eval-run-iteration-chains";

export type TrialChainDisplay =
  /** Show whatever chain the caller has (or the honest no-chain fallback). */
  | "settled"
  /** A read is in flight (the chain, or the run it is keyed on): skeleton. */
  | "loading"
  /** The run has not finished, so there is nothing to read yet: note. */
  | "waiting"
  /** The read failed: say so, offer a retry. */
  | "error"
  /**
   * This trial's chain was never read: the read stopped at its page cap
   * before reaching it, or it was keyed on another run. Say so.
   */
  | "notLoaded";

export function trialChainDisplay(input: {
  /** The trial's `suiteRunId`; absent for a quick run. */
  trialRunId: string | null | undefined;
  /** The chain the caller already resolved for this trial, if any. */
  hasChain: boolean;
  /** The run the chain read is keyed on. */
  readRunId: string | null | undefined;
  /** That run's document; null while it loads. */
  readRun: { status: string } | null | undefined;
  /** True while the run document itself is still loading. */
  readRunLoading: boolean;
  isTerminalRunStatus: (status: string | null | undefined) => boolean;
  chains: Pick<EvalRunIterationChainsState, "status" | "walkExhausted">;
}): TrialChainDisplay {
  const { trialRunId, chains } = input;
  if (!trialRunId || input.hasChain) return "settled";
  // A read keyed on another run never reached this trial.
  if (input.readRunId !== trialRunId) return "notLoaded";
  if (!input.readRun) return input.readRunLoading ? "loading" : "settled";
  if (chains.status === "loading") return "loading";
  if (chains.status === "error") return "error";
  if (chains.status === "disabled") {
    // The hook reads only finished runs. A run that never finishes (a dead
    // worker) must not hold a skeleton up forever, so this is a note over
    // the rows, not a loading state.
    return input.isTerminalRunStatus(input.readRun.status)
      ? "settled"
      : "waiting";
  }
  // Ready with no entry: absent only if every page was read.
  return chains.walkExhausted ? "settled" : "notLoaded";
}
