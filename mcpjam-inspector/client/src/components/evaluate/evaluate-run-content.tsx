/**
 * The Evaluate run body: what broke, and what to do about it.
 *
 * This is the opt-in replacement for the run-detail pane inside
 * {@link EvaluateRunPage}. It is a separate component tree from
 * `RunDetailView` on purpose rather than a refactor of it — that view is
 * shared with `/evals`, the CI surfaces and the commit-detail page, and the
 * ordering this page needs (decision first, measurements last) is the opposite
 * of the one those surfaces ship today. Changing it in place would have moved
 * three other products to make one of them better.
 *
 * The read is the same read: `useEvalRunDecisionDetail` shares its LRU store
 * with the existing decision card, so mounting both surfaces costs one request,
 * not two, and they cannot disagree about a run.
 *
 * `fallbackBody` is the migration seam. Until the case rows land, the old
 * run-detail pane still renders beneath the verdict, so no information is
 * removed from the page in the commit that adds the headline.
 */
import { useMemo, type ReactNode } from "react";

import { useEvalRunDecisionDetail } from "@/hooks/use-eval-run-decision-summary";
import {
  evalRunDecisionRevision,
  isTerminalEvalRunStatus,
} from "@/lib/evals/eval-decision-summary-store";

import type { EvalIteration, EvalSuiteRun } from "../evals/types";
import { RunVerdictCaveats } from "./run-verdict-caveats";
import { RunVerdictHero } from "./run-verdict-hero";
import { buildRunVerdictHero } from "./run-verdict-hero-model";

export function EvaluateRunContent({
  projectId,
  run,
  iterations,
  decisionSummaryEnabled,
  onOpenIteration,
  fallbackBody,
}: {
  projectId: string | null | undefined;
  run: EvalSuiteRun;
  iterations: readonly EvalIteration[];
  decisionSummaryEnabled: boolean;
  /** Focus one iteration's evidence through the app's own routing. */
  onOpenIteration?: (target: {
    testCaseId: string;
    iterationId: string;
  }) => void;
  fallbackBody?: ReactNode;
}) {
  // Terminal only, matching `RunDecisionSummarySection`: a running row has no
  // decision to read, and asking anyway spends a request per poll to be told so.
  const active = decisionSummaryEnabled && isTerminalEvalRunStatus(run.status);

  const detail = useEvalRunDecisionDetail({
    projectId,
    runId: run._id,
    enabled: active,
    revision: evalRunDecisionRevision(run),
  });

  const view = useMemo(
    () =>
      buildRunVerdictHero({
        run,
        iterations,
        decision: {
          status: detail.status,
          summary: detail.summary,
          diagnostics: detail.diagnostics,
        },
      }),
    [run, iterations, detail.status, detail.summary, detail.diagnostics],
  );

  const focusTarget = view.focus?.diagnostic;
  const openFailingTrace =
    onOpenIteration && focusTarget?.testCaseId
      ? () =>
          onOpenIteration({
            testCaseId: focusTarget.testCaseId as string,
            iterationId: focusTarget.iterationId,
          })
      : undefined;

  return (
    <div
      className="flex min-h-0 flex-1 flex-col overflow-y-auto"
      data-testid="evaluate-run-content"
    >
      <RunVerdictHero
        view={view}
        {...(openFailingTrace ? { onOpenFailingTrace: openFailingTrace } : {})}
      />

      <div className="px-5 pb-4">
        <RunVerdictCaveats
          summary={detail.summary}
          shownDiagnostics={detail.diagnostics.length}
          scannedIterations={detail.scannedIterations}
          serverComplete={detail.serverComplete}
          walkExhausted={detail.walkExhausted}
        />
      </div>

      {fallbackBody ? (
        <div className="flex min-h-0 flex-1 flex-col border-t border-border/40">
          {fallbackBody}
        </div>
      ) : null}
    </div>
  );
}
