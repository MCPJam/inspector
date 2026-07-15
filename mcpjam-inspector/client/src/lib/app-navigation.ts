/**
 * Centralized navigation API for the inspector app.
 *
 * Central wrapper around React Router's navigate/location primitives.
 *
 * URLs are path-based (`/servers`, `/organizations/:orgId/billing`, etc.)
 * matching `react-router` semantics. Chatbox session hashes
 * (`#chatbox-slug`) are NOT app navigation and are preserved verbatim.
 */
import { useCallback, useContext, useLayoutEffect, useState } from "react";
import { UNSAFE_LocationContext, UNSAFE_NavigationContext } from "react-router";
import { getAppRouter } from "../router-ref";
import type { EvalRoute } from "./eval-route-types";
import {
  HOSTED_HASH_ALLOWED_TABS,
  HOSTED_HASH_BLOCKED_TABS,
  normalizeHostedHashTab,
} from "./hosted-tab-policy";

export type OrganizationRouteSection = "overview" | "billing" | "models";

/** Typed canonical paths used across the app. */
export const routePaths = {
  root: "/",
  home: "/home",
  servers: "/servers",
  hosts: "/hosts",
  hostCompare: "/host-compare",
  /** Chrome-less host-compare for vanity domains (caniuse.dev) — no sidebar/nav, bypasses NUX. */
  embedHostCompare: "/embed/host-compare",
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
  compatibility: "/compatibility",
  oauthFlow: "/oauth-flow",
  xaaFlow: "/xaa-flow",
  tracing: "/tracing",
  chatboxes: "/chatboxes",
  swarms: "/swarms",
  playground: "/playground",
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

/**
 * Build a path that deep-links to one chatbox session in the Sessions tab.
 * `host` selects the previewed host (chatboxes are 1:1 with hosts) and
 * `session` is the sharedChatThreads doc id to open in the detail pane.
 */
export function buildChatboxSessionPath(
  hostId: string,
  threadId: string,
  // Which product surface the session link should open on. Both surfaces host
  // a Sessions tab over the same chatbox; the agent Swarm keeps links on
  // `/swarms` so a shared link doesn't bounce the recipient to the human
  // Chatbox surface.
  basePath: string = routePaths.chatboxes,
): string {
  const search = new URLSearchParams({ host: hostId, session: threadId });
  return `${basePath}?${search.toString()}`;
}

/**
 * Build a Swarms deep-link to one synthetic session. Unlike the chatbox
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

/** Build a path for a specific organization route. */
export function buildOrganizationPath(
  orgId: string,
  section?: OrganizationRouteSection
): string {
  if (section === "billing") return `/organizations/${orgId}/billing`;
  if (section === "models") return `/organizations/${orgId}/models`;
  return `/organizations/${orgId}`;
}

/**
 * Build an eval (Playground) route path from a typed EvalRoute.
 */
export function buildEvalsPath(route: EvalRoute): string {
  return buildEvalRoutePath("/evals", route);
}

export function buildCiEvalsPath(route: EvalRoute): string {
  return buildEvalRoutePath("/ci-evals", route);
}

function buildEvalRoutePath(
  prefix: "/evals" | "/ci-evals",
  route: EvalRoute
): string {
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
      if (prefix !== "/ci-evals") return prefix;
      const params = new URLSearchParams();
      if (route.suite) params.set("suite", route.suite);
      if (route.iteration) params.set("iteration", route.iteration);
      const query = params.toString();
      return `/ci-evals/commit/${encodeURIComponent(route.commitSha)}${
        query ? `?${query}` : ""
      }`;
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
  if (options?.replace) {
    window.history.replaceState({}, "", to);
  } else {
    window.history.pushState({}, "", to);
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
  const navigator = navigationContext?.navigator;
  return useCallback(
    (to: string, options?: AppNavigateOptions) => {
      if (navigator) {
        if (options?.replace) {
          navigator.replace(to);
        } else {
          navigator.push(to);
        }
        return;
      }
      navigateApp(to, options);
    },
    [navigator]
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

const KNOWN_APP_TAB_SEGMENTS = new Set<string>([
  ...HOSTED_HASH_ALLOWED_TABS,
  ...HOSTED_HASH_BLOCKED_TABS,
  "chat",
  "home",
  // Top-level cross-host config comparison surface. Distinct first segment
  // from "clients" so the sidebar's first-segment isActive resolution
  // doesn't light up Connect when this is the active route.
  "host-compare",
  // Project Computers tab — a peer of the connect views (Servers/Host/
  // Compare). Its own first segment so return-target normalization and
  // activeTab resolution treat /computer as a known route, not a fallback
  // to Servers.
  "computer",
]);

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

export function pathnameToActiveTab(pathname: string): string {
  if (isSpecialEntryPathname(pathname)) return "servers";
  if (pathname.startsWith(`${routePaths.capabilities}/`)) {
    return "host-compare";
  }
  const firstSegment = pathname.replace(/^\/+/, "").split("/")[0] || "home";
  const normalized = normalizeHostedHashTab(firstSegment);
  // Unknown first segments include chatbox slugs; App handles those surfaces
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
  const sectionSegment = segments[2];
  const orgSection: OrganizationRouteSection =
    sectionSegment === "billing"
      ? "billing"
      : sectionSegment === "models"
      ? "models"
      : "overview";
  return { orgId: decodePathSegment(orgId), orgSection };
}

function decodePathSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

// ── XAA setup center (`/xaa-flow/setup[/:section]`) ─────────────────────────

export type XaaSetupSection = "people" | "apps";

const XAA_SETUP_BASE_PATH = `${routePaths.xaaFlow}/setup`;

/** Build a deep-linkable setup-center path. `people` is the default section
 * and canonicalizes to the bare `/xaa-flow/setup`. */
export function buildXaaSetupPath(section?: XaaSetupSection): string {
  return section && section !== "people"
    ? `${XAA_SETUP_BASE_PATH}/${section}`
    : XAA_SETUP_BASE_PATH;
}

/** Resolve the active setup section from a pathname; null when the pathname
 * is not a setup-center route. Unknown section segments fall back to the
 * default section rather than 404ing a shared link. The retired `access`
 * section was absorbed into `apps`, so old deep links land on the app list. */
export function parseXaaSetupSection(pathname: string): XaaSetupSection | null {
  const segments = pathname.replace(/^\/+/, "").split("/");
  if (segments[0] !== "xaa-flow" || segments[1] !== "setup") return null;
  const sectionSegment = segments[2];
  return sectionSegment === "apps" || sectionSegment === "access"
    ? "apps"
    : "people";
}

/**
 * Deep link into the XAA debugger with a registered resource app
 * preselected. A full navigation (not a client-side route push): the
 * debugger captures the `resource` query param at module load, so an SPA
 * push after boot would be ignored.
 */
export function openXaaAppInDebugger(appId: string): void {
  window.location.assign(
    `${routePaths.xaaFlow}?resource=${encodeURIComponent(appId)}`
  );
}

/** Active setup section from the current location (pattern: useCurrentOrgRoute). */
export function useXaaSetupSection(): XaaSetupSection {
  const locationContext = useContext(UNSAFE_LocationContext);
  const pathname =
    locationContext?.location.pathname ??
    (typeof window === "undefined" ? "/" : window.location.pathname);
  return parseXaaSetupSection(pathname) ?? "people";
}

export function navigationTargetToPath(
  rawTarget: string,
  fallback: string = routePaths.servers
): string {
  const stripped = rawTarget.replace(/^#/, "").replace(/^\/+/, "");
  const questionIndex = stripped.indexOf("?");
  const pathPart =
    questionIndex === -1 ? stripped : stripped.slice(0, questionIndex);
  const queryPart = questionIndex === -1 ? "" : stripped.slice(questionIndex);
  const segments = pathPart.split("/").filter(Boolean);
  const normalizedTab = normalizeHostedHashTab(segments[0] || "servers");
  if (!KNOWN_APP_TAB_SEGMENTS.has(normalizedTab)) return fallback;
  return `/${[normalizedTab, ...segments.slice(1)].join("/")}${queryPart}`;
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

export function normalizeReturnTargetPath(
  target?: string | null,
  fallback: string = routePaths.servers
): string {
  const trimmed = target?.trim() ?? "";
  if (!trimmed) return fallback;
  return navigationTargetToPath(trimmed, fallback);
}

export function captureCurrentReturnPath(): string | null {
  if (typeof window === "undefined") return null;
  const pathname = window.location.pathname || routePaths.root;
  const search = window.location.search || "";
  if (pathname === routePaths.root || pathname === "") return null;
  return `${pathname}${search}`;
}

export function getProjectSwitchNavigationTarget({
  activeTab,
  activeOrganizationId,
  nextProjectOrganizationId,
}: {
  activeTab: string;
  activeOrganizationId?: string;
  nextProjectOrganizationId?: string;
}): string | null {
  if (activeTab !== "organizations") {
    return null;
  }

  if (
    !activeOrganizationId ||
    !nextProjectOrganizationId ||
    nextProjectOrganizationId !== activeOrganizationId
  ) {
    return routePaths.servers;
  }

  return null;
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

/**
 * Decide whether an active-project change should snap the user to Servers.
 *
 * Staying on a project-scoped page (App Builder/Chat) after the active project
 * changes would leave the user pointed at a project that no longer exists, so
 * we snap to Servers. But not every project change is a manual switch: opening
 * another org's settings (e.g. via the switcher's per-row gear) flips the
 * active org, which auto-resolves a new active project as a *side effect* while
 * the user deliberately navigates to the org page. Organization routes are
 * org-scoped, not project-scoped, so snapping there would bounce the user right
 * back off the settings they just opened.
 *
 * The initial hydration (no previous id) and the local-default `"none"`
 * placeholder are never treated as real switches.
 */
export function shouldSnapToServersOnActiveProjectChange({
  previousActiveProjectId,
  nextActiveProjectId,
  activeTab,
}: {
  previousActiveProjectId: string | null;
  nextActiveProjectId: string;
  activeTab: string;
}): boolean {
  if (
    previousActiveProjectId == null ||
    previousActiveProjectId === nextActiveProjectId ||
    previousActiveProjectId === "none" ||
    nextActiveProjectId === "none"
  ) {
    return false;
  }

  if (activeTab === "organizations") {
    return false;
  }

  return true;
}
