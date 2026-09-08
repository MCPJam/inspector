/**
 * The live page-tool signal, shared by everything that shows what the agent
 * browser's page offers.
 *
 * WHY A STORE AND NOT A POLL. The Tools pane used to re-read the page only on
 * explicit triggers — a mount, a refresh button — so it went stale the moment
 * the model navigated, which is exactly when its contents changed. Polling
 * instead would put a page-touching observation on a timer, and that
 * observation settles the page: an observer with side effects on the thing it
 * observes, running forever, on a metered box.
 *
 * So the daemon's heartbeat (which is already flowing, for the video pane)
 * carries a CHANGE SIGNAL — `{revision, hash, count}`, no definitions — and
 * this store turns it into an event. The expensive read happens once, when the
 * revision actually moves.
 *
 * ONE FETCH PER CHANGE, NOT ONE PER SUBSCRIBER. The signal arrives in whichever
 * browser-pane component happens to be mounted, while the reader is the Tools
 * pane in a different part of the tree; a hook that fetched per subscriber
 * would multiply the read by however many panes were open. The store owns both
 * ends, so two subscribers to one revision produce one read.
 */
import { create } from "zustand";

/** What the daemon's heartbeat says about the page's tools. */
export interface LiveWebmcpSignal {
  revision: number;
  hash: string;
  count: number;
  url?: string;
}

/** `projectId:engine` — the two things that decide WHICH browser this is. */
export type BrowserPageToolsKey = string;

export function browserPageToolsKey(
  projectId: string | null | undefined,
  engine: "hosted" | "local",
): BrowserPageToolsKey {
  return `${projectId ?? ""}:${engine}`;
}

interface BrowserPageToolsState {
  /** The last signal seen per browser, or absent when none has arrived. */
  live: Record<BrowserPageToolsKey, LiveWebmcpSignal | undefined>;
  /**
   * A monotone counter per browser, bumped ONLY when the signal describes a
   * different tool set.
   *
   * What subscribers actually watch. The raw signal arrives several times a
   * second and is usually identical; a hook keyed on the signal object would
   * re-run on every beat, and one keyed on `revision` alone would miss the case
   * where a daemon restarts and its revision counts up from zero again — a new
   * browser whose numbers look older than the ones before it.
   */
  epoch: Record<BrowserPageToolsKey, number>;
  /** Record a heartbeat. Cheap and idempotent for an unchanged signal. */
  noteLive: (key: BrowserPageToolsKey, signal: LiveWebmcpSignal) => void;
  /** Forget a browser (its stream closed, the project changed). */
  clear: (key: BrowserPageToolsKey) => void;
}

export const useBrowserPageToolsStore = create<BrowserPageToolsState>(
  (set, get) => ({
    live: {},
    epoch: {},
    noteLive: (key, signal) => {
      const previous = get().live[key];
      // IDENTICAL SIGNALS ARE A NO-OP, all the way down to not calling `set`.
      // This runs on every heartbeat of a stream that beats several times a
      // second; a store write per beat would re-render every subscriber for a
      // page that has not changed.
      if (
        previous &&
        previous.revision === signal.revision &&
        previous.hash === signal.hash &&
        previous.count === signal.count &&
        previous.url === signal.url
      ) {
        return;
      }
      set((state) => ({
        live: { ...state.live, [key]: signal },
        // Bumped on ANY difference, including a revision that went backwards:
        // a daemon that restarted counts up from zero again, and its tool set
        // is a different one however small the number looks.
        epoch: { ...state.epoch, [key]: (state.epoch[key] ?? 0) + 1 },
      }));
    },
    clear: (key) =>
      set((state) => {
        if (!(key in state.live) && !(key in state.epoch)) return state;
        const live = { ...state.live };
        const epoch = { ...state.epoch };
        delete live[key];
        delete epoch[key];
        return { live, epoch };
      }),
  }),
);

/** The last live signal for one browser, or undefined if none has arrived. */
export function useLiveWebmcpSignal(
  key: BrowserPageToolsKey,
): LiveWebmcpSignal | undefined {
  return useBrowserPageToolsStore((state) => state.live[key]);
}

/**
 * A number that changes exactly when this browser's tool set does.
 *
 * The thing to put in a `useEffect` dependency list: it is stable across the
 * beats that say nothing, and it moves for every change including the ones a
 * revision number alone cannot express.
 */
export function useWebmcpEpoch(key: BrowserPageToolsKey): number {
  return useBrowserPageToolsStore((state) => state.epoch[key] ?? 0);
}

/** Record a heartbeat's page-tool signal, if it carried one. */
export function noteWebmcpStats(
  key: BrowserPageToolsKey,
  stats: { webmcp?: LiveWebmcpSignal } | null | undefined,
): void {
  const webmcp = stats?.webmcp;
  if (
    !webmcp ||
    typeof webmcp.revision !== "number" ||
    typeof webmcp.hash !== "string" ||
    typeof webmcp.count !== "number"
  ) {
    // A daemon too old to send it, or a garbled beat. Silence means "no news",
    // never "no tools" — the pane keeps whatever it last read rather than
    // blanking a list that is still correct.
    return;
  }
  useBrowserPageToolsStore.getState().noteLive(key, webmcp);
}
