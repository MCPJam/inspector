import { useEffect, useMemo } from "react";
import { isEvalRunTerminalStatus } from "@mcpjam/sdk/contract";
import { navigateApp, useCurrentLocationState } from "@/lib/app-navigation";
import type { RunResultPageRoute } from "@/lib/eval-route-types";
import { evalRunDecisionRevision } from "@/lib/evals/eval-decision-summary-store";
import { useEvalRunDecisionDetail } from "@/hooks/use-eval-run-decision-summary";
import { useEvalRunIterationChains } from "@/hooks/use-eval-run-iteration-chains";
import { useRunResultPagesEnabled } from "@/hooks/use-run-result-pages-enabled";
import type {
  EvalIteration,
  EvalSuiteRun,
  EvalSuiteRunListItem,
} from "../../evals/types";
import { buildRunResultsMatrix, launchRuns } from "../run-results-matrix-model";
import { trialChainDisplay } from "../case-scorecard/trial-chain-state";
import { IterationResultsPage } from "./iteration-results-page";
import { ResultNotFound, ResultPageSkeleton } from "./result-page-parts";
import {
  BACK_TO_GRID_STATE,
  findTarget,
  openResult,
  targetParam,
  viaFromState,
  type MatrixTarget,
} from "./result-page-links";
import { IterationPager } from "./iteration-pager";
import { pagerPosition } from "./iteration-pager-model";
import { resultLinkRewrite } from "./result-link-rewrite";
import {
  trackCaseResultViewed,
  trackIterationViewed,
  trackRunViewed,
} from "./run-view-events";
import { TestCaseResultsPage } from "./test-case-results-page";

export type RunResultCrumbs = {
  crumbs: { label: string; onClick?: () => void }[];
  onOpenRun: () => void;
};

/** Resolves across the launch; loads the decision chain the unmounted grid would. */
export function RunResultPage({
  suiteId,
  runId,
  resultPage,
  fromOldLink = false,
  run,
  runs,
  allIterations,
  hostNamesById,
  loading,
  failedRunIds,
  projectId,
  decisionSummaryEnabled,
  onEditCase,
  onCrumbsChange,
}: {
  suiteId: string;
  runId: string;
  resultPage: RunResultPageRoute;
  /** A legacy `?case=&iteration=` link, replaced with its page. */
  fromOldLink?: boolean;
  run: EvalSuiteRun | null;
  runs: readonly EvalSuiteRunListItem[];
  allIterations: readonly EvalIteration[];
  hostNamesById: ReadonlyMap<string, string | null>;
  loading: boolean;
  /** Runs whose results failed to load; one in this launch makes "no result" unknown. */
  failedRunIds?: ReadonlySet<string>;
  projectId: string | null | undefined;
  decisionSummaryEnabled: boolean;
  onEditCase?: (testCaseId: string) => void;
  onCrumbsChange?: (crumbs: RunResultCrumbs | null) => void;
}) {
  const enabled = useRunResultPagesEnabled();
  const { caseKey, iterationId } = resultPage;
  const runRef = useMemo(() => ({ suiteId, runId }), [suiteId, runId]);
  const surface = iterationId ? "iteration_page" : "case_page";

  const rewrite = resultLinkRewrite({
    enabled,
    run: runRef,
    resultPage,
    fromOldLink,
    loading,
    iterations: allIterations,
  });
  useEffect(() => {
    if (rewrite) navigateApp(rewrite, { replace: true });
  }, [rewrite]);

  const matrix = useMemo(
    () =>
      run
        ? buildRunResultsMatrix<EvalSuiteRunListItem>({
            run,
            runs,
            iterations: allIterations,
            hostNamesById,
          })
        : null,
    [run, runs, allIterations, hostNamesById],
  );
  const row = matrix?.rows.find((item) => item.key === caseKey);
  const { target, iteration } =
    matrix && row ? resolveResult(matrix.targets, resultPage, runId) : {};

  // The scorecard's decision chain, read for the iteration's own run.
  const iterationRun = iteration ? target?.run : undefined;
  const active =
    enabled === true &&
    Boolean(projectId && iterationRun) &&
    decisionSummaryEnabled &&
    isEvalRunTerminalStatus(iterationRun?.status);
  const detail = useEvalRunDecisionDetail({
    projectId,
    runId: iterationRun?._id,
    enabled: active,
    revision: iterationRun ? evalRunDecisionRevision(iterationRun) : undefined,
  });
  const chains = useEvalRunIterationChains({
    projectId,
    run: iterationRun,
    enabled: active,
  });

  const locationState = useCurrentLocationState();
  const via = viaFromState(locationState);
  const shown = enabled === true && !rewrite && !(fromOldLink && loading);
  useEffect(() => {
    if (shown) trackRunViewed(runRef, surface);
  }, [shown, runRef, surface]);
  // A view names the page's run, not its column's, so it joins this visit.
  const viewedColumnRunId = target?.run._id;
  const viewedIterationId = iteration?._id;
  useEffect(() => {
    if (!shown || !viewedColumnRunId) return;
    if (!viewedIterationId)
      trackCaseResultViewed(runRef, viewedColumnRunId, "page");
    else trackIterationViewed(runRef, viewedColumnRunId, "page", via);
  }, [shown, runRef, viewedColumnRunId, caseKey, viewedIterationId, via]);

  const caseTitle = row?.title;
  const iterationNumber = iteration
    ? (iteration.iterationNumber ??
      (target?.cells.get(caseKey) ?? []).indexOf(iteration) + 1)
    : null;
  // The case crumb returns to the column this iteration ran on.
  const caseColumn =
    target && (matrix?.targets.length ?? 0) > 1
      ? targetParam(target)
      : undefined;
  useEffect(() => {
    if (!onCrumbsChange || !shown || !caseTitle) return;
    onCrumbsChange({
      crumbs:
        iterationNumber === null
          ? [{ label: caseTitle }]
          : [
              {
                label: caseTitle,
                onClick: () =>
                  openResult(runRef, { caseKey, target: caseColumn }),
              },
              { label: `Iteration #${iterationNumber}` },
            ],
      onOpenRun: () =>
        openResult(runRef, undefined, { state: BACK_TO_GRID_STATE }),
    });
    return () => onCrumbsChange(null);
  }, [
    onCrumbsChange,
    shown,
    runRef,
    caseKey,
    caseColumn,
    caseTitle,
    iterationNumber,
  ]);

  if (!shown || loading) {
    return <ResultPageSkeleton rows={iterationId ? 4 : 3} />;
  }
  const runNumber =
    run?.runNumber ?? runs.find((item) => item._id === runId)?.runNumber;
  const testCaseId = row?.testCaseId;
  const editCase =
    onEditCase && testCaseId ? () => onEditCase(testCaseId) : undefined;
  const pager =
    matrix && target && iteration
      ? pagerPosition(matrix, target.key, caseKey, iteration._id)
      : null;
  // Another run can supply the row while this column's own results failed to load.
  const columnReadFailed = Boolean(
    target &&
    !iteration &&
    failedRunIds?.has(target.run._id) &&
    !target.cells.get(caseKey)?.length,
  );
  return (
    <section
      className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-background"
      data-testid="run-result-page"
    >
      {!row || !target || (iterationId && !iteration) || columnReadFailed ? (
        <ResultNotFound
          runLabel={runNumber == null ? "This run" : `Run #${runNumber}`}
          onOpenRun={() => openResult(runRef)}
          readFailed={
            columnReadFailed ||
            (run !== null &&
              launchRuns<EvalSuiteRunListItem>(run, runs).some((item) =>
                failedRunIds?.has(item._id),
              ))
          }
        />
      ) : iteration && iterationNumber !== null ? (
        <IterationResultsPage
          key={iteration._id}
          iteration={iteration}
          iterationNumber={iterationNumber}
          target={target}
          diagnostic={detail.diagnostics.find(
            (item) => item.iterationId === iteration._id,
          )}
          chain={chains.chains.get(iteration._id)}
          chainDisplay={trialChainDisplay({
            trialRunId: iteration.suiteRunId,
            hasChain: chains.chains.has(iteration._id),
            readRunId: iterationRun?._id,
            readRun: iterationRun,
            readRunLoading: false,
            isTerminalRunStatus: isEvalRunTerminalStatus,
            chains,
          })}
          onRetryChain={chains.retry}
          onEditCase={editCase}
          pager={
            pager && (
              <IterationPager
                run={runRef}
                position={pager}
                tab={resultPage.tab}
              />
            )
          }
          tab={resultPage.tab}
          onTabChange={(tab) =>
            // Keeps the history state, so the view is not counted again.
            openResult(
              runRef,
              { ...resultPage, tab },
              {
                replace: true,
                state: locationState,
              },
            )
          }
        />
      ) : (
        <TestCaseResultsPage
          run={runRef}
          caseKey={row.key}
          title={row.title}
          target={target}
          targets={matrix?.targets ?? []}
          onEditCase={editCase}
        />
      )}
    </section>
  );
}

/**
 * An iteration finds its column; a case uses `?target`, else the route run's
 * own column with results, so a link without one opens the run it names.
 */
function resolveResult(
  targets: readonly MatrixTarget[],
  { caseKey, iterationId, target }: RunResultPageRoute,
  runId: string,
): { target?: MatrixTarget; iteration?: EvalIteration } {
  if (iterationId) {
    for (const column of targets) {
      const hit = column.cells
        .get(caseKey)
        ?.find((item) => item._id === iterationId);
      if (hit) return { target: column, iteration: hit };
    }
    return {};
  }
  if (target) return { target: findTarget(targets, target) };
  const hasResults = (column: MatrixTarget) =>
    Boolean(column.cells.get(caseKey)?.length);
  const own = targets.filter((column) => column.run._id === runId);
  return {
    target:
      own.find(hasResults) ??
      targets.find(hasResults) ??
      own[0] ??
      targets[0],
  };
}
