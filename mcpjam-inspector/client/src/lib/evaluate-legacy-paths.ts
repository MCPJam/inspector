/**
 * Old Evaluate addresses and the per-layer page each one now opens.
 *
 * Links to the old forms live in chat threads, CI logs, API replies and SDK
 * permalinks, so every one keeps working once the per-layer pages are on.
 * This module only maps old to new: with the flag off, the page map already
 * renders today's page for a new address, so nothing maps back.
 *
 * Pure (no React, no I/O), so each form is a one-line table test.
 */
import { parseDraftTestCaseId } from "@/components/evals/draft-test-case";
import { buildEvaluatePath } from "./app-navigation";
import { parseEvalRouteFromUrl } from "./eval-route-url";
import type { EvalRoute } from "./eval-route-types";

const EVALUATE_ROOT_PATHS: ReadonlySet<string> = new Set([
  "/evaluate",
  "/evaluate/",
]);

/** A rewrite the gate performs with `replace`. */
export interface LegacyEvaluateRedirect {
  /** Kind the old address parsed to; eval_nav_redirected `from_kind`. */
  fromKind: EvalRoute["type"];
  /** The route it is rewritten to; `to.type` is `to_kind`. */
  to: EvalRoute;
  /**
   * Logical path and search to open: buildEvaluatePath(to), plus the one old
   * parameter a new address still carries (?importJob=).
   * No project prefix and no hash; the gate restores both.
   */
  path: string;
  /** The page Back returns to, sent as evalNav.from. */
  backTo?: EvalRoute;
}

/** An old address that names an iteration but not the run and case it belongs to. */
export interface LegacyIterationLookup {
  fromKind: "run-detail" | "test-detail" | "test-edit";
  suiteId: string;
  iterationId: string;
  /** The run the old address named; null when it named none (case addresses). */
  runId: string | null;
  /** Where to go when the iteration has no run or case, is in another run, or cannot be read. */
  fallback: EvalRoute;
}

export type LegacyEvaluateMatch =
  /** A new address, or an old one that keeps its page. No navigation, no event. */
  | { kind: "keep" }
  | { kind: "redirect"; redirect: LegacyEvaluateRedirect }
  | { kind: "lookup"; lookup: LegacyIterationLookup }
  /** Under /evaluate but no form matches: today's fallback renders; fires matched: false. */
  | { kind: "unmatched" };

/** The two fields the lookup reads from testSuites:getTestIteration. */
export interface IterationLocation {
  suiteRunId?: string | null;
  testCaseId?: string | null;
}

const KEEP: LegacyEvaluateMatch = { kind: "keep" };

function redirect(
  fromKind: EvalRoute["type"],
  to: EvalRoute,
  extras: { query?: string; backTo?: EvalRoute } = {},
): LegacyEvaluateMatch {
  const { query, backTo } = extras;
  return {
    kind: "redirect",
    redirect: {
      fromKind,
      to,
      path: `${buildEvaluatePath(to)}${query ?? ""}`,
      ...(backTo ? { backTo } : {}),
    },
  };
}

function caseSettings(suiteId: string, testCaseId: string): EvalRoute {
  return { type: "case-settings", suiteId, testCaseId };
}

/**
 * The address of a test case opened by id (…/test/:t or …/test/:t/edit),
 * once the forms that keep their page are ruled out.
 */
function matchCaseAddress(
  fromKind: "test-detail" | "test-edit",
  suiteId: string,
  testId: string,
  options: { checks: boolean; iteration?: string },
): LegacyEvaluateMatch {
  const draft = parseDraftTestCaseId(testId);
  // Only the describe draft has a page of its own; prompt and record drafts
  // keep opening today's editor.
  if (draft === "describe") {
    return redirect(fromKind, { type: "case-new", suiteId });
  }
  if (draft) return KEEP;
  if (options.checks) {
    return redirect(fromKind, {
      type: "case-evaluators",
      suiteId,
      testCaseId: testId,
    });
  }
  if (options.iteration) {
    return {
      kind: "lookup",
      lookup: {
        fromKind,
        suiteId,
        iterationId: options.iteration,
        runId: null,
        fallback: caseSettings(suiteId, testId),
      },
    };
  }
  // ?compare=1 without an iteration opened the editor's results pane; results
  // leave the editor, so the editor is what remains.
  return redirect(fromKind, caseSettings(suiteId, testId));
}

function matchRoute(route: EvalRoute): LegacyEvaluateMatch {
  switch (route.type) {
    case "suite-overview": {
      const to: EvalRoute = {
        type: "suite-settings",
        suiteId: route.suiteId,
        tab: "cases",
      };
      // An API import's reviewUrl: the review moves to Suite settings › Test
      // cases, which reads the job from its own query.
      if (route.importJob) {
        return redirect(route.type, to, {
          query: `?importJob=${encodeURIComponent(route.importJob)}`,
        });
      }
      return route.view === "test-cases" ? redirect(route.type, to) : KEEP;
    }
    case "suite-edit":
      if (route.fromCaseChecks) {
        // The new trail is built from the address alone, so the case this
        // came from rides in router state for Back.
        return redirect(
          route.type,
          { type: "suite-settings", suiteId: route.suiteId, tab: "evaluators" },
          {
            backTo: {
              type: "case-evaluators",
              suiteId: route.suiteId,
              testCaseId: route.fromCaseChecks,
            },
          },
        );
      }
      return redirect(route.type, {
        type: "suite-settings",
        suiteId: route.suiteId,
        tab: "settings",
      });
    case "test-edit":
      // A prepared case from the "Eval my server" preview is not saved, so no
      // new page could load it.
      if (route.fromEvalServer) return KEEP;
      return matchCaseAddress(route.type, route.suiteId, route.testId, {
        checks: Boolean(route.checks),
        iteration: route.iteration,
      });
    case "test-detail":
      return matchCaseAddress(route.type, route.suiteId, route.testId, {
        checks: false,
        iteration: route.iteration,
      });
    case "run-detail": {
      if (route.comparison) return KEEP;
      const { suiteId, runId } = route;
      if (route.testCaseId) {
        const ids = { suiteId, runId, testCaseId: route.testCaseId };
        return redirect(
          route.type,
          route.iteration
            ? { type: "iteration", ...ids, iterationId: route.iteration }
            : { type: "test-run", ...ids },
        );
      }
      if (route.iteration) {
        return {
          kind: "lookup",
          lookup: {
            fromKind: route.type,
            suiteId,
            iterationId: route.iteration,
            runId,
            fallback: { type: "run-detail", suiteId, runId },
          },
        };
      }
      return KEEP;
    }
    default:
      return KEEP;
  }
}

/**
 * What to do with one logical Evaluate address (project already stripped).
 */
export function matchLegacyEvaluatePath(
  pathname: string,
  search: string,
): LegacyEvaluateMatch {
  const route = parseEvalRouteFromUrl("/evaluate", pathname, search);
  if (!route) return KEEP;
  if (route.type === "list") {
    // The parser falls back to the list for any path it does not know; only
    // the root itself is a real list address.
    return EVALUATE_ROOT_PATHS.has(pathname) ? KEEP : { kind: "unmatched" };
  }
  return matchRoute(route);
}

/**
 * The rewrite once the lookup settles. `iteration` null = not found,
 * unreadable, or the query failed. The iteration page needs both its run and
 * its case, and must be in the run the old address named, if any.
 */
export function redirectForIteration(
  lookup: LegacyIterationLookup,
  iteration: IterationLocation | null,
): LegacyEvaluateRedirect {
  const runId = iteration?.suiteRunId;
  const testCaseId = iteration?.testCaseId;
  const sameRun = lookup.runId === null || lookup.runId === runId;
  const to: EvalRoute =
    runId && testCaseId && sameRun
      ? {
          type: "iteration",
          suiteId: lookup.suiteId,
          runId,
          testCaseId,
          iterationId: lookup.iterationId,
        }
      : lookup.fallback;
  return { fromKind: lookup.fromKind, to, path: buildEvaluatePath(to) };
}
