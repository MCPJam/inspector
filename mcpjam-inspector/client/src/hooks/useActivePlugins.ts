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
  const { data, error } = useSoftQuery<ActivePluginsResult>(
    "plugins:resolveActivePlugins",
    ready && projectId
      ? {
          projectId,
          content: false,
          runtimeVenue: options?.runtimeVenue ?? activePluginsRuntimeVenue(),
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
      failed: ready && error !== undefined,
    };
  }, [plugins, ready, data, error]);
}
