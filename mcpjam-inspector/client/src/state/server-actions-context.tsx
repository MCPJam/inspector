import { createContext, useContext } from "react";
import type { EnsureServersReadyResult } from "@/hooks/use-server-state";

export interface ServerActions {
  /**
   * Single-shot batch connect by server name. Re-exposed from
   * `useServerState().ensureServersReady` so non-chatbox surfaces (host
   * builder, top-level Servers tab, Playground) can trigger auto-connect
   * without inheriting the chatbox-builder prop chain.
   */
  ensureServersReady: (
    serverNames: string[],
  ) => Promise<EnsureServersReadyResult>;
  /**
   * Flip a server's runtime state to "disconnected" WITHOUT going through
   * the delete-server side effect that `handleDisconnect` does in local
   * mode. Used by host-switch auto-disconnect to tear down connections the
   * new host doesn't require, while keeping the server config intact.
   */
  runtimeDisconnectServer: (serverName: string) => void;
  /**
   * Force a re-handshake of an already-connected server under the current
   * client identity (backend closes + reopens the transport with the active
   * host's clientInfo). Used by the client-switch recycle so every connected
   * server re-initializes as the newly-selected client. Non-interactive.
   */
  reconnectServer: (serverName: string) => Promise<void>;
  /**
   * Replace the global playground/chat multi-select set. Used by the
   * host-switch reconciliation so the chat composer's per-server toggles
   * match what the active host actually requires — without this, the
   * playground keeps the previous host's selection and the user has to
   * flip each toggle by hand after every switch.
   */
  setSelectedServerNames: (names: string[]) => void;
  /**
   * Resolve selected runtime server names → persisted Convex server ids for a
   * hosted send (persisting ad-hoc/App servers that aren't saved yet). Throws if
   * a name can't be resolved/persisted. Surfaces use this as a preflight before a
   * hosted harness turn so the proxy/authorize-batch never receive a display
   * name. Re-exposed from `useServerState().ensureHostedServerIdsForNames`.
   */
  ensureHostedServerIdsForNames: (
    serverNames: string[],
  ) => Promise<Array<{ serverName: string; serverId: string }>>;
}

const ServerActionsContext = createContext<ServerActions | null>(null);

export function ServerActionsProvider({
  actions,
  children,
}: {
  actions: ServerActions;
  children: React.ReactNode;
}) {
  return (
    <ServerActionsContext.Provider value={actions}>
      {children}
    </ServerActionsContext.Provider>
  );
}

export function useServerActions(): ServerActions {
  const ctx = useContext(ServerActionsContext);
  if (!ctx) {
    throw new Error(
      "useServerActions must be used within ServerActionsProvider",
    );
  }
  return ctx;
}

/**
 * Non-throwing variant: returns `null` when rendered outside a provider (e.g. a
 * PlaygroundMain embedded in an isolated context). Callers must treat the
 * actions as optional.
 */
export function useServerActionsOptional(): ServerActions | null {
  return useContext(ServerActionsContext);
}
