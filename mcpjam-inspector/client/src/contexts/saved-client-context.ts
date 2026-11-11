import { createContext, useContext } from "react";
import { useHostContextStore } from "@/stores/client-context-store";
import type { HostSnapshot } from "@/lib/host-snapshot";

// The wrapper distinguishes a saved empty context from no client scope.
const SavedClientContext = createContext<HostSnapshot | null>(null);
const emptyHostContext = {};
export const SavedClientProvider = SavedClientContext.Provider;

export function useSavedClient() {
  return useContext(SavedClientContext);
}

export function useEffectiveHostContext() {
  const saved = useSavedClient();
  const ambient = useHostContextStore((s) => s.draftHostContext);
  return saved ? saved.hostContext ?? emptyHostContext : ambient;
}
