import type { ReactNode } from "react";
import { MoreHorizontal, Plus, RotateCw } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@mcpjam/design-system/dropdown-menu";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@mcpjam/design-system/tooltip";
import { cn } from "@/lib/utils";
import { usePreferencesStore } from "@/stores/preferences/preferences-provider";
import { ExtensionIcon } from "@/components/host-workspace/ExtensionIcon";
import {
  entrypointIconSources,
  usePluginIconDirectory,
} from "@/components/host-workspace/plugin-icon-directory";
import {
  useExtensionApps,
  type SidebarApp,
} from "@/components/host-workspace/use-extension-apps";

/**
 * Global plugin Apps in the Playground's left rail (reference: ChatGPT's
 * sidebar). A row opens the App over the client area; a declared quick
 * action is a hover "+"; the row's menu holds Settings and Run onboarding.
 * Renders nothing when extensions are off or no server offers an App.
 */
export function PlaygroundAppsSection() {
  const extension = useExtensionApps();
  if (
    !extension.enabled ||
    (!extension.apps.length && !extension.failedServers.length)
  )
    return null;
  return <AppsList extension={extension} />;
}

function AppsList({
  extension,
}: {
  extension: ReturnType<typeof useExtensionApps>;
}) {
  const themeMode = usePreferencesStore((state) => state.themeMode);
  const theme = themeMode === "dark" ? "dark" : "light";
  return (
    <section
      aria-label="Apps"
      className="shrink-0 border-b border-border px-2 py-2"
    >
      <h2 className="px-1 pb-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        Apps
      </h2>
      <ul className="max-h-56 space-y-0.5 overflow-y-auto">
        {extension.apps.map((app) => (
          <AppRow
            key={app.id}
            app={app}
            theme={theme}
            active={extension.activeId === app.id}
            open={extension.isOpen(app)}
            onOpen={() =>
              app.declaration
                ? extension.open(app)
                : extension.openSettings(app.server.serverId)
            }
            onQuickAction={
              app.quickAction ? () => extension.runQuickAction(app) : undefined
            }
            onSettings={
              extension.hasSettings(app.server.serverId)
                ? () => extension.openSettings(app.server.serverId)
                : undefined
            }
            onboarding={extension.onboardingMenu(app.server.serverId)}
          />
        ))}
        {extension.failedServers.map((server) => (
          <li
            key={`failed:${server.serverId}`}
            className="flex items-center gap-2 rounded-md px-2 py-1 text-xs text-muted-foreground"
          >
            <span className="min-w-0 flex-1 truncate">
              Couldn&apos;t load {server.name} Apps
            </span>
            <button
              type="button"
              onClick={() => extension.retryDiscovery(server.serverId)}
              className="inline-flex items-center gap-1 rounded px-1 py-0.5 hover:bg-accent hover:text-foreground"
            >
              <RotateCw className="size-3" aria-hidden />
              Retry
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

function AppRow({
  app,
  theme,
  active,
  open,
  onOpen,
  onQuickAction,
  onSettings,
  onboarding,
}: {
  app: SidebarApp;
  theme: "light" | "dark";
  active: boolean;
  open: boolean;
  onOpen: () => void;
  onQuickAction?: () => void;
  onSettings?: () => void;
  onboarding: ReactNode;
}) {
  const hasMenu = !!onSettings || !!onboarding;
  const iconDirectory = usePluginIconDirectory();
  return (
    <li
      className={cn(
        "group flex items-center gap-1 rounded-md text-sm transition-colors",
        active
          ? "bg-accent text-foreground"
          : "text-foreground/90 hover:bg-accent/60",
      )}
    >
      <button
        type="button"
        onClick={onOpen}
        aria-current={active ? "page" : undefined}
        title={`${app.title} · ${app.server.name}`}
        className="flex min-w-0 flex-1 items-center gap-2 px-2 py-1.5 text-left"
      >
        <ExtensionIcon
          kind="sidebar"
          theme={theme}
          size={16}
          sources={entrypointIconSources(
            iconDirectory,
            app.server,
            app.declaration,
          )}
          className="text-muted-foreground"
        />
        <span className="truncate">{app.title}</span>
        {open && !active ? (
          <span
            className="ms-auto size-1.5 shrink-0 rounded-full bg-primary"
            aria-label="Open"
          />
        ) : null}
      </button>
      {onQuickAction ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={onQuickAction}
              aria-label={app.quickAction?.title ?? "Quick action"}
              className="rounded p-1 text-muted-foreground opacity-0 transition-opacity hover:bg-accent hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100"
            >
              <Plus className="size-3.5" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="right">{app.quickAction?.title}</TooltipContent>
        </Tooltip>
      ) : null}
      {hasMenu ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label={`${app.title} options`}
              className="mr-1 rounded p-1 text-muted-foreground opacity-0 transition-opacity hover:bg-accent hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100 data-[state=open]:opacity-100"
            >
              <MoreHorizontal className="size-3.5" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            {onSettings ? (
              <DropdownMenuItem onSelect={onSettings}>Settings</DropdownMenuItem>
            ) : null}
            {onboarding}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
    </li>
  );
}
