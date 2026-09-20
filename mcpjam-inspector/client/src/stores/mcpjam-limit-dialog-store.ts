import { create } from "zustand";
import type { MCPJamLimitKind, MCPJamLimitPeriod } from "@/lib/mcpjam-limit";

export type MCPJamLimitAuthStatus = "loading" | "guest" | "signedIn";

/** What the dialog should ask the user to do. Decided at notify-time so
 * variant is preserved across the loading→signedIn auth race. */
export type MCPJamLimitIntent = "guest" | "topup";

/**
 * Where the wall was raised. Picks which variant of the dialog renders:
 * `"swarm"` gets `AllowanceLimitDialogView`, anything else (or nothing) gets
 * the credits wall. The split exists because the swarm wall's two dropped
 * actions dead-end there — no swarm screen mounts the model picker the BYOK
 * link drives, and an own key can't lift the limit anyway, since generation
 * and persona turns are always MCPJam-billed. `"scenario"` is a User Testing
 * link: the owner pays, so the tester gets a notice with no billing actions.
 */
export type MCPJamLimitSurface = "chat" | "swarm" | "scenario";

export interface MCPJamLimitNotifyInput {
  runId?: string;
  limitKind?: MCPJamLimitKind;
  organizationId?: string;
  surface?: MCPJamLimitSurface;
  period?: MCPJamLimitPeriod;
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
            outOfCreditsHit: true,
            outOfCreditsOrganizationId: input.organizationId ?? null,
            pendingInput: input,
          };
        }
        const intent = intentForAuth(state.authStatus, input);
        if (!intent) {
          return {
            notifiedRunIds,
            hasPendingLimit: false,
            outOfCreditsHit: true,
            outOfCreditsOrganizationId: input.organizationId ?? null,
          };
        }
        return {
          notifiedRunIds,
          hasPendingLimit: false,
          outOfCreditsHit: true,
          outOfCreditsOrganizationId: input.organizationId ?? null,
          isOpen: true,
          intent,
          organizationId: input.organizationId ?? null,
          surface: input.surface ?? null,
          period: input.period ?? null,
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
          outOfCreditsHit: true,
          outOfCreditsOrganizationId: input.organizationId ?? null,
          isOpen: true,
          intent,
          organizationId: input.organizationId ?? null,
          surface: input.surface ?? null,
          period: input.period ?? null,
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
        pendingInput: null,
      }),
  }),
);
