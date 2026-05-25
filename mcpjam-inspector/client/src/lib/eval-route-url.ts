import { useContext, useMemo } from "react";
import { UNSAFE_LocationContext } from "react-router";
import type { EvalRoute, SuiteOverviewView } from "./eval-route-types";
import { SUITE_DASHBOARD_ROUTE_VIEW } from "./eval-suite-ia";

export type EvalRoutePrefix = "/evals" | "/ci-evals";

export function parseEvalRouteFromUrl(
  prefix: EvalRoutePrefix,
  pathname: string,
  search = "",
): EvalRoute | null {
  const normalizedPathname = pathname.startsWith("/")
    ? pathname
    : `/${pathname}`;
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
  const routeRoot = prefix.replace(/^\/+/, "");
  if (segments[0] !== routeRoot) return null;

  if (segments.length === 1 || !segments[1]) {
    return { type: "list" };
  }

  if (segments[1] === "create") {
    return { type: "create" };
  }

  if (prefix === "/ci-evals" && segments[1] === "commit" && segments[2]) {
    return {
      type: "commit-detail",
      commitSha: decodePathSegment(segments[2]),
      suite: params.get("suite") || undefined,
      iteration: params.get("iteration") || undefined,
    };
  }

  if (segments[1] !== "suite" || !segments[2]) {
    return { type: "list" };
  }

  const suiteId = decodePathSegment(segments[2]);
  const rest = segments.slice(3);

  if (rest.length === 0) {
    return {
      type: "suite-overview",
      suiteId,
      view: parseSuiteOverviewView(params.get("view")),
      ...(params.get("fromCommit")
        ? { fromCommit: params.get("fromCommit") || undefined }
        : {}),
    };
  }

  if (rest.length === 1 && rest[0] === "edit") {
    return { type: "suite-edit", suiteId };
  }

  if (rest.length === 2 && rest[0] === "runs" && rest[1]) {
    const insightsFocus = parseTruthyParam(params.get("insights"));
    return {
      type: "run-detail",
      suiteId,
      runId: decodePathSegment(rest[1]),
      iteration: params.get("iteration") || undefined,
      ...(insightsFocus ? { insightsFocus: true } : {}),
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
      return {
        type: "test-edit",
        suiteId,
        testId,
        ...(openCompare ? { openCompare: true } : {}),
        ...(params.get("iteration")
          ? { iteration: params.get("iteration") || undefined }
          : {}),
      };
    }
  }

  return { type: "list" };
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

export function useEvalsRouteFromUrl(): EvalRoute {
  return useEvalRouteFromUrl("/evals");
}

export function useCiEvalsRouteFromUrl(): EvalRoute {
  return useEvalRouteFromUrl("/ci-evals");
}

function parseSuiteOverviewView(value: string | null): SuiteOverviewView {
  return value === "test-cases" || value === "executions"
    ? value
    : SUITE_DASHBOARD_ROUTE_VIEW;
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
