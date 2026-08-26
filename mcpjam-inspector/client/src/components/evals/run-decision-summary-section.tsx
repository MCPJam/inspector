/**
 * The run-detail decision summary, wired.
 *
 * One small container so `run-detail-view.tsx` stays a pure view: it takes a
 * slot, and this is what Evaluate puts in it. Kept out of the view itself
 * because `RunDetailView` is shared with `/evals` and the CI surfaces, and
 * this read is opt-in from the Evaluate route ONLY.
 */
import {
  evalRunDecisionRevision,
  isTerminalEvalRunStatus,
  type EvalDecisionSummaryStore,
} from "@/lib/evals/eval-decision-summary-store";
import { useEvalRunDecisionDetail } from "@/hooks/use-eval-run-decision-summary";
import { RunDecisionSummaryCard } from "./run-decision-summary-card";
import type { EvalSuiteRun } from "./types";

export function RunDecisionSummarySection({
  projectId,
  run,
  enabled,
  onViewTrace,
  store,
}: {
  projectId: string | null | undefined;
  run: EvalSuiteRun;
  enabled: boolean;
  /** Open one iteration's trace through the app's own run-detail routing. */
  onViewTrace?: (target: { runId: string; iterationId: string }) => void;
  store?: EvalDecisionSummaryStore;
}) {
  // Terminal only. A pending or running row has no decision to read, and
  // asking anyway spends a request per poll to be told so.
  const active = enabled && isTerminalEvalRunStatus(run.status);
  const detail = useEvalRunDecisionDetail({
    projectId,
    runId: run._id,
    enabled: active,
    revision: evalRunDecisionRevision(run),
    ...(store ? { store } : {}),
  });

  if (!active) return null;

  return (
    <RunDecisionSummaryCard
      status={detail.status}
      summary={detail.summary}
      error={detail.error}
      diagnostics={detail.diagnostics}
      scannedIterations={detail.scannedIterations}
      serverComplete={detail.serverComplete}
      walkExhausted={detail.walkExhausted}
      canLoadMore={detail.canLoadMore}
      isLoadingMore={detail.isLoadingMore}
      pageError={detail.pageError}
      onLoadMore={detail.loadMore}
      onRetryFailedPage={detail.retryFailedPage}
      {...(onViewTrace ? { onViewTrace } : {})}
    />
  );
}
