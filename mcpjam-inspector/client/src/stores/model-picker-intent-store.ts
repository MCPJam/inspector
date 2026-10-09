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
  /**
   * How many mounted pickers will actually ACT on `openProvidersTabNonce` —
   * i.e. `ModelSelector` instances passed `respondToProviderTabIntent`. This
   * is the out-of-credits dialog's fallback test: at zero, nothing on screen
   * can open in place, so firing the nonce would be a silent no-op and the
   * dialog navigates to the org's AI providers page instead.
   */
  providersTabResponderCount: number;
  /** Register a responder; call the returned release on unmount. */
  registerProvidersTabResponder: () => () => void;
}

export const useModelPickerIntentStore = create<ModelPickerIntentState>(
  (set) => ({
    openProvidersTabNonce: 0,
    requestOpenProvidersTab: () =>
      set((state) => ({
        openProvidersTabNonce: state.openProvidersTabNonce + 1,
      })),
    providersTabResponderCount: 0,
    registerProvidersTabResponder: () => {
      set((state) => ({
        providersTabResponderCount: state.providersTabResponderCount + 1,
      }));
      // Once-only: React can invoke an effect cleanup more than once (Strict
      // Mode, a re-run racing an unmount), and a second decrement would drop
      // the count below the number of live pickers — silently sending a chat
      // user to the settings page instead of opening the picker in place.
      let released = false;
      return () => {
        if (released) return;
        released = true;
        set((state) => ({
          providersTabResponderCount: Math.max(
            0,
            state.providersTabResponderCount - 1,
          ),
        }));
      };
    },
  }),
);
