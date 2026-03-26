/**
 * CI Evals Router - Hash-based routing for CI evals tab
 *
 * Route structure:
 * - #/ci-evals - Suite list view
 * - #/ci-evals/suite/:suiteId - Suite overview (runs + test cases)
 * - #/ci-evals/suite/:suiteId/runs/:runId - Run detail view
 * - #/ci-evals/suite/:suiteId/test/:testId - Test case detail view
 */

export type CiEvalsRoute =
  | { type: "list" }
  | { type: "suite-overview"; suiteId: string; view?: "runs" | "test-cases" }
  | { type: "suite-edit"; suiteId: string }
  | { type: "run-detail"; suiteId: string; runId: string; iteration?: string }
  | {
      type: "test-detail";
      suiteId: string;
      testId: string;
      iteration?: string;
    }
  | {
      type: "test-edit";
      suiteId: string;
      testId: string;
    }
  | {
      type: "commit-detail";
      commitSha: string;
      suite?: string;
      iteration?: string;
    };

/**
 * Parse the current hash to extract CI evals route information.
 */
export function parseCiEvalsRoute(): CiEvalsRoute | null {
  const hash = window.location.hash.replace("#", "");

  if (!hash.startsWith("/ci-evals")) {
    return null;
  }

  const [path, queryString] = hash.split("?");

  if (path === "/ci-evals") {
    return { type: "list" };
  }

  const commitMatch = path.match(/^\/ci-evals\/commit\/([^/]+)$/);
  if (commitMatch) {
    const params = new URLSearchParams(queryString || "");
    return {
      type: "commit-detail",
      commitSha: decodeURIComponent(commitMatch[1]),
      suite: params.get("suite") || undefined,
      iteration: params.get("iteration") || undefined,
    };
  }

  const suiteMatch = path.match(/^\/ci-evals\/suite\/([^/]+)(?:\/(.*))?$/);
  if (suiteMatch) {
    const [, suiteId, rest] = suiteMatch;

    if (rest === "edit") {
      return { type: "suite-edit", suiteId };
    }

    const runMatch = rest?.match(/^runs\/([^/?]+)$/);
    if (runMatch) {
      const [, runId] = runMatch;
      const params = new URLSearchParams(queryString || "");
      return {
        type: "run-detail",
        suiteId,
        runId,
        iteration: params.get("iteration") || undefined,
      };
    }

    const testEditMatch = rest?.match(/^test\/([^/?]+)\/edit$/);
    if (testEditMatch) {
      const [, testId] = testEditMatch;
      return {
        type: "test-edit",
        suiteId,
        testId,
      };
    }

    const testMatch = rest?.match(/^test\/([^/?]+)$/);
    if (testMatch) {
      const [, testId] = testMatch;
      const params = new URLSearchParams(queryString || "");
      return {
        type: "test-detail",
        suiteId,
        testId,
        iteration: params.get("iteration") || undefined,
      };
    }

    if (!rest) {
      const params = new URLSearchParams(queryString || "");
      const view = params.get("view");
      return {
        type: "suite-overview",
        suiteId,
        view: view === "runs" ? "runs" : "test-cases",
      };
    }
  }

  return { type: "list" };
}

/**
 * Navigate to a specific CI evals route.
 */
export function navigateToCiEvalsRoute(
  route: CiEvalsRoute,
  options?: { replace?: boolean },
) {
  let hash = "";

  switch (route.type) {
    case "list":
      hash = "#/ci-evals";
      break;
    case "suite-overview": {
      const params = new URLSearchParams();
      if (route.view && route.view !== "test-cases") {
        params.set("view", route.view);
      }
      const query = params.toString();
      hash = `#/ci-evals/suite/${route.suiteId}${query ? `?${query}` : ""}`;
      break;
    }
    case "suite-edit":
      hash = `#/ci-evals/suite/${route.suiteId}/edit`;
      break;
    case "run-detail": {
      const params = new URLSearchParams();
      if (route.iteration) {
        params.set("iteration", route.iteration);
      }
      const query = params.toString();
      hash = `#/ci-evals/suite/${route.suiteId}/runs/${route.runId}${query ? `?${query}` : ""}`;
      break;
    }
    case "test-detail": {
      const params = new URLSearchParams();
      if (route.iteration) {
        params.set("iteration", route.iteration);
      }
      const query = params.toString();
      hash = `#/ci-evals/suite/${route.suiteId}/test/${route.testId}${query ? `?${query}` : ""}`;
      break;
    }
    case "test-edit":
      hash = `#/ci-evals/suite/${route.suiteId}/test/${route.testId}/edit`;
      break;
    case "commit-detail": {
      const params = new URLSearchParams();
      if (route.suite) params.set("suite", route.suite);
      if (route.iteration) params.set("iteration", route.iteration);
      const query = params.toString();
      hash = `#/ci-evals/commit/${encodeURIComponent(route.commitSha)}${query ? `?${query}` : ""}`;
      break;
    }
  }

  if (options?.replace) {
    history.replaceState({}, "", `/${hash}`);
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  } else {
    window.location.hash = hash;
  }
}

/**
 * React hook to get the current CI evals route.
 */
export function useCiEvalsRoute(): CiEvalsRoute {
  const [route, setRoute] = React.useState<CiEvalsRoute>(
    () => parseCiEvalsRoute() || { type: "list" },
  );

  React.useEffect(() => {
    const handleHashChange = () => {
      const newRoute = parseCiEvalsRoute() || { type: "list" };
      setRoute(newRoute);
    };

    window.addEventListener("hashchange", handleHashChange);
    return () => window.removeEventListener("hashchange", handleHashChange);
  }, []);

  return route;
}

import React from "react";
