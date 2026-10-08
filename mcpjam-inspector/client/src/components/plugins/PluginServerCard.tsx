import { useState } from "react";
import { Edit, Loader2, MoreVertical, Package, Trash2 } from "lucide-react";
import { Badge } from "@mcpjam/design-system/badge";
import { Button } from "@mcpjam/design-system/button";
import { Card } from "@mcpjam/design-system/card";
import { Separator } from "@mcpjam/design-system/separator";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@mcpjam/design-system/dropdown-menu";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/utils";
import { track } from "@/lib/analytics";
import type { PluginSummary } from "@/lib/plugins/plugin-api-types";
import { usePluginManagementActions } from "@/hooks/usePluginImportApi";
import {
  SERVER_CARD_CLASS_NAME,
  SERVER_CARD_INTERACTIVE_CLASS_NAME,
} from "@/components/connection/server-card-utils";
import { PluginIcon } from "./PluginIcon";
import { PluginUninstallDialog } from "./PluginUninstallDialog";
import { describePluginPlacement } from "./plugin-presentation";
import {
  PLUGIN_ADMIN_ONLY_REASON,
  pluginStatusDotClass,
  type PluginStatusPresentation,
} from "./plugin-status";

export interface PluginServerCardServer {
  /** The plugin component's materialized server id. */
  serverId: string;
  name: string;
  placement?: "remote" | "local" | "computer";
  componentKey?: string;
}

/**
 * A server an installed plugin adds, on the Servers tab beside the project's
 * own servers and in the same card.
 *
 * It is not a browser connection — the chat route connects it, by id, on
 * every message that carries the plugin — so where a project server's connect
 * switch sits, this card says whether chats run the plugin right now. Clicking the card (or ⋮ → Configure)
 * opens its Settings, where the plugin's versions, setup and lifecycle live.
 *
 * Without a `server` it is the plugin's own card: an installed plugin with
 * no active version has no servers yet, and this is where it is activated
 * or uninstalled from.
 */
export function PluginServerCard({
  plugin,
  server,
  status,
  canManage,
  onOpenSettings,
}: {
  plugin: PluginSummary;
  /** Omitted for the plugin's own card (no active version, so no servers). */
  server?: PluginServerCardServer;
  status: PluginStatusPresentation;
  /** Project admin: lifecycle actions are refused for anyone else. */
  canManage: boolean;
  onOpenSettings: (serverId: string | null) => void;
}) {
  const management = usePluginManagementActions();
  const [menuOpen, setMenuOpen] = useState(false);
  const [confirmUninstall, setConfirmUninstall] = useState(false);
  const [pending, setPending] = useState(false);
  const pluginLabel = plugin.displayName || plugin.name;
  const title = server?.name ?? pluginLabel;

  const uninstall = async () => {
    setPending(true);
    try {
      await management.softDeletePlugin(plugin.pluginId);
      track("plugin_uninstalled", { location: "plugin_server_card" });
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : "Could not uninstall the plugin.",
      );
    } finally {
      setPending(false);
    }
  };

  return (
    <>
      <Card
        className={cn(
          SERVER_CARD_CLASS_NAME,
          SERVER_CARD_INTERACTIVE_CLASS_NAME,
        )}
        data-testid={server ? "plugin-server-card" : "plugin-card"}
        onClick={() => {
          if (menuOpen) return;
          onOpenSettings(server?.serverId ?? null);
        }}
      >
        <div className="p-4">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <PluginIcon
                  icons={plugin.icons}
                  kind="directory"
                  className="h-5 w-5 flex-shrink-0 rounded object-contain"
                  fallback={
                    <Package
                      className="h-4 w-4 flex-shrink-0 text-muted-foreground"
                      aria-hidden
                    />
                  }
                />
                <h3 className="truncate text-sm font-semibold text-foreground">
                  {title}
                </h3>
                {server ? (
                  <Badge
                    variant="secondary"
                    className="shrink-0 text-[10px] font-normal"
                    data-testid="plugin-server-badge"
                  >
                    from {pluginLabel}
                  </Badge>
                ) : null}
              </div>
            </div>

            <div className="flex flex-col items-end gap-1.5">
              <div
                className="flex items-center gap-1.5"
                onClick={(event) => event.stopPropagation()}
              >
                <span
                  className="inline-flex items-center gap-1.5 px-1 text-[11px] text-muted-foreground"
                  data-testid="plugin-server-status"
                >
                  {pending ? (
                    <Loader2 className="h-2.5 w-2.5 animate-spin" />
                  ) : (
                    <span
                      className={cn(
                        "h-1.5 w-1.5 rounded-full",
                        pluginStatusDotClass(status.tone),
                      )}
                    />
                  )}
                  <span>{status.label}</span>
                </span>
                <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
                  <DropdownMenuTrigger asChild>
                    <Button
                      aria-label={`Open actions menu for ${title}`}
                      variant="ghost"
                      size="sm"
                      className="h-7 w-7 cursor-pointer p-0 text-muted-foreground/70 hover:text-foreground"
                    >
                      <MoreVertical className="h-3.5 w-3.5" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-56">
                    <DropdownMenuItem
                      className="cursor-pointer text-xs"
                      onClick={() => {
                        track("edit_server_clicked", {
                          location: "plugin_server_card",
                        });
                        onOpenSettings(server?.serverId ?? null);
                      }}
                    >
                      <Edit className="mr-2 h-3 w-3" />
                      Configure
                    </DropdownMenuItem>
                    <Separator />
                    <DropdownMenuItem
                      className="cursor-pointer text-xs text-destructive"
                      disabled={!canManage || pending}
                      onClick={() => setConfirmUninstall(true)}
                    >
                      <Trash2 className="mr-2 h-3 w-3" />
                      Uninstall plugin…
                    </DropdownMenuItem>
                    {!canManage ? (
                      <p
                        className="px-2 pb-1.5 text-[10px] text-muted-foreground"
                        data-testid="plugin-server-card-admin-reason"
                      >
                        {PLUGIN_ADMIN_ONLY_REASON}
                      </p>
                    ) : null}
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            </div>
          </div>

          <div className="mt-2 rounded-md border border-border/50 bg-muted/30 p-2 font-mono text-xs text-muted-foreground">
            <div className="break-all">
              {[
                server?.placement
                  ? describePluginPlacement(server.placement)
                  : null,
                plugin.name,
                server?.componentKey,
              ]
                .filter(Boolean)
                .join(" · ")}
            </div>
          </div>
        </div>
      </Card>
      <PluginUninstallDialog
        open={confirmUninstall}
        onOpenChange={setConfirmUninstall}
        pluginLabel={pluginLabel}
        onConfirm={() => void uninstall()}
      />
    </>
  );
}
