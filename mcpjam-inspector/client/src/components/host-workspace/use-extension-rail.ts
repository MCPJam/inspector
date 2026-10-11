import { useCallback, useMemo } from "react";
import {
  dismissRail,
  revealRail,
  useExtensionOwners,
  useExtensionSlot,
  useExtensionStore,
  useExtensionWorkspaceState,
} from "./ExtensionWorkspaceProvider";
import type { ThreadAppDeclaration } from "./thread-app-api";
import type { ExtensionIconSources } from "./ExtensionIcon";
import type { WorkspaceServer } from "./ThreadAppPanel";
import {
  entrypointIconSources,
  serverDisplayName,
  usePluginIconDirectory,
} from "./plugin-icon-directory";

/** The rail tab of a model-invoked App shown fullscreen (reference 11). */
export const MODEL_FULLSCREEN_TAB = "model-fullscreen";

export interface RailAppTab {
  /** `app:<row key>` or `settings:<server id>`. */
  id: string;
  kind: "app" | "settings";
  title: string;
  serverId: string;
  serverName: string;
  /** Two tabs share a title (two installs): show the server name too. */
  ambiguous: boolean;
  loading: boolean;
  failed: boolean;
  declaration?: ThreadAppDeclaration;
  /**
   * Sidebar icon sources: the entrypoint tool's icons, then the server's,
   * then the owning plugin's logo.
   */
  icons?: ExtensionIconSources;
}

export interface RailEntrypoint {
  server: WorkspaceServer;
  declaration: ThreadAppDeclaration;
}

/**
 * The right rail's view of plugin extensions: this chat's App tabs (thread,
 * file and quick-action Apps), open settings, and the thread entrypoints the
 * "+" menu lists under "Plugins and MCPs". Inert without the provider.
 */
export function useExtensionRail() {
  const store = useExtensionStore();
  const enabled = useExtensionWorkspaceState((state) => state.enabled) === true;
  const revealSeq =
    useExtensionWorkspaceState((state) => state.railRevealSeq) ?? 0;
  const { global, chat } = useExtensionOwners();
  const setSlot = useExtensionSlot("rail");

  const modelFullscreen = useExtensionWorkspaceState(
    (state) => state.modelFullscreen,
  );
  const iconDirectory = usePluginIconDirectory();
  const tabs = useMemo<RailAppTab[]>(() => {
    const appTabs: RailAppTab[] = (chat?.apps ?? []).map((row) => ({
      id: `app:${row.key}`,
      kind: "app",
      title: row.declaration.title || row.declaration.toolName,
      serverId: row.server.serverId,
      serverName: row.server.name,
      ambiguous: false,
      loading: row.status === "loading",
      failed: row.status === "error",
      declaration: row.declaration,
      icons: entrypointIconSources(iconDirectory, row.server, row.declaration),
    }));
    const settingsTabs: RailAppTab[] = (global?.settings.sessions ?? []).map(
      (session) => ({
        id: `settings:${session.serverId}`,
        kind: "settings",
        title: `${session.name} settings`,
        serverId: session.serverId,
        serverName: session.name,
        ambiguous: false,
        loading: false,
        failed: false,
        icons: entrypointIconSources(
          iconDirectory,
          global?.servers.find(
            (server) => server.serverId === session.serverId,
          ) ?? { serverId: session.serverId },
        ),
      }),
    );
    // The App names itself by its server; the tab shows that server's saved
    // name, never a raw id.
    const fullscreenLabel = modelFullscreen
      ? serverDisplayName(modelFullscreen.label, iconDirectory, [
          ...(chat?.servers ?? []),
          ...(global?.servers ?? []),
        ])
      : "";
    const fullscreenTabs: RailAppTab[] = modelFullscreen
      ? [
          {
            id: MODEL_FULLSCREEN_TAB,
            kind: "app",
            title: fullscreenLabel,
            serverId: "",
            serverName: fullscreenLabel,
            ambiguous: false,
            loading: false,
            failed: false,
          },
        ]
      : [];
    const all = [...appTabs, ...settingsTabs, ...fullscreenTabs];
    const counts = new Map<string, number>();
    for (const tab of all)
      counts.set(tab.title, (counts.get(tab.title) ?? 0) + 1);
    return all.map((tab) =>
      (counts.get(tab.title) ?? 0) > 1 ? { ...tab, ambiguous: true } : tab,
    );
  }, [
    chat?.apps,
    chat?.servers,
    global?.settings.sessions,
    global?.servers,
    modelFullscreen,
    iconDirectory,
  ]);

  const chatActive =
    chat?.active && chat.apps.some((row) => row.key === chat.active)
      ? `app:${chat.active}`
      : null;
  const settingsActive = global?.settings.activeServerId
    ? `settings:${global.settings.activeServerId}`
    : null;
  const activeId = modelFullscreen
    ? MODEL_FULLSCREEN_TAB
    : (chatActive ?? settingsActive);

  // Choosing another tab ends a model-invoked App's fullscreen (it returns
  // inline to its message); it can't be hidden while fullscreen.
  const leaveFullscreen = useCallback(
    (except?: string) => {
      if (modelFullscreen && except !== MODEL_FULLSCREEN_TAB)
        modelFullscreen.exit();
    },
    [modelFullscreen],
  );
  const select = useCallback(
    (id: string) => {
      leaveFullscreen(id);
      if (id === MODEL_FULLSCREEN_TAB) return;
      if (id.startsWith("app:")) {
        global?.settings.hide();
        chat?.select(id.slice(4));
      } else if (id.startsWith("settings:")) {
        chat?.select(null);
        global?.settings.open(id.slice(9));
      }
    },
    [chat, global, leaveFullscreen],
  );
  /** A built-in pane (Logs, Shell, Browser) was chosen: Apps stay retained. */
  const deselect = useCallback(() => {
    leaveFullscreen();
    chat?.select(null);
    global?.settings.hide();
  }, [chat, global, leaveFullscreen]);
  const close = useCallback(
    (id: string) => {
      if (id === MODEL_FULLSCREEN_TAB) {
        // Closing the tab is leaving fullscreen: the App returns to its
        // message, and a rail that covers the chat gets out of the way.
        leaveFullscreen();
        if (store) dismissRail(store);
        return;
      }
      if (id.startsWith("app:")) {
        const row = chat?.apps.find((item) => item.key === id.slice(4));
        if (row) void chat?.close(row);
      } else if (id.startsWith("settings:")) {
        global?.settings.close(id.slice(9));
      }
    },
    [chat, global, leaveFullscreen, store],
  );
  const openSettings = useCallback(
    (serverId: string) => {
      chat?.select(null);
      global?.settings.open(serverId);
      if (store) revealRail(store);
    },
    [chat, global, store],
  );

  const capabilities = chat?.appPorts?.capabilities;
  const entrypoints = useMemo<RailEntrypoint[]>(() => {
    if (!chat || capabilities?.conversationPanels === false) return [];
    return chat.servers.flatMap((server) =>
      (chat.entries[server.serverId] ?? [])
        .filter((declaration) => declaration.kind === "thread")
        .map((declaration) => ({ server, declaration })),
    );
  }, [chat, capabilities?.conversationPanels]);
  const launch = useCallback(
    (entry: RailEntrypoint) => chat?.launch(entry.server, entry.declaration),
    [chat],
  );

  return {
    enabled,
    revealSeq,
    tabs,
    activeId,
    select,
    deselect,
    close,
    openSettings,
    entrypoints,
    launch,
    setSlot,
  };
}
