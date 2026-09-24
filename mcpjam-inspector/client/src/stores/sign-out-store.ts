import { create } from "zustand";
import { flushSync } from "react-dom";

// A full-page return to the app resets this state after logout finishes.
export const useSignOutStore = create(() => ({ isSigningOut: false }));

export function showSignOutScreen() {
  // Unmount query subscribers before the session revocation request is sent.
  flushSync(() => useSignOutStore.setState({ isSigningOut: true }));
}
