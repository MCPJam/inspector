import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { RegistrySource } from "@/shared/types";

const OFFICIAL_REGISTRY: RegistrySource = {
  id: "official",
  name: "Official",
  url: "https://registry.modelcontextprotocol.io/v0.1",
  isOfficial: true,
  requiresAuth: false,
};

interface RegistrySourcesState {
  sources: RegistrySource[];
  activeSourceId: string;

  // Actions
  addSource: (source: Omit<RegistrySource, "id">) => string;
  updateSource: (id: string, updates: Partial<Omit<RegistrySource, "id">>) => void;
  removeSource: (id: string) => void;
  setActiveSource: (id: string) => void;
  getActiveSource: () => RegistrySource;
}

export const useRegistrySourcesStore = create<RegistrySourcesState>()(
  persist(
    (set, get) => ({
      sources: [OFFICIAL_REGISTRY],
      activeSourceId: "official",

      addSource: (source) => {
        const id = crypto.randomUUID();
        set((state) => ({
          sources: [...state.sources, { ...source, id }],
        }));
        return id;
      },

      updateSource: (id, updates) => {
        if (id === "official") return; // Can't modify official
        set((state) => ({
          sources: state.sources.map((s) =>
            s.id === id ? { ...s, ...updates } : s
          ),
        }));
      },

      removeSource: (id) => {
        if (id === "official") return; // Can't remove official
        set((state) => ({
          sources: state.sources.filter((s) => s.id !== id),
          // Reset to official if removing active source
          activeSourceId:
            state.activeSourceId === id ? "official" : state.activeSourceId,
        }));
      },

      setActiveSource: (id) => {
        const { sources } = get();
        // Only set if source exists
        if (sources.some((s) => s.id === id)) {
          set({ activeSourceId: id });
        }
      },

      getActiveSource: () => {
        const { sources, activeSourceId } = get();
        return (
          sources.find((s) => s.id === activeSourceId) || OFFICIAL_REGISTRY
        );
      },
    }),
    {
      name: "mcp-registry-sources",
    }
  )
);
