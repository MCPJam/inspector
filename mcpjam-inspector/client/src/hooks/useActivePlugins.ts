import { useMemo } from "react";
import { useConvexAuth } from "convex/react";
import { HOSTED_MODE } from "@/lib/config";
import type {
  ActivePluginRow,
  ActivePluginsResult,
} from "@/lib/plugins/active-plugins-types";
import { useSoftQuery } from "./use-soft-query";
import { usePluginsEnabled } from "./usePluginsEnabled";
import { shouldQueryProjectId } from "./useProjects";

/** One server a contributing plugin adds to every normal chat turn. */
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
  /** Only the plugins a normal chat turn runs right now. */
  activePlugins: ActivePluginRow[];
  /** Servers of the active plugins, in plugin order, deduped by id. */
  activeServers: ActivePluginServer[];
  /** True while the read is in flight. False when skipped or settled. */
  isLoading: boolean;
}

const EMPTY_ROWS: ActivePluginRow[] = [];

export function pluginLabel(row: {
  name: string;
  displayName: string | null;
}): string {
  return row.displayName?.trim() || row.name;
}

/** The servers of the plugins that contribute, deduped, in plugin order. */
export function activePluginServers(
  plugins: readonly ActivePluginRow[],
): ActivePluginServer[] {
  const seen = new Set<string>();
  const servers: ActivePluginServer[] = [];
  for (const plugin of plugins) {
    if (plugin.status !== "active") continue;
    for (const server of plugin.servers) {
      if (seen.has(server.serverId)) continue;
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
 * The project's installed plugins as a normal chat turn sees them
 * (`plugins:resolveActivePlugins`, `content: false`).
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
 * Asks with the same venue the chat route resolves with, so a plugin the turn
 * would skip for placement shows as skipped here too.
 */
export function useActivePlugins(
  projectId: string | null | undefined,
): ActivePluginsState {
  const flagEnabled = usePluginsEnabled();
  const { isAuthenticated } = useConvexAuth();
  const ready =
    flagEnabled && isAuthenticated && shouldQueryProjectId(projectId);
  const { data, error } = useSoftQuery<ActivePluginsResult>(
    "plugins:resolveActivePlugins",
    ready && projectId
      ? {
          projectId,
          content: false,
          runtimeVenue: HOSTED_MODE ? "hosted" : "local",
        }
      : "skip",
  );
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
    };
  }, [plugins, ready, data, error]);
}
