const HASH_TAB_ALIASES = {
  registry: "servers",
  chat: "chat-v2",
} as const;

export const HOSTED_SIDEBAR_ALLOWED_TABS = [
  "servers",
  "chat-v2",
  "app-builder",
  "views",
  "tools",
  "resources",
  "prompts",
  "support",
  "settings",
  "oauth-flow",
] as const;

export const HOSTED_HASH_ALLOWED_TABS = [
  ...HOSTED_SIDEBAR_ALLOWED_TABS,
  "profile",
  "organizations",
] as const;

export const HOSTED_HASH_BLOCKED_TABS = [
  "evals",
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
