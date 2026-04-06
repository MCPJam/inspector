import * as React from "react";
import type { EvalRoute } from "./eval-route-types";

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

export function createEvalRouter(prefix: EvalRouterPrefix) {
  function parse(): EvalRoute | null {
    const hash = normalizeHashForPrefix(window.location.hash, prefix);
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
          compareRaw === "1" ||
          compareRaw === "true" ||
          compareRaw === "yes";
        return {
          type: "test-edit",
          suiteId,
          testId,
          ...(openCompare ? { openCompare: true } : {}),
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
          view: view === "test-cases" ? "test-cases" : "runs",
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
    const hash = build(route);
    if (options?.replace && (prefix === "/ci-evals" || prefix === "/evals")) {
      history.replaceState({}, "", `/${hash}`);
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    } else {
      window.location.hash = hash;
    }
  }

  function useRoute(): EvalRoute {
    const [route, setRoute] = React.useState<EvalRoute>(
      () => parse() || { type: "list" },
    );

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
