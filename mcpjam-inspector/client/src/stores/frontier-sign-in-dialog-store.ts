import { create } from "zustand";

export const useFrontierSignInDialogStore = create<{
  isOpen: boolean;
  /**
   * A page with its own sign-in screen (the User Testing tester link) takes
   * the refusal instead: a tester cannot "choose a standard model".
   */
  override: (() => void) | null;
  open: () => void;
  close: () => void;
  setOverride: (override: (() => void) | null) => void;
}>((set, get) => ({
  isOpen: false,
  override: null,
  open: () => {
    const override = get().override;
    if (override) {
      override();
      return;
    }
    set({ isOpen: true });
  },
  close: () => set({ isOpen: false }),
  setOverride: (override) => set({ override }),
}));
