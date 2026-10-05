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
  /**
   * Wave keys recorded before the last purchase began; see
   * {@link MCPJamLimitDialogState.forgetNotifiedWaves}. They stay in
   * `notifiedKeys`, so a replay is still recognized, but they no longer
   * suppress the dialog.
   */
  staleWaveKeys: ReadonlySet<string>;
  /**
   * The run keys announced since the last purchase began, while a wave was
   * stale. A run first seen alone and then with its wave (A, then A with W)
   * teaches the store W; if the run was announced after the purchase, W is news
   * that notice already delivered, so W stops being stale. A replay of a run
   * announced before the purchase is not in this set and leaves W stale.
   */
  runKeysSincePurchase: ReadonlySet<string>;
  /**
   * The organization a wave's notices named, by wave key. A wave whose notices
   * named none has no entry; see
   * {@link MCPJamLimitDialogState.forgetNotifiedWaves}.
   */
  waveOrganizations: Readonly<Record<string, string>>;
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
  /**
   * A purchase has begun, so a wave that ran out before it and runs out again
   * after it is news: the user just paid and is still short. The waves announced
   * so far stop suppressing the dialog, but stay known: clearing them instead
   * would make the next Convex push replay an old run's notice as a new one and
   * set the latch (and teach the wave back) all over again.
   *
   * A purchase is for one organization. With `organizationId`, a wave that
   * named a different organization is left as it was: its balance did not
   * change, so its next run is not news. A wave that named none cannot be told
   * apart and is treated as this organization's, as it was before waves knew
   * theirs.
   */
  forgetNotifiedWaves: (organizationId?: string) => void;
  close: () => void;
}

/**
 * The identities one notice speaks for. A swarm's runs all meet the same wall,
 * so its wave dedupes the dialog alongside each run: without it a 15-run wave
 * opened the dialog once per run. Prefixed so a run id and a wave id can never
 * collide.
 */
const WAVE_KEY_PREFIX = "wave:";

const dedupeKeys = (input: MCPJamLimitNotifyInput): string[] => [
  ...(input.runId ? [`run:${input.runId}`] : []),
  ...(input.swarmRunGroupId
    ? [`${WAVE_KEY_PREFIX}${input.swarmRunGroupId}`]
    : []),
];

/**
 * The wave's organization once a notice has named it; the first one named
 * stays. Nothing is recorded when the notice names no wave or no organization.
 */
const withWaveOrganization = (
  known: Readonly<Record<string, string>>,
  input: MCPJamLimitNotifyInput,
): Readonly<Record<string, string>> => {
  if (!input.swarmRunGroupId || !input.organizationId) return known;
  const key = `${WAVE_KEY_PREFIX}${input.swarmRunGroupId}`;
  return key in known ? known : { ...known, [key]: input.organizationId };
};

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
//
// `continuesKnownEvent`: the notice shares a run or wave with one already seen,
// so it is another run of the same swarm and speaks for the same organization.
// From a surface that does not know which, it must not widen a latch that names
// one to every organization. A notice that starts something new and names no
// organization is of an unknown one and locks every organization, as it did
// before waves existed; attributing it to the previous latch's would leave the
// organization that actually ran out unlocked.
const latchFor = (
  state: Pick<
    MCPJamLimitDialogState,
    "outOfCreditsHit" | "outOfCreditsOrganizationId"
  >,
  input: MCPJamLimitNotifyInput,
  continuesKnownEvent = false,
) => {
  if (!input.shortfall) {
    return {
      outOfCreditsHit: true,
      outOfCreditsOrganizationId:
        input.organizationId ??
        (continuesKnownEvent && state.outOfCreditsHit
          ? state.outOfCreditsOrganizationId
          : null),
    };
  }
  const latchIsForAnotherOrg =
    !!input.organizationId &&
    !!state.outOfCreditsOrganizationId &&
    state.outOfCreditsOrganizationId !== input.organizationId;
  if (!state.outOfCreditsHit || latchIsForAnotherOrg) return {};
  return { outOfCreditsHit: false, outOfCreditsOrganizationId: null };
};

// A dialog already on screen follows newer evidence too, in place and never
// reopened: a wave's first run may report a shortfall (the dialog says credits
// remain and suggests a cheaper request) and a later one real exhaustion. A
// dialog that has an organization keeps it, one that had none learns it, and
// one for another organization is left alone, as its latch is.
const refreshOpenDialog = (
  state: Pick<MCPJamLimitDialogState, "isOpen" | "organizationId">,
  input: MCPJamLimitNotifyInput,
) => {
  if (!state.isOpen) return {};
  if (
    input.organizationId &&
    state.organizationId &&
    input.organizationId !== state.organizationId
  ) {
    return {};
  }
  return {
    organizationId: state.organizationId ?? input.organizationId ?? null,
    period: input.period ?? null,
    shortfall: input.shortfall ?? null,
  };
};

export const useMCPJamLimitDialogStore = create<MCPJamLimitDialogState>(
  (set) => ({
    notifiedKeys: new Set<string>(),
    staleWaveKeys: new Set<string>(),
    runKeysSincePurchase: new Set<string>(),
    waveOrganizations: {},
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
        const waveOrganizations = withWaveOrganization(
          state.waveOrganizations,
          input,
        );
        // Suppressed when ANY key is current, but every key is still recorded:
        // a run first seen alone (A), then with its wave (A+W), has to teach
        // the store W, or the wave's next run (B+W) would open it again. A wave
        // recorded before the last purchase is known but not current.
        const suppressed = keys.some(
          (key) => state.notifiedKeys.has(key) && !state.staleWaveKeys.has(key),
        );
        if (suppressed) {
          // A run announced since the purchase that turns out to belong to a
          // stale wave (A, then A with its wave) is that wave's news, already
          // delivered: the wave is current again, or its next run would open
          // the dialog a second time. A replay of a run announced before the
          // purchase is not in the set and leaves the wave stale.
          const staleWaveKeys =
            keys.some((key) => state.staleWaveKeys.has(key)) &&
            keys.some((key) => state.runKeysSincePurchase.has(key))
              ? new Set(
                  [...state.staleWaveKeys].filter((key) => !keys.includes(key)),
                )
              : state.staleWaveKeys;
          // A replay, every key already known, changes nothing. The views
          // that show a run replay its notice on every Convex push; setting
          // the latch again would undo what a top-up or a daily reset cleared.
          if (!newKeys.length) {
            return staleWaveKeys === state.staleWaveKeys
              ? state
              : { staleWaveKeys };
          }
          // A notice that brings a new key still carries new evidence: a
          // wave's first run may report a shortfall and a later one real
          // exhaustion, so the exhaustion latch follows it, and so does a
          // dialog that is already open.
          const latch = latchFor(state, input, true);
          // A notice held for auth keeps the NEWEST evidence, whichever it is:
          // an older exhaustion would re-set at sign-in a latch that a later
          // shortfall just cleared, and an older shortfall would clear one a
          // later exhaustion just set. It keeps the held notice's organization
          // and surface when the newer one does not know them, or the dialog
          // would open for no organization.
          const held = state.pendingInput;
          const pending = state.hasPendingLimit
            ? {
                pendingInput: {
                  ...input,
                  organizationId: input.organizationId ?? held?.organizationId,
                  surface: input.surface ?? held?.surface,
                },
              }
            : {};
          return {
            notifiedKeys,
            staleWaveKeys,
            waveOrganizations,
            ...latch,
            ...pending,
            ...refreshOpenDialog(state, input),
          };
        }
        // Not suppressed, so this notice speaks for its waves again: one that
        // was stale is announced anew, and its next run is quiet as before.
        const staleWaveKeys = keys.some((key) => state.staleWaveKeys.has(key))
          ? new Set(
              [...state.staleWaveKeys].filter((key) => !keys.includes(key)),
            )
          : state.staleWaveKeys;
        // While a wave is stale, a run announced here is one announced since the
        // purchase.
        const runKeysSincePurchase = state.staleWaveKeys.size
          ? new Set([
              ...state.runKeysSincePurchase,
              ...keys.filter((key) => !key.startsWith(WAVE_KEY_PREFIX)),
            ])
          : state.runKeysSincePurchase;
        if (state.authStatus === "loading") {
          return {
            notifiedKeys,
            staleWaveKeys,
            runKeysSincePurchase,
            waveOrganizations,
            hasPendingLimit: true,
            ...latchFor(state, input),
            pendingInput: input,
          };
        }
        const intent = intentForAuth(state.authStatus, input);
        if (!intent) {
          return {
            notifiedKeys,
            staleWaveKeys,
            runKeysSincePurchase,
            waveOrganizations,
            hasPendingLimit: false,
            ...latchFor(state, input),
          };
        }
        return {
          notifiedKeys,
          staleWaveKeys,
          runKeysSincePurchase,
          waveOrganizations,
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
    forgetNotifiedWaves: (organizationId) =>
      set((state) => {
        const waves = [...state.notifiedKeys].filter((key) => {
          if (!key.startsWith(WAVE_KEY_PREFIX)) return false;
          const owner = state.waveOrganizations[key];
          return (
            organizationId === undefined ||
            owner === undefined ||
            owner === organizationId
          );
        });
        // What counts as announced since the purchase starts over with it.
        const epoch = state.runKeysSincePurchase.size
          ? { runKeysSincePurchase: new Set<string>() }
          : {};
        return waves.every((key) => state.staleWaveKeys.has(key))
          ? epoch
          : {
              staleWaveKeys: new Set([...state.staleWaveKeys, ...waves]),
              ...epoch,
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
