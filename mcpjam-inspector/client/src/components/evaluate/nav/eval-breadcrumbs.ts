import type { EvalRoute, SuiteSettingsRouteTab } from "@/lib/eval-route-types";
import { isDraftTestCaseId } from "../../evals/draft-test-case";
import type { EvalsHeaderParentCrumb } from "../evals-header";

/** One step of the trail. The current page is the last crumb and has no `to`. */
export type EvalCrumb = { label: string; to?: EvalRoute };

/** Display names the route only holds as ids. Missing names get a generic label. */
export type EvalCrumbNames = {
  suite?: string | null;
  runNumber?: number | null;
  testCase?: string | null;
  iterationNumber?: number | null;
  server?: string | null;
};

/**
 * The breadcrumb trail for a route, one crumb per level, from the route
 * alone: the same address always shows the same trail, however you got there.
 */
export function buildEvalBreadcrumbs(
  route: EvalRoute,
  names: EvalCrumbNames = {},
): EvalCrumb[] {
  const trail = [EVALUATE_CRUMB, ...levelsBelowEvaluate(route, names)];
  return trail.map((crumb, index) =>
    index === trail.length - 1 ? { label: crumb.label } : crumb,
  );
}

const EVALUATE_CRUMB: EvalCrumb = { label: "Evaluate", to: { type: "list" } };

function levelsBelowEvaluate(
  route: EvalRoute,
  names: EvalCrumbNames,
): EvalCrumb[] {
  const suite = (suiteId: string): EvalCrumb => ({
    label: names.suite || "Suite",
    to: { type: "suite-overview", suiteId },
  });
  const settings = (
    suiteId: string,
    tab: SuiteSettingsRouteTab,
  ): EvalCrumb[] => [
    suite(suiteId),
    { label: "Suite settings", to: { type: "suite-settings", suiteId, tab } },
  ];
  const caseLabel = (testCaseId: string) =>
    names.testCase ||
    (isDraftTestCaseId(testCaseId) ? "New case" : "Test case");
  const settingsCase = (suiteId: string, testCaseId: string): EvalCrumb[] => [
    ...settings(suiteId, "cases"),
    {
      label: caseLabel(testCaseId),
      to: { type: "case-settings", suiteId, testCaseId },
    },
  ];
  const caseEvaluators = (suiteId: string, testCaseId: string): EvalCrumb[] => [
    ...settingsCase(suiteId, testCaseId),
    { label: "Test Case Evaluators" },
  ];
  const run = (suiteId: string, runId: string): EvalCrumb[] => [
    suite(suiteId),
    {
      label: names.runNumber != null ? `Run #${names.runNumber}` : "Run",
      to: { type: "run-detail", suiteId, runId },
    },
  ];
  const testRun = (
    suiteId: string,
    runId: string,
    testCaseId: string,
  ): EvalCrumb[] => [
    ...run(suiteId, runId),
    {
      label: caseLabel(testCaseId),
      to: { type: "test-run", suiteId, runId, testCaseId },
    },
  ];

  switch (route.type) {
    case "list":
    case "create":
    case "evaluate-runs":
      return [];
    case "eval-server":
      return [{ label: names.server || "Connected server", to: route }];
    case "commit-detail":
      return [{ label: route.commitSha.slice(0, 7) }];
    case "suite-overview":
      return [suite(route.suiteId)];
    case "suite-edit":
      return settings(route.suiteId, "settings");
    case "suite-settings":
      return settings(route.suiteId, route.tab);
    case "case-new":
      return [...settings(route.suiteId, "cases"), { label: "New case" }];
    case "case-settings":
      return settingsCase(route.suiteId, route.testCaseId);
    case "case-evaluators":
      return caseEvaluators(route.suiteId, route.testCaseId);
    case "test-detail":
      return settingsCase(route.suiteId, route.testId);
    case "test-edit":
      if (route.fromEvalServer) {
        return [
          {
            label: names.server || "Connected server",
            to: { type: "eval-server", serverId: route.fromEvalServer },
          },
          { label: caseLabel(route.testId) },
        ];
      }
      return route.checks
        ? caseEvaluators(route.suiteId, route.testId)
        : settingsCase(route.suiteId, route.testId);
    case "run-detail":
      return route.testCaseId
        ? testRun(route.suiteId, route.runId, route.testCaseId)
        : run(route.suiteId, route.runId);
    case "test-run":
      return testRun(route.suiteId, route.runId, route.testCaseId);
    case "iteration":
      return [
        ...testRun(route.suiteId, route.runId, route.testCaseId),
        {
          label:
            names.iterationNumber != null
              ? `Iteration #${names.iterationNumber}`
              : "Iteration",
        },
      ];
    case "test-run-edit":
      return [
        ...testRun(route.suiteId, route.runId, route.testCaseId),
        { label: "Edit Test Case" },
      ];
  }
}

/** The test case a route names, wherever in the flow it sits. */
export function evalRouteTestCaseId(route: EvalRoute): string | null {
  switch (route.type) {
    case "case-settings":
    case "case-evaluators":
    case "test-run":
    case "iteration":
    case "test-run-edit":
      return route.testCaseId;
    case "run-detail":
      return route.testCaseId ?? null;
    case "test-edit":
    case "test-detail":
      return route.testId;
    default:
      return null;
  }
}

export type EvalsHeaderTrailProps = {
  isDetail: boolean;
  parentCrumb?: EvalsHeaderParentCrumb;
  children?: string;
  onCurrentCrumbClick?: () => void;
  detailCrumb?: { label: string; onClick?: () => void }[];
};

/**
 * Lays a trail onto `EvalsHeader`'s slots: Evaluate is its own button, then
 * parent, middle crumb, and the rest in order.
 */
export function evalsHeaderTrailProps(
  crumbs: readonly EvalCrumb[],
  navigate: (route: EvalRoute) => void,
): EvalsHeaderTrailProps {
  const onClickFor = (crumb: EvalCrumb) => {
    const to = crumb.to;
    return to ? () => navigate(to) : undefined;
  };
  const [first, second, ...rest] = crumbs.slice(1);
  if (!first) return { isDetail: false };
  if (!second) return { isDetail: true, children: first.label };
  const parentTo = first.to ?? { type: "list" };
  return {
    isDetail: true,
    parentCrumb: { label: first.label, onClick: () => navigate(parentTo) },
    children: second.label,
    onCurrentCrumbClick: onClickFor(second),
    detailCrumb: rest.map((crumb) => ({
      label: crumb.label,
      onClick: onClickFor(crumb),
    })),
  };
}
