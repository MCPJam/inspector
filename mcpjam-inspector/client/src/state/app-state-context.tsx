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

/**
 * Non-throwing variant for surfaces that may legitimately render outside
 * an `AppStateProvider` (test fixtures, isolated previews, transient
 * bootstrap). Returns `null` instead of throwing — callers MUST handle
 * the absence themselves. Use sparingly; prefer
 * {@link useSharedAppState} when the provider is guaranteed.
 */
export function useOptionalSharedAppState(): AppState | null {
  return useContext(AppStateContext);
}
