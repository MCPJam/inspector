import { createContext, useContext, useRef, useEffect } from "react";

import { useStore, type StoreApi } from "zustand";

import { createPreferencesStore, PreferencesState } from "./preferences-store";
import { updateThemeMode, updateThemePreset } from "@/lib/theme-utils";

const PreferencesStoreContext =
  createContext<StoreApi<PreferencesState> | null>(null);

export const PreferencesStoreProvider = ({
  children,
  themeMode,
  themePreset,
}: {
  children: React.ReactNode;
  themeMode: PreferencesState["themeMode"];
  themePreset: PreferencesState["themePreset"];
}) => {
  const storeRef = useRef<StoreApi<PreferencesState> | null>(null);

  storeRef.current ??= createPreferencesStore({ themeMode, themePreset });

  // Apply theme on mount
  useEffect(() => {
    const state = storeRef.current?.getState();
    if (state) {
      updateThemeMode(state.themeMode);
      updateThemePreset(state.themePreset);
    }
  }, []);

  return (
    <PreferencesStoreContext.Provider value={storeRef.current}>
      {children}
    </PreferencesStoreContext.Provider>
  );
};

export const usePreferencesStore = <T,>(
  selector: (state: PreferencesState) => T,
): T => {
  const store = useContext(PreferencesStoreContext);
  if (!store) throw new Error("Missing PreferencesStoreProvider");
  return useStore(store, selector);
};
