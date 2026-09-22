import { useMemo } from "react";
import { AlertTriangle, RotateCcw } from "lucide-react";
import { Checkbox } from "@mcpjam/design-system/checkbox";
import { Label } from "@mcpjam/design-system/label";
import { cn } from "@/lib/utils";
import { describePluginUnavailableReason } from "@/components/plugins/plugin-presentation";
import { usePluginRuntimePreview } from "@/hooks/usePluginImportApi";
import { useProjectEnvironment } from "@/hooks/useProjectEnvironments";
import type { EnvironmentPreviewPlugin } from "@/hooks/use-environment-preview";

/**
 * Playground plugin chips + unavailable-component preflight (INS-4).
 *
 * Two DIFFERENT questions are answered here, from two different sources, and
 * conflating them would hide the interesting one:
 *
 *  - "what can I turn off for this turn?" — the environment's RESOLVED pins
 *    (`preview.plugins`, passed in). A resolved pin is by definition runnable,
 *    so these are the only toggleable chips.
 *  - "why can't this environment run at all?" — the environment ROW's pinned
 *    version ids probed through `plugins.resolvePluginRuntimePreview`. This
 *    path exists precisely for the case where the preview FAILED: the backend
 *    refuses to resolve an environment whose pinned plugin is disabled or
 *    uninstalled (`ENV_PLUGIN_UNAVAILABLE`), so at that moment the preview
 *    carries no plugin list at all and only the row + probe can name the
 *    culprit.
 *
 * The toggle is ephemeral, like every other Playground header control: it is
 * never persisted, a reload runs the environment's set again, and the server
 * rejects any id the environment does not pin.
 */
export function PlaygroundPluginSelector({
  projectId,
  environmentId,
  plugins,
  hasExplicitOverride,
  disabled = false,
  onTogglePlugin,
  onResetPlugins,
}: {
  projectId: string | null;
  environmentId: string | null;
  /** Resolved pins with the local enable state folded in. */
  plugins: Array<EnvironmentPreviewPlugin & { enabled: boolean }>;
  hasExplicitOverride: boolean;
  disabled?: boolean;
  onTogglePlugin: (pluginVersionId: string, enabled: boolean) => void;
  onResetPlugins: () => void;
}) {
  const environmentRow = useProjectEnvironment(projectId, environmentId);
  const pinnedVersionIds = useMemo(
    () => environmentRow?.pluginVersionIds ?? [],
    [environmentRow],
  );
  // Skipped (undefined) while the flag is off, auth is unresolved, or the
  // environment pins nothing — a plugin-free environment costs no query.
  const probe = usePluginRuntimePreview(
    projectId,
    pinnedVersionIds.length > 0 ? pinnedVersionIds : null,
  );
  const unavailable = probe?.unavailableComponents ?? [];

  // Names come from the probe when it could resolve the version; an
  // unavailable one has none, and inventing a label for it would claim
  // knowledge we do not have. The short id is what we actually know.
  const nameByVersionId = useMemo(() => {
    const byId = new Map<string, string>();
    for (const plugin of plugins) byId.set(plugin.pluginVersionId, plugin.name);
    for (const version of probe?.pluginVersions ?? []) {
      byId.set(version.pluginVersionId, version.name);
    }
    return byId;
  }, [plugins, probe]);

  if (plugins.length === 0 && unavailable.length === 0) return null;

  return (
    <div
      className="flex min-w-0 flex-col gap-1"
      data-testid="playground-plugins"
    >
      <div className="flex min-w-0 items-center gap-1.5">
        <span className="shrink-0 text-[11px] text-muted-foreground">
          Plugins
        </span>
        {hasExplicitOverride ? (
          <button
            type="button"
            onClick={onResetPlugins}
            disabled={disabled}
            className="inline-flex items-center gap-1 rounded px-1 text-[11px] text-primary underline-offset-4 hover:underline disabled:opacity-60"
            data-testid="playground-plugins-reset"
          >
            <RotateCcw className="size-3" aria-hidden />
            Reset to environment
          </button>
        ) : null}
      </div>

      {plugins.length > 0 ? (
        <div
          // One scrolling row, same rule as the server chips: a wrapped list
          // grows the header and pushes the chat surface down the page.
          className="flex max-w-full flex-nowrap items-center gap-1.5 overflow-x-auto pb-0.5"
          data-testid="playground-plugin-chips"
        >
          {plugins.map((plugin) => (
            <Label
              key={plugin.pluginVersionId}
              className={cn(
                "flex shrink-0 cursor-pointer items-center gap-1 rounded-full border border-border/60 px-1.5 py-0.5 text-[11px] font-normal",
                plugin.enabled ? "bg-muted/40" : "opacity-55",
                disabled && "cursor-not-allowed opacity-60",
              )}
              data-testid={`playground-plugin-${plugin.pluginVersionId}`}
            >
              <Checkbox
                checked={plugin.enabled}
                onCheckedChange={(next) =>
                  onTogglePlugin(plugin.pluginVersionId, next === true)
                }
                disabled={disabled}
                aria-label={plugin.name}
              />
              <span className="max-w-[160px] truncate">{plugin.name}</span>
            </Label>
          ))}
        </div>
      ) : null}

      {unavailable.length > 0 ? (
        <details
          className="text-[11px] text-amber-600 dark:text-amber-400"
          data-testid="playground-plugins-unavailable"
        >
          <summary className="flex cursor-pointer items-center gap-1">
            <AlertTriangle className="size-3 shrink-0" aria-hidden />
            <span>
              {unavailable.length} of {pinnedVersionIds.length} pinned plugin
              {pinnedVersionIds.length === 1 ? "" : "s"} can't run right now
            </span>
          </summary>
          <ul className="mt-1 flex flex-col gap-0.5 pl-4">
            {unavailable.map((entry) => {
              const described = describePluginUnavailableReason(entry.reason);
              const name = nameByVersionId.get(entry.pluginVersionId);
              return (
                <li
                  key={entry.pluginVersionId}
                  data-testid={`playground-plugin-unavailable-${entry.pluginVersionId}`}
                >
                  <span className="font-medium">
                    {name ?? entry.pluginVersionId.slice(0, 12)}
                  </span>{" "}
                  — {described.label}. {described.detail}
                </li>
              );
            })}
          </ul>
        </details>
      ) : null}
    </div>
  );
}
