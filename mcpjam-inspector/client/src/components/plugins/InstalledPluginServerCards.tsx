import type { ActivePluginRow } from "@/lib/plugins/active-plugins-types";
import type { PluginSummary } from "@/lib/plugins/plugin-api-types";
import {
  usePluginSetupStatus,
  usePluginVersion,
} from "@/hooks/usePluginImportApi";
import type { PluginServerDetail } from "@/components/connection/ServerDetailModal";
import {
  PluginServerCard,
  type PluginServerCardServer,
} from "./PluginServerCard";
import { describePluginStatus } from "./plugin-status";

/**
 * The servers of one installed plugin, as server cards.
 *
 * Read from the plugin's active version (names as the bundle declares them),
 * falling back to the active-plugins row until the version arrives. A plugin
 * with no servers renders nothing here; its skills are on the Skills tab.
 */
export function pluginCardServers(
  plugin: Pick<PluginSummary, "activeVersionId">,
  version: ReturnType<typeof usePluginVersion>,
  row: ActivePluginRow | undefined,
): PluginServerCardServer[] {
  if (version && version.pluginVersionId === plugin.activeVersionId) {
    return version.servers.flatMap((component) =>
      component.materializedServerId
        ? [
            {
              serverId: component.materializedServerId,
              name: component.declaredName,
              placement: component.placement,
              componentKey: component.componentKey,
            },
          ]
        : [],
    );
  }
  return (row?.servers ?? []).map((server) => ({
    serverId: server.serverId,
    name: server.name,
    placement: server.placement,
    componentKey: server.componentKey,
  }));
}

/**
 * One installed plugin on the Servers tab: a card per server it adds. A
 * plugin with no active version ("Install only") has no servers or skills to
 * show anywhere, so it gets one card of its own instead, which opens the
 * Settings where a version is activated or the plugin uninstalled.
 */
export function InstalledPluginServerCards({
  plugin,
  row,
  canManage,
  onOpenSettings,
}: {
  plugin: PluginSummary;
  /** The plugin's row from `useActivePlugins`, once answered. */
  row: ActivePluginRow | undefined;
  canManage: boolean;
  onOpenSettings: (detail: PluginServerDetail) => void;
}) {
  const activeVersionId = plugin.activeVersionId ?? null;
  const version = usePluginVersion(activeVersionId);
  const setupStatus = usePluginSetupStatus(activeVersionId);
  const cards = pluginCardServers(plugin, version, row);
  const pluginLabel = plugin.displayName || plugin.name;
  if (!activeVersionId) {
    return (
      <PluginServerCard
        plugin={plugin}
        status={describePluginStatus({
          enabled: plugin.enabled,
          activeVersionId,
          row,
        })}
        canManage={canManage}
        onOpenSettings={() =>
          onOpenSettings({
            pluginId: plugin.pluginId,
            pluginLabel,
            serverId: null,
            serverName: pluginLabel,
          })
        }
      />
    );
  }
  return (
    <>
      {cards.map((card) => {
        const readiness = setupStatus?.components.find(
          (component) => component.componentKey === card.componentKey,
        )?.readiness;
        const status = describePluginStatus({
          enabled: plugin.enabled,
          activeVersionId,
          row,
          readiness,
        });
        return (
          <PluginServerCard
            key={card.serverId}
            plugin={plugin}
            server={card}
            status={status}
            canManage={canManage}
            onOpenSettings={() =>
              onOpenSettings({
                pluginId: plugin.pluginId,
                pluginLabel,
                serverId: card.serverId,
                serverName: card.name,
              })
            }
          />
        );
      })}
    </>
  );
}
