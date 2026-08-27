/**
 * The route table, as data.
 *
 * `router.tsx` maps each entry to a React element; the coverage tests read
 * this module alone. That split is the point: `router.tsx` eagerly imports
 * ~30 route components from the App monolith, so a test importing it would
 * drag PostHog, Convex, and every store into jsdom to answer a question
 * about strings.
 *
 * Every route declares its `kind`, so a non-screen is an explicit, typed
 * decision rather than an entry on an exceptions list somewhere else:
 *
 *   - `screen`   — a real user destination. MUST name a manifest in
 *                  `shared/app-surfaces.ts`; CI fails otherwise, which is
 *                  what stops a new screen from shipping agent-invisible.
 *   - `redirect` — bounces elsewhere and renders nothing of its own.
 *   - `special`  — renders, but isn't a destination a user navigates to:
 *                  OAuth callbacks, the chrome-less embed, the catch-all.
 *
 * Every route also declares a `scope` (see {@link AppRouteScope}). A
 * `scope: "project"` route is registered canonically ONLY below
 * `/p/:projectId` — the paths here stay logical and project-relative, and
 * `buildProjectPath` turns one into the concrete browser path.
 */
import type { AppSurfaceId } from "@/shared/app-surfaces";

/**
 * Who owns a route.
 *
 *   - `project` — the screen reads or mutates project-owned data (the active
 *     project's servers, hosts, environments, evals, sessions…). Its ONLY
 *     canonical registration is below `/p/:projectId`, so the project a
 *     visitor is looking at lives in the address bar rather than in hidden
 *     local state. The path declared here stays LOGICAL (`servers`,
 *     `evals/suite/:suiteId`): a literal `:projectId` in the table would be
 *     unusable for navigation and meaningless in a surface manifest.
 *   - `global` — authenticated app chrome that is not a project: account and
 *     application settings, organizations, billing, the capability pages.
 *   - `public` — no project, and often no session: embeds, share tokens,
 *     OAuth callbacks, the sign-in entry.
 *
 * An explicit dimension rather than a guess from the path name. "Does this
 * screen belong to a project" is not something `/sessions` vs `/settings`
 * tells you, and getting it wrong either strands a screen outside its project
 * or prefixes a global one with a project it must not have.
 */
export type AppRouteScope = "project" | "global" | "public";

export type AppRouteEntry =
  | {
      path: string;
      kind: "screen";
      surfaceId: AppSurfaceId;
      scope: AppRouteScope;
    }
  | {
      path: string;
      kind: "redirect" | "special";
      note: string;
      scope: AppRouteScope;
    };

export const APP_ROUTES: readonly AppRouteEntry[] = [
  { path: "/", kind: "screen", surfaceId: "home", scope: "project" },
  { path: "home", kind: "screen", surfaceId: "home", scope: "project" },
  { path: "servers", kind: "screen", surfaceId: "servers", scope: "project" },
  // Exact permalink targets on Connect. Both render the same screen — the
  // route param is what selects, so a link survives the auth-gate remounts a
  // cold boot puts it through (same pattern as `user-testing/:scenarioId`).
  // `servers/plugins/:pluginId` is deeper than `servers/:serverId`, so the
  // two never compete: a two-segment URL can only be a server.
  {
    path: "servers/plugins/:pluginId",
    kind: "screen",
    surfaceId: "servers",
    scope: "project",
  },
  {
    path: "servers/:serverId",
    kind: "screen",
    surfaceId: "servers",
    scope: "project",
  },
  {
    path: "clients",
    kind: "redirect",
    note: "Legacy: the tab was renamed Client → Host; redirects to /hosts.",
    scope: "project",
  },
  {
    path: "clients/:hostId",
    kind: "redirect",
    note: "Legacy deep link; re-encoded through buildHostsPath.",
    scope: "project",
  },
  {
    path: "host-compare",
    kind: "screen",
    surfaceId: "host-compare",
    scope: "global",
  },
  {
    path: "embed/host-compare",
    kind: "special",
    note: "Chrome-less vanity surface (caniuse.dev): no sidebar, no NUX.",
    scope: "public",
  },
  {
    path: "embed/score",
    kind: "special",
    note: "Chrome-less vanity surface (score.mcpjam.com): the conformance-score runner. No sidebar, no NUX.",
    scope: "public",
  },
  {
    path: "results/:runToken",
    kind: "special",
    note: "One score run's report. Public by link token — no session required to read it.",
    scope: "public",
  },
  {
    path: "capabilities/:capabilitySlug",
    kind: "screen",
    surfaceId: "host-compare",
    scope: "global",
  },
  { path: "computer", kind: "screen", surfaceId: "computer", scope: "project" },
  { path: "hosts", kind: "screen", surfaceId: "hosts", scope: "project" },
  {
    path: "hosts/:hostId",
    kind: "screen",
    surfaceId: "hosts",
    scope: "project",
  },
  { path: "registry", kind: "screen", surfaceId: "registry", scope: "project" },
  { path: "tools", kind: "screen", surfaceId: "tools", scope: "project" },
  {
    path: "resources",
    kind: "screen",
    surfaceId: "resources",
    scope: "project",
  },
  { path: "prompts", kind: "screen", surfaceId: "prompts", scope: "project" },
  { path: "tasks", kind: "screen", surfaceId: "tasks", scope: "project" },
  { path: "skills", kind: "screen", surfaceId: "skills", scope: "project" },
  // Project-scoped despite the generic name, per the pre-commit audit: a
  // lesson LAUNCHES an agent session into the active project
  // (`launchLessonSession({ tour, projectId })`), so which project the reader
  // is in decides where their tutorial work lands.
  {
    path: "learning",
    kind: "screen",
    surfaceId: "learning",
    scope: "project",
  },
  {
    path: "conformance",
    kind: "screen",
    surfaceId: "conformance",
    scope: "project",
  },
  {
    path: "conformance/runs/:runId",
    kind: "screen",
    surfaceId: "conformance",
    scope: "project",
  },
  {
    path: "conformance/shared/:token",
    kind: "special",
    note: "Read-only shared conformance run. Redeem-based (guest session or WorkOS). Legacy HMAC tokens read as invalid on this page; /api/web/conformance-shared still serves them until I6.",
    scope: "public",
  },
  {
    path: "compatibility",
    kind: "screen",
    surfaceId: "compatibility",
    scope: "project",
  },
  {
    path: "oauth-flow",
    kind: "screen",
    surfaceId: "oauth-flow",
    scope: "project",
  },
  { path: "xaa-flow", kind: "screen", surfaceId: "xaa-flow", scope: "project" },
  { path: "tracing", kind: "screen", surfaceId: "tracing", scope: "project" },
  // `ChatAliasRoute` is a `<Navigate replace>` — it renders nothing of its
  // own, exactly like `client-config`. `chat` survives as a nav SEGMENT
  // (normalized to `playground`), which is a separate question from whether
  // any screen renders here.
  {
    path: "chat",
    kind: "redirect",
    note: "Legacy alias; redirects to /playground.",
    scope: "project",
  },
  {
    path: "chat/*",
    kind: "redirect",
    note: "Legacy deep link; redirects to /playground so old bookmarks land there rather than the catch-all.",
    scope: "project",
  },
  {
    path: "user-testing",
    kind: "screen",
    surfaceId: "scenarios",
    scope: "project",
  },
  {
    path: "user-testing/new",
    kind: "screen",
    surfaceId: "scenarios",
    scope: "project",
  },
  // `:scenarioId` is the scenario's scenario id. Edit is a sibling screen
  // (setup / share / preview), not a detail tab.
  {
    path: "user-testing/:scenarioId/edit",
    kind: "screen",
    surfaceId: "scenarios",
    scope: "project",
  },
  {
    path: "user-testing/:scenarioId",
    kind: "screen",
    surfaceId: "scenarios",
    scope: "project",
  },
  {
    path: "scenarios",
    kind: "redirect",
    note: "Legacy: the Scenario surface is now User Testing. Redirects to /user-testing, preserving search + hash so old ?host=&session= links keep working.",
    scope: "project",
  },
  { path: "swarms", kind: "screen", surfaceId: "swarms", scope: "project" },
  { path: "swarms/new", kind: "screen", surfaceId: "swarms", scope: "project" },
  {
    path: "swarms/:swarmId",
    kind: "screen",
    surfaceId: "swarms",
    scope: "project",
  },
  {
    path: "environments",
    kind: "screen",
    surfaceId: "project-environments",
    scope: "project",
  },
  {
    path: "environments/:environmentId",
    kind: "screen",
    surfaceId: "project-environments",
    scope: "project",
  },
  { path: "sessions", kind: "screen", surfaceId: "sessions", scope: "project" },
  {
    path: "playground",
    kind: "screen",
    surfaceId: "playground",
    scope: "project",
  },
  { path: "support", kind: "screen", surfaceId: "support", scope: "global" },
  { path: "settings", kind: "screen", surfaceId: "settings", scope: "global" },
  {
    path: "settings/api-keys",
    kind: "screen",
    surfaceId: "settings",
    scope: "global",
  },
  {
    path: "settings/integrations",
    kind: "screen",
    surfaceId: "settings",
    scope: "global",
  },
  {
    path: "settings/integrations/github",
    kind: "screen",
    surfaceId: "settings",
    scope: "global",
  },
  {
    // Where GitHub sends the browser back — the App's setup URL and its OAuth
    // callback both point here, told apart by which query parameters arrived.
    path: "settings/integrations/github/callback",
    kind: "screen",
    surfaceId: "settings",
    scope: "global",
  },
  {
    path: "settings/github-checks",
    kind: "redirect",
    note: "Legacy: the page moved under Integrations; redirects to /settings/integrations/github.",
    scope: "global",
  },
  { path: "profile", kind: "screen", surfaceId: "profile", scope: "global" },
  {
    path: "project-settings",
    kind: "screen",
    surfaceId: "project-settings",
    scope: "project",
  },
  {
    path: "client-config",
    kind: "redirect",
    note: "Legacy alias; redirects to /servers.",
    scope: "project",
  },
  {
    path: "organizations",
    kind: "screen",
    surfaceId: "organizations",
    scope: "global",
  },
  {
    path: "organizations/:orgId",
    kind: "screen",
    surfaceId: "organizations",
    scope: "global",
  },
  {
    path: "organizations/:orgId/billing",
    kind: "screen",
    surfaceId: "organizations",
    scope: "global",
  },
  {
    path: "organizations/:orgId/models",
    kind: "screen",
    surfaceId: "organizations",
    scope: "global",
  },
  // Slack agent org settings (Connections / Capabilities / Activity). One
  // route with `?tab=` sub-tabs, and part of the `organizations` surface
  // rather than a surface of its own: it is an organization settings section,
  // reached through the same nav segment, and a separate manifest would have
  // to claim a nav segment nothing navigates to.
  {
    path: "organizations/:orgId/slack",
    kind: "screen",
    surfaceId: "organizations",
    scope: "global",
  },
  // Discord agent org settings, on the same terms as Slack above — an
  // `organizations` section, not a surface. It has no `?tab=` because it is a
  // single view (see DiscordAgentSettingsSection), which changes nothing here:
  // sub-tabs never appeared in the path for Slack either.
  // Discord agent org settings, on the same terms as Slack above — an
  // `organizations` section, not a surface. It has no `?tab=` because it is a
  // single view (see DiscordAgentSettingsSection), which changes nothing here:
  // sub-tabs never appeared in the path for Slack either.
  {
    path: "organizations/:orgId/discord",
    kind: "screen",
    surfaceId: "organizations",
    scope: "global",
  },
  {
    path: "evals/shared/:token",
    kind: "special",
    note: "Read-only shared eval run. Redeem-based (guest session or WorkOS). Chrome-less.",
    scope: "public",
  },
  { path: "evals", kind: "screen", surfaceId: "evals", scope: "project" },
  {
    path: "evals/create",
    kind: "screen",
    surfaceId: "evals",
    scope: "project",
  },
  {
    path: "evals/suite/:suiteId",
    kind: "screen",
    surfaceId: "evals",
    scope: "project",
  },
  {
    path: "evals/suite/:suiteId/runs/:runId",
    kind: "screen",
    surfaceId: "evals",
    scope: "project",
  },
  {
    path: "evals/suite/:suiteId/test/:testId",
    kind: "screen",
    surfaceId: "evals",
    scope: "project",
  },
  {
    path: "evals/suite/:suiteId/test/:testId/edit",
    kind: "screen",
    surfaceId: "evals",
    scope: "project",
  },
  {
    path: "evals/suite/:suiteId/edit",
    kind: "screen",
    surfaceId: "evals",
    scope: "project",
  },
  // Runs mode. Same suite screens as Suites mode above, plus the cross-suite
  // commit lens; one surface, two lenses over the same eval suites.
  { path: "evals/runs", kind: "screen", surfaceId: "evals", scope: "project" },
  {
    path: "evals/runs/create",
    kind: "screen",
    surfaceId: "evals",
    scope: "project",
  },
  {
    path: "evals/runs/commit/:commitSha",
    kind: "screen",
    surfaceId: "evals",
    scope: "project",
  },
  {
    path: "evals/runs/suite/:suiteId",
    kind: "screen",
    surfaceId: "evals",
    scope: "project",
  },
  {
    path: "evals/runs/suite/:suiteId/runs/:runId",
    kind: "screen",
    surfaceId: "evals",
    scope: "project",
  },
  {
    path: "evals/runs/suite/:suiteId/test/:testId",
    kind: "screen",
    surfaceId: "evals",
    scope: "project",
  },
  {
    path: "evals/runs/suite/:suiteId/test/:testId/edit",
    kind: "screen",
    surfaceId: "evals",
    scope: "project",
  },
  {
    path: "evals/runs/suite/:suiteId/edit",
    kind: "screen",
    surfaceId: "evals",
    scope: "project",
  },
  // Evaluate (New) — the flag-gated redesign. A sibling tree of `/evals`, so
  // the original tab's URLs are untouched. Suites lens only: the new landing's
  // Runs view is in-page state, and the commit lens stays on /evals/runs.
  { path: "evaluate", kind: "screen", surfaceId: "evaluate", scope: "project" },
  {
    path: "evaluate/create",
    kind: "screen",
    surfaceId: "evaluate",
    scope: "project",
  },
  {
    path: "evaluate/suite/:suiteId",
    kind: "screen",
    surfaceId: "evaluate",
    scope: "project",
  },
  {
    path: "evaluate/suite/:suiteId/edit",
    kind: "screen",
    surfaceId: "evaluate",
    scope: "project",
  },
  {
    path: "evaluate/suite/:suiteId/runs/:runId",
    kind: "screen",
    surfaceId: "evaluate",
    scope: "project",
  },
  {
    path: "evaluate/suite/:suiteId/test/:testId",
    kind: "screen",
    surfaceId: "evaluate",
    scope: "project",
  },
  {
    path: "evaluate/suite/:suiteId/test/:testId/edit",
    kind: "screen",
    surfaceId: "evaluate",
    scope: "project",
  },
  {
    path: "ci-evals",
    kind: "redirect",
    note: "Legacy: Runs moved under Evaluate; redirects to /evals/runs.",
    scope: "project",
  },
  {
    path: "ci-evals/*",
    kind: "redirect",
    note: "Legacy Runs deep links (commit SHAs, suites, runs). These shipped in CI logs, bookmarks, and the SDK quickstart's post-sign-in return path, so the whole sub-tree is rewritten onto /evals/runs with query and hash intact.",
    scope: "project",
  },
  {
    path: "billing",
    kind: "special",
    note: "Post-checkout landing. Neutral loading screen while the billing deep-link effect hands off to the organization's billing page.",
    scope: "global",
  },
  {
    // WorkOS Initiate Login URL for IdP-initiated SSO (the Okta app tile).
    // Not a destination anyone navigates to: it starts a fresh, app-originated
    // sign-in so authkit-js writes the PKCE verifier `/callback` needs.
    path: "login",
    kind: "special",
    note: "WorkOS Initiate Login URL for IdP-initiated SSO; starts a fresh app-originated sign-in.",
    scope: "public",
  },
  {
    path: "callback",
    kind: "special",
    note: "Auth callback landing. Renders a neutral loading screen, never a project screen: App restores the stored sign-in return path from here, and flashing another project's Servers first is exactly what the canonical URL work exists to stop.",
    scope: "public",
  },
  {
    path: "oauth/callback/*",
    kind: "special",
    note: "MCP server OAuth callback. Neutral landing; useServerState restores the exact saved route.",
    scope: "public",
  },
  {
    path: "*",
    kind: "special",
    note: "Explicit not found. It used to render Servers, which meant an unknown URL silently showed a valid-looking screen for whatever project the viewer happened to be parked on.",
    scope: "public",
  },
] as const;

/**
 * Route patterns are matched here — not by React Router — because navigation
 * has to answer "is this target project-owned?" BEFORE a path exists to hand
 * to the router. Same patterns, one implementation, no second copy of the
 * catalog.
 *
 * Specificity order is deliberate: a static match beats a `:param` match beats
 * a `*` splat, so `/user-testing/new` resolves to its own entry rather than to
 * `:scenarioId`, exactly as the router would resolve it.
 */
function matchSegments(
  pattern: string,
  segments: readonly string[]
): "exact" | "param" | "splat" | null {
  if (pattern === "*") return "splat";
  if (pattern === "/") return segments.length === 0 ? "exact" : null;
  const patternSegments = pattern.split("/").filter(Boolean);
  const splat = patternSegments[patternSegments.length - 1] === "*";
  const fixed = splat ? patternSegments.slice(0, -1) : patternSegments;
  if (
    splat ? segments.length < fixed.length : segments.length !== fixed.length
  ) {
    return null;
  }
  let sawParam = false;
  for (let i = 0; i < fixed.length; i += 1) {
    const patternSegment = fixed[i];
    if (patternSegment.startsWith(":")) {
      // A param never matches an empty segment — `/hosts//` is not a host.
      if (!segments[i]) return null;
      sawParam = true;
      continue;
    }
    if (patternSegment !== segments[i]) return null;
  }
  if (splat) return "splat";
  return sawParam ? "param" : "exact";
}

/**
 * The route entry a LOGICAL (project-relative, unscoped) pathname resolves to,
 * or null when nothing matches. The `"*"` catch-all is never returned: "no
 * route" and "the not-found route" are different answers, and callers that
 * scope navigation targets need the first one.
 */
export function matchAppRoute(logicalPathname: string): AppRouteEntry | null {
  const path =
    typeof logicalPathname === "string" ? logicalPathname.split(/[?#]/)[0] : "";
  const segments = path.split("/").filter(Boolean);
  let param: AppRouteEntry | null = null;
  let splat: AppRouteEntry | null = null;
  for (const route of APP_ROUTES) {
    if (route.path === "*") continue;
    const quality = matchSegments(route.path, segments);
    if (quality === "exact") return route;
    if (quality === "param" && !param) param = route;
    if (quality === "splat" && !splat) splat = route;
  }
  return param ?? splat;
}

/**
 * The scope a logical path belongs to, or null when no route claims it.
 *
 * Null rather than a default on purpose: navigation must not prefix an
 * unknown path with a project (that would mint URLs for routes nobody
 * registered), and the caller can see the difference.
 */
export function getAppRouteScope(
  logicalPathname: string
): AppRouteScope | null {
  return matchAppRoute(logicalPathname)?.scope ?? null;
}

/** True when a logical path belongs below `/p/:projectId`. */
export function isProjectScopedRoutePath(logicalPathname: string): boolean {
  return getAppRouteScope(logicalPathname) === "project";
}

export function listAppRoutesByScope(
  scope: AppRouteScope
): readonly AppRouteEntry[] {
  return APP_ROUTES.filter((route) => route.scope === scope);
}
