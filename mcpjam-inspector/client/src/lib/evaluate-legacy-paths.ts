import { toCurrentEvalRoute } from "@/components/evaluate/nav/evaluate-nav-pages";
import { parseDraftTestCaseId } from "@/components/evals/draft-test-case";
import { buildEvaluatePath } from "./app-navigation";
import type { EvalRoute } from "./eval-route-types";
import { parseEvalRouteFromUrl } from "./eval-route-url";
import { isEvaluateNavRoute } from "./evaluate-nav-route-path";

/** Properties of `eval_nav_redirected`. */
export interface EvaluateRedirectEvent {
  from_kind: string;
  to_kind: string;
  matched: boolean;
}

/** What an Evaluate address should do once the flag is known (E4). */
export type EvaluateRedirectDecision =
  /** Already the right form for this flag value, or not an Evaluate URL. */
  | { kind: "stay" }
  /** The flag is still loading and this address redirects under one value. */
  | { kind: "wait" }
  | { kind: "redirect"; to: string; event: EvaluateRedirectEvent }
  /** An Evaluate URL no row matches: today's parser shows the suite list. */
  | { kind: "unmatched"; event: EvaluateRedirectEvent };

/** An old address form (the spec's URL table, C15) and the page it becomes. */
interface LegacyMatch {
  fromKind: string;
  to: EvalRoute;
  /** False when the form is known but part of it cannot be carried over. */
  matched: boolean;
}

/**
 * Old-to-new rows. Null leaves the address alone: it is already a new-style
 * route, its page did not move, or the new pages have no home for it yet
 * (a case opened from the Eval my server preview, a prompt or record draft).
 */
export function matchLegacyEvaluateRoute(route: EvalRoute): LegacyMatch | null {
  const row = (fromKind: string, to: EvalRoute, matched = true) => ({
    fromKind,
    to,
    matched,
  });
  switch (route.type) {
    case "suite-overview":
      return route.view === "test-cases"
        ? row("suite-test-cases", {
            type: "suite-settings",
            suiteId: route.suiteId,
            tab: "cases",
          })
        : null;
    case "suite-edit": {
      const { suiteId } = route;
      return route.fromCaseChecks
        ? row("suite-edit-from-case-checks", {
            type: "suite-settings",
            suiteId,
            tab: "evaluators",
          })
        : row("suite-edit", {
            type: "suite-settings",
            suiteId,
            tab: "settings",
          });
    }
    case "test-edit": {
      const { suiteId, testId: caseId } = route;
      if (route.fromEvalServer) return null;
      const draft = parseDraftTestCaseId(caseId);
      if (draft === "describe") {
        return row("case-draft-describe", { type: "case-new", suiteId });
      }
      if (draft) return null;
      if (route.checks) {
        return row("case-edit-checks", {
          type: "case-evaluators",
          suiteId,
          caseId,
        });
      }
      // The new editor has no results pane, so `?compare=1` opens the case.
      return row(route.openCompare ? "case-edit-compare" : "case-edit", {
        type: "case-settings",
        suiteId,
        caseId,
      });
    }
    case "test-detail":
      if (parseDraftTestCaseId(route.testId)) return null;
      return row("case-detail", {
        type: "case-settings",
        suiteId: route.suiteId,
        caseId: route.testId,
      });
    case "run-detail": {
      const { suiteId, runId, testCaseId: caseId, iteration } = route;
      if (caseId && iteration) {
        return row("run-case-iteration", {
          type: "iteration",
          suiteId,
          runId,
          caseId,
          iterationId: iteration,
        });
      }
      if (caseId) {
        return row("run-case", { type: "test-run", suiteId, runId, caseId });
      }
      // Without its case an iteration has no path; open its suite run.
      if (iteration) {
        return row(
          "run-iteration",
          { type: "run-detail", suiteId, runId },
          false,
        );
      }
      return null;
    }
    default:
      return null;
  }
}

/** Query keys the parser reads; any other key is carried to the new address. */
const ROUTE_QUERY_KEYS = new Set([
  "view",
  "fromCommit",
  "importJob",
  "iteration",
  "case",
  "insights",
  "compareTo",
  "compare",
  "checks",
  "fromEvalServer",
  "fromCaseChecks",
  "target",
]);

/** Path words kept in an unmatched `from_kind`; anything else is an id. */
const PATH_WORDS = new Set(
  "evaluate suite runs test edit settings cases evaluators iter new compare create eval-server".split(
    " ",
  ),
);

/**
 * Old-to-new with the flag on; new-to-old with it off, through each nav
 * page's `currentRoute` (PD3). `pathname` is logical (no `/p/<project>`).
 */
export function resolveEvaluateRedirect(input: {
  pathname: string;
  search: string;
  hash: string;
  navEnabled: boolean | undefined;
}): EvaluateRedirectDecision {
  const { pathname, search, hash, navEnabled } = input;
  const route = parseEvalRouteFromUrl("/evaluate", pathname, search);
  if (!route) return { kind: "stay" };
  const path = pathname.replace(/\/+$/, "");
  if (route.type === "list" && path !== "/evaluate") {
    return {
      kind: "unmatched",
      event: { from_kind: pathShape(path), to_kind: "list", matched: false },
    };
  }

  const isNew = isEvaluateNavRoute(route);
  const legacy = isNew ? null : matchLegacyEvaluateRoute(route);
  if (!isNew && !legacy) return { kind: "stay" };
  if (navEnabled === undefined) return { kind: "wait" };

  if (navEnabled && legacy) {
    return {
      kind: "redirect",
      to: withExtras(buildEvaluatePath(legacy.to), search, hash),
      event: {
        from_kind: legacy.fromKind,
        to_kind: legacy.to.type,
        matched: legacy.matched,
      },
    };
  }
  if (!navEnabled && isNew) {
    const current = toCurrentEvalRoute(route);
    return {
      kind: "redirect",
      to: withExtras(buildEvaluatePath(current), search, hash),
      event: { from_kind: route.type, to_kind: current.type, matched: true },
    };
  }
  return { kind: "stay" };
}

/** Keeps query keys the route does not own (such as `project`) and the hash. */
function withExtras(path: string, search: string, hash: string): string {
  const extras = new URLSearchParams(search);
  for (const key of [...extras.keys()]) {
    if (ROUTE_QUERY_KEYS.has(key)) extras.delete(key);
  }
  const query = extras.toString();
  const joined = query
    ? `${path}${path.includes("?") ? "&" : "?"}${query}`
    : path;
  return `${joined}${hash}`;
}

function pathShape(path: string): string {
  return path
    .split("/")
    .filter(Boolean)
    .map((segment) => (PATH_WORDS.has(segment) ? segment : ":id"))
    .join("/");
}
