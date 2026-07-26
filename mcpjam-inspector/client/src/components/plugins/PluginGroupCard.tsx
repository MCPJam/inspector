import { useState } from "react";
import {
  ChevronRight,
  Loader2,
  MoreVertical,
  Package,
  Wrench,
} from "lucide-react";
import { Badge } from "@mcpjam/design-system/badge";
import { Button } from "@mcpjam/design-system/button";
import { Card } from "@mcpjam/design-system/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@mcpjam/design-system/dropdown-menu";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@mcpjam/design-system/alert-dialog";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/utils";
import { track } from "@/lib/analytics";
import type { PluginSummary } from "@/lib/plugins/plugin-api-types";
import {
  useProjectPlugin,
  usePluginManagementActions,
  usePluginSetupStatus,
  usePluginVersion,
} from "@/hooks/usePluginImportApi";
import {
  describePluginHealth,
  describePluginPlacement,
  describePluginReadiness,
  pluralize,
  rollUpPluginHealth,
  shortBundleHash,
} from "./plugin-presentation";

/**
 * A plugin GROUP card (PR INS-2). A plugin is not a server card: it is a
 * bundle whose component servers and skills belong to an immutable revision.
 * Collapsed, it shows identity + rolled-up health; expanded, it shows the
 * revision's components with per-component health.
 *
 * Removing a component is deliberately absent — the plan requires that
 * "removing a component routes to the plugin rather than deleting it", and
 * plugin projections are read-only by construction (the backend rejects
 * structural edits to `lifecycleScope: 'plugin_component'` rows). The kebab
 * therefore offers only plugin-level lifecycle actions.
 */

const TONE_CLASSES: Record<string, string> = {
  ready:
    "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  attention:
    "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300",
  info: "border-blue-500/30 bg-blue-500/10 text-blue-700 dark:text-blue-300",
  muted: "border-border/60 bg-muted/30 text-muted-foreground",
};

export function PluginGroupCard({ plugin }: { plugin: PluginSummary }) {
  const [expanded, setExpanded] = useState(false);
  const [pendingAction, setPendingAction] = useState(false);
  const [confirmUninstall, setConfirmUninstall] = useState(false);
  const management = usePluginManagementActions();

  const activeVersionId = plugin.activeVersionId ?? null;
  const setupStatus = usePluginSetupStatus(activeVersionId);
  // Component projections only matter once the card is opened; skip the
  // subscription while collapsed.
  const version = usePluginVersion(expanded ? activeVersionId : null);
  const detail = useProjectPlugin(expanded ? plugin.pluginId : null);

  const health = rollUpPluginHealth(plugin, setupStatus);
  const healthPresentation = describePluginHealth(health);

  const runAction = async (label: string, run: () => Promise<void>) => {
    setPendingAction(true);
    try {
      await run();
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : `Could not ${label}.`,
      );
    } finally {
      setPendingAction(false);
    }
  };

  return (
    <Card className="p-0" data-testid="plugin-group-card">
      <div className="flex items-start gap-3 p-4">
        <button
          type="button"
          className="flex min-w-0 flex-1 items-start gap-3 text-left"
          aria-expanded={expanded}
          onClick={() => setExpanded((prev) => !prev)}
        >
          <ChevronRight
            className={cn(
              "mt-1 h-4 w-4 shrink-0 text-muted-foreground transition-transform",
              expanded && "rotate-90",
            )}
            aria-hidden
          />
          <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-muted">
            <Package className="h-4 w-4 text-muted-foreground" aria-hidden />
          </div>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <span className="truncate text-sm font-medium">
                {plugin.displayName || plugin.name}
              </span>
              <Badge
                variant="outline"
                className={cn(
                  "font-normal",
                  TONE_CLASSES[healthPresentation.tone],
                )}
                data-testid="plugin-health-badge"
              >
                {healthPresentation.label}
              </Badge>
            </div>
            {plugin.description ? (
              <p className="mt-0.5 line-clamp-1 text-xs text-muted-foreground">
                {plugin.description}
              </p>
            ) : null}
          </div>
        </button>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              disabled={pendingAction}
              aria-label={`Plugin actions for ${plugin.displayName || plugin.name}`}
            >
              {pendingAction ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <MoreVertical className="h-4 w-4" />
              )}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem
              onClick={() =>
                void runAction(
                  plugin.enabled ? "disable the plugin" : "enable the plugin",
                  async () => {
                    await management.setEnabled(
                      plugin.pluginId,
                      !plugin.enabled,
                    );
                    if (plugin.enabled) {
                      track("plugin_disabled", { location: "plugin_card" });
                    }
                  },
                )
              }
            >
              {plugin.enabled ? "Disable" : "Enable"}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => setConfirmUninstall(true)}>
              Uninstall
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {expanded ? (
        <div
          className="space-y-3 border-t border-border/60 px-4 py-3"
          data-testid="plugin-group-card-detail"
        >
          {activeVersionId === null ? (
            <p className="text-xs text-muted-foreground">
              No revision is active yet. Import this plugin again and choose
              “Install and connect” to activate a revision.
            </p>
          ) : version === undefined ? (
            <p className="text-xs text-muted-foreground">Loading components…</p>
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                <span>
                  Revision{" "}
                  <code className="rounded bg-muted px-1 py-0.5">
                    {shortBundleHash(version.bundleHash)}
                  </code>
                </span>
                {version.declaredVersion ? (
                  <span>v{version.declaredVersion}</span>
                ) : null}
              </div>

              {version.servers.length > 0 ? (
                <div className="space-y-1.5">
                  <p className="text-xs font-medium">
                    {pluralize(version.servers.length, "MCP server")}
                  </p>
                  <ul className="space-y-1">
                    {version.servers.map((component) => {
                      const readiness = setupStatus?.components.find(
                        (c) => c.componentKey === component.componentKey,
                      )?.readiness;
                      const described = readiness
                        ? describePluginReadiness(readiness)
                        : null;
                      return (
                        <li
                          key={component.componentId}
                          className="flex items-center gap-2 text-xs"
                        >
                          <Wrench
                            className="h-3 w-3 shrink-0 text-muted-foreground"
                            aria-hidden
                          />
                          <span className="truncate font-medium">
                            {component.declaredName}
                          </span>
                          <span className="text-muted-foreground">
                            {describePluginPlacement(component.placement)}
                          </span>
                          {described ? (
                            <Badge
                              variant="outline"
                              className={cn(
                                "ml-auto font-normal",
                                TONE_CLASSES[described.tone],
                              )}
                            >
                              {described.label}
                            </Badge>
                          ) : null}
                        </li>
                      );
                    })}
                  </ul>
                </div>
              ) : null}

              {version.skills.length > 0 ? (
                <div className="space-y-1.5">
                  <p className="text-xs font-medium">
                    {pluralize(version.skills.length, "skill")}
                  </p>
                  <ul className="space-y-1">
                    {version.skills.map((component) => (
                      <li
                        key={component.componentId}
                        className="text-xs text-muted-foreground"
                      >
                        <code className="rounded bg-muted px-1 py-0.5">
                          {component.modelRef}
                        </code>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}

              {version.componentCounts.unsupported > 0 ? (
                <p className="text-[11px] text-muted-foreground">
                  {pluralize(
                    version.componentCounts.unsupported,
                    "component",
                  )}{" "}
                  in this bundle are preserved but not run by MCPJam.
                </p>
              ) : null}

              {/* Other ready revisions of the same plugin. Activating one only
                  changes what NEW attachments offer — environments that
                  already pin a version keep it until upgraded explicitly. */}
              {detail && detail.versions.length > 1 ? (
                <div className="space-y-1.5">
                  <p className="text-xs font-medium">Other revisions</p>
                  <ul className="space-y-1">
                    {detail.versions
                      .filter(
                        (v) =>
                          v.status === "ready" &&
                          v.pluginVersionId !== activeVersionId,
                      )
                      .map((v) => (
                        <li
                          key={v.pluginVersionId}
                          className="flex items-center gap-2 text-xs"
                        >
                          <code className="rounded bg-muted px-1 py-0.5">
                            {shortBundleHash(v.bundleHash)}
                          </code>
                          {v.declaredVersion ? (
                            <span className="text-muted-foreground">
                              v{v.declaredVersion}
                            </span>
                          ) : null}
                          <Button
                            variant="ghost"
                            size="sm"
                            className="ml-auto h-6 px-2 text-xs"
                            disabled={pendingAction}
                            onClick={() =>
                              void runAction("activate that revision", async () => {
                                await management.activateVersion(
                                  plugin.pluginId,
                                  v.pluginVersionId,
                                );
                                track("plugin_version_upgraded", {
                                  location: "plugin_card",
                                });
                              })
                            }
                          >
                            Activate
                          </Button>
                        </li>
                      ))}
                  </ul>
                </div>
              ) : null}
            </>
          )}
        </div>
      ) : null}

      <AlertDialog open={confirmUninstall} onOpenChange={setConfirmUninstall}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Uninstall {plugin.displayName || plugin.name}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              Revisions already used by runs and sessions are preserved, so
              existing history stays reproducible. Uninstall is blocked while a
              live environment still pins one of this plugin's versions.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() =>
                void runAction("uninstall the plugin", async () => {
                  await management.softDeletePlugin(plugin.pluginId);
                  track("plugin_uninstalled", { location: "plugin_card" });
                })
              }
            >
              Uninstall
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}
