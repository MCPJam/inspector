import { create } from "zustand";

/** One refusal of a native turn for the organization's spent Free trial. */
export interface NativeHarnessLimitNotice {
  /** The organization that ran out. Without one, the active project's. */
  organizationId?: string;
  /** The trial's size, when the caller already knows it. */
  granted?: number;
  /**
   * A User Testing link is billed to the study's owner, so whoever is testing
   * gets the owner notice instead of an upgrade they cannot make.
   */
  surface?: "scenario";
}

interface NativeHarnessLimitDialogState {
  notice: NativeHarnessLimitNotice | null;
  /**
   * The runs and swarm waves already announced. Their views report a refusal
   * again on every update, and a dismissed dialog must stay dismissed. Every
   * key a notice carries is recorded, even when the notice opens nothing: a
   * run first reported alone and then with its wave teaches the store the
   * wave, or the wave's next run would open the dialog again.
   */
  notifiedKeys: ReadonlySet<string>;
  open: (
    notice: NativeHarnessLimitNotice,
    dedupeKeys?: readonly string[],
  ) => void;
  close: () => void;
}

export const useNativeHarnessLimitDialogStore =
  create<NativeHarnessLimitDialogState>((set) => ({
    notice: null,
    notifiedKeys: new Set<string>(),
    open: (notice, dedupeKeys = []) =>
      set((state) => {
        const fresh = dedupeKeys.filter((key) => !state.notifiedKeys.has(key));
        const notifiedKeys = fresh.length
          ? new Set([...state.notifiedKeys, ...fresh])
          : state.notifiedKeys;
        if (fresh.length < dedupeKeys.length) {
          return fresh.length ? { notifiedKeys } : state;
        }
        return { notice, notifiedKeys };
      }),
    close: () => set({ notice: null }),
  }));
