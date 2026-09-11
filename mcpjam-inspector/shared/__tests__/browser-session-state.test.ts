import { describe, expect, it } from "vitest";
import {
  activeTab,
  EMPTY_BROWSER_SESSION_STATE,
  isHeldBy,
  isHeldByAnother,
  reduceBrowserState,
  type BrowserSessionState,
  type BrowserStateSnapshot,
  type BrowserTabState,
} from "../browser-session-state";
import { INITIAL_SESSION_VIEWPORT } from "../browser-viewport";

function tab(id: string, patch: Partial<BrowserTabState> = {}): BrowserTabState {
  return {
    id,
    url: `https://${id}.example`,
    title: id,
    loading: false,
    ...patch,
  };
}

function withTabs(...ids: string[]): BrowserSessionState {
  let state = EMPTY_BROWSER_SESSION_STATE;
  ids.forEach((id, index) => {
    state = reduceBrowserState(state, {
      type: "tab_opened",
      seq: index + 1,
      tab: tab(id),
    });
  });
  return state;
}

describe("tabs", () => {
  it("opens the first tab and makes it active", () => {
    const state = withTabs("a");
    expect(state.tabs.map((t) => t.id)).toEqual(["a"]);
    expect(state.activeTabId).toBe("a");
    expect(state.seq).toBe(1);
  });

  it("does not steal focus for a tab opened behind the active one", () => {
    // A page popup does not become the active tab on its own — the browser
    // says so with its own `tab_activated`.
    const state = withTabs("a", "b");
    expect(state.activeTabId).toBe("a");
  });

  it("is idempotent on a replayed open", () => {
    let state = withTabs("a");
    state = reduceBrowserState(state, {
      type: "tab_opened",
      seq: 9,
      tab: tab("a"),
    });
    expect(state.tabs).toHaveLength(1);
  });

  it("honours an explicit insertion index", () => {
    let state = withTabs("a", "c");
    state = reduceBrowserState(state, {
      type: "tab_opened",
      seq: 5,
      tab: tab("b"),
      index: 1,
    });
    expect(state.tabs.map((t) => t.id)).toEqual(["a", "b", "c"]);
  });

  it("selects the right-hand neighbour when the active tab closes", () => {
    let state = withTabs("a", "b", "c");
    state = reduceBrowserState(state, {
      type: "tab_activated",
      seq: 10,
      tabId: "b",
    });
    state = reduceBrowserState(state, {
      type: "tab_closed",
      seq: 11,
      tabId: "b",
    });
    expect(state.tabs.map((t) => t.id)).toEqual(["a", "c"]);
    expect(state.activeTabId).toBe("c");
  });

  it("falls back to the left at the end of the strip", () => {
    let state = withTabs("a", "b");
    state = reduceBrowserState(state, {
      type: "tab_activated",
      seq: 10,
      tabId: "b",
    });
    state = reduceBrowserState(state, {
      type: "tab_closed",
      seq: 11,
      tabId: "b",
    });
    expect(state.activeTabId).toBe("a");
  });

  it("leaves nothing active when the last tab closes", () => {
    let state = withTabs("a");
    state = reduceBrowserState(state, {
      type: "tab_closed",
      seq: 5,
      tabId: "a",
    });
    expect(state.tabs).toEqual([]);
    expect(state.activeTabId).toBeNull();
    expect(activeTab(state)).toBeNull();
  });

  it("keeps the selection when a background tab closes", () => {
    let state = withTabs("a", "b");
    state = reduceBrowserState(state, {
      type: "tab_closed",
      seq: 5,
      tabId: "b",
    });
    expect(state.activeTabId).toBe("a");
  });

  it("applies an SPA url rewrite without a navigation", () => {
    let state = withTabs("a");
    state = reduceBrowserState(state, {
      type: "tab_updated",
      seq: 5,
      tabId: "a",
      patch: { url: "https://a.example/deep/link", title: "Deep" },
    });
    expect(activeTab(state)).toMatchObject({
      url: "https://a.example/deep/link",
      title: "Deep",
    });
  });

  it("ignores an update for a tab that has gone", () => {
    let state = withTabs("a");
    state = reduceBrowserState(state, {
      type: "tab_updated",
      seq: 5,
      tabId: "ghost",
      patch: { title: "nope" },
    });
    expect(state.tabs).toHaveLength(1);
  });
});

describe("ordering", () => {
  it("drops a delta that arrived behind the newest fact", () => {
    // The failure this prevents: a `tab_opened` stuck behind a slow relay
    // resurrecting a tab that has since closed.
    let state = withTabs("a");
    state = reduceBrowserState(state, {
      type: "tab_closed",
      seq: 4,
      tabId: "a",
    });
    state = reduceBrowserState(state, {
      type: "tab_opened",
      seq: 2,
      tab: tab("a"),
    });
    expect(state.tabs).toEqual([]);
  });

  it("advances the watermark even for a delta that changed nothing", () => {
    let state = withTabs("a");
    state = reduceBrowserState(state, {
      type: "tab_updated",
      seq: 7,
      tabId: "a",
      patch: { title: "a" },
    });
    expect(state.seq).toBe(7);
    // The next real delta at 8 must not be dropped as stale.
    state = reduceBrowserState(state, {
      type: "tab_updated",
      seq: 8,
      tabId: "a",
      patch: { title: "moved" },
    });
    expect(activeTab(state)?.title).toBe("moved");
  });
});

describe("snapshot reconciliation", () => {
  const snapshot = (patch: Partial<BrowserStateSnapshot> = {}) =>
    ({
      seq: 100,
      tabs: [tab("x")],
      activeTabId: "x",
      canGoBack: true,
      canGoForward: false,
      control: { kind: "agent" },
      viewport: INITIAL_SESSION_VIEWPORT,
      policy: "fixed",
      ...patch,
    }) satisfies BrowserStateSnapshot;

  it("replaces drift wholesale", () => {
    let state = withTabs("a", "b");
    state = reduceBrowserState(state, {
      type: "snapshot",
      snapshot: snapshot(),
    });
    expect(state.tabs.map((t) => t.id)).toEqual(["x"]);
    expect(state.canGoBack).toBe(true);
  });

  it("wins even against a higher local sequence", () => {
    // The disagreement IS the drift; preferring the delta would keep it.
    let state = withTabs("a");
    state = reduceBrowserState(state, {
      type: "tab_updated",
      seq: 500,
      tabId: "a",
      patch: { title: "local" },
    });
    state = reduceBrowserState(state, {
      type: "snapshot",
      snapshot: snapshot({ seq: 5 }),
    });
    expect(state.tabs.map((t) => t.id)).toEqual(["x"]);
    expect(state.seq).toBe(5);
  });

  it("never overwrites the pane's own connection reading", () => {
    // The daemon cannot know whether ITS bytes are reaching this pane.
    let state = reduceBrowserState(EMPTY_BROWSER_SESSION_STATE, {
      type: "connection_changed",
      connection: "reconnecting",
    });
    state = reduceBrowserState(state, {
      type: "snapshot",
      snapshot: snapshot(),
    });
    expect(state.connection).toBe("reconnecting");
  });

  it("returns the identical object for an unchanged snapshot", () => {
    // The heartbeat carries one several times a second; a new object each time
    // would repaint the whole shell on a page nobody touched.
    let state = reduceBrowserState(EMPTY_BROWSER_SESSION_STATE, {
      type: "snapshot",
      snapshot: snapshot(),
    });
    const again = reduceBrowserState(state, {
      type: "snapshot",
      snapshot: snapshot(),
    });
    expect(again).toBe(state);
  });

  it("returns the identical object for a delta that changed nothing at the same seq", () => {
    const state = withTabs("a");
    expect(
      reduceBrowserState(state, {
        type: "tab_activated",
        seq: 1,
        tabId: "a",
      }),
    ).toBe(state);
  });
});

describe("control", () => {
  it("distinguishes my hold from another person's", () => {
    const state = reduceBrowserState(EMPTY_BROWSER_SESSION_STATE, {
      type: "control_changed",
      seq: 1,
      control: { kind: "human", holder: "pane-1" },
    });
    expect(isHeldBy(state, "pane-1")).toBe(true);
    expect(isHeldByAnother(state, "pane-1")).toBe(false);
    expect(isHeldBy(state, "pane-2")).toBe(false);
    expect(isHeldByAnother(state, "pane-2")).toBe(true);
  });

  it("treats a script as another holder for every pane", () => {
    const state = reduceBrowserState(EMPTY_BROWSER_SESSION_STATE, {
      type: "control_changed",
      seq: 1,
      control: { kind: "script", holder: "cdp" },
    });
    expect(isHeldByAnother(state, "pane-1")).toBe(true);
    expect(isHeldBy(state, "pane-1")).toBe(false);
  });

  it("does not claim a hold while the agent drives", () => {
    expect(isHeldBy(EMPTY_BROWSER_SESSION_STATE, "pane-1")).toBe(false);
    expect(isHeldByAnother(EMPTY_BROWSER_SESSION_STATE, "pane-1")).toBe(false);
  });

  it("carries the parked flag through", () => {
    const state = reduceBrowserState(EMPTY_BROWSER_SESSION_STATE, {
      type: "control_changed",
      seq: 1,
      control: { kind: "human", holder: "pane-1", parked: true },
    });
    expect(state.control.parked).toBe(true);
    // Parked still belongs to its holder.
    expect(isHeldBy(state, "pane-1")).toBe(true);
  });
});

describe("viewport", () => {
  it("folds a resize in", () => {
    const state = reduceBrowserState(EMPTY_BROWSER_SESSION_STATE, {
      type: "viewport_changed",
      seq: 1,
      viewport: { width: 1400, height: 900, revision: 1 },
    });
    expect(state.viewport).toEqual({ width: 1400, height: 900, revision: 1 });
  });

  it("treats a same-size different-revision viewport as a change", () => {
    let state = reduceBrowserState(EMPTY_BROWSER_SESSION_STATE, {
      type: "viewport_changed",
      seq: 1,
      viewport: { width: 1024, height: 768, revision: 2 },
    });
    expect(state.viewport.revision).toBe(2);
    state = reduceBrowserState(state, {
      type: "viewport_changed",
      seq: 2,
      viewport: { width: 1024, height: 768, revision: 4 },
    });
    expect(state.viewport.revision).toBe(4);
  });
});

describe("connection", () => {
  it("is not sequenced against the publisher's facts", () => {
    // A stale remote seq must not suppress a socket close this pane watched.
    let state = withTabs("a");
    state = reduceBrowserState(state, {
      type: "tab_updated",
      seq: 900,
      tabId: "a",
      patch: { title: "later" },
    });
    state = reduceBrowserState(state, {
      type: "connection_changed",
      connection: "closed",
    });
    expect(state.connection).toBe("closed");
  });
});
