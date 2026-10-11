import { createContext, useContext, useMemo } from "react";
import type {
  PluginIconRef,
  PluginIcons,
} from "@/lib/plugins/plugin-api-types";
import type { DiscoveredServer } from "./use-extension-discovery";
import {
  declarationIcons,
  declarationServerIcons,
  type ExtensionIconSources,
} from "./ExtensionIcon";

/**
 * Where a plugin-owned server's surfaces find that plugin's manifest icons.
 * Discovery (already run once per server) names the installed plugin that
 * owns each server; the project's plugin list (one subscription) carries each
 * plugin's icons. The two are joined at render, never with a query per
 * server or per render.
 */
export interface PluginIconDirectory {
  /** pluginId → the plugin's manifest icons (`listProjectPlugins`). */
  plugins: ReadonlyMap<string, PluginIcons>;
  /** serverId → what discovery reported about the server itself. */
  servers: Readonly<Record<string, DiscoveredServer>>;
}

/** The icon sources a server's surfaces resolve from. */
export interface ServerIconSources {
  /** The owning plugin's manifest icons, when the server belongs to one. */
  pluginIcons?: PluginIcons;
  /** The server's icons from discovery (`server/discover`, else `initialize`). */
  serverIcons?: readonly unknown[];
}

export const EMPTY_PLUGIN_ICON_DIRECTORY: PluginIconDirectory = Object.freeze({
  plugins: new Map<string, PluginIcons>(),
  servers: Object.freeze({}),
});

export function serverIconSources(
  directory: PluginIconDirectory,
  serverId: string | undefined,
): ServerIconSources {
  const server = serverId ? directory.servers[serverId] : undefined;
  if (!server) return {};
  const pluginIcons = server.pluginId
    ? directory.plugins.get(server.pluginId)
    : undefined;
  return {
    ...(pluginIcons ? { pluginIcons } : {}),
    ...(server.serverIcons?.length ? { serverIcons: server.serverIcons } : {}),
  };
}

/** A raw saved-server (database) id: 32 lowercase letters and digits. */
export function isRawServerId(value: string): boolean {
  return (
    /^[a-z0-9]{32}$/.test(value) && /[a-z]/.test(value) && /[0-9]/.test(value)
  );
}

/**
 * What tabs and headers call a server: its saved name, never a raw id.
 *
 * `label` is whatever the surface was handed (a server id, or already a
 * name). The workspace's own server list is checked first, then discovery.
 * An id nothing names reads as "App".
 */
export function serverDisplayName(
  label: string | undefined,
  directory: PluginIconDirectory,
  servers: readonly { serverId: string; name?: string }[] = [],
): string {
  const value = label?.trim() ?? "";
  const named =
    servers.find((server) => server.serverId === value)?.name?.trim() ||
    directory.servers[value]?.name?.trim();
  if (named) return named;
  return value && !isRawServerId(value) ? value : "App";
}

/**
 * An entrypoint's icon sources (left-rail Apps, right-rail App tabs, the
 * "Plugins and MCPs" menu), in the spec's order: the tool's `icons`, then
 * the server's icons (`server/discover`, else `initialize`), then the owning
 * plugin's directory logo; the icon renders a generic one after that.
 */
export function entrypointIconSources(
  directory: PluginIconDirectory,
  server: { serverId: string; icons?: readonly unknown[] },
  declaration?: object,
): ExtensionIconSources {
  const discovered = serverIconSources(directory, server.serverId);
  const toolIcons = declarationIcons(declaration);
  const serverIcons =
    declarationServerIcons(declaration) ??
    discovered.serverIcons ??
    server.icons;
  return {
    ...(toolIcons ? { toolIcons } : {}),
    ...(serverIcons ? { serverIcons } : {}),
    ...(discovered.pluginIcons ? { pluginIcons: discovered.pluginIcons } : {}),
  };
}

const ICON_KEYS = ["logo", "logoDark", "composerIcon"] as const;

function iconRef(value: unknown): PluginIconRef | undefined {
  if (!value || typeof value !== "object") return undefined;
  const { url, contentType } = value as Record<string, unknown>;
  return typeof url === "string" &&
    url.length <= 8192 &&
    /^https?:\/\//i.test(url) &&
    typeof contentType === "string" &&
    /^image\//i.test(contentType)
    ? { url, contentType }
    : undefined;
}

/** Plugin icons by plugin id, from `listProjectPlugins` rows. */
export function pluginIconsById(
  rows: unknown,
): ReadonlyMap<string, PluginIcons> {
  const byId = new Map<string, PluginIcons>();
  if (!Array.isArray(rows)) return byId;
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const { pluginId, icons } = row as { pluginId?: unknown; icons?: unknown };
    if (typeof pluginId !== "string" || !icons || typeof icons !== "object")
      continue;
    const refs: PluginIcons = {};
    for (const key of ICON_KEYS) {
      const ref = iconRef((icons as Record<string, unknown>)[key]);
      if (ref) refs[key] = ref;
    }
    if (Object.keys(refs).length) byId.set(pluginId, refs);
  }
  return byId;
}

/** `pluginIconsById`, stable while the icons are unchanged. */
export function usePluginIconsById(
  rows: unknown,
): ReadonlyMap<string, PluginIcons> {
  // Recomputed when the subscription delivers new rows, not on every render.
  const key = useMemo(() => JSON.stringify([...pluginIconsById(rows)]), [rows]);
  return useMemo(
    () => new Map(JSON.parse(key) as [string, PluginIcons][]),
    [key],
  );
}

const PluginIconDirectoryContext = createContext<PluginIconDirectory>(
  EMPTY_PLUGIN_ICON_DIRECTORY,
);

export const PluginIconDirectoryProvider = PluginIconDirectoryContext.Provider;

export function usePluginIconDirectory(): PluginIconDirectory {
  return useContext(PluginIconDirectoryContext);
}

/** One server's icon sources; empty outside the Playground's extension provider. */
export function useServerIconSources(
  serverId: string | undefined,
): ServerIconSources {
  const { pluginIcons, serverIcons } = serverIconSources(
    usePluginIconDirectory(),
    serverId,
  );
  return useMemo(
    () => ({
      ...(pluginIcons ? { pluginIcons } : {}),
      ...(serverIcons ? { serverIcons } : {}),
    }),
    [pluginIcons, serverIcons],
  );
}
