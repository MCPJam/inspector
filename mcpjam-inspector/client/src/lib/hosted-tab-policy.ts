const HASH_TAB_ALIASES = {
  chat: "playground",
  /** Public hash slug; in-app tab id is `clients`. */
  connect: "clients",
  /** Legacy alias: `/hosts` and `#hosts` map to the renamed clients tab. */
  hosts: "clients",
} as const;

export const HOSTED_SIDEBAR_ALLOWED_TABS = [
  "home",
  "clients",
  "servers",
  "host-compare",
  "registry",
  "chatboxes",
  "playground",
  "views",
  "client-config",
  "evals",
  "ci-evals",
  "tools",
  "resources",
  "prompts",
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
  // server-side, not by this list). Reached via the Connect tab switcher, not
  // a standalone sidebar item, so it needs the hash allow-list only — see PR.
  "computer",
  // Cloud Skills are supported in hosted mode when the Computer feature is on
  // (skills live on the project's Computer). Kept OUT of the sidebar-allowed
  // list so the nav item stays disabled-by-default until the Computer flag
  // flips it on at render time (see `withCloudSkillsGate`); the route guard
  // (`SkillsRoute`) enforces the flag on direct navigation.
  "skills",
] as const;

export const HOSTED_HASH_BLOCKED_TABS = ["tasks", "tracing", "auth"] as const;

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
