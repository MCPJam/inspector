import { create } from "zustand";

export const useFrontierSignInDialogStore = create<{
  isOpen: boolean;
  open: () => void;
  close: () => void;
}>((set) => ({
  isOpen: false,
  open: () => set({ isOpen: true }),
  close: () => set({ isOpen: false }),
}));
