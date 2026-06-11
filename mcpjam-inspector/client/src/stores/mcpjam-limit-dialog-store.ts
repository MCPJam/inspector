import { create } from "zustand";
import type { MCPJamLimitKind } from "@/lib/mcpjam-limit";

export type MCPJamLimitAuthStatus = "loading" | "guest" | "signedIn";

/** What the dialog should ask the user to do. Decided at notify-time so
 * variant is preserved across the loading→signedIn auth race. */
export type MCPJamLimitIntent = "guest" | "topup";

export interface MCPJamLimitNotifyInput {
  limitKind?: MCPJamLimitKind;
  organizationId?: string;
}

interface MCPJamLimitDialogState {
  isOpen: boolean;
  hasPendingLimit: boolean;
  authStatus: MCPJamLimitAuthStatus;
  intent: MCPJamLimitIntent | null;
  organizationId: string | null;
  /** Stash the full notify input rather than just a boolean: future fields
   * on the limit signal should be forwarded to setAuthStatus's deferred
   * resolve without each addition needing a store change. */
  pendingInput: MCPJamLimitNotifyInput | null;
  notifyLimitHit: (input?: MCPJamLimitNotifyInput) => void;
  setAuthStatus: (authStatus: MCPJamLimitAuthStatus) => void;
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
    isOpen: false,
    hasPendingLimit: false,
    authStatus: "loading",
    intent: null,
    organizationId: null,
    pendingInput: null,
    notifyLimitHit: (input = {}) =>
      set((state) => {
        if (state.authStatus === "loading") {
          return { hasPendingLimit: true, pendingInput: input };
        }
        const intent = intentForAuth(state.authStatus, input);
        if (!intent) return { hasPendingLimit: false };
        return {
          hasPendingLimit: false,
          isOpen: true,
          intent,
          organizationId: input.organizationId ?? null,
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
          isOpen: true,
          intent,
          organizationId: input.organizationId ?? null,
          pendingInput: null,
        };
      }),
    close: () =>
      set({
        isOpen: false,
        hasPendingLimit: false,
        intent: null,
        organizationId: null,
        pendingInput: null,
      }),
  }),
);
