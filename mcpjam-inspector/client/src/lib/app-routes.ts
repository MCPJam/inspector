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
  { path: "auth", kind: "screen", surfaceId: "auth" },
  { path: "skills", kind: "screen", surfaceId: "skills" },
  { path: "learning", kind: "screen", surfaceId: "learning" },
  { path: "conformance", kind: "screen", surfaceId: "conformance" },
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
  { path: "chatboxes", kind: "screen", surfaceId: "chatboxes" },
  { path: "swarms", kind: "screen", surfaceId: "swarms" },
  { path: "playground", kind: "screen", surfaceId: "playground" },
  { path: "support", kind: "screen", surfaceId: "support" },
  { path: "settings", kind: "screen", surfaceId: "settings" },
  { path: "settings/api-keys", kind: "screen", surfaceId: "settings" },
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
  { path: "ci-evals", kind: "screen", surfaceId: "ci-evals" },
  { path: "ci-evals/create", kind: "screen", surfaceId: "ci-evals" },
  {
    path: "ci-evals/commit/:commitSha",
    kind: "screen",
    surfaceId: "ci-evals",
  },
  { path: "ci-evals/suite/:suiteId", kind: "screen", surfaceId: "ci-evals" },
  {
    path: "ci-evals/suite/:suiteId/runs/:runId",
    kind: "screen",
    surfaceId: "ci-evals",
  },
  {
    path: "ci-evals/suite/:suiteId/test/:testId",
    kind: "screen",
    surfaceId: "ci-evals",
  },
  {
    path: "ci-evals/suite/:suiteId/test/:testId/edit",
    kind: "screen",
    surfaceId: "ci-evals",
  },
  {
    path: "ci-evals/suite/:suiteId/edit",
    kind: "screen",
    surfaceId: "ci-evals",
  },
  {
    path: "billing",
    kind: "special",
    note: "Post-checkout landing; renders Servers.",
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
