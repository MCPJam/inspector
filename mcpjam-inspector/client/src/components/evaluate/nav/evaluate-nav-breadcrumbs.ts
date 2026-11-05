import type { EvalRoute } from "@/lib/eval-route-types";

/** What a crumb stands for; stable across label changes and loading. */
export type EvaluateNavCrumbKind =
  | "evaluate"
  | "create-suite"
  | "server"
  | "suite"
  | "suite-settings"
  | "case"
  | "case-new"
  | "case-evaluators"
  | "suite-run"
  | "test-run"
  | "test-run-edit"
  | "iteration";

export interface EvaluateNavCrumb {
  kind: EvaluateNavCrumbKind;
  label: string;
  /** Where the crumb leads. The last crumb is the current page. */
  route: EvalRoute;
}

/** Display names the page has loaded; any of them may still be missing. */
export interface EvaluateNavCrumbNames {
  suiteName?: string;
  caseName?: string;
  serverName?: string;
  runNumber?: number;
  iterationNumber?: number;
}

/**
 * The breadcrumb for a route, built from the route alone (E2): the same
 * address always shows the same trail, however the user got there. Back
 * uses router state instead, so arrival never leaks into the trail.
 */
export function buildEvaluateNavCrumbs(
  route: EvalRoute,
  names: EvaluateNavCrumbNames = {},
): EvaluateNavCrumb[] {
  const evaluate: EvaluateNavCrumb = {
    kind: "evaluate",
    label: "Evaluate",
    route: { type: "list" },
  };
  switch (route.type) {
    case "list":
    case "evaluate-runs":
    case "commit-detail":
      return [evaluate];
    case "create":
      return [evaluate, { kind: "create-suite", label: "Create suite", route }];
    case "eval-server":
      return [
        evaluate,
        {
          kind: "server",
          label: names.serverName || "Connected server",
          route,
        },
      ];
    case "suite-overview":
      return suiteTrail(route.suiteId, names, evaluate);
    case "suite-settings":
    case "suite-edit":
      return [
        ...suiteTrail(route.suiteId, names, evaluate),
        settingsCrumb(
          route.suiteId,
          route.type === "suite-settings" ? route.tab : "settings",
        ),
      ];
    case "case-new":
      return [
        ...settingsTrail(route.suiteId, names, evaluate),
        { kind: "case-new", label: "New test case", route },
      ];
    case "case-settings":
      return [
        ...settingsTrail(route.suiteId, names, evaluate),
        caseCrumb(route.suiteId, route.caseId, names),
      ];
    case "case-evaluators":
      return [
        ...settingsTrail(route.suiteId, names, evaluate),
        caseCrumb(route.suiteId, route.caseId, names),
        { kind: "case-evaluators", label: "Test Case Evaluators", route },
      ];
    case "test-detail":
    case "test-edit":
      return [
        ...suiteTrail(route.suiteId, names, evaluate),
        {
          kind: "case",
          label: names.caseName || "Test case",
          route: {
            type: "test-edit",
            suiteId: route.suiteId,
            testId: route.testId,
          },
        },
      ];
    case "run-detail":
      return runTrail(route.suiteId, route.runId, names, evaluate);
    case "test-run":
      return testRunTrail(route, names, evaluate);
    case "test-run-edit":
      return [
        ...testRunTrail(route, names, evaluate),
        { kind: "test-run-edit", label: "Edit Test Case", route },
      ];
    case "iteration":
      return [
        ...testRunTrail(route, names, evaluate),
        {
          kind: "iteration",
          label: names.iterationNumber
            ? `Iteration #${names.iterationNumber}`
            : "Iteration",
          route,
        },
      ];
  }
}

function suiteTrail(
  suiteId: string,
  names: EvaluateNavCrumbNames,
  evaluate: EvaluateNavCrumb,
): EvaluateNavCrumb[] {
  return [
    evaluate,
    {
      kind: "suite",
      label: names.suiteName || "Suite",
      route: { type: "suite-overview", suiteId },
    },
  ];
}

function settingsCrumb(
  suiteId: string,
  tab: "settings" | "cases" | "evaluators",
): EvaluateNavCrumb {
  return {
    kind: "suite-settings",
    label: "Suite settings",
    route: { type: "suite-settings", suiteId, tab },
  };
}

/** Case pages sit under Suite settings › Test cases, so that crumb opens that tab. */
function settingsTrail(
  suiteId: string,
  names: EvaluateNavCrumbNames,
  evaluate: EvaluateNavCrumb,
): EvaluateNavCrumb[] {
  return [
    ...suiteTrail(suiteId, names, evaluate),
    settingsCrumb(suiteId, "cases"),
  ];
}

function caseCrumb(
  suiteId: string,
  caseId: string,
  names: EvaluateNavCrumbNames,
): EvaluateNavCrumb {
  return {
    kind: "case",
    label: names.caseName || "Test case",
    route: { type: "case-settings", suiteId, caseId },
  };
}

function runTrail(
  suiteId: string,
  runId: string,
  names: EvaluateNavCrumbNames,
  evaluate: EvaluateNavCrumb,
): EvaluateNavCrumb[] {
  return [
    ...suiteTrail(suiteId, names, evaluate),
    {
      kind: "suite-run",
      label: names.runNumber ? `Run #${names.runNumber}` : "Run",
      route: { type: "run-detail", suiteId, runId },
    },
  ];
}

/** The target picked on the test run is part of its address, so it stays on the crumb. */
function testRunTrail(
  route: { suiteId: string; runId: string; caseId: string; target?: string },
  names: EvaluateNavCrumbNames,
  evaluate: EvaluateNavCrumb,
): EvaluateNavCrumb[] {
  const { suiteId, runId, caseId, target } = route;
  return [
    ...runTrail(suiteId, runId, names, evaluate),
    {
      kind: "test-run",
      label: names.caseName || "Test run",
      route: {
        type: "test-run",
        suiteId,
        runId,
        caseId,
        ...(target ? { target } : {}),
      },
    },
  ];
}
