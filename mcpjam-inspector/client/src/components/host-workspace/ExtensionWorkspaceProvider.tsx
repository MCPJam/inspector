import {
  createContext,
  memo,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { createStore, type StoreApi } from "zustand/vanilla";
import { useStore } from "zustand";
import type { PluginMessageIntent } from "@/shared/plugin-message";
import { X } from "lucide-react";
import {
  RetainedAppsView,
  SettingsSessionsView,
  useThreadAppWorkspace,
  type ThreadAppWorkspace,
  type WorkspaceServer,
} from "./ThreadAppPanel";
import { createThreadAppApi } from "./thread-app-api";
import { logExtensionEvent } from "./extension-log";
import type { RunPluginOnboarding } from "./use-plugin-onboarding";
import {
  useExtensionDiscovery,
  type ExtensionDiscovery,
} from "./use-extension-discovery";
import {
  EMPTY_PLUGIN_ICON_DIRECTORY,
  PluginIconDirectoryProvider,
  type PluginIconDirectory,
} from "./plugin-icon-directory";
import type { PluginIcons } from "@/lib/plugins/plugin-api-types";
import {
  ALL_EXTENSION_CAPABILITIES,
  GLOBAL_OWNER_THREAD_ID,
  capabilitiesKey,
  chatOwnerScope,
  globalOwnerScope,
  ownerIdentityKey,
  type ExtensionCapabilities,
  type ExtensionOwnerIdentity,
} from "./extension-owners";

type AppMessageSender = (
  intent: PluginMessageIntent,
  isLive: () => boolean,
) => Promise<boolean>;

/** What the center registers: who is looking, at which chat, with which servers. */
export interface ExtensionRegistration {
  /** `null` turns every extension off (master switch, flag, access, client). */
  identity: ExtensionOwnerIdentity | null;
  chatId: string;
  servers: WorkspaceServer[];
  capabilities?: ExtensionCapabilities;
  /** Which client profile App launches are counted under (H9). */
  profile?: "chatgpt" | "codex";
  /**
   * The client's saved settings (their content address). Changing it keeps
   * every owner and App; each open App is re-checked against the server.
   */
  hostRevision?: string;
  /**
   * With `identity: null`: who is looking is momentarily unknown (the session
   * is refreshing, the user record is re-subscribing), not different. Every
   * owner and App stays as it is for up to `EXTENSION_AUTH_HOLD_MS`; only a
   * real change (sign-out, another user, project or client, the master
   * switch) closes them.
   */
  hold?: boolean;
}

/** How long owners outlive an identity that is momentarily unknown. */
export const EXTENSION_AUTH_HOLD_MS = 30_000;

/** Callbacks owned by the center; read when used, never a reason to re-register. */
export interface ExtensionPorts {
  sendMessage: AppMessageSender;
  runOnboarding: RunPluginOnboarding;
}

export type ExtensionOwnerKind = "global" | "chat";

interface ExtensionStoreState {
  /** Extensions are on for the registered client. */
  enabled: boolean;
  global: ThreadAppWorkspace | null;
  chats: Record<string, ThreadAppWorkspace>;
  currentChatId: string | null;
  /**
   * Where thread, file and quick-action Apps (and settings) are drawn: the
   * right rail's App area, mounted once and never moved.
   */
  railSlot: HTMLElement | null;
  /** Where global Apps take the client area over. Mounted once by the center. */
  takeoverSlot: HTMLElement | null;
  /** Bumped when a rail tab should be shown (opening the rail if collapsed). */
  railRevealSeq: number;
  /**
   * Bumped when the person dismisses a model App's fullscreen (its Exit full
   * screen control or its tab's close): a narrow window, where the rail
   * covers the chat, then collapses the rail so the chat comes back.
   */
  railDismissSeq: number;
  /**
   * A model-invoked chat App that went fullscreen, drawn over the rail's App
   * area as a tab (ChatGPT and Codex clients). Its DOM parent stays in chat.
   */
  modelFullscreen: { label: string; exit: () => void } | null;
}

function createExtensionStore() {
  return createStore<ExtensionStoreState>(() => ({
    enabled: false,
    global: null,
    chats: {},
    currentChatId: null,
    railSlot: null,
    takeoverSlot: null,
    railRevealSeq: 0,
    railDismissSeq: 0,
    modelFullscreen: null,
  }));
}

export function revealRail(store: ExtensionStore) {
  store.setState((state) => ({ railRevealSeq: state.railRevealSeq + 1 }));
}

export function dismissRail(store: ExtensionStore) {
  store.setState((state) => ({ railDismissSeq: state.railDismissSeq + 1 }));
}

export type ExtensionStore = StoreApi<ExtensionStoreState>;

interface ExtensionWorkspaceContextValue {
  store: ExtensionStore;
  register: (registration: ExtensionRegistration) => void;
  unregister: () => void;
  setPorts: (ports: ExtensionPorts) => void;
  /** The project's plugin icons by plugin id, from the center's subscription. */
  setPluginIcons: (icons: ReadonlyMap<string, PluginIcons>) => void;
  /** A deleted (archived) chat closes its owner once it is no longer shown. */
  releaseChat: (chatId: string) => void;
}

const ExtensionWorkspaceContext =
  createContext<ExtensionWorkspaceContextValue | null>(null);

const MAX_RETAINED_CHATS = 8;

function registrationKey(registration: ExtensionRegistration): string {
  return JSON.stringify([
    ownerIdentityKey(registration.identity),
    registration.chatId,
    registration.servers.map((server) => [
      server.serverId,
      server.name,
      server.connection ?? null,
    ]),
    capabilitiesKey(registration.capabilities ?? ALL_EXTENSION_CAPABILITIES),
    registration.profile ?? "chatgpt",
    registration.hostRevision ?? null,
    registration.hold === true && registration.identity === null,
  ]);
}

/**
 * Owns plugin-extension state for the whole Playground, so the left rail, the
 * center and the right rail share it. The center only registers its scope.
 *
 * One GLOBAL owner per user + project + client, and one CHAT owner per chat
 * (kept hidden when another chat is selected, up to a small bound; chats with
 * nothing open are released when you leave them).
 */
export function ExtensionWorkspaceProvider({
  children,
}: {
  children: ReactNode;
}) {
  const [store] = useState(createExtensionStore);
  const [registration, setRegistration] =
    useState<ExtensionRegistration | null>(null);
  const [released, setReleased] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [pluginIcons, setPluginIcons] = useState<
    ReadonlyMap<string, PluginIcons>
  >(EMPTY_PLUGIN_ICON_DIRECTORY.plugins);
  const clearTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const holdTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const portsRef = useRef<ExtensionPorts>({
    sendMessage: async () => false,
    runOnboarding: async () => {
      throw new Error("Onboarding is unavailable");
    },
  });
  const value = useMemo<ExtensionWorkspaceContextValue>(
    () => ({
      store,
      register: (next) => {
        if (clearTimer.current) clearTimeout(clearTimer.current);
        clearTimer.current = null;
        if (next.identity === null && next.hold) {
          // Keep the current owners (and their Apps) through an auth gap,
          // but never past the bound: a gap that does not end is a sign-out.
          holdTimer.current ??= setTimeout(() => {
            holdTimer.current = null;
            setRegistration(null);
          }, EXTENSION_AUTH_HOLD_MS);
          return;
        }
        if (holdTimer.current) clearTimeout(holdTimer.current);
        holdTimer.current = null;
        setRegistration((old) =>
          old && registrationKey(old) === registrationKey(next) ? old : next,
        );
      },
      // StrictMode replays effects immediately; a real unregister outlives that.
      unregister: () => {
        if (clearTimer.current) clearTimeout(clearTimer.current);
        clearTimer.current = setTimeout(() => {
          clearTimer.current = null;
          setRegistration(null);
        }, 0);
      },
      setPorts: (ports) => {
        portsRef.current = ports;
      },
      setPluginIcons,
      releaseChat: (chatId) =>
        setReleased((old) =>
          old.has(chatId) ? old : new Set([...old, chatId]),
        ),
    }),
    [store],
  );
  useEffect(
    () => () => {
      if (clearTimer.current) clearTimeout(clearTimer.current);
      if (holdTimer.current) clearTimeout(holdTimer.current);
    },
    [],
  );

  const identityKey = ownerIdentityKey(registration?.identity);
  const identity = useMemo(
    () => registration?.identity ?? null,
    // The identity object is re-created by every registration.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [identityKey],
  );
  const serversKey = JSON.stringify(
    (registration?.servers ?? []).map((server) => [
      server.serverId,
      server.name,
      server.connection ?? null,
    ]),
  );
  const servers = useMemo(
    () => (identity ? (registration?.servers ?? []) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [serversKey, identity],
  );
  const capsKey = capabilitiesKey(
    registration?.capabilities ?? ALL_EXTENSION_CAPABILITIES,
  );
  const capabilities = useMemo(
    () => registration?.capabilities ?? ALL_EXTENSION_CAPABILITIES,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [capsKey],
  );
  const chatId = identity ? (registration?.chatId ?? null) : null;
  const profile = registration?.profile ?? "chatgpt";
  const hostRevision = identity ? registration?.hostRevision : undefined;

  // Retained chats for the current identity, most recent last.
  const [retained, setRetained] = useState<{
    identity: string | null;
    ids: string[];
  }>({ identity: null, ids: [] });
  const retainedIds = (
    retained.identity === identityKey ? retained.ids : ([] as string[])
  ).filter((id) => id === chatId || !released.has(id));
  const chatIds =
    chatId && !retainedIds.includes(chatId)
      ? [...retainedIds, chatId]
      : retainedIds;
  useEffect(() => {
    setRetained((old) => {
      const base = old.identity === identityKey ? old.ids : [];
      if (!chatId) return { identity: identityKey, ids: base };
      const ids = [...base.filter((id) => id !== chatId), chatId];
      // Release deleted chats and hidden chats with nothing open, then cap
      // the rest.
      const chats = store.getState().chats;
      const kept = ids.filter(
        (id) =>
          id === chatId ||
          (!released.has(id) &&
            ((chats[id]?.apps.length ?? 0) > 0 ||
              (chats[id]?.settings.sessions.length ?? 0) > 0)),
      );
      const capped = kept.slice(-MAX_RETAINED_CHATS);
      return old.identity === identityKey &&
        capped.length === old.ids.length &&
        capped.every((id, index) => old.ids[index] === id)
        ? old
        : { identity: identityKey, ids: capped };
    });
  }, [identityKey, chatId, store, released]);
  useLayoutEffect(() => {
    store.setState({ currentChatId: chatId, enabled: identity !== null });
  }, [store, chatId, identity]);
  // Choosing another chat (Sessions, New chat) returns from a global App's
  // takeover to that chat; the App stays retained.
  const shownChat = useRef(chatId);
  useEffect(() => {
    if (shownChat.current !== null && chatId !== shownChat.current)
      store.getState().global?.select(null);
    shownChat.current = chatId;
  }, [store, chatId]);

  const globalScope = useMemo(
    () => (identity ? globalOwnerScope(identity) : null),
    [identity],
  );
  const discoveryApi = useMemo(
    () => (globalScope ? createThreadAppApi(globalScope) : null),
    [globalScope],
  );
  const discovery = useExtensionDiscovery(discoveryApi, servers);
  // Entrypoints and composer chips of a plugin-owned server show that
  // plugin's icons: discovery names the owner, the plugin list its icons.
  const iconDirectory = useMemo<PluginIconDirectory>(
    () => ({ plugins: pluginIcons, servers: discovery.servers }),
    [pluginIcons, discovery.servers],
  );
  const currentThreadId = useCallback(
    () => store.getState().currentChatId ?? GLOBAL_OWNER_THREAD_ID,
    [store],
  );
  const sendMessage = useCallback<AppMessageSender>(
    (intent, isLive) => portsRef.current.sendMessage(intent, isLive),
    [],
  );
  const runOnboarding = useCallback<RunPluginOnboarding>(
    (...args) => portsRef.current.runOnboarding(...args),
    [],
  );

  return (
    <ExtensionWorkspaceContext.Provider value={value}>
      <PluginIconDirectoryProvider value={iconDirectory}>
        {children}
        {identity && globalScope ? (
          <GlobalOwner
            key={globalScope.pluginWorkspace.workspaceId}
            identity={identity}
            servers={servers}
            discovery={discovery}
            capabilities={capabilities}
            profile={profile}
            hostRevision={hostRevision}
            currentThreadId={currentThreadId}
            sendMessage={sendMessage}
            runOnboarding={runOnboarding}
            store={store}
          />
        ) : null}
        {identity
          ? chatIds.map((id) => (
              <ChatOwner
                key={`${identityKey}:${id}`}
                identity={identity}
                chatId={id}
                servers={servers}
                discovery={discovery}
                capabilities={capabilities}
                profile={profile}
                hostRevision={hostRevision}
                sendMessage={sendMessage}
                store={store}
              />
            ))
          : null}
      </PluginIconDirectoryProvider>
    </ExtensionWorkspaceContext.Provider>
  );
}

function useOwnerPublication(
  store: ExtensionStore,
  kind: ExtensionOwnerKind,
  chatId: string | null,
  workspace: ThreadAppWorkspace,
) {
  useLayoutEffect(() => {
    if (kind === "global") store.setState({ global: workspace });
    else if (chatId)
      store.setState((state) => ({
        chats: { ...state.chats, [chatId]: workspace },
      }));
  });
  useLayoutEffect(
    () => () => {
      if (kind === "global") store.setState({ global: null });
      else if (chatId)
        store.setState((state) => {
          if (!(chatId in state.chats)) return state;
          const chats = { ...state.chats };
          delete chats[chatId];
          return { chats };
        });
    },
    [store, kind, chatId],
  );
}

/** A host-owned container; content is portaled into it and never moved. */
function SlotPortal({
  slot,
  children,
}: {
  slot: HTMLElement | null;
  children: ReactNode;
}) {
  return slot ? createPortal(children, slot) : null;
}

/**
 * A global App takes the client area over: the plugin's name, the App, and
 * the floating composer the center draws. Closing returns to the chat and
 * keeps the App retained.
 */
function GlobalTakeover({ workspace }: { workspace: ThreadAppWorkspace }) {
  const current = workspace.apps.find((row) => row.key === workspace.active);
  return (
    <div
      data-extension-global-takeover
      // Hidden, never unmounted: the App stays retained while you chat.
      className={
        current ? "flex h-full min-h-0 flex-col bg-background" : "hidden"
      }
    >
      <div className="grid h-14 shrink-0 grid-cols-[1fr_auto_1fr] items-center gap-3 border-b border-border/40 bg-background/95 px-4 backdrop-blur">
        <div />
        <div className="min-w-0 max-w-[40vw] truncate text-sm font-medium text-muted-foreground">
          {current?.server.name ?? ""}
        </div>
        <div className="flex min-w-0 items-center justify-end gap-2">
          <button
            type="button"
            onClick={() => workspace.select(null)}
            className="rounded-lg p-2 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            aria-label="Exit fullscreen"
            title="Back to chat"
          >
            <X className="size-5" />
          </button>
        </div>
      </div>
      <div className="flex min-h-0 flex-1 flex-col">
        <RetainedAppsView workspace={workspace} />
      </div>
    </div>
  );
}

const GlobalOwner = memo(function GlobalOwner({
  identity,
  servers,
  discovery,
  capabilities,
  profile,
  hostRevision,
  currentThreadId,
  sendMessage,
  runOnboarding,
  store,
}: {
  identity: ExtensionOwnerIdentity;
  servers: WorkspaceServer[];
  discovery: ExtensionDiscovery;
  capabilities: ExtensionCapabilities;
  profile: "chatgpt" | "codex";
  hostRevision?: string;
  currentThreadId: () => string;
  sendMessage: AppMessageSender;
  runOnboarding: RunPluginOnboarding;
  store: ExtensionStore;
}) {
  const scope = useMemo(() => globalOwnerScope(identity), [identity]);
  const workspace = useThreadAppWorkspace(scope, servers, {
    discovery,
    capabilities,
    launchProfile: profile,
    hostRevision,
    currentThreadId,
    sendMessage,
    runOnboarding,
    routeLaunch: (server, declaration) => {
      if (declaration.kind === "global") return undefined;
      const { chats, currentChatId } = store.getState();
      const chat = currentChatId ? chats[currentChatId] : undefined;
      if (chat) return chat.launch(server, declaration);
      logExtensionEvent({
        serverId: server.serverId,
        serverName: server.name,
        label: "launch",
        level: "warning",
        message: `${declaration.title}: this App opens in the current chat, and no chat is ready yet. Open or start a chat, then open it again.`,
      });
      return Promise.resolve();
    },
  });
  useOwnerPublication(store, "global", null, workspace);
  const takeoverSlot = useStore(store, (state) => state.takeoverSlot);
  const railSlot = useStore(store, (state) => state.railSlot);
  return (
    <>
      {takeoverSlot ? (
        <SlotPortal slot={takeoverSlot}>
          <GlobalTakeover workspace={workspace} />
        </SlotPortal>
      ) : (
        workspace.approvalDialog
      )}
      <SlotPortal slot={railSlot}>
        <div
          data-extension-rail-settings
          hidden={!workspace.settings.activeServerId}
          className="h-full min-h-0"
        >
          <SettingsSessionsView settings={workspace.settings} />
        </div>
      </SlotPortal>
    </>
  );
});

const ChatOwner = memo(function ChatOwner({
  identity,
  chatId,
  servers,
  discovery,
  capabilities,
  profile,
  hostRevision,
  sendMessage,
  store,
}: {
  identity: ExtensionOwnerIdentity;
  chatId: string;
  servers: WorkspaceServer[];
  discovery: ExtensionDiscovery;
  capabilities: ExtensionCapabilities;
  profile: "chatgpt" | "codex";
  hostRevision?: string;
  sendMessage: AppMessageSender;
  store: ExtensionStore;
}) {
  const scope = useMemo(
    () => chatOwnerScope(identity, chatId),
    [identity, chatId],
  );
  const workspace = useThreadAppWorkspace(scope, servers, {
    discovery,
    capabilities,
    launchProfile: profile,
    hostRevision,
    sendMessage,
    settings: false,
    // Each App owns its ports (T1): a file viewer or quick-action App opens
    // its plugin's global App the same way a thread App does.
    routeNavigate: (server, url) => {
      const global = store.getState().global;
      return global
        ? global.navigateDeepLink(server, url)
        : Promise.reject(new Error("Plugin Apps aren't available"));
    },
    onLaunch: () => {
      if (store.getState().currentChatId !== chatId) return;
      // Settings and an App never share the rail's body.
      store.getState().global?.settings.hide();
      // Nor does a model App drawn fullscreen over it: the App the person
      // just opened (a file viewer from a chip, a quick action) wins, and
      // the model App returns inline to its chat.
      store.getState().modelFullscreen?.exit();
      revealRail(store);
    },
  });
  useOwnerPublication(store, "chat", chatId, workspace);
  const railSlot = useStore(store, (state) => state.railSlot);
  const shown = useStore(store, (state) => state.currentChatId === chatId);
  const active = workspace.apps.some((row) => row.key === workspace.active);
  if (!railSlot) return <>{workspace.approvalDialog}</>;
  return (
    <SlotPortal slot={railSlot}>
      <div
        data-extension-chat={chatId}
        hidden={!shown || !active}
        className="h-full min-h-0"
      >
        <RetainedAppsView workspace={workspace} />
      </div>
    </SlotPortal>
  );
});

export function useOptionalExtensionWorkspace() {
  return useContext(ExtensionWorkspaceContext);
}

/** Read one slice of the shared extension state; inert without a provider. */
export function useExtensionWorkspaceState<T>(
  selector: (state: ExtensionStoreState) => T,
): T | undefined {
  const context = useContext(ExtensionWorkspaceContext);
  const fallback = useMemo(createExtensionStore, []);
  const value = useStore(context?.store ?? fallback, selector);
  return context ? value : undefined;
}

/** The global owner and the current chat's owner. */
export function useExtensionOwners() {
  const global = useExtensionWorkspaceState((state) => state.global) ?? null;
  const chat =
    useExtensionWorkspaceState((state) =>
      state.currentChatId ? (state.chats[state.currentChatId] ?? null) : null,
    ) ?? null;
  return { global, chat };
}

/**
 * The center registers its scope here. Returns whether a provider exists;
 * without one (embedded chats) the caller keeps its own inline workspace.
 */
export function useExtensionRegistration(
  registration: ExtensionRegistration | null,
  ports: ExtensionPorts,
): boolean {
  const context = useContext(ExtensionWorkspaceContext);
  useLayoutEffect(() => {
    context?.setPorts(ports);
  });
  const key = registration ? registrationKey(registration) : null;
  const latest = useRef(registration);
  latest.current = registration;
  useLayoutEffect(() => {
    if (!context) return;
    context.register(
      latest.current ?? {
        identity: null,
        chatId: "",
        servers: [],
      },
    );
  }, [context, key]);
  useLayoutEffect(() => {
    if (!context) return;
    return () => context.unregister();
  }, [context]);
  return context !== null;
}

/**
 * The center publishes the project's plugin icons (one subscription it
 * already owns); every extension surface in the provider reads them.
 */
export function usePublishPluginIcons(
  icons: ReadonlyMap<string, PluginIcons>,
) {
  const context = useContext(ExtensionWorkspaceContext);
  useLayoutEffect(() => {
    context?.setPluginIcons(icons);
  }, [context, icons]);
}

/**
 * The layout publishes where retained App surfaces live: the right rail's App
 * area and the center's takeover area. Each must be mounted once and never
 * moved, because moving an iframe to a new parent reloads it.
 */
export function useExtensionSlot(kind: "rail" | "takeover") {
  const context = useContext(ExtensionWorkspaceContext);
  return useCallback(
    (element: HTMLElement | null) => {
      if (!context) return;
      const key = kind === "rail" ? "railSlot" : "takeoverSlot";
      if (context.store.getState()[key] !== element)
        context.store.setState({ [key]: element } as Partial<ExtensionStoreState>);
    },
    [context, kind],
  );
}

/** Close a deleted chat's Apps (kept until it is no longer the shown chat). */
export function useExtensionChatRelease() {
  const context = useContext(ExtensionWorkspaceContext);
  return useCallback(
    (chatId: string) => context?.releaseChat(chatId),
    [context],
  );
}

export function useExtensionStore(): ExtensionStore | null {
  return useContext(ExtensionWorkspaceContext)?.store ?? null;
}
