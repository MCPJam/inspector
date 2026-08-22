import { listHostedBlockedNavSegments } from "@/shared/app-surfaces";

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

/**
 * Hosted deployments block a tab only when it cannot work there — today that
 * is Tracing alone, which needs the local OTLP collector.
 *
 * This was an ALLOW-list until the Sessions bug (#4210): every new tab had to
 * be added by hand, the sidebar filter ran before the feature-flag filter, and
 * a tab that nobody remembered to list was invisible on app.mcpjam.com with no
 * error to explain it. Default-deny bought nothing — of ~30 nav segments, one
 * is genuinely hosted-blocked — while costing 37 commits of catch-up edits.
 *
 * DERIVED from `hostedBlocked` in the surface manifests, so a screen declares
 * its own availability next to the rest of its metadata and there is no second
 * list to keep in sync. Same move `KNOWN_APP_TAB_SEGMENTS` already made in
 * `app-navigation.ts`.
 */
export const HOSTED_HASH_BLOCKED_TABS: readonly string[] =
  listHostedBlockedNavSegments();

const hostedBlockedSet = new Set<string>(HOSTED_HASH_BLOCKED_TABS);

export function normalizeHostedHashTab(tab: string): string {
  return HASH_TAB_ALIASES[tab as keyof typeof HASH_TAB_ALIASES] ?? tab;
}

/**
 * The single hosted-availability check, shared by the sidebar, hash/route
 * resolution, and the agent's `ui_navigate` targets. There is deliberately no
 * sidebar-specific variant: the two lists differed only in `computer` and
 * `skills`, neither of which is a sidebar item to begin with.
 */
export function isHostedTabBlocked(tab: string): boolean {
  return hostedBlockedSet.has(normalizeHostedHashTab(tab));
}
