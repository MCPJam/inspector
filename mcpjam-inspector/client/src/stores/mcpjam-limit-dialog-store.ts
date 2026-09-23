import { create } from "zustand";
import type {
  MCPJamCreditShortfall,
  MCPJamLimitKind,
  MCPJamLimitPeriod,
} from "@/lib/mcpjam-limit";

export type MCPJamLimitAuthStatus = "loading" | "guest" | "signedIn";

/** What the dialog should ask the user to do. Decided at notify-time so
 * variant is preserved across the loading→signedIn auth race. */
export type MCPJamLimitIntent = "guest" | "topup";

/** Swarm selects its billing copy/actions; scenario testers see an owner notice. */
export type MCPJamLimitSurface = "chat" | "swarm" | "scenario";

export interface MCPJamLimitNotifyInput {
  runId?: string;
  limitKind?: MCPJamLimitKind;
  organizationId?: string;
  surface?: MCPJamLimitSurface;
  period?: MCPJamLimitPeriod;
  shortfall?: MCPJamCreditShortfall;
}

interface MCPJamLimitDialogState {
  notifiedRunIds: ReadonlySet<string>;
  isOpen: boolean;
  hasPendingLimit: boolean;
  outOfCreditsHit: boolean;
  outOfCreditsOrganizationId: string | null;
  authStatus: MCPJamLimitAuthStatus;
  intent: MCPJamLimitIntent | null;
  organizationId: string | null;
  surface: MCPJamLimitSurface | null;
  period: MCPJamLimitPeriod | null;
  shortfall: MCPJamCreditShortfall | null;
  /** Stash the full notify input rather than just a boolean: future fields
   * on the limit signal should be forwarded to setAuthStatus's deferred
   * resolve without each addition needing a store change. */
  pendingInput: MCPJamLimitNotifyInput | null;
  notifyLimitHit: (input?: MCPJamLimitNotifyInput) => void;
  setAuthStatus: (authStatus: MCPJamLimitAuthStatus) => void;
  clearOutOfCreditsHit: (organizationId?: string | null) => void;
  close: () => void;
}

const intentForAuth = (
  authStatus: MCPJamLimitAuthStatus,
  _input: MCPJamLimitNotifyInput,
): MCPJamLimitIntent | null => {
  if (authStatus === "guest") return "guest";
  if (authStatus === "signedIn") return "topup";
  return null;
};

// A shortfall leaves credits a cheaper model can still spend, so it must not
// gray out the MCPJam models the dialog tells the user to try.
const latchFor = (input: MCPJamLimitNotifyInput) =>
  input.shortfall
    ? {}
    : {
        outOfCreditsHit: true,
        outOfCreditsOrganizationId: input.organizationId ?? null,
      };

export const useMCPJamLimitDialogStore = create<MCPJamLimitDialogState>(
  (set) => ({
    notifiedRunIds: new Set<string>(),
    isOpen: false,
    hasPendingLimit: false,
    outOfCreditsHit: false,
    outOfCreditsOrganizationId: null,
    authStatus: "loading",
    intent: null,
    organizationId: null,
    surface: null,
    period: null,
    shortfall: null,
    pendingInput: null,
    notifyLimitHit: (input = {}) =>
      set((state) => {
        if (input.runId && state.notifiedRunIds.has(input.runId)) return state;
        const notifiedRunIds = input.runId
          ? new Set([...state.notifiedRunIds, input.runId])
          : state.notifiedRunIds;
        if (state.authStatus === "loading") {
          return {
            notifiedRunIds,
            hasPendingLimit: true,
            ...latchFor(input),
            pendingInput: input,
          };
        }
        const intent = intentForAuth(state.authStatus, input);
        if (!intent) {
          return {
            notifiedRunIds,
            hasPendingLimit: false,
            ...latchFor(input),
          };
        }
        return {
          notifiedRunIds,
          hasPendingLimit: false,
          ...latchFor(input),
          isOpen: true,
          intent,
          organizationId: input.organizationId ?? null,
          surface: input.surface ?? null,
          period: input.period ?? null,
          shortfall: input.shortfall ?? null,
          pendingInput: null,
        };
      }),
    setAuthStatus: (authStatus) =>
      set((state) => {
        if (!state.hasPendingLimit) {
          return { authStatus };
        }
        const input = state.pendingInput ?? {};
        const intent = intentForAuth(authStatus, input);
        if (!intent) {
          return { authStatus };
        }
        return {
          authStatus,
          hasPendingLimit: false,
          ...latchFor(input),
          isOpen: true,
          intent,
          organizationId: input.organizationId ?? null,
          surface: input.surface ?? null,
          period: input.period ?? null,
          shortfall: input.shortfall ?? null,
          pendingInput: null,
        };
      }),
    clearOutOfCreditsHit: (organizationId) =>
      set((state) => {
        if (!state.outOfCreditsHit) return {};
        if (
          organizationId !== undefined &&
          state.outOfCreditsOrganizationId &&
          state.outOfCreditsOrganizationId !== organizationId
        ) {
          return {};
        }
        return {
          outOfCreditsHit: false,
          outOfCreditsOrganizationId: null,
        };
      }),
    close: () =>
      set({
        isOpen: false,
        hasPendingLimit: false,
        intent: null,
        organizationId: null,
        surface: null,
        period: null,
        shortfall: null,
        pendingInput: null,
      }),
  }),
);
