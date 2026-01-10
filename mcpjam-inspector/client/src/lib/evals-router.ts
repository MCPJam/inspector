/**
 * Evals Router - Hash-based routing for evals tab
 *
 * Route structure:
 * - #/evals - Suite list view
 * - #/evals/create - Create new suite
 * - #/evals/suite/:suiteId - Suite overview (runs + test cases)
 * - #/evals/suite/:suiteId/runs/:runId - Run detail view
 * - #/evals/suite/:suiteId/test/:testId - Test case detail view
 * - #/evals/suite/:suiteId/edit - Edit suite configuration
 */

export type EvalsRoute =
  | { type: "list" }
  | { type: "create" }
  | { type: "suite-overview"; suiteId: string; view?: "runs" | "test-cases" }
  | { type: "run-detail"; suiteId: string; runId: string; iteration?: string }
  | { type: "test-detail"; suiteId: string; testId: string; iteration?: string }
  | { type: "test-edit"; suiteId: string; testId: string }
  | { type: "suite-edit"; suiteId: string };

/**
 * Parse the current hash to extract evals route information
 */
export function parseEvalsRoute(): EvalsRoute | null {
  const hash = window.location.hash.replace("#", "");

  // Not on evals tab
  if (!hash.startsWith("/evals")) {
    return null;
  }

  // Split hash from query params
  const [path, queryString] = hash.split("?");

  // Root evals path
  if (path === "/evals") {
    return { type: "list" };
  }

  // Create new suite
  if (path === "/evals/create") {
    return { type: "create" };
  }

  // Suite-specific routes
  const suiteMatch = path.match(/^\/evals\/suite\/([^/]+)(?:\/(.*))?$/);
  if (suiteMatch) {
    const [, suiteId, rest] = suiteMatch;

    // Edit mode
    if (rest === "edit") {
      return { type: "suite-edit", suiteId };
    }

    // Run detail
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

    // Test case edit
    const testEditMatch = rest?.match(/^test\/([^/?]+)\/edit$/);
    if (testEditMatch) {
      const [, testId] = testEditMatch;
      return {
        type: "test-edit",
        suiteId,
        testId,
      };
    }

    // Test case detail
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

    // Suite overview with optional query params
    if (!rest) {
      const params = new URLSearchParams(queryString || "");
      const view = params.get("view");
      return {
        type: "suite-overview",
        suiteId,
        view: view === "test-cases" ? "test-cases" : "runs",
      };
    }
  }

  // Invalid route, default to list
  return { type: "list" };
}

/**
 * Navigate to a specific evals route
 */
export function navigateToEvalsRoute(route: EvalsRoute) {
  let hash = "";

  switch (route.type) {
    case "list":
      hash = "#/evals";
      break;
    case "create":
      hash = "#/evals/create";
      break;
    case "suite-overview": {
      const params = new URLSearchParams();
      if (route.view && route.view !== "runs") {
        params.set("view", route.view);
      }
      const query = params.toString();
      hash = `#/evals/suite/${route.suiteId}${query ? `?${query}` : ""}`;
      break;
    }
    case "run-detail": {
      const params = new URLSearchParams();
      if (route.iteration) {
        params.set("iteration", route.iteration);
      }
      const query = params.toString();
      hash = `#/evals/suite/${route.suiteId}/runs/${route.runId}${query ? `?${query}` : ""}`;
      break;
    }
    case "test-detail": {
      const params = new URLSearchParams();
      if (route.iteration) {
        params.set("iteration", route.iteration);
      }
      const query = params.toString();
      hash = `#/evals/suite/${route.suiteId}/test/${route.testId}${query ? `?${query}` : ""}`;
      break;
    }
    case "test-edit":
      hash = `#/evals/suite/${route.suiteId}/test/${route.testId}/edit`;
      break;
    case "suite-edit":
      hash = `#/evals/suite/${route.suiteId}/edit`;
      break;
  }

  window.location.hash = hash;
}

/**
 * React hook to get the current evals route
 */
export function useEvalsRoute(): EvalsRoute {
  const [route, setRoute] = React.useState<EvalsRoute>(
    () => parseEvalsRoute() || { type: "list" },
  );

  React.useEffect(() => {
    const handleHashChange = () => {
      const newRoute = parseEvalsRoute() || { type: "list" };
      setRoute(newRoute);
    };

    window.addEventListener("hashchange", handleHashChange);
    return () => window.removeEventListener("hashchange", handleHashChange);
  }, []);

  return route;
}

// Add React import for the hook
import React from "react";
