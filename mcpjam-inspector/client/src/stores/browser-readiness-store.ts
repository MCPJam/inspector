import { create } from "zustand";
/** Server refusal stays visible until this browser succeeds again. No credentials. */
export const useBrowserReadinessStore = create<{
  reasons: Record<string, string>;
  setReason: (key: string, reason: string | null) => void;
}>((set) => ({
  reasons: {},
  setReason: (key, reason) =>
    set((state) => {
      const reasons = { ...state.reasons };
      if (reason) reasons[key] = reason;
      else delete reasons[key];
      return { reasons };
    }),
}));
