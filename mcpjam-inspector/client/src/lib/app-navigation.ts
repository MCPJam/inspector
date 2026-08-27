/**
 * Centralized navigation API for the inspector app.
 *
 * Central wrapper around React Router's navigate/location primitives.
 *
 * URLs are path-based (`/servers`, `/organizations/:orgId/billing`, etc.)
 * matching `react-router` semantics. Scenario session hashes
 * (`#scenario-slug`) are NOT app navigation and are preserved verbatim.
 *
 * ## Logical paths in, scoped paths out
 *
 * `routePaths` and every `build*Path` helper stay LOGICAL — project-relative,
 * with no `/p/<projectId>` in them. One conversion happens at the navigation
 * boundary (`useAppNavigate`, `navigateApp`): a `scope: "project"` target
 * navigated from inside a project keeps that project in the URL. That is the
 * whole trick — callers never think about the prefix, and the prefix never
 * gets lost, because there is exactly one place that adds it and one place
 * (`stripProjectFromPath`) that takes it off before a path is matched against
 * the logical route table.
 */
import { useCallback, useContext, useLayoutEffect, useState } from "react";
import { UNSAFE_LocationContext, UNSAFE_NavigationContext } from "react-router";
import { getAppRouter } from "../router-ref";
import type { EvalRoute } from "./eval-route-types";
import type { EvalRoutePrefix } from "./eval-route-url";
import { normalizeHostedHashTab } from "./hosted-tab-policy";
import { isProjectScopedRoutePath } from "./app-routes";
import {
  buildProjectPath,
  isAppRelativeTarget,
  parseProjectPath,
  stripProjectFromPath,
} from "./project-route";
import { listAppSurfaceNavSegments } from "@/shared/app-surfaces";
import type { InsightsView } from "@/hooks/useInsightsFlowController";

/**
 * Every organization settings section.
 *
 * A runtime list rather than a bare union so the route-coverage test can walk
 * it. `buildOrganizationPath` below is the only thing that decides these URLs,
 * and nothing used to check that the paths it produced were actually
 * registered — the Discord section shipped that way and was unreachable: the
 * nav sent you to `/organizations/:id/discord`, no route matched, and the
 * router's `"*"` wildcard rendered Servers instead. Adding a member here now
 * fails the test until the route table, the element map and the surface
 * manifest all know about it.
 */
export const ORGANIZATION_ROUTE_SECTIONS = [
  "overview",
  "billing",
  "models",
  "slack",
  "discord",
] as const;

export type OrganizationRouteSection =
  (typeof ORGANIZATION_ROUTE_SECTIONS)[number];

/**
 * Third path segment → section. "overview" is the section with no segment, so
 * an unknown segment lands there too; that is what makes an unregistered
 * section fail quietly rather than 404, and why the coverage test exists.
 */
export function parseOrganizationSection(
  segment: string | undefined
): OrganizationRouteSection {
  if (segment === "billing") return "billing";
  if (segment === "models") return "models";
  if (segment === "slack") return "slack";
  if (segment === "discord") return "discord";
  return "overview";
}

/** Typed canonical paths used across the app. */
export const routePaths = {
  root: "/",
  home: "/home",
  servers: "/servers",
  hosts: "/hosts",
  hostCompare: "/host-compare",
  /** Chrome-less host-compare for vanity domains (caniuse.dev) — no sidebar/nav, bypasses NUX. */
  embedHostCompare: "/embed/host-compare",
  /** Chrome-less conformance-score runner for score.mcpjam.com. */
  embedScore: "/embed/score",
  /** Chrome-less Connector Bench runner. `/<runId>` resumes an in-flight run. */
  embedBench: "/embed/bench",
  /** Result of one score run, addressable only by its secret link token. */
  scoreResults: "/results",
  /** One benchmark scorecard, addressable only by its secret link. */
  benchResults: "/bench/results",
  capabilities: "/capabilities",
  computer: "/computer",
  registry: "/registry",
  tools: "/tools",
  resources: "/resources",
  prompts: "/prompts",
  tasks: "/tasks",
  auth: "/auth",
  skills: "/skills",
  learning: "/learning",
  conformance: "/conformance",
  /** Immutable detail URL for one project-owned conformance run. */
  conformanceRuns: "/conformance/runs",
  /** Revocable read-only share of a conformance run. The token IS the credential. */
  conformanceShared: "/conformance/shared",
  compatibility: "/compatibility",
  oauthFlow: "/oauth-flow",
  xaaFlow: "/xaa-flow",
  tracing: "/tracing",
  /** Legacy path. Still routed (it redirects), but never build links with it. */
  scenarios: "/scenarios",
  userTesting: "/user-testing",
  swarms: "/swarms",
  environments: "/environments",
  sessions: "/sessions",
  playground: "/playground",
  support: "/support",
  settings: "/settings",
  profile: "/profile",
  projectSettings: "/project-settings",
  /**
   * WorkOS Initiate Login URL. AuthKit redirects IdP-initiated logins (the
   * Okta app tile) here instead of issuing a code; the route starts a normal
   * sign-in so the code exchange on `/callback` has a matching PKCE verifier.
   */
  login: "/login",
  callback: "/callback",
  billing: "/billing",
  evals: "/evals",
  /** Runs mode of Evaluate. Legacy `/ci-evals` URLs redirect here. */
  evalsRuns: "/evals/runs",
  /** Redeem-based read-only share of an eval run. */
  evalsShared: "/evals/shared",
  /**
   * Evaluate (New) — the flag-gated redesign of the Evaluate tab. A sibling
   * route, not a sub-tree of `/evals`, so the two tabs never parse each
   * other's URLs and the original tab keeps every link it already shipped.
   */
  evaluate: "/evaluate",
  organizations: "/organizations",
} as const;

export type RoutePath = (typeof routePaths)[keyof typeof routePaths] | string;

/**
 * Build the exact path for one saved MCP server on Connect.
 *
 * The app's own counterpart to the SDK permalink builder: agents mint
 * `/servers/:serverId?project=` through `@mcpjam/sdk/platform`, and the screen
 * itself round-trips selection through this so a copied URL from the address
 * bar is the same URL an agent would hand out.
 */
export function buildProjectServerPath(serverId?: string | null): string {
  if (!serverId) return routePaths.servers;
  return `${routePaths.servers}/${encodeURIComponent(serverId)}`;
}

/** Build the exact path for one installed Agent Plugin, expanded on Connect. */
export function buildProjectPluginPath(pluginId?: string | null): string {
  if (!pluginId) return routePaths.servers;
  return `${routePaths.servers}/plugins/${encodeURIComponent(pluginId)}`;
}

/** Build the exact path for one project environment's detail. */
export function buildProjectEnvironmentPath(
  environmentId?: string | null
): string {
  if (!environmentId) return routePaths.environments;
  return `${routePaths.environments}/${encodeURIComponent(environmentId)}`;
}

/** Build a path that deep-links to a specific host's canvas, or to the hosts hub. */
export function buildHostsPath(hostId?: string | null): string {
  if (!hostId) return routePaths.hosts;
  return `${routePaths.hosts}/${encodeURIComponent(hostId)}`;
}

/** Build a path that deep-links into Compare with a pre-selected set of hosts. */
export function buildHostComparePath(
  hostIds?: ReadonlyArray<string> | null
): string {
  if (!hostIds || hostIds.length === 0) return routePaths.hostCompare;
  const param = hostIds.map((id) => id.trim()).filter((id) => id.length > 0);
  if (param.length === 0) return routePaths.hostCompare;
  const search = new URLSearchParams({ hosts: param.join(",") });
  return `${routePaths.hostCompare}?${search.toString()}`;
}

/** The create route. A static segment, so it outranks `:scenarioId`. */
export const userTestingCreatePath = `${routePaths.userTesting}/new`;

/**
 * Detail sub-tabs on `/user-testing/:scenarioId`. Insights is the landing tab.
 * Edit is a sibling route (`/edit`), not a tab.
 */
export type UserTestingDetailTab = "sessions" | "insights";

const USER_TESTING_DETAIL_TABS: ReadonlySet<string> = new Set([
  "sessions",
  "insights",
]);

/**
 * Build a path to one User Testing scenario. `scenarioId` is the scenario's
 * SCENARIO id — the identity host-backed and environment-backed scenarios
 * share. A HOST id is still accepted by the surface (links minted under the
 * older scheme redirect onto the scenario id), but new links should never be
 * built with one. `session` opens straight into one tester session, which is
 * what a copied session link carries; `sel` and `view` carry an Insights
 * selection and which diagram it was made on, so a link to "this cluster, in
 * the flow view" reopens exactly that. `buildSwarmPath` carries `sel` in the
 * same shape but not `view` — Swarms always reopens on the flow diagram.
 */
export function buildUserTestingScenarioPath(
  scenarioId: string,
  opts: {
    tab?: UserTestingDetailTab;
    session?: string;
    sel?: string;
    /** Typed like `tab`, so an unknown view cannot be minted into a link. */
    view?: InsightsView;
  } = {}
): string {
  const base = `${routePaths.userTesting}/${encodeURIComponent(scenarioId)}`;
  const search = new URLSearchParams();
  if (opts.tab && opts.tab !== "insights") search.set("tab", opts.tab);
  if (opts.session) search.set("session", opts.session);
  if (opts.sel) search.set("sel", opts.sel);
  // `flow` is the default; only the non-default view needs saying.
  if (opts.view && opts.view !== "flow") search.set("view", opts.view);
  const query = search.toString();
  return query ? `${base}?${query}` : base;
}

/** Setup / share / preview for one scenario — sibling of the detail tabs. */
export function buildUserTestingScenarioEditPath(scenarioId: string): string {
  return `${routePaths.userTesting}/${encodeURIComponent(scenarioId)}/edit`;
}

/**
 * Legacy `?tab=edit` / `share` / `preview` query — Edit is now its own route.
 * Callers should redirect these to {@link buildUserTestingScenarioEditPath}.
 */
export function isLegacyUserTestingEditTab(search: string): boolean {
  const tab = new URLSearchParams(search).get("tab");
  return tab === "edit" || tab === "share" || tab === "preview";
}

/**
 * Parse the sub-tab query on a scenario path. Missing / unknown → insights.
 * A `session` deep-link without an explicit tab still opens Sessions.
 * Legacy edit/share/preview queries are NOT returned here — use
 * {@link isLegacyUserTestingEditTab} and redirect to `/edit`.
 */
export function parseUserTestingDetailTab(
  search: string
): UserTestingDetailTab {
  const params = new URLSearchParams(search);
  const tab = params.get("tab");
  if (tab === "clusters") return "insights";
  if (tab && USER_TESTING_DETAIL_TABS.has(tab)) {
    return tab as UserTestingDetailTab;
  }
  if (params.get("session")) return "sessions";
  return "insights";
}

/** The Swarms create route. Static, so it outranks `:swarmId`. */
export const swarmsCreatePath = `${routePaths.swarms}/new`;

/** Detail tabs on `/swarms/:swarmId`. Insights is the default landing tab. */
export type SwarmDetailTab = "insights" | "sessions";

/**
 * Build a path to one Swarm Run (wave) detail. `swarmId` is the durable
 * `swarmRunGroupId` when present, otherwise the wave's newest journey-run id.
 */
export function buildSwarmPath(
  swarmId: string,
  opts: {
    tab?: SwarmDetailTab;
    session?: string;
    sel?: string;
  } = {}
): string {
  const base = `${routePaths.swarms}/${encodeURIComponent(swarmId)}`;
  const search = new URLSearchParams();
  if (opts.tab && opts.tab !== "insights") search.set("tab", opts.tab);
  if (opts.session) search.set("session", opts.session);
  if (opts.sel) search.set("sel", opts.sel);
  const query = search.toString();
  return query ? `${base}?${query}` : base;
}

/**
 * Parse the detail-tab query on a Swarm Run path. Missing / unknown →
 * insights. Legacy `overview` / `personas` → insights (personas live there).
 * A `session` deep-link without an explicit tab still opens Sessions.
 */
export function parseSwarmDetailTab(search: string): SwarmDetailTab {
  const params = new URLSearchParams(search);
  const value = params.get("tab");
  if (value === "sessions") return "sessions";
  if (value === "insights" || value === "personas" || value === "overview") {
    return "insights";
  }
  if (params.get("session")) return "sessions";
  return "insights";
}

/**
 * Build a Swarms deep-link to one synthetic session. Unlike the scenario
 * Sessions tab (host-anchored), the Swarms surface is Persona → Journey → Run →
 * Session, so a link that only carried `host`/`session` couldn't restore the
 * persona + run selection the recipient needs to reach the session. This
 * encodes `persona` (personaRefId) and `run` (runId) alongside `host`/`session`
 * so `SwarmsTab` can restore the full selection chain on load.
 */
export function buildSwarmSessionPath(args: {
  personaRefId: string;
  runId: string;
  hostId: string;
  threadId: string;
}): string {
  const search = new URLSearchParams({
    persona: args.personaRefId,
    run: args.runId,
    host: args.hostId,
    session: args.threadId,
  });
  return `${routePaths.swarms}?${search.toString()}`;
}

/**
 * Parse a Swarms session deep-link's selection params (see
 * {@link buildSwarmSessionPath}) from a search string. Every field is optional —
 * a bare `/swarms` visit returns all-undefined.
 */
export function parseSwarmSessionParams(search: string): {
  personaRefId?: string;
  runId?: string;
  hostId?: string;
  threadId?: string;
} {
  const params = new URLSearchParams(search);
  const pick = (key: string) => {
    const value = params.get(key);
    return value && value.trim() ? value : undefined;
  };
  return {
    personaRefId: pick("persona"),
    runId: pick("run"),
    hostId: pick("host"),
    threadId: pick("session"),
  };
}

/**
 * Build a deep-link to the cross-surface Sessions page, optionally focused on
 * one session.
 *
 * Unlike {@link buildSwarmSessionPath} this carries no selection chain: the
 * Sessions detail pane loads by `threadId` alone (`ShareUsageThreadDetail`
 * subscribes per-thread), so a link never has to describe how to page a list
 * to the row. That is what lets the backend mint `/sessions?session=…` as the
 * universal permalink fallback for a session whose surface-native target does
 * not exist (an eval Quick Run, a session whose parent run was deleted).
 *
 * `project` is threaded explicitly rather than inherited from the recipient's
 * picker, and it goes in the PATH: a link minted for one project must open
 * that project for whoever follows it, including on a refresh, which a
 * consumed-and-stripped query parameter could not survive.
 */
export function buildSessionsPath(
  opts: { session?: string; project?: string } = {}
): string {
  const search = new URLSearchParams();
  if (opts.session) search.set("session", opts.session);
  const query = search.toString();
  const logical = query
    ? `${routePaths.sessions}?${query}`
    : routePaths.sessions;
  return opts.project ? buildProjectPath(opts.project, logical) : logical;
}

/** Build a path for a specific organization route. */
export function buildOrganizationPath(
  orgId: string,
  section?: OrganizationRouteSection
): string {
  if (section === "billing") return `/organizations/${orgId}/billing`;
  if (section === "models") return `/organizations/${orgId}/models`;
  // The Slack section's sub-tabs live in `?tab=`, not in the path: they are
  // one settings screen with three views, not three org routes, and keeping
  // them out of the path means the nav, the surface manifest and the route
  // table each gain exactly one entry.
  if (section === "slack") return `/organizations/${orgId}/slack`;
  // Discord has no sub-tabs at all (see DiscordAgentSettingsSection), so it
  // needs even less than Slack does — one segment, no `?tab=`.
  if (section === "discord") return `/organizations/${orgId}/discord`;
  return `/organizations/${orgId}`;
}

/**
 * Build an eval route path in Suites mode from a typed EvalRoute.
 */
export function buildEvalsPath(route: EvalRoute): string {
  return buildEvalRoutePath(routePaths.evals, route);
}

/** Build the same typed EvalRoute in Runs mode (`/evals/runs/...`). */
export function buildEvalsRunsPath(route: EvalRoute): string {
  return buildEvalRoutePath(routePaths.evalsRuns, route);
}

/**
 * Build the same typed EvalRoute under Evaluate (New) (`/evaluate/...`).
 *
 * `commit-detail` has no home here — `buildEvalRoutePath` degrades it to this
 * prefix's list, which is right: the commit lens is a Runs-mode view and stays
 * on `/evals/runs`.
 */
export function buildEvaluatePath(route: EvalRoute): string {
  return buildEvalRoutePath(routePaths.evaluate, route);
}

/**
 * Legacy `/ci-evals/*` → `/evals/runs/*`, for the router's redirect loader.
 *
 * A raw-string prefix rewrite rather than a rebuild from route params: the
 * sub-tree is matched with a splat, and the string form preserves commit SHAs
 * and suite ids exactly as they were encoded. Query and hash come along —
 * commit links carry `?suite=&iteration=`, run links carry
 * `?iteration=&case=&compareTo=`, and anything can carry `?project=`.
 *
 * These URLs shipped in CI logs, bookmarks, and the SDK quickstart's
 * post-sign-in return path, so they redirect rather than 404 into the
 * catch-all (which renders Servers — a silently wrong landing page).
 */
export function legacyCiEvalsPathToRunsPath(
  pathname: string,
  search = "",
  hash = ""
): string {
  return `${pathname.replace(
    /^\/ci-evals/,
    routePaths.evalsRuns
  )}${search}${hash}`;
}

function buildEvalRoutePath(prefix: EvalRoutePrefix, route: EvalRoute): string {
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
      return `${prefix}/suite/${encodeURIComponent(route.suiteId)}${
        query ? `?${query}` : ""
      }`;
    }
    case "run-detail": {
      const params = new URLSearchParams();
      if (route.iteration) params.set("iteration", route.iteration);
      if (route.testCaseId) params.set("case", route.testCaseId);
      if (route.insightsFocus) params.set("insights", "1");
      if (route.compareToRunId) params.set("compareTo", route.compareToRunId);
      const query = params.toString();
      return `${prefix}/suite/${encodeURIComponent(
        route.suiteId
      )}/runs/${encodeURIComponent(route.runId)}${query ? `?${query}` : ""}`;
    }
    case "test-detail": {
      const params = new URLSearchParams();
      if (route.iteration) params.set("iteration", route.iteration);
      const query = params.toString();
      return `${prefix}/suite/${encodeURIComponent(
        route.suiteId
      )}/test/${encodeURIComponent(route.testId)}${query ? `?${query}` : ""}`;
    }
    case "test-edit": {
      const params = new URLSearchParams();
      if (route.openCompare) params.set("compare", "1");
      if (route.iteration) params.set("iteration", route.iteration);
      const query = params.toString();
      return `${prefix}/suite/${encodeURIComponent(
        route.suiteId
      )}/test/${encodeURIComponent(route.testId)}/edit${
        query ? `?${query}` : ""
      }`;
    }
    case "suite-edit":
      return `${prefix}/suite/${encodeURIComponent(route.suiteId)}/edit`;
    case "commit-detail": {
      // Commits are a Runs-mode lens: Suites mode has no cross-suite SHA view,
      // so a commit route built there degrades to that mode's list.
      if (prefix !== routePaths.evalsRuns) return prefix;
      const params = new URLSearchParams();
      if (route.suite) params.set("suite", route.suite);
      if (route.iteration) params.set("iteration", route.iteration);
      const query = params.toString();
      return `${prefix}/commit/${encodeURIComponent(route.commitSha)}${
        query ? `?${query}` : ""
      }`;
    }
  }
}

export interface AppNavigateOptions {
  replace?: boolean;
  /**
   * Navigate to the LOGICAL path, refusing to inherit the current project.
   *
   * Rare and deliberate: the only caller is the screen shown when a project
   * URL cannot be resolved, whose way out must not be "the project you just
   * failed to open". Everything else wants the inheritance.
   */
  unscoped?: boolean;
}

/**
 * The pathname the app is actually on, preferring the router's own location.
 *
 * `window.location` lags a router navigation that is still committing, and the
 * scope decision below has to be made against where the user IS, not where the
 * browser has finished painting.
 */
function currentAppPathname(): string {
  const routerPathname = getAppRouter()?.state?.location?.pathname;
  if (routerPathname) return routerPathname;
  return getWindowFallbackPathname();
}

/**
 * Carry the current project into a project-owned target.
 *
 * The one conversion from logical to concrete. It is deliberately derived
 * from the CURRENT URL rather than from an ambient "active project" variable:
 * two tabs can be on two different projects, and a module-level default would
 * be a second source of truth for the very thing the URL now owns.
 *
 * Left alone: already-scoped paths (idempotent), global and public targets
 * (Settings must never gain a project), bare `?query`/`#hash` navigations,
 * anything off-origin, and any path no route claims.
 */
export function scopeNavigationTarget(
  to: string,
  fromPathname?: string
): string {
  if (typeof to !== "string" || !to) return to;
  if (to.startsWith("?") || to.startsWith("#")) return to;
  if (!isAppRelativeTarget(to)) return to;
  if (parseProjectPath(to)) return to;
  const current = parseProjectPath(fromPathname ?? currentAppPathname());
  if (!current) return to;
  const logical = to.split(/[?#]/)[0];
  if (!isProjectScopedRoutePath(logical)) return to;
  return buildProjectPath(current.projectId, to);
}

/**
 * Imperative navigate from a non-React caller (IPC bridge, OAuth callback).
 *
 * Prefer `useAppNavigate()` inside components. Falls back to writing
 * `window.history` directly if the router has not yet been created
 * (e.g. very early bootstrap).
 */
export function navigateApp(to: string, options?: AppNavigateOptions): void {
  const target = options?.unscoped ? to : scopeNavigationTarget(to);
  const router = getAppRouter();
  if (router) {
    void router.navigate(target, { replace: options?.replace });
    return;
  }
  if (options?.replace) {
    window.history.replaceState({}, "", target);
  } else {
    window.history.pushState({}, "", target);
  }
  window.dispatchEvent(new PopStateEvent("popstate"));
}

/**
 * React hook returning a typed navigate function.
 *
 * Reads the router's navigation context directly so the hook call shape is
 * unconditional (Rules of Hooks compliant). When mounted outside a Router
 * (e.g. component tests rendering without a `<MemoryRouter>`), the navigator
 * context is undefined and the callback falls back to `navigateApp`.
 */
export function useAppNavigate() {
  const navigationContext = useContext(UNSAFE_NavigationContext);
  const locationContext = useContext(UNSAFE_LocationContext);
  const navigator = navigationContext?.navigator;
  const pathname = locationContext?.location.pathname;
  return useCallback(
    (to: string, options?: AppNavigateOptions) => {
      const target = options?.unscoped
        ? to
        : scopeNavigationTarget(to, pathname);
      if (navigator) {
        if (options?.replace) {
          navigator.replace(target);
        } else {
          navigator.push(target);
        }
        return;
      }
      navigateApp(target, options);
    },
    [navigator, pathname]
  );
}

/**
 * Strip the leading slash from the first pathname segment so `useActiveTab()`
 * returns `"servers"` (matching the legacy `activeTab` state shape).
 *
 * Phase 3: this is the single source of truth for `activeTab`; App.tsx keeps
 * the old render tree but reads the tab from the URL.
 */
export function useActiveTab(): string {
  const locationContext = useContext(UNSAFE_LocationContext);
  const [fallbackPathname, setFallbackPathname] = useState(
    getWindowFallbackPathname
  );

  useLayoutEffect(() => {
    if (locationContext || typeof window === "undefined") return;
    const syncFallbackPathname = () => {
      setFallbackPathname(getWindowFallbackPathname());
    };
    window.addEventListener("popstate", syncFallbackPathname);
    return () => {
      window.removeEventListener("popstate", syncFallbackPathname);
    };
  }, [locationContext]);

  const pathname = locationContext?.location.pathname ?? fallbackPathname;
  return pathnameToActiveTab(pathname);
}

/**
 * The live pathname, router-first with a `window` fallback and a `popstate`
 * listener for the no-router render path.
 *
 * Same shape as `useActiveTab` and for the same reason: components in this app
 * are mounted without a `<Router>` in unit tests, where `useLocation()` throws.
 * Subscribing to the location context is what makes the project route
 * coordinator reconcile CONTINUOUSLY — Back/Forward and an in-app A → B
 * navigation change the pathname without remounting anything, and a
 * once-per-mount reader would miss both.
 */
export function useCurrentPathname(): string {
  const locationContext = useContext(UNSAFE_LocationContext);
  const [fallbackPathname, setFallbackPathname] = useState(
    getWindowFallbackPathname
  );

  useLayoutEffect(() => {
    if (locationContext || typeof window === "undefined") return;
    const sync = () => setFallbackPathname(getWindowFallbackPathname());
    window.addEventListener("popstate", sync);
    return () => window.removeEventListener("popstate", sync);
  }, [locationContext]);

  return locationContext?.location.pathname ?? fallbackPathname;
}

export interface AppLocationParts {
  pathname: string;
  search: string;
  hash: string;
}

/**
 * The full current location (path, search, hash), router-first.
 *
 * The legacy normalizer needs all three: it rewrites the path, drops exactly
 * one query field, and must hand back the hash byte-for-byte.
 */
export function useCurrentLocationParts(): AppLocationParts {
  const locationContext = useContext(UNSAFE_LocationContext);
  const [fallback, setFallback] = useState(getWindowFallbackLocationParts);

  useLayoutEffect(() => {
    if (locationContext || typeof window === "undefined") return;
    const sync = () => setFallback(getWindowFallbackLocationParts());
    window.addEventListener("popstate", sync);
    return () => window.removeEventListener("popstate", sync);
  }, [locationContext]);

  const location = locationContext?.location;
  if (!location) return fallback;
  return {
    pathname: location.pathname || "/",
    search: location.search || "",
    hash: location.hash || "",
  };
}

function getWindowFallbackLocationParts(): AppLocationParts {
  if (typeof window === "undefined") {
    return { pathname: "/", search: "", hash: "" };
  }
  return {
    pathname: window.location.pathname || "/",
    search: window.location.search || "",
    hash: window.location.hash || "",
  };
}

/**
 * Every tab segment that resolves to a real screen — DERIVED from the
 * surface manifests (`shared/app-surfaces.ts`), which are also what the
 * agent's atlas and the route-coverage tests read.
 *
 * It used to be a hand-maintained union of the hosted-policy lists plus a
 * few literals, which is a drift hazard in the one direction that matters:
 * add a screen, forget this list, and the screen silently becomes
 * unreachable by `ui_navigate` while `pathnameToActiveTab` quietly resolves
 * it to Servers. Now the manifest is the single place to add.
 *
 * The hosted policy (`hosted-tab-policy.ts`) stays as a FILTER over these
 * segments — availability is a separate question from existence — and it is
 * derived from the same manifests, so it cannot name a segment that no
 * longer exists.
 */
const KNOWN_APP_TAB_SEGMENTS = new Set<string>(listAppSurfaceNavSegments());

export function isKnownAppTabSegment(segment: string): boolean {
  return KNOWN_APP_TAB_SEGMENTS.has(segment);
}

export function listKnownAppTabSegments(): string[] {
  return [...KNOWN_APP_TAB_SEGMENTS];
}

function isSpecialEntryPathname(pathname: string): boolean {
  return (
    pathname === "/billing" ||
    pathname === "/billing/" ||
    pathname === "/callback" ||
    pathname === "/callback/" ||
    pathname.startsWith("/oauth/callback")
  );
}

/**
 * The OAuth debugger callback (`/oauth/callback/debug`) runs in a throwaway
 * popup that only relays its code to the opener and closes. It must render
 * WITHOUT `<AuthKitProvider>` (see main.tsx): AuthKit's on-load refresh rotates
 * the shared WorkOS token from this short-lived context, intermittently
 * dropping the opener window's session.
 */
export function isDebugOAuthCallbackPath(pathname: string): boolean {
  return (
    pathname === "/oauth/callback/debug" ||
    pathname.startsWith("/oauth/callback/debug/")
  );
}

/**
 * One conformance run's immutable detail URL.
 *
 * The project rides in the PATH now. It used to be `?project=<id>`, which the
 * app accepted, consumed, and stripped — leaving a URL that no longer said
 * which project it belonged to, so a refresh or a re-share went back to
 * whatever project the reader was parked on.
 */
export function buildConformanceRunPath(
  runId: string,
  projectId?: string | null
): string {
  const base = `${routePaths.conformanceRuns}/${encodeURIComponent(runId)}`;
  return projectId ? buildProjectPath(projectId, base) : base;
}

export function buildConformanceSharePath(token: string): string {
  return `${routePaths.conformanceShared}/${encodeURIComponent(token)}`;
}

export function buildEvalSharePath(token: string): string {
  return `${routePaths.evalsShared}/${encodeURIComponent(token)}`;
}

export function pathnameToActiveTab(rawPathname: string): string {
  // Every first-segment parser in the app funnels through here, so this is
  // where the project prefix comes off: `/p/<id>/servers` is the Servers tab,
  // not a tab called "p".
  const pathname = stripProjectFromPath(rawPathname);
  if (isSpecialEntryPathname(pathname)) return "servers";
  if (pathname.startsWith(`${routePaths.capabilities}/`)) {
    return "host-compare";
  }
  const firstSegment = pathname.replace(/^\/+/, "").split("/")[0] || "home";
  const normalized = normalizeHostedHashTab(firstSegment);
  // Unknown first segments include scenario slugs; App handles those surfaces
  // before route rendering, so the shell falls back to the safe servers body.
  return KNOWN_APP_TAB_SEGMENTS.has(normalized) ? normalized : "servers";
}

function getWindowFallbackPathname(): string {
  if (typeof window === "undefined") return "/";
  return window.location.pathname || "/";
}

export interface CurrentOrgRoute {
  orgId: string;
  orgSection: OrganizationRouteSection;
}

export function useCurrentOrgRoute(): CurrentOrgRoute | null {
  const locationContext = useContext(UNSAFE_LocationContext);
  const pathname =
    locationContext?.location.pathname ??
    (typeof window === "undefined" ? "/" : window.location.pathname);
  const segments = pathname.replace(/^\/+/, "").split("/");
  if (segments[0] !== "organizations") return null;
  const orgId = segments[1];
  if (!orgId) return null;
  const orgSection = parseOrganizationSection(segments[2]);
  return { orgId: decodePathSegment(orgId), orgSection };
}

/**
 * One query-string parameter from the current location.
 *
 * Reads the router's location context directly — with a `window` fallback —
 * for the same reason `useActiveTab` does: components in this app are rendered
 * without a `<Router>` in unit tests, and `useSearchParams` throws there.
 * Subscribing to the context (rather than reading `window.location` alone) is
 * what makes a `?tab=` change re-render the component that reads it.
 */
export function useCurrentSearchParam(name: string): string | null {
  const locationContext = useContext(UNSAFE_LocationContext);
  const [fallbackSearch, setFallbackSearch] = useState(getWindowFallbackSearch);

  // Mirrors `useActiveTab`: without the listener the no-router path reads the
  // query string once and never again, so a `?tab=` change would move history
  // and leave the component rendering the previous tab.
  useLayoutEffect(() => {
    if (locationContext || typeof window === "undefined") return;
    const syncFallbackSearch = () =>
      setFallbackSearch(getWindowFallbackSearch());
    window.addEventListener("popstate", syncFallbackSearch);
    return () => {
      window.removeEventListener("popstate", syncFallbackSearch);
    };
  }, [locationContext]);

  const search = locationContext?.location.search ?? fallbackSearch;
  return new URLSearchParams(search).get(name);
}

function getWindowFallbackSearch(): string {
  if (typeof window === "undefined") return "";
  return window.location.search || "";
}

function decodePathSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

export function navigationTargetToPath(
  rawTarget: string,
  fallback: string = routePaths.servers
): string {
  // A scoped target normalizes on its LOGICAL half and is re-scoped to the
  // same project. Without this, `/p/A/evals/suite/X` would reduce to the
  // fallback (`/servers`) — which is exactly how a sign-in round trip used to
  // lose the page the user asked for.
  const scoped = parseProjectPath(rawTarget);
  if (scoped) {
    const { suffix, path } = (() => {
      const stripped = stripProjectFromPath(rawTarget);
      const cut = stripped.search(/[?#]/);
      return cut === -1
        ? { path: stripped, suffix: "" }
        : { path: stripped.slice(0, cut), suffix: stripped.slice(cut) };
    })();
    const logical = navigationTargetToPath(`${path}${suffix}`, fallback);
    return buildProjectPath(scoped.projectId, logical);
  }
  const stripped = rawTarget.replace(/^#/, "").replace(/^\/+/, "");
  const questionIndex = stripped.indexOf("?");
  const pathPart =
    questionIndex === -1 ? stripped : stripped.slice(0, questionIndex);
  const queryPart = questionIndex === -1 ? "" : stripped.slice(questionIndex);
  const segments = pathPart.split("/").filter(Boolean);
  const normalizedTab = normalizeHostedHashTab(segments[0] || "servers");
  if (!KNOWN_APP_TAB_SEGMENTS.has(normalizedTab)) return fallback;
  // The tab id and the public path segment agree everywhere except User
  // Testing, whose tab id stayed `scenarios`. Emit the canonical path so
  // agent navigation and legacy bookmarks land directly instead of bouncing
  // through the `/scenarios` redirect.
  const pathSegment =
    normalizedTab === "scenarios" ? "user-testing" : normalizedTab;
  return `/${[pathSegment, ...segments.slice(1)].join("/")}${queryPart}`;
}

export function legacyHashBookmarkToPath(hash: string): string | null {
  const fragment = hash.replace(/^#\/?/, "");
  if (!fragment) return null;
  const firstSegment = fragment.split(/[/?]/)[0] || "";
  const normalizedFirstSegment = normalizeHostedHashTab(firstSegment);
  if (!KNOWN_APP_TAB_SEGMENTS.has(normalizedFirstSegment)) return null;
  const normalizedFragment =
    normalizedFirstSegment === firstSegment
      ? fragment
      : `${normalizedFirstSegment}${fragment.slice(firstSegment.length)}`;
  return navigationTargetToPath(normalizedFragment);
}

export function normalizeInitialLegacyHashBookmark(): void {
  if (typeof window === "undefined") return;
  const pathname = window.location.pathname || "/";
  if (pathname !== "/" && pathname !== "") return;
  const path = legacyHashBookmarkToPath(window.location.hash);
  if (!path) return;
  window.history.replaceState({}, "", path);
}

/**
 * A stored "come back here" path → a path this app will actually navigate to.
 *
 * Two jobs: refuse anything that could leave this origin (an absolute URL, a
 * protocol-relative one, a backslash the browser folds into a slash), and
 * keep a valid `/p/<projectId>/...` intact instead of reducing it to
 * `/servers`. The second one is postcondition 7 of the canonical-URL work: the
 * complete URL, project and all, survives a sign-in round trip.
 */
export function normalizeReturnTargetPath(
  target?: string | null,
  fallback: string = routePaths.servers
): string {
  const trimmed = target?.trim() ?? "";
  if (!trimmed) return fallback;
  if (!isAppRelativeTarget(trimmed)) return fallback;
  return navigationTargetToPath(trimmed, fallback);
}

export function captureCurrentReturnPath(): string | null {
  if (typeof window === "undefined") return null;
  const pathname = window.location.pathname || routePaths.root;
  const search = window.location.search || "";
  // The hash is part of the destination on eval and scenario deep links
  // (`#case`, `#scenario-slug`); dropping it returns the user to the page but
  // not to the thing on it.
  const hash = window.location.hash || "";
  if (pathname === routePaths.root || pathname === "") return null;
  return `${pathname}${search}${hash}`;
}

/**
 * Where selecting another project in the picker lands.
 *
 * Deterministic and URL-first: the picker NAVIGATES, and the project route
 * coordinator performs the state switch because the URL changed. The previous
 * shape — switch hidden state, then repair the URL from an effect — is what
 * made project switching racy: two effects (a snap-to-Servers and a
 * deep-link resolver) both wrote the URL from a project change they had each
 * observed at a different moment.
 *
 * Servers rather than "stay where you are": the current path can name a
 * resource that only exists in the project being left (`/evals/suite/<id>`),
 * and carrying that id across projects renders someone else's empty state.
 */
export function buildProjectSwitchTarget(projectId: string): string {
  return buildProjectPath(projectId, routePaths.servers);
}

/** The per-project settings gear in the picker — one gesture, one URL. */
export function buildProjectSettingsTarget(projectId: string): string {
  return buildProjectPath(projectId, routePaths.projectSettings);
}

export function getInvalidOrganizationRouteNavigationTarget({
  routeTab,
  routeOrganizationId,
  isLoadingOrganizations,
  hasRouteOrganization,
}: {
  routeTab: string;
  routeOrganizationId?: string;
  isLoadingOrganizations: boolean;
  hasRouteOrganization: boolean;
}): string | null {
  if (routeTab !== "organizations" || isLoadingOrganizations) {
    return null;
  }

  if (!routeOrganizationId || !hasRouteOrganization) {
    return routePaths.servers;
  }

  return null;
}
