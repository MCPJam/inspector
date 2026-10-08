import { create } from "zustand";
import { flushSync } from "react-dom";

// A full-page return to the app resets this state after logout finishes.
export const useSignOutStore = create<{
  isSigningOut: boolean;
  /** A line under the sign-out spinner, when the sign-out needs explaining. */
  message?: string;
}>(() => ({ isSigningOut: false }));

export function showSignOutScreen(message?: string) {
  // Unmount query subscribers before the session revocation request is sent.
  flushSync(() => useSignOutStore.setState({ isSigningOut: true, message }));
}
