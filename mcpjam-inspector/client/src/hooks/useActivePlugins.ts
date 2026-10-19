import { useMemo } from "react";
import { useConvexAuth } from "convex/react";
import { HOSTED_MODE } from "@/lib/config";
import { describeConvexFailure } from "@/lib/convex-error";
import type {
  ActivePluginRow,
  ActivePluginsResult,
} from "@/lib/plugins/active-plugins-types";
import { useSoftQuery } from "./use-soft-query";
import { usePluginsEnabled } from "./usePluginsEnabled";
import { shouldQueryProjectId } from "./useProjects";

/** One server a contributing plugin adds to a chat's turns. */
export interface ActivePluginServer {
  serverId: string;
  name: string;
  pluginId: string;
  /** What the user calls the plugin: its display name, else its name. */
  pluginLabel: string;
}

export interface ActivePluginsState {
  /** Every installed plugin, contributing or skipped, in plugin order. */
  plugins: ActivePluginRow[];
  /** Only the plugins a chat turn runs right now. */
  activePlugins: ActivePluginRow[];
  /** Servers of the active plugins, in plugin order, deduped by id. */
  activeServers: ActivePluginServer[];
  /** True while the read is in flight. False when skipped or settled. */
  isLoading: boolean;
  /**
   * The read failed (an error, or a backend without it). The lists read as
   * empty, so a caller that must not mistake this for "no plugins" checks it.
   */
  failed: boolean;
  /** The read came back with this project's answer: the lists are it. */
  answered: boolean;
}

const EMPTY_ROWS: ActivePluginRow[] = [];

export function pluginLabel(row: {
  name: string;
  displayName: string | null;
}): string {
  return row.displayName?.trim() || row.name;
}

/**
 * The servers of the plugins that contribute, deduped, in plugin order,
 * without the ones this member can't use yet.
 */
export function activePluginServers(
  plugins: readonly ActivePluginRow[],
): ActivePluginServer[] {
  const seen = new Set<string>();
  const servers: ActivePluginServer[] = [];
  for (const plugin of plugins) {
    if (plugin.status !== "active") continue;
    for (const server of plugin.servers) {
      if (server.unavailable || seen.has(server.serverId)) continue;
      seen.add(server.serverId);
      servers.push({
        serverId: server.serverId,
        name: server.name,
        pluginId: plugin.pluginId,
        pluginLabel: pluginLabel(plugin),
      });
    }
  }
  return servers;
}

/**
 * A backend from before component admission refuses the argument as an extra
 * field. Callers ask it again without one rather than reading that refusal as
 * "no plugins".
 *
 * A development deployment names the field. A production one redacts every
 * error that isn't a `ConvexError` to `Server Error`, so there the refusal
 * looks like any other failure of the read, and that gets the second read too.
 * On a backend that has the argument, that read leaves out a plugin with a
 * server the member can't use, as before admission. A `ConvexError` is the
 * backend answering on purpose, never a validator refusal.
 */
export function refusesComponentAdmission(error: unknown): boolean {
  if (!(error instanceof Error) || "data" in error) return false;
  if (/extra field `componentAdmission`/.test(error.message)) return true;
  return describeConvexFailure(error, "").redacted;
}

/**
 * The venue a chat turn in this deployment resolves plugins for, and the
 * read below's default. The Playground's hidden environment never uses it: it
 * asks for "hosted" in every build, so it only ever composes remote components.
 */
export function activePluginsRuntimeVenue(): "hosted" | "local" {
  return HOSTED_MODE ? "hosted" : "local";
}

/**
 * The project's installed plugins as a Playground chat would run them
 * (`plugins:resolveActivePlugins`, `content: false`): which contribute right
 * now, and why the others are skipped.
 *
 * Skipped unless the agent-plugins flag (`plugins-enabled`) is on, Convex auth
 * has resolved, and the project id is a real Convex id. It deliberately does
 * NOT read the client's plugin-extensions switch: agent plugins load on every
 * client, and that switch only governs extension features (Apps, forms,
 * settings).
 *
 * A soft read: a backend without the function yet (deploy skew), a refusal or
 * any other error all read as "no plugins" instead of throwing into render.
 *
 * Asks with the venue this deployment runs chat turns in, so a plugin a turn
 * would refuse for placement shows as skipped here too. A caller that must
 * only ever see remote components (the Playground's hidden environment) asks
 * for `"hosted"` instead.
 */
export function useActivePlugins(
  projectId: string | null | undefined,
  options?: { runtimeVenue?: "hosted" | "local" },
): ActivePluginsState {
  const flagEnabled = usePluginsEnabled();
  const { isAuthenticated } = useConvexAuth();
  const ready =
    flagEnabled && isAuthenticated && shouldQueryProjectId(projectId);
  const args =
    ready && projectId
      ? {
          projectId,
          content: false,
          runtimeVenue: options?.runtimeVenue ?? activePluginsRuntimeVenue(),
        }
      : null;
  // A server this member can't use yet is left out alone, not its plugin.
  const admitted = useSoftQuery<ActivePluginsResult>(
    "plugins:resolveActivePlugins",
    args ? { ...args, componentAdmission: true } : "skip",
  );
  // Asked the old way only while that read is refused, so it answers again
  // as soon as it can: one failure never pins the old view.
  const refused = refusesComponentAdmission(admitted.error);
  const legacy = useSoftQuery<ActivePluginsResult>(
    "plugins:resolveActivePlugins",
    args && refused ? args : "skip",
  );
  const { data, error } = refused ? legacy : admitted;
  const plugins =
    !error && data?.enabled === true && Array.isArray(data.plugins)
      ? data.plugins
      : EMPTY_ROWS;
  return useMemo(() => {
    const activePlugins = plugins.filter(
      (plugin) => plugin.status === "active",
    );
    return {
      plugins,
      activePlugins,
      activeServers: activePluginServers(plugins),
      isLoading: ready && data === undefined && error === undefined,
      failed: ready && error !== undefined,
      answered: ready && data !== undefined && error === undefined,
    };
  }, [plugins, ready, data, error]);
}
