import { create } from "zustand";
import type { DeviceType } from "@/stores/ui-playground-store";

export type PaneTheme = "light" | "dark";

/** How one Compare pane displays its Apps, over the Playground's own. */
export interface PaneDisplay {
  deviceType?: DeviceType;
  theme?: PaneTheme;
}

interface ComparePaneDisplayState {
  byPane: Record<string, PaneDisplay>;
  setPaneDisplay: (paneId: string, patch: PaneDisplay) => void;
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
