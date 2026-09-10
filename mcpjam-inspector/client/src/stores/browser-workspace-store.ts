import { create } from "zustand";
import { persist } from "zustand/middleware";

export const DEFAULT_BROWSER_PANEL_SIZE = 60;
export const MIN_BROWSER_PANEL_SIZE = 25;
export const MAX_BROWSER_PANEL_SIZE = 85;

/** Conversation IDs are globally unique; no action substitutes the selected chat. */
export interface BrowserWorkspaceState {
  conversations: Record<string, { open: boolean; expanded: boolean }>;
  size: number;
  collapsedRailForBrowser: boolean;
  openBrowser: (conversationId: string) => void;
  closeBrowser: (conversationId: string) => void;
  setExpanded: (conversationId: string, expanded: boolean) => void;
  setSize: (size: number) => void;
  noteRailCollapsed: () => void;
}

export const useBrowserWorkspaceStore = create<BrowserWorkspaceState>()(
  persist(
    (set) => ({
      conversations: {},
      size: DEFAULT_BROWSER_PANEL_SIZE,
      collapsedRailForBrowser: false,
      openBrowser: (id) =>
        set((state) => {
          if (!id || state.conversations[id]?.open) return state;
          return {
            conversations: {
              ...state.conversations,
              [id]: { open: true, expanded: false },
            },
          };
        }),
      closeBrowser: (id) =>
        set((state) => {
          if (
            !state.conversations[id]?.open &&
            !state.conversations[id]?.expanded
          )
            return state;
          return {
            conversations: {
              ...state.conversations,
              [id]: { open: false, expanded: false },
            },
          };
        }),
      setExpanded: (id, expanded) =>
        set((state) => {
          if (!id || !!state.conversations[id]?.expanded === expanded)
            return state;
          return {
            conversations: {
              ...state.conversations,
              [id]: { open: state.conversations[id]?.open ?? false, expanded },
            },
          };
        }),
      setSize: (size) =>
        set((state) => {
          const clamped = Math.min(
            MAX_BROWSER_PANEL_SIZE,
            Math.max(MIN_BROWSER_PANEL_SIZE, Math.round(size)),
          );
          return state.size === clamped ? state : { size: clamped };
        }),
      noteRailCollapsed: () =>
        set((state) =>
          state.collapsedRailForBrowser
            ? state
            : { collapsedRailForBrowser: true },
        ),
    }),
    {
      name: "mcpjam.playground.browserWorkspace",
      // Restoring visibility only attaches an existing browser. Mounting an
      // empty panel never provisions one. Expansion remains transient.
      partialize: (state) => ({
        size: state.size,
        collapsedRailForBrowser: state.collapsedRailForBrowser,
        conversations: Object.fromEntries(
          Object.entries(state.conversations)
            .slice(-200)
            .map(([id, view]) => [id, { open: view.open, expanded: false }]),
        ),
      }),
    },
  ),
);
