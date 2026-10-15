import { create } from "zustand";

export const useWorkosAuthUnavailableStore = create<{
  open: boolean;
  returnFocus: HTMLElement | null;
  show: () => void;
  dismiss: () => void;
}>((set) => ({
  open: false,
  returnFocus: null,
  show: () =>
    set((state) =>
      state.open
        ? state
        : {
            open: true,
            returnFocus:
              document.activeElement instanceof HTMLElement
                ? document.activeElement
                : null,
          },
    ),
  dismiss: () => set({ open: false }),
}));
