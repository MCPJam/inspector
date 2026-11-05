/**
 * The Test run and Iteration pages, mounted for their addresses while
 * `evaluate-nav-enabled` is on. With the flag off, Evaluate keeps rendering
 * today's run page and drawers for the same addresses (`eval-nav-pages.ts`).
 */
import { Loader2 } from "lucide-react";
import type { EvalRoute } from "@/lib/eval-route-types";
import { stripTimestampSuffix } from "../../evals/suite-overview-presentation";
import { useSelectedRun } from "../../evals/use-selected-run";
import type {
  EvalCase,
  EvalSuite,
  EvalSuiteRunListItem,
} from "../../evals/types";
import { IterationPage } from "./iteration-page";
import { TestRunPage } from "./test-run-page";

export type TestRunLayerRoute = Extract<
  EvalRoute,
  { type: "test-run" } | { type: "iteration" }
>;

export function isTestRunLayerRoute(
  route: EvalRoute,
): route is TestRunLayerRoute {
  return route.type === "test-run" || route.type === "iteration";
}

export function TestRunLayerLoading({
  label = "Loading…",
}: {
  label?: string;
}) {
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center gap-2 text-sm text-muted-foreground">
      <Loader2 className="size-4 animate-spin" aria-hidden />
      {label}
    </div>
  );
}

export function TestRunLayerPage({
  route,
  projectId,
  suite,
  cases,
  runs,
  hostNamesById,
}: {
  route: TestRunLayerRoute;
  projectId: string | null | undefined;
  suite: EvalSuite;
  /** `undefined` while the suite's cases load. */
  cases: readonly EvalCase[] | undefined;
  runs: readonly EvalSuiteRunListItem[];
  hostNamesById?: ReadonlyMap<string, string | null>;
}) {
  const { run, isLoading, isUnavailable } = useSelectedRun(
    route.suiteId,
    route.type === "test-run" ? route.runId : null,
  );

  if (route.type === "iteration") {
    return (
      <IterationPage
        key={route.iterationId}
        route={route}
        projectId={projectId}
        suiteName={stripTimestampSuffix(suite.name || "") || "Untitled suite"}
        runs={runs}
      />
    );
  }
  if (isLoading || cases === undefined) {
    return <TestRunLayerLoading label="Loading test run…" />;
  }
  if (isUnavailable || !run) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center text-sm">
        This run isn't available. It may have been deleted, or it belongs to
        another suite.
      </div>
    );
  }
  return (
    <TestRunPage
      key={`${route.runId}:${route.testCaseId}`}
      route={route}
      projectId={projectId}
      suite={suite}
      testCase={cases.find(({ _id }) => _id === route.testCaseId) ?? null}
      run={run}
      runs={runs}
      hostNamesById={hostNamesById}
    />
  );
}
