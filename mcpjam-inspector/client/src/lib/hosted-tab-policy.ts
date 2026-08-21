const HASH_TAB_ALIASES = {
  chat: "playground",
  /** Public hash slug; in-app tab id is `clients`. */
  connect: "clients",
  /** Legacy alias: `/hosts` and `#hosts` map to the renamed clients tab. */
  hosts: "clients",
  /** Public path is `/user-testing`; the in-app tab id stays `scenarios`. */
  "user-testing": "scenarios",
  /**
   * Legacy: Runs was its own tab at `/ci-evals` before both eval lenses
   * merged under `/evals`. Kept so an old `#ci-evals` hash bookmark resolves
   * to Evaluate instead of falling through to Servers.
   */
  "ci-evals": "evals",
} as const;

export const HOSTED_SIDEBAR_ALLOWED_TABS = [
  "home",
  "clients",
  "servers",
  "host-compare",
  "registry",
  "scenarios",
  "swarms",
  "playground",
  "client-config",
  "evals",
  // The unified Sessions feed reads the same Convex-backed session rows the
  // hosted surfaces already write, so there is nothing hosted-specific to
  // block. Visibility still comes from `unified-sessions-enabled` (PostHog);
  // this entry only makes the tab REACHABLE, same as `environments` below.
  "sessions",
  // Project Environments are Convex-backed and hosted-first; the sidebar item
  // and route are additionally gated behind `project-environments-enabled`
  // (PostHog), so this entry only makes the tab REACHABLE — visibility still
  // comes from the flag.
  "environments",
  "tools",
  "resources",
  "prompts",
  // Hosted tasks poll through ephemeral per-request connections
  // (`/api/web/tasks/*`), so the tab no longer needs a persistent session.
  "tasks",
  "support",
  "settings",
  "conformance",
  "compatibility",
  "oauth-flow",
  "xaa-flow",
  "learning",
] as const;

export const HOSTED_HASH_ALLOWED_TABS = [
  ...HOSTED_SIDEBAR_ALLOWED_TABS,
  "profile",
  "organizations",
  "project-settings",
  // Project Computers are supported in hosted mode (access is enforced
  // server-side, not by this list). Reached via the Servers tab switcher, not
  // a standalone sidebar item, so it needs the hash allow-list only — see PR.
  "computer",
  // Cloud Skills are a project-membership resource (Convex-backed, usable in
  // the Playground without a Computer) but gated behind the `skills-enabled`
  // PostHog flag until QA completes. Reached via the Servers tab switcher, not
  // a standalone sidebar item, so it needs the hash allow-list only — the tab
  // itself is hidden while the flag is off (`useSkillsEnabled`) and the route
  // guard (`SkillsRoute`) redirects direct navigation.
  "skills",
] as const;

export const HOSTED_HASH_BLOCKED_TABS = ["tracing"] as const;

const hostedSidebarAllowedSet = new Set<string>(HOSTED_SIDEBAR_ALLOWED_TABS);
const hostedHashAllowedSet = new Set<string>(HOSTED_HASH_ALLOWED_TABS);
const hostedHashBlockedSet = new Set<string>(HOSTED_HASH_BLOCKED_TABS);

export function normalizeHostedHashTab(tab: string): string {
  return HASH_TAB_ALIASES[tab as keyof typeof HASH_TAB_ALIASES] ?? tab;
}

export function isHostedSidebarTabAllowed(tab: string): boolean {
  return hostedSidebarAllowedSet.has(normalizeHostedHashTab(tab));
}

export function isHostedHashTabAllowed(tab: string): boolean {
  return hostedHashAllowedSet.has(normalizeHostedHashTab(tab));
}

export function isHostedHashTabBlocked(tab: string): boolean {
  return hostedHashBlockedSet.has(normalizeHostedHashTab(tab));
}
