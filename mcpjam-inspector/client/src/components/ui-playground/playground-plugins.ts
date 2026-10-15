import type { WorkspaceServer } from "@/components/host-workspace/ThreadAppPanel";
import type { ActivePluginServer } from "@/hooks/useActivePlugins";
import type { PluginIcons } from "@/lib/plugins/plugin-api-types";

/**
 * What the Playground's extension workspace sees of the project's installed
 * plugins when a chat carries them through a hidden environment (see
 * `lib/plugins/hidden-environment.ts`). The browser never connects plugin
 * servers itself; the chat route connects them by id on each turn.
 */

interface PlaygroundServerState {
  connectionStatus?: string;
  lastConnectionTime?: Date | string | number;
  initializationInfo?: {
    serverVersion?: { icons?: unknown };
  } | null;
}

/**
 * The servers the extension workspace (Apps menu, sidebar Apps, settings,
 * onboarding) sees for this chat.
 *
 * Environment mode is the environment's enabled servers, as before. Otherwise
 * it is the selected browser-connected servers plus `pluginServers` — the
 * servers a hidden environment's plugins add to this chat's turns, or none. A
 * plugin server the user also selected by hand is listed once.
 */
export function buildExtensionServers(input: {
  isEnvironmentMode: boolean;
  environmentServers: ReadonlyArray<{
    serverId: string;
    name: string;
    enabled: boolean;
  }>;
  selectedServers: readonly string[];
  serversByName: ReadonlyMap<string, string>;
  servers: Readonly<Record<string, PlaygroundServerState | undefined>>;
  pluginServers: readonly ActivePluginServer[];
  pluginIconsById?: ReadonlyMap<string, PluginIcons>;
}): WorkspaceServer[] {
  if (input.isEnvironmentMode) {
    return input.environmentServers
      .filter((server) => server.enabled)
      .map((server) => ({ serverId: server.serverId, name: server.name }));
  }
  const selected: WorkspaceServer[] = input.selectedServers.flatMap((name) => {
    const serverId = input.serversByName.get(name);
    const server = input.servers[name];
    // A new epoch after the first means a reconnect: entrypoints and open
    // Apps' tool metadata are read again.
    const connection =
      server?.connectionStatus === "connected"
        ? String(new Date(server.lastConnectionTime as never).getTime())
        : undefined;
    const icons = server?.initializationInfo?.serverVersion?.icons;
    return serverId
      ? [
          {
            serverId,
            name,
            ...(connection ? { connection } : {}),
            ...(Array.isArray(icons) && icons.length ? { icons } : {}),
          },
        ]
      : [];
  });
  const listed = new Set(selected.map((server) => server.serverId));
  const fromPlugins: WorkspaceServer[] = [];
  for (const server of input.pluginServers) {
    if (listed.has(server.serverId)) continue;
    listed.add(server.serverId);
    const pluginIcons = input.pluginIconsById?.get(server.pluginId);
    fromPlugins.push({
      serverId: server.serverId,
      name: server.name,
      ...(pluginIcons ? { pluginIcons } : {}),
    });
  }
  return fromPlugins.length > 0 ? [...selected, ...fromPlugins] : selected;
}
