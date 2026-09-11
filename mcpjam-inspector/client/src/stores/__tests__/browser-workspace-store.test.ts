import { beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_BROWSER_PANEL_SIZE,
  MAX_BROWSER_PANEL_SIZE,
  MIN_BROWSER_PANEL_SIZE,
  useBrowserWorkspaceStore,
} from "../browser-workspace-store";

const reset = () =>
  useBrowserWorkspaceStore.setState({
    conversations: {},
    size: DEFAULT_BROWSER_PANEL_SIZE,
    collapsedRailForBrowser: false,
    revealSeq: 0,
    revealConversationId: null,
  });

describe("browser workspace layout", () => {
  beforeEach(reset);

  it("starts closed at roughly sixty percent", () => {
    const state = useBrowserWorkspaceStore.getState();
    expect(state.conversations).toEqual({});
    expect(state.size).toBe(60);
  });

  it("keeps the conversation layout stable when browsing calls it again", () => {
    const { openBrowser } = useBrowserWorkspaceStore.getState();
    openBrowser("a");
    const first = useBrowserWorkspaceStore.getState();
    openBrowser("a");
    const again = useBrowserWorkspaceStore.getState();
    expect(again.conversations).toBe(first.conversations);
    expect(again.revealSeq).toBe(first.revealSeq + 1);
    expect(again.revealConversationId).toBe("a");
  });

  it("puts an expanded browser away entirely when it closes", () => {
    // Expanded-but-hidden only becomes visible the confusing way: reopening it
    // later takes over the whole window with no obvious cause.
    const store = useBrowserWorkspaceStore.getState();
    store.openBrowser("a");
    store.setExpanded("a", true);
    useBrowserWorkspaceStore.getState().closeBrowser("a");
    expect(useBrowserWorkspaceStore.getState().conversations.a).toMatchObject({
      open: false,
      expanded: false,
    });
  });

  it("keeps A's layout when a background tool opens B", () => {
    const store = useBrowserWorkspaceStore.getState();
    store.openBrowser("a");
    store.setExpanded("a", true);
    store.openBrowser("b");
    store.closeBrowser("b");
    expect(useBrowserWorkspaceStore.getState().conversations).toEqual({
      a: { open: true, expanded: true },
      b: { open: false, expanded: false },
    });
  });

  it("clamps a size to something that is still a browser", () => {
    const { setSize } = useBrowserWorkspaceStore.getState();
    setSize(2);
    expect(useBrowserWorkspaceStore.getState().size).toBe(
      MIN_BROWSER_PANEL_SIZE,
    );
    setSize(99);
    expect(useBrowserWorkspaceStore.getState().size).toBe(
      MAX_BROWSER_PANEL_SIZE,
    );
  });

  it("rounds a fractional drag measurement", () => {
    useBrowserWorkspaceStore.getState().setSize(63.4);
    expect(useBrowserWorkspaceStore.getState().size).toBe(63);
  });

  it("returns the same state for a size that did not change", () => {
    const { setSize } = useBrowserWorkspaceStore.getState();
    setSize(55);
    const before = useBrowserWorkspaceStore.getState();
    setSize(55.2);
    expect(useBrowserWorkspaceStore.getState()).toBe(before);
  });

  it("collapses the rail for the browser exactly once", () => {
    // Doing it again on every reopen would fight a person who deliberately
    // put the rail back.
    const { noteRailCollapsed } = useBrowserWorkspaceStore.getState();
    noteRailCollapsed();
    expect(useBrowserWorkspaceStore.getState().collapsedRailForBrowser).toBe(
      true,
    );
    const after = useBrowserWorkspaceStore.getState();
    noteRailCollapsed();
    expect(useBrowserWorkspaceStore.getState()).toBe(after);
  });

  it("persists each conversation’s visibility but not expansion", () => {
    // Reopening on load would start a browser session nobody asked for, on a
    // metered box, before the person had said anything.
    const store = useBrowserWorkspaceStore.getState();
    store.openBrowser("a");
    store.setExpanded("a", true);
    store.setSize(72);
    const persisted = JSON.parse(
      window.localStorage.getItem("mcpjam.playground.browserWorkspace") ?? "{}",
    );
    expect(persisted.state).toMatchObject({ size: 72 });
    expect(persisted.state).not.toHaveProperty("open");
    expect(persisted.state).not.toHaveProperty("revealSeq");
    expect(persisted.state.conversations.a).toEqual({
      open: true,
      expanded: false,
    });
  });
});
