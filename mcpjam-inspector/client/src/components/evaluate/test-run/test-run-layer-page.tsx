/**
 * The Test run and Iteration pages, mounted for their addresses while
 * `evaluate-nav-enabled` is on. With the flag off, Evaluate keeps rendering
 * today's run page and drawers for the same addresses (`eval-nav-pages.ts`).
 */
import { useEffect, useState } from "react";
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
import { useEvaluateNavEnabled } from "../nav/use-evaluate-nav-enabled";

/** How long a test-run or iteration address waits for PostHog before reading the flag as off (as 2F's redirects do). */
export const NAV_FLAG_WAIT_MS = 2000;

/**
 * `evaluate-nav-enabled`, settled: `undefined` while PostHog loads, `false`
 * once it has not answered within {@link NAV_FLAG_WAIT_MS}. The page waits
 * on `undefined` so the old screen never flashes before the new one (plan E10).
 */
export function useSettledEvaluateNavFlag(): boolean | undefined {
  const enabled = useEvaluateNavEnabled();
  const [expired, setExpired] = useState(false);
  useEffect(() => {
    if (enabled !== undefined) return;
    const timer = setTimeout(() => setExpired(true), NAV_FLAG_WAIT_MS);
    return () => clearTimeout(timer);
  }, [enabled]);
  return enabled ?? (expired ? false : undefined);
}

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
