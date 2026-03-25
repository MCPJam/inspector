import { createContext, useContext } from "react";
import type { MCPServerConfig } from "@mcpjam/sdk/browser";
import type { AppState, ServerWithName } from "./app-types";

const AppStateContext = createContext<AppState | null>(null);
const AppRuntimeContext = createContext<AppRuntimeContextValue | null>(null);

export interface AppRuntimeContextValue {
  connectRuntimeServer: (options: {
    name: string;
    config: MCPServerConfig;
    surface?: ServerWithName["surface"];
    silent?: boolean;
    select?: boolean;
  }) => Promise<void>;
  disconnectRuntimeServer: (serverName: string) => Promise<void>;
  getServerEntry: (name: string) => ServerWithName | undefined;
}

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
    <AppRuntimeContext.Provider value={runtimeApi ?? null}>
      <AppStateContext.Provider value={appState}>
        {children}
      </AppStateContext.Provider>
    </AppRuntimeContext.Provider>
  );
}

export function useSharedAppState(): AppState {
  const ctx = useContext(AppStateContext);
  if (!ctx) {
    throw new Error("useSharedAppState must be used within AppStateProvider");
  }
  return ctx;
}

export function useSharedAppRuntime(): AppRuntimeContextValue {
  const ctx = useContext(AppRuntimeContext);
  if (!ctx) {
    throw new Error("useSharedAppRuntime must be used within AppStateProvider");
  }
  return ctx;
}
