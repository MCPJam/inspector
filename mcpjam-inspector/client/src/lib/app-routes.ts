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
 */
import type { AppSurfaceId } from "@/shared/app-surfaces";

export type AppRouteEntry =
  | { path: string; kind: "screen"; surfaceId: AppSurfaceId }
  | { path: string; kind: "redirect"; note: string }
  | { path: string; kind: "special"; note: string };

export const APP_ROUTES: readonly AppRouteEntry[] = [
  { path: "/", kind: "screen", surfaceId: "home" },
  { path: "home", kind: "screen", surfaceId: "home" },
  { path: "servers", kind: "screen", surfaceId: "servers" },
  // Exact permalink targets on Connect. Both render the same screen — the
  // route param is what selects, so a link survives the auth-gate remounts a
  // cold boot puts it through (same pattern as `user-testing/:scenarioId`).
  // `servers/plugins/:pluginId` is deeper than `servers/:serverId`, so the
  // two never compete: a two-segment URL can only be a server.
  { path: "servers/plugins/:pluginId", kind: "screen", surfaceId: "servers" },
  { path: "servers/:serverId", kind: "screen", surfaceId: "servers" },
  {
    path: "clients",
    kind: "redirect",
    note: "Legacy: the tab was renamed Client → Host; redirects to /hosts.",
  },
  {
    path: "clients/:hostId",
    kind: "redirect",
    note: "Legacy deep link; re-encoded through buildHostsPath.",
  },
  { path: "host-compare", kind: "screen", surfaceId: "host-compare" },
  {
    path: "embed/host-compare",
    kind: "special",
    note: "Chrome-less vanity surface (caniuse.dev): no sidebar, no NUX.",
  },
  {
    path: "embed/score",
    kind: "special",
    note: "Chrome-less vanity surface (score.mcpjam.com): the conformance-score runner. No sidebar, no NUX.",
  },
  {
    path: "results/:runToken",
    kind: "special",
    note: "One score run's report. Public by link token — no session required to read it.",
  },
  {
    path: "capabilities/:capabilitySlug",
    kind: "screen",
    surfaceId: "host-compare",
  },
  { path: "computer", kind: "screen", surfaceId: "computer" },
  { path: "hosts", kind: "screen", surfaceId: "hosts" },
  { path: "hosts/:hostId", kind: "screen", surfaceId: "hosts" },
  { path: "registry", kind: "screen", surfaceId: "registry" },
  { path: "tools", kind: "screen", surfaceId: "tools" },
  { path: "resources", kind: "screen", surfaceId: "resources" },
  { path: "prompts", kind: "screen", surfaceId: "prompts" },
  { path: "tasks", kind: "screen", surfaceId: "tasks" },
  { path: "skills", kind: "screen", surfaceId: "skills" },
  { path: "learning", kind: "screen", surfaceId: "learning" },
  { path: "conformance", kind: "screen", surfaceId: "conformance" },
  {
    path: "conformance/runs/:runId",
    kind: "screen",
    surfaceId: "conformance",
  },
  {
    path: "conformance/shared/:token",
    kind: "special",
    note: "Read-only shared conformance run. Redeem-based (guest session or WorkOS). Legacy HMAC tokens read as invalid on this page; /api/web/conformance-shared still serves them until I6.",
  },
  { path: "compatibility", kind: "screen", surfaceId: "compatibility" },
  { path: "oauth-flow", kind: "screen", surfaceId: "oauth-flow" },
  { path: "xaa-flow", kind: "screen", surfaceId: "xaa-flow" },
  { path: "tracing", kind: "screen", surfaceId: "tracing" },
  // `ChatAliasRoute` is a `<Navigate replace>` — it renders nothing of its
  // own, exactly like `client-config`. `chat` survives as a nav SEGMENT
  // (normalized to `playground`), which is a separate question from whether
  // any screen renders here.
  {
    path: "chat",
    kind: "redirect",
    note: "Legacy alias; redirects to /playground.",
  },
  {
    path: "chat/*",
    kind: "redirect",
    note: "Legacy deep link; redirects to /playground so old bookmarks land there rather than the catch-all.",
  },
  { path: "user-testing", kind: "screen", surfaceId: "scenarios" },
  { path: "user-testing/new", kind: "screen", surfaceId: "scenarios" },
  // `:scenarioId` is the scenario's scenario id. Edit is a sibling screen
  // (setup / share / preview), not a detail tab.
  {
    path: "user-testing/:scenarioId/edit",
    kind: "screen",
    surfaceId: "scenarios",
  },
  { path: "user-testing/:scenarioId", kind: "screen", surfaceId: "scenarios" },
  {
    path: "scenarios",
    kind: "redirect",
    note: "Legacy: the Scenario surface is now User Testing. Redirects to /user-testing, preserving search + hash so old ?host=&session= links keep working.",
  },
  { path: "swarms", kind: "screen", surfaceId: "swarms" },
  { path: "swarms/new", kind: "screen", surfaceId: "swarms" },
  { path: "swarms/:swarmId", kind: "screen", surfaceId: "swarms" },
  {
    path: "environments",
    kind: "screen",
    surfaceId: "project-environments",
  },
  {
    path: "environments/:environmentId",
    kind: "screen",
    surfaceId: "project-environments",
  },
  { path: "sessions", kind: "screen", surfaceId: "sessions" },
  { path: "playground", kind: "screen", surfaceId: "playground" },
  { path: "support", kind: "screen", surfaceId: "support" },
  { path: "settings", kind: "screen", surfaceId: "settings" },
  { path: "settings/api-keys", kind: "screen", surfaceId: "settings" },
  { path: "settings/integrations", kind: "screen", surfaceId: "settings" },
  {
    path: "settings/integrations/github",
    kind: "screen",
    surfaceId: "settings",
  },
  {
    // Where GitHub sends the browser back — the App's setup URL and its OAuth
    // callback both point here, told apart by which query parameters arrived.
    path: "settings/integrations/github/callback",
    kind: "screen",
    surfaceId: "settings",
  },
  {
    path: "settings/github-checks",
    kind: "redirect",
    note: "Legacy: the page moved under Integrations; redirects to /settings/integrations/github.",
  },
  { path: "profile", kind: "screen", surfaceId: "profile" },
  { path: "project-settings", kind: "screen", surfaceId: "project-settings" },
  {
    path: "client-config",
    kind: "redirect",
    note: "Legacy alias; redirects to /servers.",
  },
  { path: "organizations", kind: "screen", surfaceId: "organizations" },
  { path: "organizations/:orgId", kind: "screen", surfaceId: "organizations" },
  {
    path: "organizations/:orgId/billing",
    kind: "screen",
    surfaceId: "organizations",
  },
  {
    path: "organizations/:orgId/models",
    kind: "screen",
    surfaceId: "organizations",
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
  },
  {
    path: "evals/shared/:token",
    kind: "special",
    note: "Read-only shared eval run. Redeem-based (guest session or WorkOS). Chrome-less.",
  },
  { path: "evals", kind: "screen", surfaceId: "evals" },
  { path: "evals/create", kind: "screen", surfaceId: "evals" },
  { path: "evals/suite/:suiteId", kind: "screen", surfaceId: "evals" },
  {
    path: "evals/suite/:suiteId/runs/:runId",
    kind: "screen",
    surfaceId: "evals",
  },
  {
    path: "evals/suite/:suiteId/test/:testId",
    kind: "screen",
    surfaceId: "evals",
  },
  {
    path: "evals/suite/:suiteId/test/:testId/edit",
    kind: "screen",
    surfaceId: "evals",
  },
  { path: "evals/suite/:suiteId/edit", kind: "screen", surfaceId: "evals" },
  // Runs mode. Same suite screens as Suites mode above, plus the cross-suite
  // commit lens; one surface, two lenses over the same eval suites.
  { path: "evals/runs", kind: "screen", surfaceId: "evals" },
  { path: "evals/runs/create", kind: "screen", surfaceId: "evals" },
  {
    path: "evals/runs/commit/:commitSha",
    kind: "screen",
    surfaceId: "evals",
  },
  { path: "evals/runs/suite/:suiteId", kind: "screen", surfaceId: "evals" },
  {
    path: "evals/runs/suite/:suiteId/runs/:runId",
    kind: "screen",
    surfaceId: "evals",
  },
  {
    path: "evals/runs/suite/:suiteId/test/:testId",
    kind: "screen",
    surfaceId: "evals",
  },
  {
    path: "evals/runs/suite/:suiteId/test/:testId/edit",
    kind: "screen",
    surfaceId: "evals",
  },
  {
    path: "evals/runs/suite/:suiteId/edit",
    kind: "screen",
    surfaceId: "evals",
  },
  {
    path: "ci-evals",
    kind: "redirect",
    note: "Legacy: Runs moved under Evaluate; redirects to /evals/runs.",
  },
  {
    path: "ci-evals/*",
    kind: "redirect",
    note: "Legacy Runs deep links (commit SHAs, suites, runs). These shipped in CI logs, bookmarks, and the SDK quickstart's post-sign-in return path, so the whole sub-tree is rewritten onto /evals/runs with query and hash intact.",
  },
  {
    path: "billing",
    kind: "special",
    note: "Post-checkout landing; renders Servers.",
  },
  {
    // WorkOS Initiate Login URL for IdP-initiated SSO (the Okta app tile).
    // Not a destination anyone navigates to: it starts a fresh, app-originated
    // sign-in so authkit-js writes the PKCE verifier `/callback` needs.
    path: "login",
    kind: "special",
    note: "WorkOS Initiate Login URL for IdP-initiated SSO; starts a fresh app-originated sign-in.",
  },
  {
    path: "callback",
    kind: "special",
    note: "Auth callback landing; renders Servers.",
  },
  {
    path: "oauth/callback/*",
    kind: "special",
    note: "MCP server OAuth callback; renders Servers.",
  },
  {
    path: "*",
    kind: "special",
    note: "Catch-all; renders Servers.",
  },
] as const;
