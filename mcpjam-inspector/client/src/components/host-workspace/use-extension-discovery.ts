import { useCallback, useEffect, useRef, useState } from "react";
import { useTrafficLogStore } from "@/stores/traffic-log-store";
import type { ThreadAppApi, ThreadAppDeclaration } from "./thread-app-api";
import { logExtensionEvent } from "./extension-log";

export interface DiscoveryServer {
  serverId: string;
  name: string;
  /**
   * Opaque connection epoch. A new defined value after the first one means the
   * server reconnected, so its entrypoints are read again.
   */
  connection?: string;
}

/** What discovery reports about a server itself, beside its entrypoints. */
export interface DiscoveredServer {
  /** The installed plugin that owns the server, when one does. */
  pluginId?: string;
  /** The server's icons (`server/discover`, else `initialize`). */
  serverIcons?: ThreadAppDeclaration["serverIcons"];
  /** The saved server's name: what tabs and headers call it. */
  name?: string;
}

export interface ExtensionDiscovery {
  entries: Record<string, ThreadAppDeclaration[]>;
  servers: Record<string, DiscoveredServer>;
  errors: Record<string, boolean>;
  /** Bumped per server each time a fresh read lands after the first. */
  revisions: Record<string, number>;
  retry: (serverId: string) => Promise<void>;
  refresh: (serverId: string) => void;
}

const LIST_CHANGED = "notifications/tools/list_changed";
const NO_SERVERS: Record<string, DiscoveredServer> = Object.freeze({});

/**
 * One discovery per (owner scope, server) shared by the global and chat
 * owners. Re-reads on `notifications/tools/list_changed` (seen in the Logs
 * stream), on reconnect, and on explicit retry, so launchers, cached metadata
 * and open Apps' tool metadata update together.
 */
export function useExtensionDiscovery(
  api: ThreadAppApi | null,
  servers: readonly DiscoveryServer[],
): ExtensionDiscovery {
  const serverKey = JSON.stringify(
    servers.map(({ serverId, name }) => [serverId, name]),
  );
  const [state, setState] = useState<{
    api: ThreadAppApi | null;
    entries: Record<string, ThreadAppDeclaration[]>;
    servers: Record<string, DiscoveredServer>;
    errors: Record<string, boolean>;
    revisions: Record<string, number>;
  }>({ api: null, entries: {}, servers: {}, errors: {}, revisions: {} });
  const owner = useRef<AbortController | null>(null);
  const perServer = useRef(new Map<string, AbortController>());
  const serversRef = useRef(servers);
  serversRef.current = servers;
  const apiRef = useRef(api);
  apiRef.current = api;

  const read = useCallback(
    async (serverId: string, fresh: boolean) => {
      const discovery = owner.current;
      const current = apiRef.current;
      if (!current || !discovery || discovery.signal.aborted) return;
      perServer.current.get(serverId)?.abort();
      const request = new AbortController();
      perServer.current.set(serverId, request);
      const signal = AbortSignal.any([discovery.signal, request.signal]);
      try {
        const found = await current.discoverServer(serverId, signal);
        if (signal.aborted || owner.current !== discovery) return;
        const name = serversRef.current
          .find((item) => item.serverId === serverId)
          ?.name.trim();
        const server: DiscoveredServer = {
          ...(name ? { name } : {}),
          ...(found.pluginId ? { pluginId: found.pluginId } : {}),
          ...(found.serverIcons?.length
            ? { serverIcons: found.serverIcons }
            : {}),
        };
        setState((old) =>
          old.api !== current
            ? old
            : {
                ...old,
                entries: { ...old.entries, [serverId]: found.entries },
                servers: { ...old.servers, [serverId]: server },
                errors: { ...old.errors, [serverId]: false },
                revisions: fresh
                  ? {
                      ...old.revisions,
                      [serverId]: (old.revisions[serverId] ?? 0) + 1,
                    }
                  : old.revisions,
              },
        );
      } catch {
        if (signal.aborted || owner.current !== discovery) return;
        setState((old) =>
          old.api !== current
            ? old
            : { ...old, errors: { ...old.errors, [serverId]: true } },
        );
        const server = serversRef.current.find(
          (item) => item.serverId === serverId,
        );
        logExtensionEvent({
          serverId,
          serverName: server?.name,
          label: "discovery",
          level: "error",
          message:
            "Couldn't read this server's App entrypoints. Its Apps are hidden until discovery succeeds.",
        });
      } finally {
        if (perServer.current.get(serverId) === request)
          perServer.current.delete(serverId);
      }
    },
    [],
  );

  useEffect(() => {
    const discovery = new AbortController();
    owner.current = discovery;
    setState({ api, entries: {}, servers: {}, errors: {}, revisions: {} });
    if (api)
      for (const server of JSON.parse(serverKey) as [string, string][])
        void read(server[0], false);
    return () => {
      discovery.abort();
      for (const request of perServer.current.values()) request.abort();
      perServer.current.clear();
      if (owner.current === discovery) owner.current = null;
    };
  }, [api, serverKey, read]);

  const refresh = useCallback(
    (serverId: string) => {
      if (!serversRef.current.some((server) => server.serverId === serverId))
        return;
      void read(serverId, true);
    },
    [read],
  );

  // Reconnect: a new connection epoch for a server re-reads it.
  const epochs = useRef(new Map<string, string>());
  const connectionKey = JSON.stringify(
    servers.map((server) => [server.serverId, server.connection ?? null]),
  );
  useEffect(() => {
    const next = new Map<string, string>();
    for (const server of servers) {
      if (!server.connection) continue;
      next.set(server.serverId, server.connection);
      const previous = epochs.current.get(server.serverId);
      if (previous !== undefined && previous !== server.connection)
        refresh(server.serverId);
    }
    // Disconnected servers keep their last epoch so reconnecting refreshes.
    for (const [id, epoch] of epochs.current)
      if (!next.has(id) && servers.some((server) => server.serverId === id))
        next.set(id, epoch);
    epochs.current = next;
  }, [connectionKey, refresh]);

  // tools/list_changed seen in the Logs stream.
  useEffect(() => {
    if (!api) return;
    let seen = new Set(
      useTrafficLogStore.getState().mcpServerItems.map((item) => item.id),
    );
    const pending = new Set<string>();
    let timer: ReturnType<typeof setTimeout> | null = null;
    const unsubscribe = useTrafficLogStore.subscribe((state) => {
      for (const item of state.mcpServerItems) {
        if (seen.has(item.id)) break;
        seen.add(item.id);
        if (item.method !== LIST_CHANGED) continue;
        const server = serversRef.current.find(
          (candidate) =>
            candidate.serverId === item.serverId ||
            candidate.name === item.serverId ||
            (item.serverName !== undefined &&
              candidate.name === item.serverName),
        );
        if (server) pending.add(server.serverId);
      }
      if (seen.size > 4096)
        seen = new Set(state.mcpServerItems.map((item) => item.id));
      if (pending.size && !timer)
        timer = setTimeout(() => {
          timer = null;
          for (const serverId of pending) refresh(serverId);
          pending.clear();
        }, 150);
    });
    return () => {
      unsubscribe();
      if (timer) clearTimeout(timer);
    };
  }, [api, refresh]);

  const retry = useCallback((serverId: string) => read(serverId, true), [read]);
  const current = state.api === api;
  return {
    entries: current ? state.entries : {},
    servers: current ? state.servers : NO_SERVERS,
    errors: current ? state.errors : {},
    revisions: current ? state.revisions : {},
    retry,
    refresh,
  };
}
