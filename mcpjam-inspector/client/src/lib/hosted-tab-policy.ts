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
  "oauth-flow",
  "xaa-flow",
  "learning",
] as const;

export const HOSTED_HASH_ALLOWED_TABS = [
  ...HOSTED_SIDEBAR_ALLOWED_TABS,
  "profile",
  "organizations",
  "project-settings",
  // Project Computers (E2B-backed) are supported in hosted mode: the server
  // leaves /api/web/computers/* outside the hosted block partition, and the
  // control plane gates access by project membership + the `projectComputers`
  // org entitlement + a per-user HMAC terminal token. The tab is reached via
  // the Connect tab switcher (gated by the `computers-enabled` flag), not a
  // standalone sidebar item, so it only needs the hash allow-list — not the
  // sidebar one. ComputerView itself reports unavailability when no data plane
  // (local E2B creds or COMPUTERS_REMOTE_DATA_PLANE_URL) is configured.
  "computer",
] as const;

export const HOSTED_HASH_BLOCKED_TABS = [
  "skills",
  "tasks",
  "tracing",
  "auth",
] as const;

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
