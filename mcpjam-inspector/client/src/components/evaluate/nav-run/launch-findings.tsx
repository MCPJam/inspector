/**
 * Findings for every run of a launch at once ("All models" on the Suite run
 * page). Each member run's findings are read on their own and merged by
 * stage and reason. Until every run's are built, the first run still
 * waiting shows today's panel (its loading, Build findings or error state).
 */
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { ErrorBoundary } from "@/components/ui/error-boundary";
import { useInsightsEnvelope } from "@/components/shared/actionable-insights/use-insights-envelope";
import {
  useUnifiedFindings,
  type BorrowedGenerationController,
} from "@/components/shared/actionable-insights/use-unified-findings";
import type { EvalIteration } from "../../evals/types";
import { findingsBuilt } from "../unified-findings-section";
import { FindingsCompactList } from "./findings-compact";
import { mergeLaunchFindings, type RunFindings } from "./launch-findings-model";

/** Readers only read: building and analysing stay with the fallback panel's controller. */
const READ_ONLY: BorrowedGenerationController = {
  pending: false,
  failedGeneration: false,
  error: null,
  unavailable: true,
  canRequest: false,
  requestInsight: () => undefined,
};

function RunFindingsReader({
  runId,
  iterationCount,
  onRead,
}: {
  runId: string;
  iterationCount: number;
  onRead: (runId: string, read: RunFindings | null) => void;
}) {
  const envelope = useInsightsEnvelope({ kind: "eval_run", suiteRunId: runId });
  const state = useUnifiedFindings({
    suiteRunId: runId,
    envelope,
    generation: READ_ONLY,
  });
  const read = findingsBuilt(state)
    ? { findings: state.findings, provenance: state.provenance, iterationCount }
    : null;
  // Publish a changed reading only, not a fresh array from this render.
  const fingerprint = JSON.stringify(read);
  useEffect(() => {
    onRead(runId, read);
  }, [runId, fingerprint, onRead]);
  return null;
}

export function LaunchFindings({
  runs,
  scope,
  onOpenIteration,
  fallback,
}: {
  runs: readonly { runId: string; iterations: readonly EvalIteration[] }[];
  scope: string;
  onOpenIteration?: (iteration: EvalIteration) => void;
  /** Today's panel for a run whose findings are not built yet. */
  fallback: (runId: string) => ReactNode;
}) {
  const [reads, setReads] = useState<ReadonlyMap<string, RunFindings | null>>(
    new Map(),
  );
  const record = useCallback((runId: string, read: RunFindings | null) => {
    setReads((previous) => new Map(previous).set(runId, read));
  }, []);
  const parts = runs.flatMap((run) => reads.get(run.runId) ?? []);
  const waiting = runs.find((run) => !reads.get(run.runId));
  const iterations = runs.flatMap((run) => run.iterations);
  const readers = runs.map((run) => (
    <ErrorBoundary
      key={run.runId}
      name="evaluate-launch-findings"
      fallback={null}
    >
      <RunFindingsReader
        runId={run.runId}
        iterationCount={run.iterations.length}
        onRead={record}
      />
    </ErrorBoundary>
  ));
  return (
    <>
      {readers}
      {waiting ? (
        fallback(waiting.runId)
      ) : (
        <FindingsCompactList
          findings={mergeLaunchFindings(parts)}
          scope={scope}
          heldIterationIds={new Set(iterations.map((item) => item._id))}
          {...(onOpenIteration
            ? {
                onOpenIteration: (iterationId: string) => {
                  const row = iterations.find(
                    (item) => item._id === iterationId,
                  );
                  if (row) onOpenIteration(row);
                },
              }
            : {})}
        />
      )}
    </>
  );
}
