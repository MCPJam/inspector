/**
 * The tab names `launchInspector({ defaultTab })` and the Vite plugin accept.
 *
 * The launcher cannot import client code, so the list lives here and
 * `client/src/lib/__tests__/launcher-tabs.test.ts` checks it against the
 * client's own tab registry in both directions: every name here opens a real
 * screen, and every screen the client knows is accepted here.
 */
export const LAUNCHER_TABS = [
  "client-config",
  "clients",
  "compatibility",
  "computer",
  "conformance",
  "environments",
  "evals",
  "evaluate",
  "events",
  "home",
  "host-compare",
  "learning",
  "oauth-flow",
  "organizations",
  "playground",
  "profile",
  "project-settings",
  "prompts",
  "readiness",
  "registry",
  "resources",
  "scenarios",
  "servers",
  "sessions",
  "settings",
  "skills",
  "support",
  "swarms",
  "tasks",
  "tools",
  "tracing",
  "triggers",
  "webmcp",
  "xaa-flow",
] as const;

export type LauncherTab = (typeof LAUNCHER_TABS)[number];

/**
 * Other names for a tab, resolved before the launcher uses them. The same
 * names resolve the same way in a link's hash (`HASH_TAB_ALIASES` in
 * `client/src/lib/hosted-tab-policy.ts`).
 */
export const LAUNCHER_TAB_ALIASES: Readonly<Record<string, LauncherTab>> = {
  /** App Builder became Playground; published templates still pass it. */
  "app-builder": "playground",
  chat: "playground",
  /** Older launchers sent `chat` as `chat-v2`. */
  "chat-v2": "playground",
  "ci-evals": "evals",
  connect: "clients",
  hosts: "clients",
  "user-testing": "scenarios",
};

const launcherTabs: ReadonlySet<string> = new Set(LAUNCHER_TABS);
const aliasTargets = new Map<string, LauncherTab>(
  Object.entries(LAUNCHER_TAB_ALIASES),
);

function isLauncherTab(tab: string): tab is LauncherTab {
  return launcherTabs.has(tab);
}

/**
 * The tab a name opens, or undefined when the Inspector has no such tab.
 * A leading `#` or `/` is ignored, as the client ignores it when it opens
 * the launcher's initial tab, so names that already worked keep working.
 */
export function resolveLauncherTab(tab: string): LauncherTab | undefined {
  const name = tab.replace(/^[#/]+/, "");
  const resolved = aliasTargets.get(name) ?? name;
  return isLauncherTab(resolved) ? resolved : undefined;
}
