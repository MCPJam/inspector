import { create } from "zustand";

interface ModelPickerIntentState {
  /**
   * Bumped to ask the chat model picker to open on its "Your providers"
   * (configured) tab — e.g. from the out-of-credits dialog's "Bring your own
   * key" action. A nonce (not a boolean) so repeat requests always re-fire,
   * even if the picker was already opened to that tab once.
   */
  openProvidersTabNonce: number;
  requestOpenProvidersTab: () => void;
}

export const useModelPickerIntentStore = create<ModelPickerIntentState>(
  (set) => ({
    openProvidersTabNonce: 0,
    requestOpenProvidersTab: () =>
      set((state) => ({
        openProvidersTabNonce: state.openProvidersTabNonce + 1,
      })),
  }),
);
