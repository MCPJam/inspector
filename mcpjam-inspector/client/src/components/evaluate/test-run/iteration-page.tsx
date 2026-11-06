/**
 * Iteration: one attempt of one case on one model, at its own address. The
 * run report's iteration drawer as a page: its header copies the case run
 * sheet's, and its body is the same IterationDetails, filling the height.
 */
import { useMemo, type ReactNode } from "react";
import { useQueries } from "convex/react";
import { makeFunctionReference } from "convex/server";
import { cn } from "@mcpjam/design-system/cn";
import { Skeleton } from "@mcpjam/design-system/skeleton";
import type { EvalRoute } from "@/lib/eval-route-types";
import { runIterationTargetKey } from "@/lib/eval-target-key";
import { EvalCrumbBar } from "@/components/evaluate/evals-header";
import type { EvalIteration, EvalSuiteRun } from "../../evals/types";
import { formatRunId } from "../../evals/helpers";
import { age } from "../case-workspace/case-run-timeline";
import { computeIterationResult } from "../../evals/pass-criteria";
import { stripTimestampSuffix } from "../../evals/suite-overview-presentation";
import { useSelectedRun } from "../../evals/use-selected-run";
import { matrixCaseKey } from "../run-results-matrix-model";
import type { EvalNavPageProps } from "../nav/eval-nav-pages";
import { buildEvalBack, buildEvalCrumbs } from "../nav/eval-nav-crumbs";
import { useEvalNavArrival } from "../nav/eval-nav-state";
import { useEvalNavPageView } from "../nav/eval-nav-analytics";
import { IterationEvidence } from "./iteration-evidence";
import { useTestRunData } from "./use-test-run-data";
import { useTestRunDecisions } from "./use-test-run-decisions";

type IterationRoute = Extract<EvalRoute, { type: "iteration" }>;

const iterationQuery = makeFunctionReference<
  "query",
  { iterationId: string },
  EvalIteration | null
>("testSuites:getTestIteration");

export type IterationVerdict =
  "Passed" | "Failed" | "Timeout" | "Running" | "Pending" | "Cancelled";

export function iterationVerdict(iteration: EvalIteration): IterationVerdict {
  const result = computeIterationResult(iteration);
  if (result === "passed") return "Passed";
  if (result === "failed") return "Failed";
  if (result === "timed_out") return "Timeout";
  if (result === "cancelled") return "Cancelled";
  return iteration.status === "pending" ? "Pending" : "Running";
}

const CHIP_TONE: Record<IterationVerdict, string> = {
  Passed: "bg-success/15 text-success",
  Failed: "bg-destructive/15 text-destructive",
  Timeout: "bg-destructive/15 text-destructive",
  Running: "bg-warning/30 text-foreground",
  Pending: "bg-warning/30 text-foreground",
  Cancelled: "bg-muted text-muted-foreground",
};

/** The page's card: header, then the evidence filling the rest. Presentational. */
export function IterationCard({
  title,
  verdict,
  description,
  children,
}: {
  title: string;
  verdict: IterationVerdict;
  description: string;
  children: ReactNode;
}) {
  return (
    <div
      className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-border bg-card"
      data-testid="nav-iteration-page"
    >
      <div className="flex shrink-0 flex-col gap-1.5 border-b border-border p-4">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-sm font-semibold text-foreground">{title}</h2>
          <span
            className={cn(
              "inline-flex shrink-0 rounded px-2 py-1 text-[10px] font-semibold uppercase leading-3 tracking-wide",
              CHIP_TONE[verdict],
            )}
          >
            {verdict}
          </span>
        </div>
        <p className="text-sm text-muted-foreground">{description}</p>
      </div>
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto p-4">
        {children}
      </div>
    </div>
  );
}

/** Same frame for every state, under the crumb bar. */
function IterationFrame({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden px-4 pb-6 pt-6 sm:px-6">
      {children}
    </div>
  );
}

export function IterationPage({ route, projectId }: EvalNavPageProps) {
  if (route.type !== "iteration") return null;
  return <IterationPageBody route={route} projectId={projectId} />;
}

/** 1-based position among the same target's iterations of this case, by creation time. */
function positionOf(
  iteration: EvalIteration,
  run: EvalSuiteRun,
  iterations: readonly EvalIteration[],
): number {
  const target = runIterationTargetKey(run, iteration);
  const peers = iterations
    .filter(
      (item) =>
        item.suiteRunId === iteration.suiteRunId &&
        runIterationTargetKey(run, item) === target,
    )
    .sort((a, b) => a.createdAt - b.createdAt);
  return peers.findIndex((item) => item._id === iteration._id) + 1;
}

function IterationPageBody({
  route,
  projectId,
}: {
  route: IterationRoute;
  projectId: string | null;
}) {
  const { suiteId, runId, testCaseId, iterationId } = route;
  const ids = useMemo(
    () => ({ suiteId, runId, testCaseId }),
    [suiteId, runId, testCaseId],
  );
  const testRun = useTestRunData(ids);
  const answer = useQueries(
    useMemo(
      () => ({ iteration: { query: iterationQuery, args: { iterationId } } }),
      [iterationId],
    ),
  ).iteration as EvalIteration | null | Error | undefined;
  const found = answer instanceof Error ? null : answer;
  const ownRun = useSelectedRun(suiteId, found?.suiteRunId ?? null);
  const run =
    testRun.launchRuns.find((item) => item._id === found?.suiteRunId) ??
    ownRun.run;
  const runs = useMemo(() => (run ? [run] : []), [run]);
  const iterationList = useMemo(() => (found ? [found] : []), [found]);
  const decisions = useTestRunDecisions(projectId, runs, iterationList);
  useEvalNavPageView(route, { projectId, ui: "nav", enabled: true });

  const notFound =
    found === null ||
    (found !== undefined && matrixCaseKey(found) !== testCaseId) ||
    (found !== undefined && ownRun.isUnavailable && !run);
  const iteration = notFound ? null : found;
  const iterationNumber =
    iteration && run
      ? iteration.iterationNumber ||
        positionOf(iteration, run, testRun.iterations)
      : undefined;
  const names = {
    suiteName: testRun.suite
      ? stripTimestampSuffix(testRun.suite.name)
      : undefined,
    runNumber: testRun.run?.runNumber,
    testCaseTitle: testRun.status === "loading" ? undefined : testRun.title,
    iterationNumber,
  };
  const crumbs = buildEvalCrumbs(route, names) ?? [];
  const back = buildEvalBack(route, names, useEvalNavArrival().from);

  let body: ReactNode;
  if (notFound) {
    body = (
      <p className="text-sm text-muted-foreground">
        This iteration is not part of this test run. Check the link, or go back
        to the test run.
      </p>
    );
  } else if (!iteration || !run) {
    body = (
      <Skeleton
        className="min-h-0 flex-1 rounded-xl"
        data-testid="nav-iteration-loading"
      />
    );
  } else {
    const singleCase = (run.configSnapshot?.tests ?? []).length === 1;
    const title = singleCase
      ? testRun.title || "Untitled test case"
      : stripTimestampSuffix(testRun.suite?.name ?? run.name ?? "Run");
    const decision = decisions.byRun.get(run._id);
    body = (
      <IterationCard
        title={`#${run.runNumber} ${title}`}
        verdict={iterationVerdict(iteration)}
        description={`Run ${formatRunId(run._id)} · ${
          iteration.testCaseSnapshot?.model || "Unknown model"
        } · ${age(iteration.createdAt)}`}
      >
        <IterationEvidence
          iteration={iteration}
          run={run}
          diagnostic={decision?.diagnostics.find(
            (item) => item.iterationId === iteration._id,
          )}
          chain={decision?.chains.get(iteration._id)}
        />
      </IterationCard>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <EvalCrumbBar crumbs={crumbs} back={back} />
      <IterationFrame>{body}</IterationFrame>
      {decisions.readers}
    </div>
  );
}
