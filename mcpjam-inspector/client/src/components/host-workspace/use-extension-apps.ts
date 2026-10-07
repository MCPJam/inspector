import { useCallback, useMemo } from "react";
import {
  revealRail,
  useExtensionOwners,
  useExtensionStore,
  useExtensionWorkspaceState,
} from "./ExtensionWorkspaceProvider";
import { threadAppRowKey, type WorkspaceServer } from "./ThreadAppPanel";
import type { ThreadAppDeclaration } from "./thread-app-api";
import { logExtensionEvent } from "./extension-log";

export interface SidebarApp {
  /** `serverId` + tool name. */
  id: string;
  server: WorkspaceServer;
  /** The global entrypoint; absent for a server listed only for its settings. */
  declaration?: ThreadAppDeclaration;
  /** A quick action declared on the same tool (SDK-only, spec note S1). */
  quickAction?: ThreadAppDeclaration;
  title: string;
}

/**
 * The left rail's view of plugin extensions: one row per global entrypoint
 * (title from `title`, then `annotations.title`, then `name`, as discovery
 * reports it), plus servers that offer settings or onboarding without one.
 */
export function useExtensionApps() {
  const store = useExtensionStore();
  const enabled = useExtensionWorkspaceState((state) => state.enabled) === true;
  const { global, chat } = useExtensionOwners();
  const capabilities = global?.appPorts?.capabilities;

  const apps = useMemo<SidebarApp[]>(() => {
    if (!global) return [];
    const rows: SidebarApp[] = [];
    for (const server of global.servers) {
      const declared = global.entries[server.serverId] ?? [];
      const entrypoints =
        capabilities?.sidebarApps === false
          ? []
          : declared.filter((entry) => entry.kind === "global");
      for (const declaration of entrypoints)
        rows.push({
          id: JSON.stringify([server.serverId, declaration.toolName]),
          server,
          declaration,
          quickAction: declared.find(
            (entry) =>
              entry.kind === "quick-action" &&
              entry.toolName === declaration.toolName,
          ),
          title: declaration.title || declaration.toolName,
        });
      if (
        !entrypoints.length &&
        (global.settings.availableServerIds.includes(server.serverId) ||
          global.onboarding.menu(server.serverId) !== null)
      )
        rows.push({
          id: JSON.stringify([server.serverId, null]),
          server,
          title: server.name,
        });
    }
    return rows;
  }, [global, capabilities?.sidebarApps]);

  const failedServers = useMemo(
    () =>
      (global?.servers ?? []).filter(
        (server) => global?.discoveryErrors[server.serverId],
      ),
    [global],
  );

  const activeId = useMemo(() => {
    const row = global?.apps.find((item) => item.key === global.active);
    return row
      ? JSON.stringify([row.server.serverId, row.declaration.toolName])
      : null;
  }, [global]);

  const open = useCallback(
    (app: SidebarApp) => {
      if (!global || !app.declaration) return;
      void global.launch(app.server, app.declaration);
    },
    [global],
  );
  const runQuickAction = useCallback(
    (app: SidebarApp) => {
      if (!app.quickAction) return;
      if (!chat) {
        // A quick action runs in the current chat; never a silent no-op.
        logExtensionEvent({
          serverId: app.server.serverId,
          serverName: app.server.name,
          label: "launch",
          level: "warning",
          message: `${app.quickAction.title || app.title}: quick actions run in the current chat, and no chat is ready yet. Open or start a chat, then run it again.`,
        });
        return;
      }
      void chat.launch(app.server, app.quickAction);
    },
    [chat],
  );
  const openSettings = useCallback(
    (serverId: string) => {
      if (!global) return;
      chat?.select(null);
      global.settings.open(serverId);
      if (store) revealRail(store);
    },
    [chat, global, store],
  );
  const isOpen = useCallback(
    (app: SidebarApp) =>
      !!app.declaration &&
      !!global?.apps.some(
        (row) =>
          row.key === threadAppRowKey(app.server.serverId, app.declaration!),
      ),
    [global],
  );

  return {
    enabled: enabled && !!global,
    apps,
    failedServers,
    activeId,
    open,
    isOpen,
    runQuickAction,
    openSettings,
    hasSettings: (serverId: string) =>
      capabilities?.settings !== false &&
      !!global?.settings.availableServerIds.includes(serverId),
    onboardingMenu: (serverId: string) =>
      global?.onboarding.menu(serverId) ?? null,
    retryDiscovery: (serverId: string) => void global?.retryDiscovery(serverId),
  };
}
