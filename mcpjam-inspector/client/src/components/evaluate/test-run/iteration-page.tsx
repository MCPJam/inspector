/**
 * Iteration: one iteration of a test run, as a page (spec C12). The same
 * evidence the drawer showed, at full height, with Back to test run.
 */
import { Loader2 } from "lucide-react";
import { useQuery } from "convex/react";
import { makeFunctionReference } from "convex/server";
import { useEvalRunDecisionDetail } from "@/hooks/use-eval-run-decision-summary";
import { useEvalRunIterationChains } from "@/hooks/use-eval-run-iteration-chains";
import {
  evalRunDecisionRevision,
  isTerminalEvalRunStatus,
} from "@/lib/evals/eval-decision-summary-store";
import type { EvalRoute } from "@/lib/eval-route-types";
import { runIterationTargetKey } from "@/lib/eval-target-key";
import { formatRelativeTime, formatRunId } from "../../evals/helpers";
import { useSelectedRun } from "../../evals/use-selected-run";
import type { EvalIteration, EvalSuiteRunListItem } from "../../evals/types";
import { navigatePlaygroundEvalsRoute } from "../create-suite-navigation";
import { launchRuns } from "../run-results-matrix-model";
import { EvalHeaderActions, EvalHeaderBack } from "../nav/eval-header-actions";
import { useEvalNavPageViewed } from "../nav/eval-nav-link";
import { IterationOutcomeBadge, IterationReport } from "./iteration-report";

type IterationRoute = Extract<EvalRoute, { type: "iteration" }>;

const iterationQuery = makeFunctionReference<
  "query",
  { iterationId: string },
  EvalIteration | null
>("testSuites:getTestIteration");

/** The iteration an Iteration address names; `undefined` while it loads. */
export function useRouteIteration(
  iterationId: string | null,
): EvalIteration | null | undefined {
  return useQuery(iterationQuery, iterationId ? { iterationId } : "skip");
}

/** The number the Iteration crumb shows ("Iteration #2"), once it has loaded. */
export function useIterationCrumbNumber(route: EvalRoute, enabled: boolean) {
  const iteration = useRouteIteration(
    enabled && route.type === "iteration" ? route.iterationId : null,
  );
  return iteration?.iterationNumber ?? null;
}

export function IterationPage({
  route,
  projectId,
  suiteName,
  runs,
}: {
  route: IterationRoute;
  projectId: string | null | undefined;
  suiteName: string;
  runs: readonly EvalSuiteRunListItem[];
}) {
  const { suiteId, runId, testCaseId, iterationId } = route;
  useEvalNavPageViewed("iteration", true);
  const iteration = useRouteIteration(iterationId);
  const iterationRunId = iteration?.suiteRunId ?? runId;
  const { run, isLoading: runLoading } = useSelectedRun(
    suiteId,
    iteration ? iterationRunId : null,
  );
  const active =
    Boolean(projectId && run) && isTerminalEvalRunStatus(run?.status);
  const detail = useEvalRunDecisionDetail({
    projectId,
    runId: iterationRunId,
    enabled: active,
    revision: run ? evalRunDecisionRevision(run) : "",
  });
  const chains = useEvalRunIterationChains({ projectId, run, enabled: active });

  const target =
    run && iteration ? runIterationTargetKey(run, iteration) : undefined;
  const severalTargets = run ? launchRuns<EvalSuiteRunListItem>(run, runs).length > 1 : false;
  const backToTestRun = () =>
    navigatePlaygroundEvalsRoute({
      type: "test-run",
      suiteId,
      runId,
      testCaseId,
      ...(severalTargets && target ? { target } : {}),
    });

  const backButton = (
    <EvalHeaderActions>
      <EvalHeaderBack label="Back to test run" onClick={backToTestRun} />
    </EvalHeaderActions>
  );

  if (iteration === undefined || (iteration && runLoading)) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" aria-hidden />
        Loading iteration…
      </div>
    );
  }
  if (!iteration || !run || iteration.testCaseId !== testCaseId) {
    return (
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 text-sm">
        <p>This iteration isn't part of this test run, or it was deleted.</p>
        {backButton}
      </div>
    );
  }

  const model =
    iteration.testCaseSnapshot?.provider && iteration.testCaseSnapshot.model
      ? `${iteration.testCaseSnapshot.provider}/${iteration.testCaseSnapshot.model}`
      : (target ?? "Client default");
  const number = iteration.iterationNumber;

  return (
    <div
      className="flex min-h-0 flex-1 flex-col gap-4 px-6 py-6"
      data-testid="iteration-page"
    >
      {backButton}
      <section className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-border bg-card">
        <header className="border-b border-border px-6 py-4">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-lg font-semibold">
              {number != null ? `#${number} ` : ""}
              {suiteName}
            </h2>
            <IterationOutcomeBadge iteration={iteration} />
          </div>
          <p className="text-[13px] text-muted-foreground">
            Run {formatRunId(run._id)} · {model} ·{" "}
            {formatRelativeTime(
              iteration.createdAt ?? iteration.startedAt ?? iteration.updatedAt,
            )}
          </p>
        </header>
        <div className="flex min-h-0 flex-1 flex-col px-6 py-4">
          <IterationReport
            iteration={iteration}
            run={run}
            diagnostic={detail.diagnostics.find(
              (item) => item.iterationId === iteration._id,
            )}
            chain={chains.chains.get(iteration._id)}
            onEditEvaluator={() =>
              navigatePlaygroundEvalsRoute({
                type: "case-evaluators",
                suiteId,
                testCaseId,
              })
            }
          />
        </div>
      </section>
    </div>
  );
}
