import { useContext, useMemo } from "react";
import { UNSAFE_LocationContext } from "react-router";
import type {
  EvalRoute,
  EvaluateNavRoute,
  SuiteOverviewView,
} from "./eval-route-types";
import { stripProjectFromPath } from "./project-route";

/**
 * Both eval modes live under `/evals`; Runs is the `/evals/runs` sub-tree.
 * The two prefixes stay mutually exclusive — parsing a Runs URL against the
 * Suites prefix returns null rather than a bare list route, so a mode never
 * silently renders the other mode's URL.
 *
 * `/evaluate` is the flag-gated Evaluate (New) tab. It is a SIBLING of
 * `/evals`, not a sub-tree: it does not start with `/evals/`, so the guards
 * below already keep the two from parsing each other's URLs.
 */
export type EvalRoutePrefix = "/evals" | "/evals/runs" | "/evaluate";

export function parseEvalRouteFromUrl(
  prefix: EvalRoutePrefix,
  pathname: string,
  search = "",
): EvalRoute | null {
  // Eval routes are project-owned, so the live pathname is
  // `/p/<projectId>/evals/...`. The project comes off before matching: these
  // prefixes are LOGICAL, and the eval route is the same route in every
  // project.
  const withoutProject = stripProjectFromPath(pathname);
  const normalizedPathname = withoutProject.startsWith("/")
    ? withoutProject
    : `/${withoutProject}`;
  if (
    normalizedPathname !== prefix &&
    !normalizedPathname.startsWith(`${prefix}/`)
  ) {
    return null;
  }

  const params = new URLSearchParams(
    search.startsWith("?") ? search : search ? `?${search}` : "",
  );
  const segments = normalizedPathname.replace(/^\/+/, "").split("/");
  const prefixSegments = prefix.replace(/^\/+/, "").split("/");
  if (prefixSegments.some((segment, index) => segments[index] !== segment)) {
    return null;
  }
  // `/evals/runs` is Runs mode's own root, not a Suites route.
  if (prefix === "/evals" && segments[1] === "runs") return null;

  const tail = segments.slice(prefixSegments.length);

  if (tail.length === 0 || !tail[0]) {
    return { type: "list" };
  }

  if (tail[0] === "create") {
    return { type: "create" };
  }

  // Evaluate (New) only. The v1 `/evals` tab has no first-run preview.
  if (prefix === "/evaluate" && tail[0] === "eval-server" && tail[1]) {
    return {
      type: "eval-server",
      serverId: decodePathSegment(tail[1]),
    };
  }

  if (prefix === "/evaluate" && tail[0] === "runs" && tail.length === 1) {
    return { type: "evaluate-runs" };
  }

  if (prefix === "/evals/runs" && tail[0] === "commit" && tail[1]) {
    return {
      type: "commit-detail",
      commitSha: decodePathSegment(tail[1]),
      suite: params.get("suite") || undefined,
      iteration: params.get("iteration") || undefined,
    };
  }

  if (tail[0] !== "suite" || !tail[1]) {
    return { type: "list" };
  }

  const suiteId = decodePathSegment(tail[1]);
  const rest = tail.slice(2);

  if (rest.length === 0) {
    return {
      type: "suite-overview",
      suiteId,
      view: parseSuiteOverviewView(params.get("view")),
      ...(params.get("fromCommit")
        ? { fromCommit: params.get("fromCommit") || undefined }
        : {}),
      ...(params.get("importJob")
        ? { importJob: params.get("importJob") || undefined }
        : {}),
    };
  }

  if (prefix === "/evaluate") {
    const navRoute = parseEvaluateNavSuiteTail(suiteId, rest, params);
    if (navRoute) return navRoute;
  }

  if (rest.length === 1 && rest[0] === "edit") {
    return {
      type: "suite-edit",
      suiteId,
      ...(params.get("fromCaseChecks")
        ? { fromCaseChecks: params.get("fromCaseChecks")! }
        : {}),
    };
  }

  if (
    (rest.length === 2 || (rest.length === 3 && rest[2] === "compare")) &&
    rest[0] === "runs" &&
    rest[1]
  ) {
    const insightsFocus = parseTruthyParam(params.get("insights"));
    return {
      type: "run-detail",
      suiteId,
      runId: decodePathSegment(rest[1]),
      ...(rest[2] === "compare" ? { comparison: true } : {}),
      iteration: params.get("iteration") || undefined,
      testCaseId: params.get("case") || undefined,
      ...(insightsFocus ? { insightsFocus: true } : {}),
      ...(params.get("compareTo")
        ? { compareToRunId: params.get("compareTo") || undefined }
        : {}),
    };
  }

  if (rest[0] === "test" && rest[1]) {
    const testId = decodePathSegment(rest[1]);
    if (rest.length === 2) {
      return {
        type: "test-detail",
        suiteId,
        testId,
        iteration: params.get("iteration") || undefined,
      };
    }
    if (rest.length === 3 && rest[2] === "edit") {
      const openCompare = parseTruthyParam(params.get("compare"));
      const fromEvalServer = params.get("fromEvalServer") || undefined;
      return {
        type: "test-edit",
        suiteId,
        testId,
        ...(openCompare ? { openCompare: true } : {}),
        ...(parseTruthyParam(params.get("checks")) ? { checks: true } : {}),
        ...(params.get("iteration")
          ? { iteration: params.get("iteration") || undefined }
          : {}),
        ...(fromEvalServer ? { fromEvalServer } : {}),
      };
    }
  }

  return { type: "list" };
}

/**
 * The suite-level paths of the Evaluate navigation rework:
 * `settings[/cases|/evaluators]`, `settings/cases/new`,
 * `settings/cases/:case[/evaluators]` and
 * `runs/:run/cases/:case[/edit|/iter/:iter]`. Null for anything else, so the
 * caller falls through to the older suite routes.
 */
function parseEvaluateNavSuiteTail(
  suiteId: string,
  rest: string[],
  params: URLSearchParams,
): EvaluateNavRoute | null {
  if (rest[0] === "settings") {
    if (rest.length === 1) {
      return { type: "suite-settings", suiteId, tab: "settings" };
    }
    if (rest.length === 2 && rest[1] === "evaluators") {
      return { type: "suite-settings", suiteId, tab: "evaluators" };
    }
    if (rest[1] !== "cases") return null;
    if (rest.length === 2) {
      return { type: "suite-settings", suiteId, tab: "cases" };
    }
    if (rest.length === 3 && rest[2] === "new") {
      return { type: "case-new", suiteId };
    }
    if (!rest[2]) return null;
    const caseId = decodePathSegment(rest[2]);
    if (rest.length === 3) return { type: "case-settings", suiteId, caseId };
    if (rest.length === 4 && rest[3] === "evaluators") {
      return { type: "case-evaluators", suiteId, caseId };
    }
    return null;
  }

  if (rest[0] !== "runs" || !rest[1] || rest[2] !== "cases" || !rest[3]) {
    return null;
  }
  const runId = decodePathSegment(rest[1]);
  const caseId = decodePathSegment(rest[3]);
  if (rest.length === 4) {
    const target = params.get("target");
    return {
      type: "test-run",
      suiteId,
      runId,
      caseId,
      ...(target ? { target } : {}),
    };
  }
  if (rest.length === 5 && rest[4] === "edit") {
    return { type: "test-run-edit", suiteId, runId, caseId };
  }
  if (rest.length === 6 && rest[4] === "iter" && rest[5]) {
    return {
      type: "iteration",
      suiteId,
      runId,
      caseId,
      iterationId: decodePathSegment(rest[5]),
    };
  }
  return null;
}

export function useEvalRouteFromUrl(prefix: EvalRoutePrefix): EvalRoute {
  // Parse pathname + search centrally instead of scattering useParams calls;
  // this keeps index routes, flat routes, and no-Router tests on one path.
  const locationContext = useContext(UNSAFE_LocationContext);
  const pathname =
    locationContext?.location.pathname ??
    (typeof window === "undefined" ? prefix : window.location.pathname);
  const search =
    locationContext?.location.search ??
    (typeof window === "undefined" ? "" : window.location.search);

  return useMemo(
    () => parseEvalRouteFromUrl(prefix, pathname, search) ?? { type: "list" },
    [prefix, pathname, search],
  );
}

/** The two lenses over the same eval suites, switched in the Evaluate header. */
export type EvalsMode = "suites" | "runs";

export function evalsModeForPathname(pathname: string): EvalsMode {
  const logical = stripProjectFromPath(pathname);
  const normalized = logical.startsWith("/") ? logical : `/${logical}`;
  return normalized === "/evals/runs" || normalized.startsWith("/evals/runs/")
    ? "runs"
    : "suites";
}

export function useEvalsMode(): EvalsMode {
  const locationContext = useContext(UNSAFE_LocationContext);
  const pathname =
    locationContext?.location.pathname ??
    (typeof window === "undefined" ? "/evals" : window.location.pathname);
  return evalsModeForPathname(pathname);
}

export function useEvalsRouteFromUrl(): EvalRoute {
  return useEvalRouteFromUrl("/evals");
}

export function useEvalsRunsRouteFromUrl(): EvalRoute {
  return useEvalRouteFromUrl("/evals/runs");
}

/** Evaluate (New): same typed routes, parsed under the `/evaluate` prefix. */
export function useEvaluateRouteFromUrl(): EvalRoute {
  return useEvalRouteFromUrl("/evaluate");
}

function parseSuiteOverviewView(value: string | null): SuiteOverviewView {
  return value === "test-cases" ||
    value === "executions" ||
    value === "cross-host"
    ? value
    : "runs";
}

function parseTruthyParam(value: string | null): boolean {
  return value === "1" || value === "true" || value === "yes";
}

function decodePathSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}
