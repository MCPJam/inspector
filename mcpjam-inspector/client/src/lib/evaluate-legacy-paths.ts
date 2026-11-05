import { parseDraftTestCaseId } from "@/components/evals/draft-test-case";
import { resolveEvalNavPage } from "@/components/evaluate/nav/eval-nav-pages";
import { buildEvaluatePath } from "./app-navigation";
import { parseEvalRouteFromUrl } from "./eval-route-url";
import type { EvalRoute } from "./eval-route-types";
import { buildProjectPath, parseProjectPath } from "./project-route";

/**
 * Evaluate addresses, rewritten between today's forms and the page-per-layer
 * forms. With `evaluate-nav-enabled` on, an old address opens its new page;
 * with it off, a new address opens today's page through the nav page map's
 * `todayRoute`, so both directions share one mapping per page.
 */

/** Today's address forms the table knows, as `eval_nav_redirected.from_kind` names them. */
export type LegacyEvalForm =
  | "suite-edit"
  | "suite-edit-from-case-checks"
  | "suite-test-cases-view"
  | "case-draft"
  | "case-edit"
  | "case-detail"
  | "case-checks"
  | "case-compare"
  | "case-iteration"
  | "run-case"
  | "run-iteration"
  | "run-iteration-no-case";

/** Where an iteration sits, as `testSuites:getTestIteration` reports it. */
export type IterationLocation = { testCaseId?: string; suiteRunId?: string };

type Mapping =
  | { to: EvalRoute }
  | {
      iterationId: string;
      /** Null when the found iteration still does not name its page. */
      resolve: (found: IterationLocation) => EvalRoute | null;
    };

type LegacyEvalRow = {
  form: LegacyEvalForm;
  /** Null when the route is not this form. */
  map: (route: EvalRoute) => Mapping | null;
};

type CaseRoute = Extract<EvalRoute, { type: "test-edit" | "test-detail" }>;

/** A suite's saved case; drafts and prepared server cases have no new page. */
function savedCase(route: EvalRoute): CaseRoute | null {
  if (route.type !== "test-edit" && route.type !== "test-detail") return null;
  if (route.type === "test-edit" && route.fromEvalServer) return null;
  return parseDraftTestCaseId(route.testId) ? null : route;
}

function caseRoute(route: CaseRoute) {
  return { suiteId: route.suiteId, testCaseId: route.testId };
}

/** One row per old address form, first match wins. */
export const LEGACY_EVAL_FORMS: readonly LegacyEvalRow[] = [
  {
    form: "suite-edit-from-case-checks",
    map: (route) =>
      route.type === "suite-edit" && route.fromCaseChecks
        ? {
            to: {
              type: "suite-settings",
              suiteId: route.suiteId,
              tab: "evaluators",
            },
          }
        : null,
  },
  {
    form: "suite-edit",
    map: (route) =>
      route.type === "suite-edit"
        ? {
            to: {
              type: "suite-settings",
              suiteId: route.suiteId,
              tab: "settings",
            },
          }
        : null,
  },
  {
    form: "suite-test-cases-view",
    map: (route) =>
      route.type === "suite-overview" && route.view === "test-cases"
        ? {
            to: {
              type: "suite-settings",
              suiteId: route.suiteId,
              tab: "cases",
            },
          }
        : null,
  },
  {
    form: "case-draft",
    map: (route) =>
      route.type === "test-edit" &&
      !route.fromEvalServer &&
      parseDraftTestCaseId(route.testId) === "describe"
        ? { to: { type: "case-new", suiteId: route.suiteId } }
        : null,
  },
  {
    form: "case-checks",
    map: (route) => {
      const found = savedCase(route);
      return found?.type === "test-edit" && found.checks
        ? { to: { type: "case-evaluators", ...caseRoute(found) } }
        : null;
    },
  },
  {
    // The case's results now live on its test runs, so the iteration a
    // results link pointed at opens on its own page.
    form: "case-iteration",
    map: (route) => {
      const found = savedCase(route);
      if (!found?.iteration) return null;
      const iterationId = found.iteration;
      return {
        iterationId,
        resolve: ({ suiteRunId }) =>
          suiteRunId
            ? {
                type: "iteration",
                ...caseRoute(found),
                runId: suiteRunId,
                iterationId,
              }
            : null,
      };
    },
  },
  {
    form: "case-compare",
    map: (route) => {
      const found = savedCase(route);
      return found?.type === "test-edit" && found.openCompare
        ? { to: { type: "case-settings", ...caseRoute(found) } }
        : null;
    },
  },
  {
    form: "case-edit",
    map: (route) => {
      const found = savedCase(route);
      return found?.type === "test-edit"
        ? { to: { type: "case-settings", ...caseRoute(found) } }
        : null;
    },
  },
  {
    form: "case-detail",
    map: (route) => {
      const found = savedCase(route);
      return found?.type === "test-detail"
        ? { to: { type: "case-settings", ...caseRoute(found) } }
        : null;
    },
  },
  {
    form: "run-iteration",
    map: (route) =>
      route.type === "run-detail" &&
      !route.comparison &&
      route.iteration &&
      route.testCaseId
        ? {
            to: {
              type: "iteration",
              suiteId: route.suiteId,
              runId: route.runId,
              testCaseId: route.testCaseId,
              iterationId: route.iteration,
            },
          }
        : null,
  },
  {
    // The backend's iteration permalinks carry no case, so it is looked up.
    form: "run-iteration-no-case",
    map: (route) => {
      if (route.type !== "run-detail" || route.comparison) return null;
      const iterationId = route.iteration;
      if (!iterationId) return null;
      return {
        iterationId,
        resolve: ({ testCaseId }) =>
          testCaseId
            ? {
                type: "iteration",
                suiteId: route.suiteId,
                runId: route.runId,
                testCaseId,
                iterationId,
              }
            : null,
      };
    },
  },
  {
    form: "run-case",
    map: (route) =>
      route.type === "run-detail" && !route.comparison && route.testCaseId
        ? {
            to: {
              type: "test-run",
              suiteId: route.suiteId,
              runId: route.runId,
              testCaseId: route.testCaseId,
            },
          }
        : null,
  },
];

export type EvalNavRedirectEvent = {
  from_kind: string;
  to_kind: string;
  matched: boolean;
};

export type EvaluateAddressPlan =
  /** `event` is set when an old address could not be mapped and stays as is. */
  | { action: "stay"; event?: EvalNavRedirectEvent }
  | { action: "redirect"; to: string; event: EvalNavRedirectEvent }
  /** The new address needs the iteration's case or run; look it up, then `resolve`. */
  | {
      action: "lookup";
      iterationId: string;
      /** Null when the lookup failed or the iteration is not readable. */
      resolve: (found: IterationLocation | null) => EvaluateAddressPlan;
    };

export type AddressParts = { pathname: string; search: string; hash: string };

const STAY: EvaluateAddressPlan = { action: "stay" };

/**
 * What to do with an Evaluate address. Addresses outside `/evaluate`, and
 * forms that have no other page (the compare page, prepared server cases,
 * prompt and record drafts), stay as they are.
 */
export function planEvaluateAddress(
  location: AddressParts,
  navEnabled: boolean,
): EvaluateAddressPlan {
  const route = parseEvalRouteFromUrl(
    "/evaluate",
    location.pathname,
    location.search,
  );
  if (!route) return STAY;
  const href = (to: EvalRoute) => addressFor(to, location);

  if (!navEnabled) {
    const { pageRoute } = resolveEvalNavPage(route);
    if (pageRoute === route) return STAY;
    return {
      action: "redirect",
      to: href(pageRoute),
      event: { from_kind: route.type, to_kind: pageRoute.type, matched: true },
    };
  }

  for (const row of LEGACY_EVAL_FORMS) {
    const mapping = row.map(route);
    if (!mapping) continue;
    const redirect = (to: EvalRoute): EvaluateAddressPlan => ({
      action: "redirect",
      to: href(to),
      event: { from_kind: row.form, to_kind: to.type, matched: true },
    });
    if ("to" in mapping) return redirect(mapping.to);
    return {
      action: "lookup",
      iterationId: mapping.iterationId,
      resolve: (found) => {
        const to = found ? mapping.resolve(found) : null;
        if (to) return redirect(to);
        return {
          action: "stay",
          event: { from_kind: row.form, to_kind: route.type, matched: false },
        };
      },
    };
  }
  return STAY;
}

/** True when either flag value would move this address, so the page waits for the flag. */
export function evaluateAddressDependsOnFlag(location: AddressParts): boolean {
  return (
    planEvaluateAddress(location, true).action !== "stay" ||
    planEvaluateAddress(location, false).action !== "stay"
  );
}

/** The new address, in the same project, keeping `?project=` and the fragment. */
function addressFor(to: EvalRoute, location: AddressParts): string {
  const project = new URLSearchParams(location.search).get("project");
  let target = buildEvaluatePath(to);
  if (project) {
    target += `${target.includes("?") ? "&" : "?"}${new URLSearchParams({ project })}`;
  }
  target += location.hash;
  const scoped = parseProjectPath(location.pathname);
  return scoped ? buildProjectPath(scoped.projectId, target) : target;
}
