import { createContext, useContext } from "react";
import type { AppState } from "./app-types";
import type { MCPServerConfig } from "@mcpjam/sdk/browser";
import type { ServerWithName } from "./app-types";

/**
 * Runtime API that a subtree can use to connect/disconnect MCP servers
 * against its own scoped state. The root app does not provide this —
 * only the learning sandbox (or similar isolated providers) do.
 */
export interface AppRuntimeContextValue {
  connectRuntimeServer(opts: {
    name: string;
    config: MCPServerConfig;
    silent?: boolean;
  }): Promise<void>;
  disconnectRuntimeServer(name: string): Promise<void>;
  getServerEntry(name: string): ServerWithName | undefined;
}

const AppStateContext = createContext<AppState | null>(null);
const AppRuntimeContext = createContext<AppRuntimeContextValue | null>(null);

export function AppStateProvider({
  appState,
  runtimeApi,
  children,
}: {
  appState: AppState;
  runtimeApi?: AppRuntimeContextValue;
  children: React.ReactNode;
}) {
  return (
    <AppStateContext.Provider value={appState}>
      {runtimeApi ? (
        <AppRuntimeContext.Provider value={runtimeApi}>
          {children}
        </AppRuntimeContext.Provider>
      ) : (
        children
      )}
    </AppStateContext.Provider>
  );
}

export function useSharedAppState(): AppState {
  const ctx = useContext(AppStateContext);
  if (!ctx) {
    throw new Error("useSharedAppState must be used within AppStateProvider");
  }
  return ctx;
}

/**
 * Returns the runtime API from the nearest provider, or null if
 * the current subtree is state-only (e.g. the root app).
 */
export function useSharedAppRuntime(): AppRuntimeContextValue | null {
  return useContext(AppRuntimeContext);
}
