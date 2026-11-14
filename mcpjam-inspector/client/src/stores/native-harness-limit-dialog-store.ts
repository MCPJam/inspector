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
  /** The dedupe keys the open notice was announced with. */
  noticeKeys: readonly string[];
  /** Counts the notices opened, so a late callback can tell its own apart. */
  noticeSerial: number;
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
  /** Closes the notice opened as `serial`; a newer one stays open. */
  closeNotice: (serial: number) => void;
  /**
   * What runs once the dialog has switched the project's clients, set by the
   * Playground while its own last turn is the refusal: a new chat with the
   * refused message in the composer, since a chat stays on the harness it
   * started on.
   */
  afterSwitch: (() => void) | null;
  setAfterSwitch: (afterSwitch: (() => void) | null) => void;
}

export const useNativeHarnessLimitDialogStore =
  create<NativeHarnessLimitDialogState>((set) => ({
    notice: null,
    noticeKeys: [],
    noticeSerial: 0,
    notifiedKeys: new Set<string>(),
    open: (notice, dedupeKeys = []) =>
      set((state) => {
        const fresh = dedupeKeys.filter((key) => !state.notifiedKeys.has(key));
        const notifiedKeys = fresh.length
          ? new Set([...state.notifiedKeys, ...fresh])
          : state.notifiedKeys;
        if (fresh.length < dedupeKeys.length) {
          // Announced already, so nothing reopens. A later report of the open
          // notice's run can still name the organization the first one
          // lacked; without it the dialog speaks for the active project's.
          const open = state.notice;
          if (
            open &&
            open.organizationId === undefined &&
            notice.organizationId !== undefined &&
            dedupeKeys.some((key) => state.noticeKeys.includes(key))
          ) {
            return {
              notifiedKeys,
              notice: { ...open, organizationId: notice.organizationId },
            };
          }
          return fresh.length ? { notifiedKeys } : state;
        }
        return {
          notice,
          noticeKeys: dedupeKeys,
          noticeSerial: state.noticeSerial + 1,
          notifiedKeys,
        };
      }),
    close: () => set({ notice: null }),
    closeNotice: (serial) =>
      set((state) =>
        serial === state.noticeSerial ? { notice: null } : state,
      ),
    afterSwitch: null,
    setAfterSwitch: (afterSwitch) => set({ afterSwitch }),
  }));
