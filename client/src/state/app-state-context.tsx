import { createContext, useContext } from "react";
import type { AppState } from "./app-types";

const AppStateContext = createContext<AppState | null>(null);

export function AppStateProvider({
  appState,
  children,
}: {
  appState: AppState;
  children: React.ReactNode;
}) {
  return (
    <AppStateContext.Provider value={appState}>
      {children}
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
