import {
  type ReactNode,
  createContext,
  useRef,
  useContext,
  useEffect,
} from "react";
import { useStore } from "zustand";
import { type RegistryState, createRegistryStore } from "./registry-store";

export type RegistryStoreApi = ReturnType<typeof createRegistryStore>;

const RegistryStoreContext = createContext<RegistryStoreApi | undefined>(
  undefined,
);

export interface RegistryStoreProviderProps {
  children: ReactNode;
}

export const RegistryStoreProvider = ({
  children,
}: RegistryStoreProviderProps) => {
  const storeRef = useRef<RegistryStoreApi>();

  if (!storeRef.current) {
    storeRef.current = createRegistryStore();
  }

  // Load all registry data when the provider mounts
  useEffect(() => {
    if (storeRef.current) {
      const store = storeRef.current;
      store.getState().fetchAllPages();
    }
  }, []);

  return (
    <RegistryStoreContext.Provider value={storeRef.current}>
      {children}
    </RegistryStoreContext.Provider>
  );
};

export const useRegistryStore = <T,>(
  selector: (state: RegistryState) => T,
): T => {
  const store = useContext(RegistryStoreContext);
  if (!store) {
    throw new Error(
      "useRegistryStore must be used within RegistryStoreProvider",
    );
  }
  return useStore(store, selector);
};
