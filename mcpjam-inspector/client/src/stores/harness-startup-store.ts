import { create } from "zustand";
import type { HarnessStartupPhase } from "@/shared/harness-startup";
interface HarnessStartupState {
  phases: Record<string, HarnessStartupPhase | undefined>;
  setPhase: (chatSessionId: string, phase: HarnessStartupPhase | null) => void;
  clear: (chatSessionId: string | null | undefined) => void;
}
export const useHarnessStartupStore = create<HarnessStartupState>((set) => ({
  phases: {},
  setPhase: (chatSessionId, phase) =>
    set((state) => {
      const phases = { ...state.phases };
      if (phase === null) delete phases[chatSessionId];
      else phases[chatSessionId] = phase;
      return { phases };
    }),
  clear: (chatSessionId) =>
    set((state) => {
      const phases = { ...state.phases };
      delete phases[chatSessionId ?? "new"];
      return { phases };
    }),
}));
