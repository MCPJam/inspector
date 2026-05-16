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
