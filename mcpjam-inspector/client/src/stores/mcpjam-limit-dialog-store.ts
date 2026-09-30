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
  /** The run's wave; see {@link dedupeKeys}. */
  swarmRunGroupId?: string;
  limitKind?: MCPJamLimitKind;
  organizationId?: string;
  surface?: MCPJamLimitSurface;
  period?: MCPJamLimitPeriod;
  shortfall?: MCPJamCreditShortfall;
}

interface MCPJamLimitDialogState {
  /** Every run and wave key a notice has carried; see {@link dedupeKeys}. */
  notifiedKeys: ReadonlySet<string>;
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

/**
 * The identities one notice speaks for. A swarm's runs all meet the same wall,
 * so its wave dedupes the dialog alongside each run: without it a 15-run wave
 * opened the dialog once per run. Prefixed so a run id and a wave id can never
 * collide.
 */
const dedupeKeys = (input: MCPJamLimitNotifyInput): string[] => [
  ...(input.runId ? [`run:${input.runId}`] : []),
  ...(input.swarmRunGroupId ? [`wave:${input.swarmRunGroupId}`] : []),
];

const intentForAuth = (
  authStatus: MCPJamLimitAuthStatus,
  _input: MCPJamLimitNotifyInput,
): MCPJamLimitIntent | null => {
  if (authStatus === "guest") return "guest";
  if (authStatus === "signedIn") return "topup";
  return null;
};

// A shortfall leaves credits a cheaper model can still spend, so it must not
// gray out the MCPJam models the dialog tells the user to try. An earlier
// exhaustion latch for the same organization is stale by then and is cleared;
// another organization's latch is left alone.
const latchFor = (
  state: Pick<
    MCPJamLimitDialogState,
    "outOfCreditsHit" | "outOfCreditsOrganizationId"
  >,
  input: MCPJamLimitNotifyInput,
) => {
  if (!input.shortfall) {
    return {
      outOfCreditsHit: true,
      // A notice from a surface that does not know the organization never
      // widens a latch that already names one to every organization.
      outOfCreditsOrganizationId:
        input.organizationId ??
        (state.outOfCreditsHit ? state.outOfCreditsOrganizationId : null),
    };
  }
  const latchIsForAnotherOrg =
    !!input.organizationId &&
    !!state.outOfCreditsOrganizationId &&
    state.outOfCreditsOrganizationId !== input.organizationId;
  if (!state.outOfCreditsHit || latchIsForAnotherOrg) return {};
  return { outOfCreditsHit: false, outOfCreditsOrganizationId: null };
};

export const useMCPJamLimitDialogStore = create<MCPJamLimitDialogState>(
  (set) => ({
    notifiedKeys: new Set<string>(),
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
        const keys = dedupeKeys(input);
        const newKeys = keys.filter((key) => !state.notifiedKeys.has(key));
        const notifiedKeys = newKeys.length
          ? new Set([...state.notifiedKeys, ...newKeys])
          : state.notifiedKeys;
        // Suppressed when ANY key was seen, but every key is still recorded:
        // a run first seen alone (A), then with its wave (A+W), has to teach
        // the store W, or the wave's next run (B+W) would open it again.
        if (newKeys.length < keys.length) {
          // A replay, every key already known, changes nothing. The views
          // that show a run replay its notice on every Convex push; setting
          // the latch again would undo what a top-up or a daily reset cleared.
          if (!newKeys.length) return state;
          // A notice that brings a new key still carries new evidence: a
          // wave's first run may report a shortfall and a later one real
          // exhaustion, so the exhaustion latch follows it.
          const latch = latchFor(state, input);
          // A notice held for auth keeps the newest exhaustion, or the replay
          // after sign-in would clear the latch this one just set. It keeps
          // the held notice's organization and surface when the newer one does
          // not know them, or the dialog would open for no organization.
          const held = state.pendingInput;
          const pending =
            state.hasPendingLimit && !input.shortfall
              ? {
                  pendingInput: {
                    ...input,
                    organizationId:
                      input.organizationId ?? held?.organizationId,
                    surface: input.surface ?? held?.surface,
                  },
                }
              : {};
          return { notifiedKeys, ...latch, ...pending };
        }
        if (state.authStatus === "loading") {
          return {
            notifiedKeys,
            hasPendingLimit: true,
            ...latchFor(state, input),
            pendingInput: input,
          };
        }
        const intent = intentForAuth(state.authStatus, input);
        if (!intent) {
          return {
            notifiedKeys,
            hasPendingLimit: false,
            ...latchFor(state, input),
          };
        }
        return {
          notifiedKeys,
          hasPendingLimit: false,
          ...latchFor(state, input),
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
          ...latchFor(state, input),
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
