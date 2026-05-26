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
   * Replace the global playground/chat multi-select set. Used by the
   * host-switch reconciliation so the chat composer's per-server toggles
   * match what the active host actually requires — without this, the
   * playground keeps the previous host's selection and the user has to
   * flip each toggle by hand after every switch.
   */
  setSelectedServerNames: (names: string[]) => void;
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
