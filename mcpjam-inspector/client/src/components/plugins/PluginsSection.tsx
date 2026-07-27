import { useProjectPlugins } from "@/hooks/usePluginImportApi";
import { pluralize } from "./plugin-presentation";
import { PluginGroupCard } from "./PluginGroupCard";

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
export function PluginsSection({ projectId }: { projectId: string | null }) {
  const plugins = useProjectPlugins(projectId);
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
          <PluginGroupCard key={plugin.pluginId} plugin={plugin} />
        ))}
      </div>
    </div>
  );
}
