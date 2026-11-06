/**
 * Breadcrumbs, Back and place labels for the per-layer Evaluate pages.
 *
 * Pure functions of the route and the names a page has loaded: the same
 * address always gives the same trail, however the user got there. Only Back
 * looks at arrival, and only through the `from` the caller read from router
 * state.
 */
import { buildEvaluatePath } from "@/lib/app-navigation";
import type { EvalRoute } from "@/lib/eval-route-types";
import { isDraftTestCaseId } from "@/components/evals/draft-test-case";
import type { EvalNavFrom } from "./eval-nav-state";

/** Display names the page has loaded. undefined = still loading. */
export interface EvalNavNames {
  /** Already display-ready: callers pass stripTimestampSuffix(suite.name). "" = loaded but blank. */
  suiteName?: string;
  runNumber?: number;
  /** "" = loaded but blank. */
  testCaseTitle?: string;
  /** 1-based position of the iteration within its test run. */
  iterationNumber?: number;
}

export interface EvalCrumb {
  label: string;
  /** Where clicking goes. Absent on the current page's crumb, which is not a link. */
  to?: EvalRoute;
  /** True while the name behind this crumb is loading; label is then the placeholder. */
  pending?: boolean;
}

export interface EvalBack {
  /** Full button text, e.g. "Back to test run". */
  label: string;
  /** Logical path to navigate to (push, with via: "back"). */
  path: string;
}

type CrumbLabel = Pick<EvalCrumb, "label" | "pending">;
type RunIds = { suiteId: string; runId: string };
type TestRunIds = RunIds & { testCaseId: string };

function nameLabel(
  name: string | undefined,
  placeholder: string,
  blank: string,
): CrumbLabel {
  if (name === undefined) return { label: placeholder, pending: true };
  return { label: name.trim() || blank };
}

function numberLabel(value: number | undefined, word: string): CrumbLabel {
  return value === undefined
    ? { label: word, pending: true }
    : { label: `${word} #${value}` };
}

const suiteLabel = (names: EvalNavNames) =>
  nameLabel(names.suiteName, "Suite", "Untitled suite");
const caseLabel = (names: EvalNavNames) =>
  nameLabel(names.testCaseTitle, "Test case", "Untitled test case");
const runLabel = (names: EvalNavNames) => numberLabel(names.runNumber, "Run");

const suiteRoute = (suiteId: string): EvalRoute => ({
  type: "suite-overview",
  suiteId,
});
const casesRoute = (suiteId: string): EvalRoute => ({
  type: "suite-settings",
  suiteId,
  tab: "cases",
});
const runRoute = ({ suiteId, runId }: RunIds): EvalRoute => ({
  type: "run-detail",
  suiteId,
  runId,
});
const testRunRoute = ({
  suiteId,
  runId,
  testCaseId,
}: TestRunIds): EvalRoute => ({
  type: "test-run",
  suiteId,
  runId,
  testCaseId,
});

const EVALUATE_CRUMB: EvalCrumb = { label: "Evaluate", to: { type: "list" } };

/**
 * The trail for a route, built from the route and names alone. The first
 * crumb is always Evaluate.
 * []   for list and evaluate-runs (the landing shows tabs, not a trail).
 * null for kinds the new pages do not own; today's header keeps those.
 */
export function buildEvalCrumbs(
  route: EvalRoute,
  names: EvalNavNames,
): EvalCrumb[] | null {
  switch (route.type) {
    case "list":
    case "evaluate-runs":
      return [];
    case "create":
    case "eval-server":
    case "test-detail":
    case "test-edit":
    case "suite-edit":
    case "commit-detail":
      return null;
  }
  const suite: EvalCrumb = {
    ...suiteLabel(names),
    to: suiteRoute(route.suiteId),
  };
  const settings: EvalCrumb = {
    label: "Suite settings",
    to: casesRoute(route.suiteId),
  };
  switch (route.type) {
    case "suite-overview":
      return [EVALUATE_CRUMB, suiteLabel(names)];
    case "suite-settings":
      // The tab is not a page level, so it never adds a crumb.
      return [EVALUATE_CRUMB, suite, { label: "Suite settings" }];
    case "case-new":
      return [EVALUATE_CRUMB, suite, settings, { label: "New case" }];
    case "case-settings":
      return [EVALUATE_CRUMB, suite, settings, caseLabel(names)];
    case "case-evaluators": {
      const to: EvalRoute = { ...route, type: "case-settings" };
      const testCase = { ...caseLabel(names), to };
      return [
        EVALUATE_CRUMB,
        suite,
        settings,
        testCase,
        { label: "Test Case Evaluators" },
      ];
    }
    case "run-detail":
      return route.comparison ? null : [EVALUATE_CRUMB, suite, runLabel(names)];
  }
  const run: EvalCrumb = { ...runLabel(names), to: runRoute(route) };
  if (route.type === "test-run")
    return [EVALUATE_CRUMB, suite, run, caseLabel(names)];
  const testRun: EvalCrumb = { ...caseLabel(names), to: testRunRoute(route) };
  const current =
    route.type === "iteration"
      ? numberLabel(names.iterationNumber, "Iteration")
      : { label: "Edit Test Case" };
  return [EVALUATE_CRUMB, suite, run, testRun, current];
}

const PLACES: Record<EvalRoute["type"], string> = {
  list: "Suites",
  "evaluate-runs": "Runs",
  "suite-overview": "suite",
  "suite-settings": "suite settings",
  "suite-edit": "suite settings",
  "case-new": "new case",
  "case-settings": "test case",
  "test-run-edit": "test case",
  "test-detail": "test case",
  "test-edit": "test case",
  "case-evaluators": "test case evaluators",
  "run-detail": "run",
  "test-run": "test run",
  iteration: "iteration",
  create: "new suite",
  "eval-server": "server preview",
  "commit-detail": "commit",
};

/** How a Back button names this page when you return to it. */
export function evalNavPlace(route: EvalRoute, names: EvalNavNames): string {
  if (route.type === "run-detail" && names.runNumber !== undefined) {
    return `Run #${names.runNumber}`;
  }
  if (route.type === "test-edit") {
    if (isDraftTestCaseId(route.testId)) return PLACES["case-new"];
    if (route.checks) return PLACES["case-evaluators"];
  }
  return PLACES[route.type];
}

function back(place: string, to: EvalRoute): EvalBack {
  return { label: `Back to ${place}`, path: buildEvaluatePath(to) };
}

/**
 * The Back button for a route, or null when the page has none.
 * For suite-settings, run-detail, test-run and iteration, `from` wins when
 * present and its path differs from this page's; otherwise the route's own
 * default applies. case-settings and test-run-edit always use their default:
 * the address already says where they belong.
 */
export function buildEvalBack(
  route: EvalRoute,
  names: EvalNavNames,
  from: EvalNavFrom | null,
): EvalBack | null {
  let fallback: EvalBack;
  switch (route.type) {
    case "case-settings":
      return back("suite settings", casesRoute(route.suiteId));
    case "test-run-edit":
      return back("test run", testRunRoute(route));
    case "run-detail":
      if (route.comparison) return null;
      fallback = back("suite", suiteRoute(route.suiteId));
      break;
    case "suite-settings":
      fallback = back("suite", suiteRoute(route.suiteId));
      break;
    case "test-run":
      fallback = back(evalNavPlace(runRoute(route), names), runRoute(route));
      break;
    case "iteration":
      fallback = back("test run", testRunRoute(route));
      break;
    default:
      return null;
  }
  if (from && from.path !== buildEvaluatePath(route)) {
    return { label: `Back to ${from.place}`, path: from.path };
  }
  return fallback;
}
