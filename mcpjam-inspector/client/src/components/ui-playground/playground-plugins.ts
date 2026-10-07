import type { WorkspaceServer } from "@/components/host-workspace/ThreadAppPanel";
import type { ActivePluginServer } from "@/hooks/useActivePlugins";
import type { PluginIcons } from "@/lib/plugins/plugin-api-types";

/**
 * How the project's installed plugins reach a normal (non-environment)
 * Playground chat.
 *
 * The chat route adds the project's active plugins to every host-target turn
 * on its own, re-resolved per message. The browser never connects their
 * servers and never names them in the turn's selection, so these helpers only
 * decide what the page SHOWS and which route a turn takes.
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
 * it is the selected browser-connected servers plus the active plugins'
 * servers, which the chat route adds to the turn itself. A plugin server the
 * user also selected by hand is listed once.
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
      server?.connectionStatus === "connected" &&
      server.lastConnectionTime !== undefined
        ? String(new Date(server.lastConnectionTime).getTime())
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

/**
 * Whether this chat's turns carry the project's plugins, which also means the
 * local binary must send them to the web chat route (`/api/web/chat-v2`), as
 * environment mode does: only that route resolves plugins.
 *
 * Not in environment mode (its own pins decide, and it forces the route
 * itself), and not when the member explicitly chose to run a harness on this
 * machine: local execution exists only on the local route, and silently moving
 * an explicit local ask to the cloud is worse than running it without plugins.
 * That turn shows no plugin servers as on, so nothing claims they ran.
 */
export function playgroundTurnsCarryPlugins(input: {
  isEnvironmentMode: boolean;
  hasActivePlugins: boolean;
  localHarnessRequested: boolean;
}): boolean {
  return (
    !input.isEnvironmentMode &&
    input.hasActivePlugins &&
    !input.localHarnessRequested
  );
}
