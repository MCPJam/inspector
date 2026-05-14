import * as React from "react";
import { UNSAFE_LocationContext } from "react-router";
import type { EvalRoute } from "./eval-route-types";
import { navigateApp } from "./app-navigation";

export type EvalRouterPrefix = "/evals" | "/ci-evals";

function normalizeHashForPrefix(
  rawHash: string,
  prefix: EvalRouterPrefix,
): string {
  let hash = rawHash.replace(/^#/, "");
  if (prefix === "/ci-evals" && !hash.startsWith("/")) {
    hash = `/${hash}`;
  }
  return hash;
}

/**
 * Resolve the current eval route source.
 *
 * If `window.location.hash` is set, prefer it — that's the legacy bookmark
 * form, the hash-driven test contract, and the migration shim's intermediate
 * state. Otherwise read from `window.location.pathname + search` (the
 * production path-based form set by `navigateApp` / React Router).
 */
function readCurrentEvalRouteSource(prefix: EvalRouterPrefix): string {
  if (window.location.hash) {
    return normalizeHashForPrefix(window.location.hash, prefix);
  }
  const pathname = window.location.pathname || "";
  const search = window.location.search || "";
  return `${pathname}${search}`;
}

export function createEvalRouter(prefix: EvalRouterPrefix) {
  function parse(): EvalRoute | null {
    const hash = readCurrentEvalRouteSource(prefix);
    if (!hash.startsWith(prefix)) {
      return null;
    }

    const [path, queryString] = hash.split("?");

    if (path === `${prefix}/create`) {
      return { type: "create" };
    }

    if (path === prefix) {
      return { type: "list" };
    }

    if (prefix === "/ci-evals") {
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
    }

    const suiteMatch = path.match(
      new RegExp(
        `^${prefix.replace(/\//g, "\\/")}\\/suite\\/([^/]+)(?:/(.*))?$`,
      ),
    );
    if (suiteMatch) {
      const [, suiteId, rest] = suiteMatch;

      if (rest === "edit") {
        return { type: "suite-edit", suiteId };
      }

      const runMatch = rest?.match(/^runs\/([^/?]+)$/);
      if (runMatch) {
        const [, runId] = runMatch;
        const params = new URLSearchParams(queryString || "");
        const insightsRaw = params.get("insights");
        const insightsFocus =
          insightsRaw === "1" ||
          insightsRaw === "true" ||
          insightsRaw === "yes";
        return {
          type: "run-detail",
          suiteId,
          runId,
          iteration: params.get("iteration") || undefined,
          ...(insightsFocus ? { insightsFocus: true } : {}),
        };
      }

      const testEditMatch = rest?.match(/^test\/([^/?]+)\/edit$/);
      if (testEditMatch) {
        const [, testId] = testEditMatch;
        const params = new URLSearchParams(queryString || "");
        const compareRaw = params.get("compare");
        const openCompare =
          compareRaw === "1" || compareRaw === "true" || compareRaw === "yes";
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
        const fromCommit = params.get("fromCommit") || undefined;
        return {
          type: "suite-overview",
          suiteId,
          view:
            view === "test-cases" || view === "executions" ? view : "runs",
          ...(fromCommit ? { fromCommit } : {}),
        };
      }
    }

    return { type: "list" };
  }

  function build(route: EvalRoute): string {
    let hash = "";

    switch (route.type) {
      case "list":
        hash = `#${prefix}`;
        break;
      case "create":
        hash = `#${prefix}/create`;
        break;
      case "suite-overview": {
        const params = new URLSearchParams();
        if (route.view && route.view !== "runs") {
          params.set("view", route.view);
        }
        if (route.fromCommit) {
          params.set("fromCommit", route.fromCommit);
        }
        const query = params.toString();
        hash = `#${prefix}/suite/${route.suiteId}${query ? `?${query}` : ""}`;
        break;
      }
      case "run-detail": {
        const params = new URLSearchParams();
        if (route.iteration) {
          params.set("iteration", route.iteration);
        }
        if (route.insightsFocus) {
          params.set("insights", "1");
        }
        const query = params.toString();
        hash = `#${prefix}/suite/${route.suiteId}/runs/${route.runId}${query ? `?${query}` : ""}`;
        break;
      }
      case "test-detail": {
        const params = new URLSearchParams();
        if (route.iteration) {
          params.set("iteration", route.iteration);
        }
        const query = params.toString();
        hash = `#${prefix}/suite/${route.suiteId}/test/${route.testId}${query ? `?${query}` : ""}`;
        break;
      }
      case "test-edit": {
        const params = new URLSearchParams();
        if (route.openCompare) {
          params.set("compare", "1");
        }
        if (route.iteration) {
          params.set("iteration", route.iteration);
        }
        const query = params.toString();
        hash = `#${prefix}/suite/${route.suiteId}/test/${route.testId}/edit${query ? `?${query}` : ""}`;
        break;
      }
      case "suite-edit":
        hash = `#${prefix}/suite/${route.suiteId}/edit`;
        break;
      case "commit-detail": {
        if (prefix !== "/ci-evals") {
          hash = `#${prefix}`;
          break;
        }
        const params = new URLSearchParams();
        if (route.suite) params.set("suite", route.suite);
        if (route.iteration) params.set("iteration", route.iteration);
        const query = params.toString();
        hash = `#/ci-evals/commit/${encodeURIComponent(route.commitSha)}${query ? `?${query}` : ""}`;
        break;
      }
    }

    return hash;
  }

  function navigate(route: EvalRoute, options?: { replace?: boolean }) {
    // `build(route)` returns the legacy hash form (e.g. `#/evals/suite/123`).
    // Convert to a path-based URL and route through the central navigation
    // API so React Router stays authoritative. Phase 5 will rip out this
    // router entirely; callers will use `buildEvalsPath` / `buildCiEvalsPath`
    // from `app-navigation` directly.
    const hash = build(route);
    const path = `/${hash.replace(/^[#/]+/, "")}`;
    navigateApp(path, { replace: options?.replace });
  }

  function useRoute(): EvalRoute {
    // Read the router location via context so the hook call shape is
    // unconditional (Rules of Hooks compliant). Outside a Router (tests),
    // `locationCtx` is undefined and we still re-parse via the legacy
    // hashchange listener below.
    const locationCtx = React.useContext(UNSAFE_LocationContext);
    const pathname = locationCtx?.location.pathname;
    const search = locationCtx?.location.search;
    const [route, setRoute] = React.useState<EvalRoute>(
      () => parse() || { type: "list" },
    );

    // Re-parse whenever React Router's pathname or search changes (production
    // navigation), in addition to legacy hashchange events (inbound bookmarks
    // and component tests rendered without a Router).
    React.useEffect(() => {
      setRoute(parse() || { type: "list" });
    }, [pathname, search]);

    React.useEffect(() => {
      const handleHashChange = () => {
        setRoute(parse() || { type: "list" });
      };
      window.addEventListener("hashchange", handleHashChange);
      return () => window.removeEventListener("hashchange", handleHashChange);
    }, []);

    return route;
  }

  return { parse, build, navigate, useRoute };
}
