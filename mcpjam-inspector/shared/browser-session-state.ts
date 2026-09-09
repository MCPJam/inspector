/**
 * What the browser IS, as one value every surface agrees on.
 *
 * Before this, "what is open" had three answers and none of them was
 * authoritative. The hosted pane read a `{id, url}` list off the frame
 * heartbeat — an 8 KiB budget shared with the encoder's counters, so a session
 * with a dozen tabs simply lost the tail. The local pane read nothing at all,
 * because its stream carries frames and never carried metadata. Electron had
 * no frame socket to read from in the first place: its picture is a real
 * `WebContentsView` and there is no stream between the view and the window.
 *
 * Three engines, three different amounts of truth, and a tab strip that could
 * only ever show the intersection. So the state moves here: one shape,
 * published deliberately rather than inferred from whatever a transport
 * happened to carry, and delivered explicitly on every engine — including the
 * two that had no path for it.
 *
 * TWO WAYS IN, and both are necessary. Browser EVENTS publish a change the
 * moment it happens, which is what makes a tab title appear when the page sets
 * it rather than a second later. A periodic SNAPSHOT reconciles: an event can
 * be dropped by a reconnect, arrive out of order behind a slow relay, or
 * describe a tab that closed while it was in flight, and a pane that only ever
 * applied deltas would drift and never recover. The reducer below takes both
 * and the snapshot always wins.
 *
 * Pure data and pure functions. The transports differ per engine and this
 * deliberately knows about none of them.
 */

import {
  INITIAL_SESSION_VIEWPORT,
  type SessionViewport,
  type SessionViewportPolicy,
} from "./browser-viewport";

/** One tab, as the strip draws it. */
export interface BrowserTabState {
  /** The daemon's tab id. Stable for the tab's life; never reused. */
  id: string;
  /**
   * Where the tab is NOW, which is not always where it was told to go.
   *
   * A redirect chain settles somewhere else, and an SPA rewrites this with
   * `history.pushState` without a navigation at all. The address field shows
   * this, so both have to reach it.
   */
  url: string;
  /**
   * The document's title, or an empty string while it has none.
   *
   * EMPTY, not the URL. The strip decides what to draw for a title-less tab —
   * it shows the host — and baking that fallback in here would make "the page
   * set its title to its own hostname" indistinguishable from "the page has no
   * title yet", which is the difference between a settled tab and a loading one.
   */
  title: string;
  /**
   * The favicon's URL, when the page declared one and it can be fetched.
   *
   * Optional in the strongest sense: most pages have one, a data: URL is
   * common, and a great many are 404s. The strip falls back to a glyph.
   */
  faviconUrl?: string;
  /** Is this tab fetching or parsing right now? */
  loading: boolean;
}

/**
 * Who is driving, in the vocabulary the pane already speaks.
 *
 * `PaneControl` in the client says the same four things; this is its
 * transport-side twin, kept separate because the client's is a display concern
 * and this one is authority. The pane maps one to the other, and the mapping is
 * the place where "someone else holds it" becomes "Someone else has control".
 */
export type BrowserControlKind = "agent" | "human" | "script";

export interface BrowserControlState {
  kind: BrowserControlKind;
  /**
   * The lease holder's id, when something holds it.
   *
   * Compared against the pane's OWN holder id to answer "is that me?" — which
   * is a different question from "is a human driving", and the one the Resume
   * button depends on. Two panes open on one browser are both `human`, and
   * only one of them may hand it back.
   */
  holder?: string;
  /**
   * A held lease that ran out. Commands stay blocked; only an explicit resume
   * moves it. Surfaced because "parked" and "held" lead to different copy: one
   * is somebody working, the other is somebody who walked away.
   */
  parked?: boolean;
}

/**
 * Is the picture live?
 *
 * Distinct from control, and both are needed: a pane can hold the lease while
 * its socket is reconnecting, and the address bar must stay usable in exactly
 * that moment or a person mid-login watches their own typing disappear.
 */
export type BrowserConnectionState =
  | "connecting"
  | "live"
  | "reconnecting"
  | "closed";

export interface BrowserSessionState {
  /** Every tab, in the order the browser holds them. */
  tabs: BrowserTabState[];
  /** Which one is on screen, or null before the first tab exists. */
  activeTabId: string | null;
  /** Can the ACTIVE tab go back? Empty history is the common case at start. */
  canGoBack: boolean;
  canGoForward: boolean;
  control: BrowserControlState;
  connection: BrowserConnectionState;
  viewport: SessionViewport;
  policy: SessionViewportPolicy;
  /**
   * The publisher's sequence number for the newest fact folded in.
   *
   * Monotonic per session. Events carry it so a delta that overtook a snapshot
   * on a slower path can be dropped rather than resurrecting a closed tab —
   * the failure this prevents is a tab strip that grows a ghost every time a
   * relay hiccups.
   */
  seq: number;
}

export const EMPTY_BROWSER_SESSION_STATE: BrowserSessionState = {
  tabs: [],
  activeTabId: null,
  canGoBack: false,
  canGoForward: false,
  control: { kind: "agent" },
  connection: "connecting",
  viewport: INITIAL_SESSION_VIEWPORT,
  policy: "fixed",
  seq: 0,
};

/**
 * The whole truth, as the publisher currently knows it.
 *
 * Everything except `connection`, which no remote can answer: the daemon
 * cannot know whether ITS bytes are reaching this particular pane, and a
 * snapshot that claimed to would overwrite a reconnecting pane's own honest
 * assessment with "live" every time one arrived.
 */
export interface BrowserStateSnapshot {
  seq: number;
  tabs: BrowserTabState[];
  activeTabId: string | null;
  canGoBack: boolean;
  canGoForward: boolean;
  control: BrowserControlState;
  viewport: SessionViewport;
  policy: SessionViewportPolicy;
}

export type BrowserStateEvent =
  /** A full reconciliation. Always wins; see `reduceBrowserState`. */
  | { type: "snapshot"; snapshot: BrowserStateSnapshot }
  | { type: "tab_opened"; seq: number; tab: BrowserTabState; index?: number }
  | { type: "tab_closed"; seq: number; tabId: string }
  | { type: "tab_activated"; seq: number; tabId: string }
  /**
   * Anything about a tab that changed without the tab list changing: the URL
   * after a redirect or a `pushState`, the title the document set, the favicon
   * that finished loading, the loading flag going down.
   */
  | {
      type: "tab_updated";
      seq: number;
      tabId: string;
      patch: Partial<Omit<BrowserTabState, "id">>;
    }
  | {
      type: "navigation_state";
      seq: number;
      canGoBack: boolean;
      canGoForward: boolean;
    }
  | { type: "control_changed"; seq: number; control: BrowserControlState }
  | { type: "viewport_changed"; seq: number; viewport: SessionViewport }
  /**
   * The pane's own reading of its transport. Carries no `seq`: it is not the
   * publisher's fact and ordering it against the publisher's would let a stale
   * remote sequence suppress a socket close this pane just watched happen.
   */
  | { type: "connection_changed"; connection: BrowserConnectionState };

/**
 * Fold one fact into the state, or return the SAME object when nothing moved.
 *
 * Identity is the contract, and React is the reason: this state feeds a store
 * whose subscribers re-render on every new object, and the heartbeat carrying
 * an unchanged snapshot several times a second would repaint the whole browser
 * shell on a page nobody touched. Every arm below returns `state` unchanged
 * when it has nothing to add.
 *
 * The SNAPSHOT always wins, even against a higher `seq`. It is the only arm
 * that does, and the reason is that a snapshot is the publisher's whole truth
 * at a moment while a delta is a claim about one field: if the two disagree,
 * the disagreement IS the drift this exists to correct, and preferring the
 * delta would keep whatever went wrong.
 */
export function reduceBrowserState(
  state: BrowserSessionState,
  event: BrowserStateEvent,
): BrowserSessionState {
  if (event.type === "connection_changed") {
    if (state.connection === event.connection) return state;
    return { ...state, connection: event.connection };
  }
  if (event.type === "snapshot") {
    return applySnapshot(state, event.snapshot);
  }
  // A delta from before the newest fact we hold describes a browser that has
  // since moved on. Dropped rather than applied: this is what stops a
  // `tab_opened` stuck behind a slow relay from resurrecting a closed tab.
  if (event.seq <= state.seq) return state;
  const next = applyDelta(state, event);
  if (next === state) {
    // The sequence still advances even when the payload changed nothing —
    // otherwise a no-op delta leaves the watermark behind and the NEXT real
    // delta at that sequence is dropped as stale.
    return { ...state, seq: event.seq };
  }
  return { ...next, seq: event.seq };
}

function applySnapshot(
  state: BrowserSessionState,
  snapshot: BrowserStateSnapshot,
): BrowserSessionState {
  const tabs = sameTabs(state.tabs, snapshot.tabs) ? state.tabs : snapshot.tabs;
  const control = sameControl(state.control, snapshot.control)
    ? state.control
    : snapshot.control;
  const viewport = sameViewportValue(state.viewport, snapshot.viewport)
    ? state.viewport
    : snapshot.viewport;
  if (
    tabs === state.tabs &&
    control === state.control &&
    viewport === state.viewport &&
    state.activeTabId === snapshot.activeTabId &&
    state.canGoBack === snapshot.canGoBack &&
    state.canGoForward === snapshot.canGoForward &&
    state.policy === snapshot.policy &&
    state.seq === snapshot.seq
  ) {
    return state;
  }
  return {
    tabs,
    activeTabId: snapshot.activeTabId,
    canGoBack: snapshot.canGoBack,
    canGoForward: snapshot.canGoForward,
    control,
    viewport,
    policy: snapshot.policy,
    // The pane's own, never the publisher's. @see BrowserStateSnapshot
    connection: state.connection,
    seq: snapshot.seq,
  };
}

function applyDelta(
  state: BrowserSessionState,
  event: Exclude<
    BrowserStateEvent,
    { type: "snapshot" } | { type: "connection_changed" }
  >,
): BrowserSessionState {
  switch (event.type) {
    case "tab_opened": {
      // Idempotent by id. A tab that arrives twice — an event replayed across a
      // reconnect — must not appear twice in the strip.
      if (state.tabs.some((tab) => tab.id === event.tab.id)) return state;
      const tabs = state.tabs.slice();
      const at =
        typeof event.index === "number"
          ? Math.min(Math.max(0, event.index), tabs.length)
          : tabs.length;
      tabs.splice(at, 0, event.tab);
      return {
        ...state,
        tabs,
        // A first tab is the active one. A popup opened by a page is not: the
        // browser decides, and it says so with its own `tab_activated`.
        activeTabId: state.activeTabId ?? event.tab.id,
      };
    }
    case "tab_closed": {
      const index = state.tabs.findIndex((tab) => tab.id === event.tabId);
      if (index < 0) return state;
      const tabs = state.tabs.slice();
      tabs.splice(index, 1);
      // Closing the ACTIVE tab has to leave something selected, and the choice
      // is the browser's convention rather than ours: the neighbour to the
      // right, falling back to the left at the end of the strip. Leaving
      // `activeTabId` pointing at a tab that no longer exists would blank the
      // address field and the page area until the next snapshot arrived.
      const activeTabId =
        state.activeTabId === event.tabId
          ? (tabs[index]?.id ?? tabs[index - 1]?.id ?? null)
          : state.activeTabId;
      return { ...state, tabs, activeTabId };
    }
    case "tab_activated": {
      if (state.activeTabId === event.tabId) return state;
      // An activation naming a tab we have never heard of is applied anyway.
      // The tab exists — the browser just told us it is on screen — and the
      // `tab_opened` for it is presumably behind us on the wire; dropping the
      // activation would leave the strip highlighting the wrong tab until the
      // next snapshot.
      return { ...state, activeTabId: event.tabId };
    }
    case "tab_updated": {
      const index = state.tabs.findIndex((tab) => tab.id === event.tabId);
      if (index < 0) return state;
      const current = state.tabs[index] as BrowserTabState;
      const merged = { ...current, ...event.patch };
      if (sameTab(current, merged)) return state;
      const tabs = state.tabs.slice();
      tabs[index] = merged;
      return { ...state, tabs };
    }
    case "navigation_state": {
      if (
        state.canGoBack === event.canGoBack &&
        state.canGoForward === event.canGoForward
      ) {
        return state;
      }
      return {
        ...state,
        canGoBack: event.canGoBack,
        canGoForward: event.canGoForward,
      };
    }
    case "control_changed": {
      if (sameControl(state.control, event.control)) return state;
      return { ...state, control: event.control };
    }
    case "viewport_changed": {
      if (sameViewportValue(state.viewport, event.viewport)) return state;
      return { ...state, viewport: event.viewport };
    }
    default: {
      const exhaustive: never = event;
      void exhaustive;
      return state;
    }
  }
}

/** The tab the strip and the address field are describing, if any. */
export function activeTab(state: BrowserSessionState): BrowserTabState | null {
  if (!state.activeTabId) return null;
  return state.tabs.find((tab) => tab.id === state.activeTabId) ?? null;
}

/**
 * Is this pane the one holding the browser?
 *
 * Takes the pane's own holder id rather than deriving it, because "a human has
 * control" and "I have control" differ exactly when two panes are open on one
 * browser — and that is the case where offering the wrong button matters.
 */
export function isHeldBy(
  state: BrowserSessionState,
  holderId: string | null,
): boolean {
  return (
    state.control.kind === "human" &&
    !!holderId &&
    state.control.holder === holderId
  );
}

/**
 * Is somebody OTHER than this pane driving?
 *
 * True for a script as well as another person: both mean the same thing to a
 * pane that wants the browser, which is that taking it is not this pane's to
 * do. A takeover attempt in this state must be refused rather than queued.
 */
export function isHeldByAnother(
  state: BrowserSessionState,
  holderId: string | null,
): boolean {
  if (state.control.kind === "script") return true;
  if (state.control.kind !== "human") return false;
  return state.control.holder !== holderId;
}

function sameTab(a: BrowserTabState, b: BrowserTabState): boolean {
  return (
    a.id === b.id &&
    a.url === b.url &&
    a.title === b.title &&
    a.faviconUrl === b.faviconUrl &&
    a.loading === b.loading
  );
}

function sameTabs(
  a: readonly BrowserTabState[],
  b: readonly BrowserTabState[],
): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  return a.every((tab, index) => sameTab(tab, b[index] as BrowserTabState));
}

function sameControl(a: BrowserControlState, b: BrowserControlState): boolean {
  return (
    a.kind === b.kind && a.holder === b.holder && !!a.parked === !!b.parked
  );
}

function sameViewportValue(a: SessionViewport, b: SessionViewport): boolean {
  return (
    a.width === b.width && a.height === b.height && a.revision === b.revision
  );
}
