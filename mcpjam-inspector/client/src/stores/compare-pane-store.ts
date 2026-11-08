import { create } from "zustand";

/** What the Tools sidebar needs to show one Compare pane. */
export interface ComparePaneOption {
  paneId: string;
  label: string;
  /** The client the pane runs; its built-in and browser tools are listed. */
  hostId: string | null;
  /** The pane's own servers, or null when it follows the shared selection. */
  serverNames: string[] | null;
}

interface ComparePaneState {
  /** The panes while Compare runs clients; empty otherwise. */
  panes: ComparePaneOption[];
  selectedPaneId: string | null;
  publishPanes: (panes: ComparePaneOption[]) => void;
  selectPane: (paneId: string) => void;
}

/**
 * The Playground's Compare grid and its Tools sidebar are siblings, so the
 * grid publishes its panes here and the sidebar shows the selected one. A
 * selection that left the lineup falls back to pane 0.
 */
export const useComparePaneStore = create<ComparePaneState>((set) => ({
  panes: [],
  selectedPaneId: null,
  publishPanes: (panes) =>
    set((state) => ({
      panes,
      selectedPaneId: panes.some((pane) => pane.paneId === state.selectedPaneId)
        ? state.selectedPaneId
        : (panes[0]?.paneId ?? null),
    })),
  selectPane: (selectedPaneId) => set({ selectedPaneId }),
}));

/** The pane the sidebar shows, or null when Compare is not running clients. */
export function useSelectedComparePane(): ComparePaneOption | null {
  return useComparePaneStore(
    (state) =>
      state.panes.find((pane) => pane.paneId === state.selectedPaneId) ??
      state.panes[0] ??
      null,
  );
}
