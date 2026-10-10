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
  /** The user asked to see the dialog (a button), so a dismissal never hides
   * it; see {@link MCPJamLimitDialogState.outOfCreditsDismissed}. */
  userInitiated?: boolean;
}

interface MCPJamLimitDialogState {
  /** Every run, evidence and wave key a notice has carried; see {@link dedupeKeys}. */
  notifiedKeys: ReadonlySet<string>;
  /**
   * Wave keys recorded before the last purchase began; see
   * {@link MCPJamLimitDialogState.forgetNotifiedWaves}. They stay in
   * `notifiedKeys`, so a replay is still recognized, but they no longer
   * suppress the dialog.
   */
  staleWaveKeys: ReadonlySet<string>;
  /**
   * The run keys known when each scope last bought, by scope: an organization,
   * or {@link ANY_ORGANIZATION} for a purchase that named none. A run first seen
   * alone and then with its wave (A, then A with W) teaches the store W, and W
   * is as old as A: a run announced after the purchase delivered W's news
   * already, so W is current; one announced before it leaves W stale (or makes
   * it stale, when W was unknown at the purchase), and the next run in W is
   * news. Each scope keeps its own boundary: a run announced after one
   * organization bought is not older than that purchase because another
   * organization bought later.
   */
  runKeysAtPurchase: Readonly<Record<string, ReadonlySet<string>>>;
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
  /**
   * The user dismissed an out-of-credits dialog, so a later exhaustion notice
   * for that organization (or any, when it named none) only updates the latch:
   * the run, send and launch buttons already say so. A shortfall is about one
   * request and still opens, and so does a notice the user asked for. Cleared
   * when a purchase begins or credits come back.
   */
  outOfCreditsDismissed: boolean;
  outOfCreditsDismissedOrganizationId: string | null;
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
   * theirs. The same goes for a wave the store only learns later: checkout can
   * begin before a run's wave is known (the stream reports run A alone, and the
   * run document supplies the wave afterwards), and a wave supplied by a run
   * announced before the purchase is stale at once when the purchase covers its
   * organization.
   */
  forgetNotifiedWaves: (organizationId?: string) => void;
  /** Credits came back for the organization; see
   * {@link MCPJamLimitDialogState.outOfCreditsDismissed}. */
  clearOutOfCreditsDismissed: (organizationId?: string | null) => void;
  close: () => void;
  /** The user closed the dialog: {@link MCPJamLimitDialogState.close}, and an
   * exhaustion it showed stays dismissed. */
  dismiss: () => void;
}

/**
 * The identities one notice speaks for. A swarm's runs all meet the same wall,
 * so its wave dedupes the dialog alongside each run: without it a 15-run wave
 * opened the dialog once per run. Prefixed so a run id and a wave id can never
 * collide.
 *
 * A run's attempts all carry its id, so the id alone cannot tell a replay from
 * another attempt reporting something else (one target refused on a shortfall,
 * a later one on an empty wallet). What the run reported is part of its
 * identity: the same run saying the same thing again is a replay, and saying
 * something new is evidence.
 */
const WAVE_KEY_PREFIX = "wave:";
const RUN_KEY_PREFIX = "run:";

const evidenceKey = (runId: string, input: MCPJamLimitNotifyInput): string => {
  const { shortfall, period } = input;
  const reported = shortfall
    ? `short:${shortfall.creditsRemaining}/${shortfall.creditsRequired}`
    : `out:${period ?? ""}`;
  return `evidence:${runId}:${reported}`;
};

const dedupeKeys = (input: MCPJamLimitNotifyInput): string[] => [
  ...(input.runId
    ? [`${RUN_KEY_PREFIX}${input.runId}`, evidenceKey(input.runId, input)]
    : []),
  ...(input.swarmRunGroupId
    ? [`${WAVE_KEY_PREFIX}${input.swarmRunGroupId}`]
    : []),
];

/** What a purchase that named no organization stands for: any of them. */
const ANY_ORGANIZATION = "*";

/**
 * Whether a run was announced before a purchase that covers the organization.
 * A notice that names no organization cannot be told apart and is treated as
 * the purchaser's, as a wave that named none is when a purchase begins.
 */
const predatesPurchase = (
  snapshots: Readonly<Record<string, ReadonlySet<string>>>,
  runKey: string,
  organizationId: string | undefined,
): boolean =>
  Object.entries(snapshots).some(
    ([scope, runKeys]) =>
      runKeys.has(runKey) &&
      (scope === ANY_ORGANIZATION ||
        organizationId === undefined ||
        scope === organizationId),
  );

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

// The user already dismissed this exhaustion; see `outOfCreditsDismissed`. A
// notice or a dismissal that names no organization cannot be told apart, so it
// matches any.
const isDismissed = (
  state: Pick<
    MCPJamLimitDialogState,
    "outOfCreditsDismissed" | "outOfCreditsDismissedOrganizationId"
  >,
  input: MCPJamLimitNotifyInput,
): boolean =>
  state.outOfCreditsDismissed &&
  !input.userInitiated &&
  !input.shortfall &&
  (!input.organizationId ||
    !state.outOfCreditsDismissedOrganizationId ||
    input.organizationId === state.outOfCreditsDismissedOrganizationId);

// Ends a dismissal for the organization, as `clearOutOfCreditsHit` ends a
// latch: `undefined` names any, and another organization's is left alone.
const withoutDismissal = (
  state: Pick<
    MCPJamLimitDialogState,
    "outOfCreditsDismissed" | "outOfCreditsDismissedOrganizationId"
  >,
  organizationId: string | undefined,
) => {
  if (!state.outOfCreditsDismissed) return {};
  if (
    organizationId !== undefined &&
    state.outOfCreditsDismissedOrganizationId &&
    state.outOfCreditsDismissedOrganizationId !== organizationId
  ) {
    return {};
  }
  return {
    outOfCreditsDismissed: false,
    outOfCreditsDismissedOrganizationId: null,
  };
};

const CLOSED = {
  isOpen: false,
  hasPendingLimit: false,
  intent: null,
  organizationId: null,
  surface: null,
  period: null,
  shortfall: null,
  pendingInput: null,
} satisfies Partial<MCPJamLimitDialogState>;

// A dialog already on screen follows newer evidence too, in place and never
// reopened: a wave's first run may report a shortfall (the dialog says credits
// remain and suggests a cheaper request) and a later one real exhaustion. A
// dialog that has an organization keeps it, one that had none learns it, and
// one for another organization is left alone, as its latch is. A notice that
// brings no new report (`withEvidence` false) only teaches the organization.
const refreshOpenDialog = (
  state: Pick<MCPJamLimitDialogState, "isOpen" | "organizationId">,
  input: MCPJamLimitNotifyInput,
  withEvidence: boolean,
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
    ...(withEvidence
      ? { period: input.period ?? null, shortfall: input.shortfall ?? null }
      : {}),
  };
};

// A notice held for auth keeps the NEWEST report, whichever it is: an older
// exhaustion would re-set at sign-in a latch that a later shortfall just
// cleared, and an older shortfall would clear one a later exhaustion just set.
// Either way it learns the organization and surface it lacked, or the dialog
// would open for no organization. A notice with no new report leaves the held
// one's evidence as it is, and the held notice itself when it learns nothing.
const heldWith = (
  held: MCPJamLimitNotifyInput | null,
  input: MCPJamLimitNotifyInput,
  withEvidence: boolean,
): MCPJamLimitNotifyInput => {
  const base = withEvidence || !held ? input : held;
  const organizationId =
    base.organizationId ?? input.organizationId ?? held?.organizationId;
  const surface = base.surface ?? input.surface ?? held?.surface;
  if (
    held &&
    base === held &&
    organizationId === held.organizationId &&
    surface === held.surface
  ) {
    return held;
  }
  return { ...base, organizationId, surface };
};

// What `next` changes in `state`, or `state` itself when it changes nothing: a
// replay that teaches nothing must not notify the views that subscribe.
const onlyChanges = <T extends object>(
  state: T,
  next: Partial<T>,
): Partial<T> | T => {
  const changed = Object.entries(next).filter(
    ([key, value]) => state[key as keyof T] !== value,
  );
  return changed.length ? (Object.fromEntries(changed) as Partial<T>) : state;
};

export const useMCPJamLimitDialogStore = create<MCPJamLimitDialogState>(
  (set) => ({
    notifiedKeys: new Set<string>(),
    staleWaveKeys: new Set<string>(),
    runKeysAtPurchase: {},
    waveOrganizations: {},
    isOpen: false,
    hasPendingLimit: false,
    outOfCreditsHit: false,
    outOfCreditsOrganizationId: null,
    outOfCreditsDismissed: false,
    outOfCreditsDismissedOrganizationId: null,
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
          // The run speaks for its wave at the age it has. Announced since the
          // purchase, a run that turns out to belong to a stale wave (A, then A
          // with its wave) delivered that wave's news already: the wave is
          // current again, or its next run would open the dialog a second time.
          // Announced before the purchase, it leaves a stale wave stale, and a
          // wave it only now supplies is stale at once (checkout began before the
          // store knew the wave): the next run in it is news.
          const runKey = input.runId
            ? `${RUN_KEY_PREFIX}${input.runId}`
            : undefined;
          const runIsKnown =
            runKey !== undefined && state.notifiedKeys.has(runKey);
          const runPredatesPurchase =
            runIsKnown &&
            predatesPurchase(
              state.runKeysAtPurchase,
              runKey,
              input.organizationId,
            );
          const waveIsCurrent =
            runIsKnown &&
            !runPredatesPurchase &&
            keys.some((key) => state.staleWaveKeys.has(key));
          const wavesLearnedStale = runPredatesPurchase
            ? newKeys.filter((key) => key.startsWith(WAVE_KEY_PREFIX))
            : [];
          const staleWaveKeys =
            waveIsCurrent || wavesLearnedStale.length
              ? new Set([
                  ...[...state.staleWaveKeys].filter(
                    (key) => !waveIsCurrent || !keys.includes(key),
                  ),
                  ...wavesLearnedStale,
                ])
              : state.staleWaveKeys;
          // A new run, or a run reporting something new, still carries new
          // evidence: a wave's first run may report a shortfall and a later one
          // real exhaustion, so the exhaustion latch follows it, and so does a
          // dialog that is already open or a notice held for auth. A notice
          // whose only new key is its wave (A, then A with W) is the same report
          // again: a top-up that cleared the latch is not undone when the run
          // document supplies the wave late, and an older report does not
          // replace a newer one. It still teaches the organization it names.
          const withEvidence = newKeys.some(
            (key) => !key.startsWith(WAVE_KEY_PREFIX),
          );
          const latch = withEvidence ? latchFor(state, input, true) : {};
          const pending = state.hasPendingLimit
            ? {
                pendingInput: heldWith(state.pendingInput, input, withEvidence),
              }
            : {};
          const next = {
            notifiedKeys,
            staleWaveKeys,
            waveOrganizations,
            ...latch,
            ...pending,
            ...refreshOpenDialog(state, input, withEvidence),
          };
          // A replay, every key already known, brings no report either. The
          // views that show a run replay its notice on every Convex push, and
          // setting the latch again would undo what a top-up or a daily reset
          // cleared, so only what the replay teaches that was not known
          // changes: an organization the first notice lacked (it was processed
          // before the organization loaded) belongs to the wave, a dialog that
          // is open and a notice held for auth. A replay that teaches nothing
          // returns the state itself.
          return newKeys.length ? next : onlyChanges(state, next);
        }
        // Not suppressed, so this notice speaks for its waves again: one that
        // was stale is announced anew, and its next run is quiet as before.
        const staleWaveKeys = keys.some((key) => state.staleWaveKeys.has(key))
          ? new Set(
              [...state.staleWaveKeys].filter((key) => !keys.includes(key)),
            )
          : state.staleWaveKeys;
        if (isDismissed(state, input)) {
          return {
            notifiedKeys,
            staleWaveKeys,
            waveOrganizations,
            ...latchFor(state, input),
          };
        }
        if (state.authStatus === "loading") {
          return {
            notifiedKeys,
            staleWaveKeys,
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
            waveOrganizations,
            hasPendingLimit: false,
            ...latchFor(state, input),
          };
        }
        return {
          notifiedKeys,
          staleWaveKeys,
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
        return {
          ...(waves.every((key) => state.staleWaveKeys.has(key))
            ? {}
            : { staleWaveKeys: new Set([...state.staleWaveKeys, ...waves]) }),
          // A user who is buying and runs out again is told again.
          ...withoutDismissal(state, organizationId),
          // What counts as announced before this scope's purchase starts over
          // with it; the other scopes keep the boundary of their own purchase.
          runKeysAtPurchase: {
            ...state.runKeysAtPurchase,
            [organizationId ?? ANY_ORGANIZATION]: new Set(
              [...state.notifiedKeys].filter((key) =>
                key.startsWith(RUN_KEY_PREFIX),
              ),
            ),
          },
        };
      }),
    clearOutOfCreditsDismissed: (organizationId) =>
      set((state) => withoutDismissal(state, organizationId ?? undefined)),
    close: () => set(CLOSED),
    dismiss: () =>
      set((state) => ({
        ...CLOSED,
        ...(state.isOpen && !state.shortfall
          ? {
              outOfCreditsDismissed: true,
              outOfCreditsDismissedOrganizationId: state.organizationId,
            }
          : {}),
      })),
  }),
);
