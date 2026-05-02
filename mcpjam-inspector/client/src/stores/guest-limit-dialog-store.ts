import { create } from "zustand";

export type GuestLimitAuthStatus = "loading" | "guest" | "signedIn";

interface GuestLimitDialogState {
  isOpen: boolean;
  hasPendingLimit: boolean;
  authStatus: GuestLimitAuthStatus;
  notifyLimitHit: () => void;
  setAuthStatus: (authStatus: GuestLimitAuthStatus) => void;
  close: () => void;
}

export const useGuestLimitDialogStore = create<GuestLimitDialogState>(
  (set) => ({
    isOpen: false,
    hasPendingLimit: false,
    authStatus: "loading",
    notifyLimitHit: () =>
      set((state) => {
        if (state.authStatus === "signedIn") {
          return { hasPendingLimit: false, isOpen: false };
        }
        if (state.authStatus === "guest") {
          return { hasPendingLimit: false, isOpen: true };
        }
        return { hasPendingLimit: true };
      }),
    setAuthStatus: (authStatus) =>
      set((state) => {
        if (authStatus === "signedIn") {
          return { authStatus, hasPendingLimit: false, isOpen: false };
        }
        if (authStatus === "guest" && state.hasPendingLimit) {
          return { authStatus, hasPendingLimit: false, isOpen: true };
        }
        return { authStatus };
      }),
    close: () => set({ isOpen: false, hasPendingLimit: false }),
  }),
);
