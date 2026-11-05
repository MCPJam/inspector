/**
 * The new page for each route kind, mounted while `evaluate-nav-enabled` is
 * on. `eval-nav-pages.ts` names each address's page and the route today's
 * screen renders for it; a page lands here so `EvaluateTab` mounts it without
 * knowing which page it is.
 */
import type { ReactNode } from "react";
import type { EvalRoute } from "@/lib/eval-route-types";
import type { RemoteServer } from "@/hooks/useProjects";
import { isCiOwnedSuite } from "@/lib/evals/is-ci-owned-suite";
import type { EvalCase, EvalSuite } from "../../evals/types";
import type { useEvalQueries } from "../../evals/use-eval-queries";
import {
  CaseStepsNavPage,
  type CaseStepsRoute,
} from "../case-steps/case-steps-nav-page";
import {
  TestRunLayerLoading,
  TestRunLayerPage,
  type TestRunLayerRoute,
} from "../test-run/test-run-layer-page";
import { useSettledEvaluateNavFlag } from "./use-settled-evaluate-nav-flag";

type CaseRunOptions = { location: string; suppressCompletionToasts: boolean };

/** What Evaluate holds for the open suite, for the page to render with. */
export type EvalNavPageContext = {
  projectId: string | null | undefined;
  queries: Pick<
    ReturnType<typeof useEvalQueries>,
    | "selectedSuite"
    | "suiteDetails"
    | "isSuiteDetailsLoading"
    | "runsForSelectedSuite"
  >;
  projectServers?: RemoteServer[];
  runCase: (
    suite: EvalSuite,
    testCase: EvalCase,
    options: CaseRunOptions,
  ) => Promise<{ iteration?: { suiteRunId?: string | null } } | null>;
  deleteCases: (testCaseIds: string[]) => Promise<unknown>;
};

type EvalNavPageMount<R extends EvalRoute> = {
  /** Show a spinner, not today's page, while the flag loads (plan E10). */
  waitsForFlag?: boolean;
  /** Null hands the address back to today's page. */
  render: (
    route: R,
    context: EvalNavPageContext,
    suite: EvalSuite,
  ) => ReactNode;
};

const testRunLayer: EvalNavPageMount<TestRunLayerRoute> = {
  waitsForFlag: true,
  render: (route, { projectId, queries }, suite) => (
    <TestRunLayerPage
      route={route}
      projectId={projectId}
      suite={suite}
      cases={queries.suiteDetails?.testCases}
      runs={queries.runsForSelectedSuite}
    />
  ),
};

const casePage: EvalNavPageMount<CaseStepsRoute> = {
  // Today's suite spinner shows until the cases load.
  render: (route, context, suite) =>
    context.queries.isSuiteDetailsLoading ? null : (
      <CaseStepsNavPage
        route={route}
        suite={suite}
        cases={context.queries.suiteDetails?.testCases ?? []}
        projectId={context.projectId}
        projectServers={context.projectServers}
        readOnly={isCiOwnedSuite(suite)}
        onRunCase={(testCase, options) =>
          context.runCase(suite, testCase, options)
        }
        onDeleteCase={(id) => context.deleteCases([id])}
      />
    ),
};

/**
 * Route kinds whose new page Evaluate mounts here. The landing, Suite, Suite
 * run and Suite settings pages render inside today's screens for their
 * routes instead, each reading the flag itself.
 */
const EVAL_NAV_PAGE_MOUNTS: {
  [K in EvalRoute["type"]]?: EvalNavPageMount<Extract<EvalRoute, { type: K }>>;
} = {
  "test-run": testRunLayer,
  iteration: testRunLayer,
  "case-settings": casePage,
  "case-new": casePage,
  "case-evaluators": casePage,
  "test-run-edit": casePage,
};

function mountFor(route: EvalRoute): EvalNavPageMount<EvalRoute> | undefined {
  return EVAL_NAV_PAGE_MOUNTS[route.type] as
    | EvalNavPageMount<EvalRoute>
    | undefined;
}

/**
 * The new page for the address, or null to render today's screen: with the
 * flag off, without a suite, or for a route kind that has no page here.
 */
export function useEvalNavPageMount(
  route: EvalRoute,
  context: EvalNavPageContext,
): ReactNode {
  const flag = useSettledEvaluateNavFlag();
  const mount = mountFor(route);
  const suite = context.queries.selectedSuite;
  if (!mount || flag === false || !suite) return null;
  if (flag === undefined) {
    return mount.waitsForFlag ? <TestRunLayerLoading /> : null;
  }
  return mount.render(route, context, suite);
}
