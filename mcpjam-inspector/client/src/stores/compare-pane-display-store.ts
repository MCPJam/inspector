import { create } from "zustand";
import type { DeviceType } from "@/stores/ui-playground-store";

export type PaneTheme = "light" | "dark";
export type PaneThemePreference = PaneTheme | "app" | "client";

/** How one Compare pane displays its Apps, over the Playground's own. */
export interface PaneDisplay {
  deviceType?: DeviceType;
  theme?: PaneTheme;
}

type PaneDisplayPreferences = {
  deviceType?: DeviceType;
  theme?: PaneThemePreference;
};

interface ComparePaneDisplayState {
  byPane: Record<string, PaneDisplayPreferences>;
  setPaneDisplay: (paneId: string, patch: PaneDisplayPreferences) => void;
}

/** Per-pane Device and Theme for this tab. Not saved with the client. */
export const useComparePaneDisplayStore = create<ComparePaneDisplayState>(
  (set) => ({
    byPane: {},
    setPaneDisplay: (paneId, patch) =>
      set((state) => ({
        byPane: {
          ...state.byPane,
          [paneId]: { ...state.byPane[paneId], ...patch },
        },
      })),
  }),
);
