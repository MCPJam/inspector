/**
 * Every trial's chain for one run, keyed by iteration.
 *
 * ── Why this is a second read and not a widening of the first ────────────────
 *
 * D9's decision summary already carries per-trial chains and the run page
 * already fetches it — for NON-PASSING trials only, by contract. A reader who
 * opens a trial that passed gets nothing from it, and that is not an oversight
 * to patch there: diagnostics are evidence beneath a verdict. So the chains
 * for the whole population come from the iterations resource instead, and the
 * two are joined by iteration id at the point of use.
 *
 * ── Keyed on the run's REVISION, not just its status ─────────────────────────
 *
 * A terminal run is not frozen. An asynchronous judge landing after the run
 * stopped rewrites `judgePending` into `judgeObserved`, which is a different
 * chain for the same trial. This keys its cache on the same revision marker
 * the decision-summary store uses, so the two reads refresh together — one
 * trial showing two different chains during a stale window is exactly the
 * disagreement the single-chain-type rule exists to prevent.
 *
 * ── Off by default, and silent when off ──────────────────────────────────────
 *
 * Gated on the caller's own switch, a project id and a terminal run. With any
 * of them missing this issues NO request at all, so every non-Evaluate mount
 * of the views that use it stays at exactly zero.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import {
  EvalRunIterationsError,
  fetchEvalRunIterationChains,
  isEvalRunIterationsError,
  type EvalRunIterationsFailureKind,
} from "@/lib/apis/eval-run-iterations-api";
import {
  evalRunDecisionRevision,
  isTerminalEvalRunStatus,
} from "@/lib/evals/eval-decision-summary-store";
import type { EvalRunDecisionChain } from "@mcpjam/sdk/contract";

/**
 * How many pages this will walk on its own.
 *
 * The route's own page cap makes nearly every run a single request, and the
 * SDK's fallback walk stops at a fixed count for the same reason: an unbounded
 * loop over a cursor the server keeps issuing is a way to hang a browser tab
 * on a pathological run. Reaching the cap is not an error — it leaves
 * `walkExhausted` false, and a row past the last page renders NOTHING rather
 * than "no chain".
 */
export const ITERATION_CHAIN_PAGE_CAP = 10;

export interface EvalRunIterationChainsState {
  status: "disabled" | "loading" | "ready" | "error";
  /** Chains by iteration id. Absent key = not loaded, NOT "no chain". */
  chains: Map<string, EvalRunDecisionChain>;
  error: EvalRunIterationsFailureKind | null;
  /** Whether every page the server offered has been read. */
  walkExhausted: boolean;
  scannedIterations: number;
}

const EMPTY: EvalRunIterationChainsState = {
  status: "disabled",
  chains: new Map(),
  error: null,
  walkExhausted: false,
  scannedIterations: 0,
};

export interface EvalRunIterationChainsTarget {
  projectId: string | null | undefined;
  run:
    | {
        _id: string;
        status: string;
        result?: string | null;
        completedAt?: number | null;
        verdictPolicyVersion?: unknown;
        verdictSummary?: unknown;
        goalCompletionStatus?: string | null;
      }
    | null
    | undefined;
  /** The caller's own switch — the existing Evaluate opt-in. */
  enabled: boolean;
}

export function useEvalRunIterationChains({
  projectId,
  run,
  enabled,
}: EvalRunIterationChainsTarget): EvalRunIterationChainsState {
  const terminal = isTerminalEvalRunStatus(run?.status);
  const active = Boolean(enabled && projectId && run && terminal);
  // The revision is part of the identity, so a judge landing after the run
  // terminalized re-reads instead of serving a chain that has since changed.
  const revision = run ? evalRunDecisionRevision(run) : "";
  const key = active ? `${projectId}:${run?._id}:${revision}` : "";

  const [state, setState] = useState<EvalRunIterationChainsState>(EMPTY);
  // What the last completed read was for, so a resolved response for a run the
  // reader has already navigated away from is discarded rather than rendered.
  const currentKey = useRef("");

  useEffect(() => {
    currentKey.current = key;
    if (!active || !projectId || !run) {
      setState(EMPTY);
      return;
    }

    const controller = new AbortController();
    setState({ ...EMPTY, status: "loading" });

    (async () => {
      const chains = new Map<string, EvalRunDecisionChain>();
      let cursor: string | undefined;
      let pages = 0;
      try {
        do {
          const page = await fetchEvalRunIterationChains(
            {
              projectId,
              runId: run._id,
              ...(cursor ? { cursor } : {}),
            },
            controller.signal,
          );
          for (const item of page.items)
            chains.set(item.iterationId, item.chain);
          cursor = page.nextCursor;
          pages += 1;
        } while (cursor && pages < ITERATION_CHAIN_PAGE_CAP);
      } catch (error) {
        if (controller.signal.aborted || currentKey.current !== key) return;
        setState({
          status: "error",
          chains: new Map(),
          error: isEvalRunIterationsError(error)
            ? error.kind
            : ("requestFailed" as EvalRunIterationsFailureKind),
          walkExhausted: false,
          scannedIterations: 0,
        });
        return;
      }
      if (controller.signal.aborted || currentKey.current !== key) return;
      setState({
        status: "ready",
        chains,
        error: null,
        // OUR OWN fact, and named as such: we followed every cursor offered.
        // It is not a claim that the server considers the set complete.
        walkExhausted: cursor === undefined,
        scannedIterations: chains.size,
      });
    })().catch(() => {
      // `fetchEvalRunIterationChains` rethrows a caller abort untouched, and
      // an abort is not a failure to report.
      if (!controller.signal.aborted && currentKey.current === key) {
        setState({
          status: "error",
          chains: new Map(),
          error: "requestFailed",
          walkExhausted: false,
          scannedIterations: 0,
        });
      }
    });

    return () => controller.abort();
  }, [active, key, projectId, run?._id]);

  return useMemo(() => state, [state]);
}

export { EvalRunIterationsError };
