import { useProjectPlugins } from "@/hooks/usePluginImportApi";
import { pluralize } from "./plugin-presentation";
import { PluginGroupCard } from "./PluginGroupCard";
import {
  permalinkUnavailableMessage,
  resolvePermalinkTarget,
} from "@/lib/permalink-target";

/**
 * The installed-plugins group on the Connect surface (PR INS-2).
 *
 * Renders nothing at all when the project has no plugins — plugin import is
 * behind `plugins-enabled` and is a new surface, so an empty section would be
 * chrome for a feature most projects are not using. The **Add plugin** entry
 * point lives in the Connect actions menu, which is always available while the
 * flag is on.
 *
 * Callers must gate this on `usePluginsEnabled()`; the query hooks fail closed
 * on their own, but the heading should not render either.
 */
export function PluginsSection({
  projectId,
  /** The plugin a `/servers/plugins/:pluginId` permalink named, if any. */
  expandedPluginId = null,
}: {
  projectId: string | null;
  expandedPluginId?: string | null;
}) {
  const plugins = useProjectPlugins(projectId);
  const routeState = resolvePermalinkTarget(
    expandedPluginId,
    plugins,
    (plugin) => plugin.pluginId
  );

  // A permalink to a plugin this viewer cannot see still has to say so — and
  // the empty-section shortcut below would otherwise swallow the answer
  // entirely on a project with no plugins at all.
  if (routeState.kind === "unavailable") {
    return (
      <div
        role="status"
        data-testid="plugin-permalink-unavailable"
        className="rounded-lg border border-border bg-muted/40 px-4 py-3 text-sm text-muted-foreground"
      >
        {permalinkUnavailableMessage("plugin")}
      </div>
    );
  }
  if (!plugins || plugins.length === 0) return null;

  return (
    <div className="space-y-2" data-testid="plugins-section">
      <div className="flex items-baseline gap-2">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Plugins
        </h3>
        <span className="text-[11px] text-muted-foreground">
          {pluralize(plugins.length, "installed")}
        </span>
      </div>
      <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
        {plugins.map((plugin) => (
          <PluginGroupCard
            key={plugin.pluginId}
            plugin={plugin}
            initiallyExpanded={plugin.pluginId === expandedPluginId}
          />
        ))}
      </div>
    </div>
  );
}
