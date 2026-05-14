/**
 * Centralized navigation API for the inspector app.
 *
 * Phase 2 introduces a typed wrapper around React Router's navigate/location
 * primitives. The legacy `applyNavigation` in App.tsx delegates here for URL
 * updates; in Phase 6, `applyNavigation` and the hash-change listener are
 * deleted and call sites use `useAppNavigate()` / `navigateApp()` directly.
 *
 * URLs are path-based (`/servers`, `/organizations/:orgId/billing`, etc.)
 * matching `react-router` semantics. Chatbox session hashes
 * (`#chatbox-slug`) are NOT app navigation and are preserved verbatim.
 */
import { useCallback } from "react";
import {
  useInRouterContext,
  useLocation,
  useNavigate,
  useParams,
} from "react-router";
import { getAppRouter } from "../router";
import type { OrganizationRouteSection } from "./hosted-navigation";
import type { EvalRoute } from "./eval-route-types";

/** Typed canonical paths used across the app. */
export const routePaths = {
  root: "/",
  servers: "/servers",
  hosts: "/hosts",
  registry: "/registry",
  tools: "/tools",
  resources: "/resources",
  prompts: "/prompts",
  tasks: "/tasks",
  auth: "/auth",
  skills: "/skills",
  learning: "/learning",
  conformance: "/conformance",
  oauthFlow: "/oauth-flow",
  xaaFlow: "/xaa-flow",
  tracing: "/tracing",
  chatV2: "/chat-v2",
  chatboxes: "/chatboxes",
  appBuilder: "/app-builder",
  views: "/views",
  support: "/support",
  settings: "/settings",
  profile: "/profile",
  projectSettings: "/project-settings",
  callback: "/callback",
  billing: "/billing",
  evals: "/evals",
  ciEvals: "/ci-evals",
  organizations: "/organizations",
} as const;

export type RoutePath = (typeof routePaths)[keyof typeof routePaths] | string;

/** Build a path for a specific organization route. */
export function buildOrganizationPath(
  orgId: string,
  section?: OrganizationRouteSection,
): string {
  if (section === "billing") return `/organizations/${orgId}/billing`;
  if (section === "models") return `/organizations/${orgId}/models`;
  return `/organizations/${orgId}`;
}

/**
 * Build an eval (Playground) route path from a typed EvalRoute.
 * Mirrors `eval-router-core.ts:build` but produces path-based URLs.
 */
export function buildEvalsPath(route: EvalRoute): string {
  return buildEvalRoutePath("/evals", route);
}

export function buildCiEvalsPath(route: EvalRoute): string {
  return buildEvalRoutePath("/ci-evals", route);
}

function buildEvalRoutePath(prefix: "/evals" | "/ci-evals", route: EvalRoute): string {
  switch (route.type) {
    case "list":
      return prefix;
    case "create":
      return `${prefix}/create`;
    case "suite-overview": {
      const params = new URLSearchParams();
      if (route.view && route.view !== "runs") params.set("view", route.view);
      if (route.fromCommit) params.set("fromCommit", route.fromCommit);
      const query = params.toString();
      return `${prefix}/suite/${route.suiteId}${query ? `?${query}` : ""}`;
    }
    case "run-detail": {
      const params = new URLSearchParams();
      if (route.iteration) params.set("iteration", route.iteration);
      if (route.insightsFocus) params.set("insights", "1");
      const query = params.toString();
      return `${prefix}/suite/${route.suiteId}/runs/${route.runId}${query ? `?${query}` : ""}`;
    }
    case "test-detail": {
      const params = new URLSearchParams();
      if (route.iteration) params.set("iteration", route.iteration);
      const query = params.toString();
      return `${prefix}/suite/${route.suiteId}/test/${route.testId}${query ? `?${query}` : ""}`;
    }
    case "test-edit": {
      const params = new URLSearchParams();
      if (route.openCompare) params.set("compare", "1");
      if (route.iteration) params.set("iteration", route.iteration);
      const query = params.toString();
      return `${prefix}/suite/${route.suiteId}/test/${route.testId}/edit${query ? `?${query}` : ""}`;
    }
    case "suite-edit":
      return `${prefix}/suite/${route.suiteId}/edit`;
    case "commit-detail": {
      if (prefix !== "/ci-evals") return prefix;
      const params = new URLSearchParams();
      if (route.suite) params.set("suite", route.suite);
      if (route.iteration) params.set("iteration", route.iteration);
      const query = params.toString();
      return `/ci-evals/commit/${encodeURIComponent(route.commitSha)}${query ? `?${query}` : ""}`;
    }
  }
}

export interface AppNavigateOptions {
  replace?: boolean;
}

/**
 * Imperative navigate from a non-React caller (IPC bridge, OAuth callback).
 *
 * Prefer `useAppNavigate()` inside components. Falls back to writing
 * `window.history` directly if the router has not yet been created
 * (e.g. very early bootstrap).
 */
export function navigateApp(to: string, options?: AppNavigateOptions): void {
  const router = getAppRouter();
  if (router) {
    void router.navigate(to, { replace: options?.replace });
    return;
  }
  // Test/fallback path: no Router mounted. Mirror navigation to both pathname
  // and the legacy hash so tests checking `window.location.hash` keep passing
  // while production (with a Router) uses path-based URLs only.
  if (options?.replace) {
    window.history.replaceState({}, "", to);
  } else {
    window.history.pushState({}, "", to);
  }
  const [pathPart, queryPart] = to.split("?");
  if (pathPart) {
    // Nested routes (ci-evals/evals) keep the leading slash in their legacy
    // hash form (`#/ci-evals/...`); flat tabs use `#tab`.
    const isNested = /^\/(ci-evals|evals)(\/|$)/.test(pathPart);
    const basePath = isNested ? pathPart : pathPart.replace(/^\/+/, "");
    const fragment = queryPart ? `${basePath}?${queryPart}` : basePath;
    const newHash = `#${fragment}`;
    if (window.location.hash !== newHash) {
      window.location.hash = fragment;
    }
  }
}

/**
 * React hook returning a typed navigate function.
 *
 * Use in components instead of `applyNavigation` or `window.location.hash =`.
 * Falls back to `navigateApp` (history API) when rendered outside a Router
 * context, so component tests rendering with `<>` keep working.
 */
export function useAppNavigate() {
  const inRouter = useInRouterContext();
  const navigate = inRouter ? useNavigate() : null;
  return useCallback(
    (to: string, options?: AppNavigateOptions) => {
      if (navigate) {
        navigate(to, { replace: options?.replace });
      } else {
        navigateApp(to, options);
      }
    },
    [navigate],
  );
}

/**
 * Strip the leading slash from the first pathname segment so `useActiveTab()`
 * returns `"servers"` (matching the legacy `activeTab` state shape).
 *
 * Phases 3-6: this is the single source of truth for `activeTab`; the
 * useState in App.tsx is deleted in Phase 6.
 */
export function useActiveTab(): string {
  const { pathname } = useLocation();
  return pathnameToActiveTab(pathname);
}

export function pathnameToActiveTab(pathname: string): string {
  const trimmed = pathname.replace(/^\/+/, "").split("/")[0] || "servers";
  return trimmed;
}

export interface CurrentOrgRoute {
  orgId: string;
  orgSection: OrganizationRouteSection;
}

export function useCurrentOrgRoute(): CurrentOrgRoute | null {
  const params = useParams();
  const { pathname } = useLocation();
  const segments = pathname.replace(/^\/+/, "").split("/");
  if (segments[0] !== "organizations") return null;
  const orgId = params.orgId ?? segments[1];
  if (!orgId) return null;
  const sectionSegment = segments[2];
  const orgSection: OrganizationRouteSection =
    sectionSegment === "billing"
      ? "billing"
      : sectionSegment === "models"
        ? "models"
        : "overview";
  return { orgId, orgSection };
}

/**
 * Compatibility helper: convert a legacy hash-fragment target like
 * `"organizations/:id/billing"` or `"#servers"` into a path-based URL.
 *
 * Used by the navigate IPC command bridge during Phase 6.
 */
export function legacyHashTargetToPath(rawTarget: string): string {
  const stripped = rawTarget.replace(/^#/, "").replace(/^\/+/, "");
  const [path, query] = stripped.split("?");
  const queryPart = query ? `?${query}` : "";
  if (!path) return "/servers";
  return `/${path}${queryPart}`;
}
