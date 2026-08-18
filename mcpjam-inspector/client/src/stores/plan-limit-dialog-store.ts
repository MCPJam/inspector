import { create } from "zustand";

/**
 * Which free-plan cap the user just hit. Only `evalIterations` is wired for
 * now — the credits wall still routes to `MCPJamLimitDialog` (top-up/BYOK)
 * until we decide whether upgrade should lead there too.
 */
export type PlanLimitKind = "evalIterations";

export interface PlanLimitDialogInput {
  kind: PlanLimitKind;
  organizationId: string;
  used: number;
  allowed: number | null;
  resetsAt: number | null;
  windowKind: "day" | "month";
  /** Where the user was blocked. Sent to telemetry; also the surface the
   * post-checkout return lands back on. */
  origin: string;
}

interface PlanLimitDialogState {
  isOpen: boolean;
  limit: PlanLimitDialogInput | null;
  open: (input: PlanLimitDialogInput) => void;
  close: () => void;
}

export const usePlanLimitDialogStore = create<PlanLimitDialogState>((set) => ({
  isOpen: false,
  limit: null,
  open: (limit) => set({ isOpen: true, limit }),
  close: () => set({ isOpen: false, limit: null }),
}));
