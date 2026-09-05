import { createContext, useContext, useRef } from "react";

import { useStore, type StoreApi } from "zustand";

import { createPreferencesStore, PreferencesState } from "./preferences-store";

const PreferencesStoreContext =
  createContext<StoreApi<PreferencesState> | null>(null);

export const PreferencesStoreProvider = ({
  children,
  themeMode,
  themePreset,
  hostStyle,
}: {
  children: React.ReactNode;
  themeMode: PreferencesState["themeMode"];
  themePreset: PreferencesState["themePreset"];
  hostStyle?: PreferencesState["hostStyle"];
}) => {
  const storeRef = useRef<StoreApi<PreferencesState> | null>(null);

  storeRef.current ??= createPreferencesStore({
    themeMode,
    themePreset,
    hostStyle,
  });

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

/**
 * Defaults-backed store for presentational leaves that only *read* a
 * preference — a server card's client-support pill asking which theme it is
 * in, say. Those components are rendered bare in plenty of unit tests, and
 * making one throw for want of an app-level provider turns a cosmetic read
 * into a hard failure for every such test.
 *
 * Created once, module-level, so the hook is unconditional (no conditional
 * `useStore`) and every provider-less consumer shares one instance. It holds
 * the same values `createPreferencesStore()` starts with — `themeMode` is
 * "light" — and nothing writes to it, so a read here means "no provider in
 * this tree, assume the defaults."
 *
 * Anything that *depends* on the real preference (persisting a change, gating
 * behavior) must use `usePreferencesStore` and get the loud error instead.
 */
let defaultsStore: StoreApi<PreferencesState> | null = null;

export const usePreferencesStoreWithDefaults = <T,>(
  selector: (state: PreferencesState) => T,
): T => {
  defaultsStore ??= createPreferencesStore();
  const store = useContext(PreferencesStoreContext) ?? defaultsStore;
  return useStore(store, selector);
};
