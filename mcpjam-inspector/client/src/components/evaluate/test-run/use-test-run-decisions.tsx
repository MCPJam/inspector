import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type {
  EvalRunDecisionChain,
  EvalRunDecisionDiagnostic,
} from "@mcpjam/sdk/contract";
import {
  evalRunDecisionRevision,
  isTerminalEvalRunStatus,
} from "@/lib/evals/eval-decision-summary-store";
import {
  useEvalRunDecisionDetail,
  type EvalRunDecisionDetailState,
} from "@/hooks/use-eval-run-decision-summary";
import { useEvalRunIterationChains } from "@/hooks/use-eval-run-iteration-chains";
import type { EvalIteration, EvalSuiteRun } from "../../evals/types";
import { groupRunIterationsByTestCase } from "../../evals/run-case-groups";
import {
  buildEvaluateCaseRows,
  type EvaluateCaseRow,
} from "../evaluate-case-row-model";

/** One launch run's decision read, as the case rows and scorecards use it. */
export type RunDecision = {
  status: EvalRunDecisionDetailState["status"];
  summary: EvalRunDecisionDetailState["summary"];
  diagnostics: EvalRunDecisionDiagnostic[];
  chains: ReadonlyMap<string, EvalRunDecisionChain>;
  chainsLoaded: boolean;
};

const sameItems = <T,>(a: readonly T[], b: readonly T[]) =>
  a.length === b.length && a.every((item, index) => item === b[index]);

/**
 * The previous list while its items are the same objects. The decision read
 * rebuilds its diagnostics array on every render from stable store entries,
 * so the array's identity alone would report a change that never happened.
 */
function useStableItems<T>(items: T[]): T[] {
  const last = useRef(items);
  if (!sameItems(last.current, items)) last.current = items;
  return last.current;
}

const sameDecision = (a: RunDecision, b: RunDecision) =>
  a.status === b.status &&
  a.summary === b.summary &&
  a.chains === b.chains &&
  a.chainsLoaded === b.chainsLoaded &&
  sameItems(a.diagnostics, b.diagnostics);

/**
 * Reads one run's decision and chains. A component rather than a hook call
 * because a launch has as many runs as it has models, and hooks cannot loop.
 */
function RunDecisionReader({
  projectId,
  run,
  onRead,
}: {
  projectId: string | null;
  run: EvalSuiteRun;
  onRead: (runId: string, decision: RunDecision) => void;
}) {
  const active = Boolean(projectId) && isTerminalEvalRunStatus(run.status);
  const detail = useEvalRunDecisionDetail({
    projectId,
    runId: run._id,
    enabled: active,
    revision: evalRunDecisionRevision(run),
  });
  const chains = useEvalRunIterationChains({ projectId, run, enabled: active });
  const { status, summary } = detail;
  const diagnostics = useStableItems(detail.diagnostics);
  useEffect(() => {
    onRead(run._id, {
      status,
      summary,
      diagnostics,
      chains: chains.chains,
      chainsLoaded: status !== "loading" && chains.status !== "loading",
    });
  }, [
    onRead,
    run._id,
    status,
    summary,
    diagnostics,
    chains.chains,
    chains.status,
  ]);
  return null;
}

export type TestRunDecisions = {
  /** Mount these once; they render nothing. */
  readers: ReactNode;
  byRun: ReadonlyMap<string, RunDecision>;
  /** This case's row in each launch run, in launch order. */
  rows: EvaluateCaseRow[];
};

export function useTestRunDecisions(
  projectId: string | null,
  runs: readonly EvalSuiteRun[],
  iterations: readonly EvalIteration[],
): TestRunDecisions {
  const [byRun, setByRun] = useState<ReadonlyMap<string, RunDecision>>(
    () => new Map(),
  );
  // A report equal to the one held keeps the same map, so React skips the
  // render instead of re-rendering every reader again.
  const onRead = useCallback((runId: string, decision: RunDecision) => {
    setByRun((previous) => {
      const held = previous.get(runId);
      if (held && sameDecision(held, decision)) return previous;
      return new Map(previous).set(runId, decision);
    });
  }, []);
  const readers = runs.map((run) => (
    <RunDecisionReader
      key={run._id}
      projectId={projectId}
      run={run}
      onRead={onRead}
    />
  ));
  const rows = useMemo(
    () =>
      runs.flatMap((run) => {
        const decision = byRun.get(run._id);
        const groups = groupRunIterationsByTestCase(
          iterations.filter((iteration) => iteration.suiteRunId === run._id),
          "test",
        );
        if (groups.length === 0) return [];
        return buildEvaluateCaseRows({
          groups,
          summary: decision?.summary ?? null,
          diagnostics: decision?.diagnostics ?? [],
          chains: decision?.chains ?? new Map(),
          chainsLoaded: decision?.chainsLoaded ?? false,
          decisionStatus: decision?.status ?? "loading",
        });
      }),
    [runs, iterations, byRun],
  );
  return { readers, byRun, rows };
}
